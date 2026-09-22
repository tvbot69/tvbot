import 'reflect-metadata';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MoonlinkManager } from './moonlinkManager';

const SAVED_ENV = { ...process.env };
const HOME_KEYS = ['HOME_LAVALINK_URL', 'HOME_LAVALINK_PASSWORD', 'HOME_LAVALINK_SECURE', 'HOME_NODE_ENABLED'] as const;
const savedHome: Record<string, string | undefined> = {};
for (const k of HOME_KEYS) savedHome[k] = SAVED_ENV[k];

const liveManagers: MoonlinkManager[] = [];

afterEach(() => {
  process.env.ENVIRONMENT = SAVED_ENV.ENVIRONMENT;
  if (SAVED_ENV.ENABLE_LAVALINK === undefined) {
    delete process.env.ENABLE_LAVALINK;
  } else {
    process.env.ENABLE_LAVALINK = SAVED_ENV.ENABLE_LAVALINK;
  }
  for (const k of HOME_KEYS) {
    if (savedHome[k] === undefined) delete process.env[k];
    else process.env[k] = savedHome[k];
  }
  vi.useRealTimers();
  for (const m of liveManagers.splice(0)) m.stop();
});

describe('MoonlinkManager enablement', () => {
  it('explicit false disables music even in production', () => {
    process.env.ENVIRONMENT = 'production';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    expect(manager.hasHealthyNode()).toBe(false);
    expect(manager.getHealthyNodeCount()).toBe(0);
    expect(manager.getNodeStats()).toEqual([]);
  });

  it('production without a flag enables the node pool', () => {
    process.env.ENVIRONMENT = 'production';
    delete process.env.ENABLE_LAVALINK;
    const manager = new MoonlinkManager();
    expect(manager.getManager()).toBeDefined();
    // Not connected in unit test, but the pool is configured
    expect(manager.getHealthyNodeCount()).toBe(0);
  });

  it('local dev stays dark unless explicitly enabled', () => {
    process.env.ENVIRONMENT = 'local';
    delete process.env.ENABLE_LAVALINK;
    const manager = new MoonlinkManager();
    expect(manager.hasHealthyNode()).toBe(false);
  });
});

describe('MoonlinkManager node resurrection (tower sleep/reboot)', () => {
  const useHomeEnv = () => {
    process.env.ENVIRONMENT = 'production';
    delete process.env.ENABLE_LAVALINK;
    // Closed localhost port: refused in ms, no real network in tests.
    process.env.HOME_LAVALINK_URL = 'http://127.0.0.1:1';
    process.env.HOME_LAVALINK_PASSWORD = 'test-pw';
    process.env.HOME_LAVALINK_SECURE = 'false';
  };

  const innerMapOf = (manager: MoonlinkManager): Map<string, unknown> => {
    const inner = manager.getManager() as unknown as { nodes: { nodes: Map<string, unknown> } };
    return inner.nodes.nodes;
  };

  const markInitialized = (manager: MoonlinkManager) => {
    (manager as unknown as { isInitialized: boolean }).isInitialized = true;
  };

  const sweep = (manager: MoonlinkManager) => {
    (manager as unknown as { checkNodesHealth: () => void }).checkNodesHealth();
  };

  const connectedFake = (identifier: string) => ({
    identifier,
    host: 'example.com',
    port: 443,
    connected: true,
    destroyed: false,
    connect: vi.fn(async () => undefined),
    destroy: vi.fn(),
  });

  it('rebuilds a destroyed Home node instead of leaving it dead forever', () => {
    vi.useFakeTimers();
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    markInitialized(manager);
    const map = innerMapOf(manager);
    // Publics look healthy so the sweep leaves them alone (no network).
    map.set('MilloHost', connectedFake('MilloHost'));
    map.set('Serenetia-SSL', connectedFake('Serenetia-SSL'));
    // Home as Moonlink leaves it after a long tower sleep: retries exhausted.
    const deadHome = { ...connectedFake('Home'), connected: false, destroyed: true };
    map.set('Home', deadHome);

    sweep(manager);

    const rebuilt = map.get('Home') as { destroyed?: boolean; identifier?: string };
    expect(rebuilt).not.toBe(deadHome);
    expect(rebuilt?.identifier).toBe('Home');
    expect(rebuilt?.destroyed).toBeFalsy();
    expect(deadHome.destroy).toHaveBeenCalled();
  });

  it('re-arms the retry when a reconnect timer fires inside cooldown (no orphan)', () => {
    vi.useFakeTimers();
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    markInitialized(manager);
    const map = innerMapOf(manager);
    map.set('MilloHost', connectedFake('MilloHost'));
    map.set('Serenetia-SSL', connectedFake('Serenetia-SSL'));
    const home = { ...connectedFake('Home'), connected: false, destroyed: false, connect: vi.fn(async () => undefined) };
    map.set('Home', home);

    const inner = manager as unknown as {
      scheduleReconnect: (node: unknown, ms: number) => void;
      nodeCooldownUntil: Map<string, number>;
      reconnectTimers: Map<string, NodeJS.Timeout>;
    };
    // Cooldown outlives the timer: the old code dropped the retry here.
    inner.nodeCooldownUntil.set('Home', Date.now() + 60000);
    inner.scheduleReconnect(home, 10);
    expect(inner.reconnectTimers.has('Home')).toBe(true);

    vi.advanceTimersByTime(50);

    // Re-armed past the cooldown instead of orphaned, and never dialed early.
    expect(inner.reconnectTimers.has('Home')).toBe(true);
    expect(home.connect).not.toHaveBeenCalled();
  });

  it('does not touch rate-limited nodes (cooldown respected)', () => {
    vi.useFakeTimers();
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    markInitialized(manager);
    const map = innerMapOf(manager);
    map.set('MilloHost', connectedFake('MilloHost'));
    map.set('Serenetia-SSL', connectedFake('Serenetia-SSL'));
    const home = { ...connectedFake('Home'), connected: false, destroyed: false, connect: vi.fn(async () => undefined) };
    map.set('Home', home);

    const inner = manager as unknown as { nodeCooldownUntil: Map<string, number>; reconnectTimers: Map<string, NodeJS.Timeout> };
    inner.nodeCooldownUntil.set('Home', Date.now() + 3600000);
    sweep(manager);

    // Sweep skips cooldown nodes: nothing dialed while the cooldown holds.
    expect(home.connect).not.toHaveBeenCalled();
    expect(inner.reconnectTimers.has('Home')).toBe(false);

    // Once the cooldown lapses, the regular 10s loop picks it back up
    // (advance stops exactly at expiry so the 5s retry stays pending).
    vi.advanceTimersByTime(3600000);
    expect(inner.reconnectTimers.has('Home')).toBe(true);
    expect(home.connect).not.toHaveBeenCalled();
  });
});
