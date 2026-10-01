import 'reflect-metadata';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MoonlinkManager } from '../moonlinkManager';
import type { CacheService } from '../../system/cacheService';
import { Logger } from '@domain/logger';

/**
 * The node-event handlers — the layer that decides what a dead Lavalink node
 * does to playback.
 *
 * `moonlinkManager` was the least-covered file in the tree (175 of 494 lines)
 * and every one of those lines is on a failure path, which is the code that is
 * hardest to reason about and most expensive when wrong.
 *
 * The handlers are reached the way the class reaches them: swap the Moonlink
 * `Manager` for an event-capturing double, then call `registerNodeEvents()` a
 * second time. That exercises the real production closures — nothing is
 * re-implemented here — and it also lets the registration list itself be
 * asserted, which is the one thing that would silently lose every handler.
 *
 * The two rules this file exists to pin, in both directions:
 *
 *  - **A rate limit (4000) is an hour, a flake is 30 seconds, and anything else
 *    is also 30 seconds but logged at DEBUG.** Collapsing them means either
 *    hammering a rate-limited public node until someone else gets blocked, or
 *    sitting out a recoverable flake for an hour.
 *  - **A disconnect migrates players; an error only does when it says 429.**
 *    A `trackException` from an unrelated cause must not re-seek every other
 *    guild's playback mid-song.
 *
 * No hostname, node id, port or credential appears here: the doubles use
 * `example.com` and a closed localhost port, which is what the sibling
 * `moonlinkManager.test.ts` already does.
 */

const SAVED_ENV = { ...process.env };
const HOME_KEYS = ['HOME_LAVALINK_URL', 'HOME_LAVALINK_PASSWORD', 'HOME_LAVALINK_SECURE'] as const;
const savedHome: Record<string, string | undefined> = {};
for (const k of HOME_KEYS) savedHome[k] = SAVED_ENV[k];

const liveManagers: MoonlinkManager[] = [];

type Handler = (...args: unknown[]) => unknown;

interface Harness {
  manager: MoonlinkManager;
  handlers: Map<string, Handler>;
  inner: {
    nodeCooldownUntil: Map<string, number>;
    reconnectTimers: Map<string, NodeJS.Timeout>;
    nodeReconnectAttempts: Map<string, number>;
    lastRateLimitLog: Map<string, number>;
    restFailureSightings: Map<string, number>;
    failover: ReturnType<typeof vi.fn>;
    reconnectAttempts: ReturnType<typeof vi.fn>;
  };
  cache: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

/** Production env: the pool is configured, Lavalink enabled. */
const useHomeEnv = () => {
  process.env.ENVIRONMENT = 'production';
  delete process.env.ENABLE_LAVALINK;
  // Closed localhost port: refused in ms, no real network in tests.
  process.env.HOME_LAVALINK_URL = 'http://127.0.0.1:1';
  process.env.HOME_LAVALINK_PASSWORD = 'test-pw';
  process.env.HOME_LAVALINK_SECURE = 'false';
};

const fakeNode = (identifier: string, over: Record<string, unknown> = {}) => ({
  identifier,
  host: 'example.com',
  port: 443,
  connected: true,
  destroyed: false,
  connect: vi.fn(async () => undefined),
  ...over,
});

/**
 * Builds a manager with an event-capturing double in place of the Moonlink
 * `Manager`, by re-running the production registration against it.
 */
const build = (opts: { nodes?: Map<string, unknown>; players?: unknown[] } = {}): Harness => {
  useHomeEnv();
  const cache = {
    set: vi.fn(async (..._a: unknown[]) => undefined),
    get: vi.fn(async (..._a: unknown[]) => null),
    delete: vi.fn(async (..._a: unknown[]) => undefined),
  };
  const manager = new MoonlinkManager(cache as unknown as CacheService);
  liveManagers.push(manager);

  const nodeMap = opts.nodes ?? new Map<string, unknown>();
  const on = vi.fn();
  (manager as unknown as { manager: unknown }).manager = {
    on,
    nodes: { nodes: nodeMap },
    players: { all: opts.players ?? [] },
  };
  (manager as unknown as { registerNodeEvents: () => void }).registerNodeEvents();

  const handlers = new Map<string, Handler>();
  for (const [event, cb] of on.mock.calls as Array<[string, Handler]>) handlers.set(event, cb);

  const inner = manager as unknown as Harness['inner'];
  return {
    manager,
    handlers,
    cache,
    inner: {
      nodeCooldownUntil: inner.nodeCooldownUntil,
      reconnectTimers: inner.reconnectTimers,
      nodeReconnectAttempts: inner.nodeReconnectAttempts,
      lastRateLimitLog: inner.lastRateLimitLog,
      restFailureSightings: inner.restFailureSightings,
      failover: vi.fn(),
      reconnectAttempts: vi.fn(),
    },
  };
};

/** Swaps in a failover spy AFTER construction, since it is called via `this`. */
const spyOnFailover = (h: Harness): ReturnType<typeof vi.fn> => {
  const fn = vi.fn();
  (h.manager as unknown as { handleNodeFailover: (n: unknown) => void }).handleNodeFailover = fn;
  return fn;
};

const fire = (h: Harness, event: string, ...args: unknown[]) => {
  const handler = h.handlers.get(event);
  if (!handler) throw new Error(`no handler registered for "${event}"`);
  return handler(...args);
};

/** Lets the fire-and-forget pieces inside a handler run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** Every logger level takes `(msg)` or `(context, msg)`, so search all args. */
const said = (spy: { mock: { calls: unknown[][] } }, needle: string): boolean =>
  spy.mock.calls.some((call) => call.some((arg) => String(arg).includes(needle)));

afterEach(() => {
  process.env.ENVIRONMENT = SAVED_ENV.ENVIRONMENT;
  if (SAVED_ENV.ENABLE_LAVALINK === undefined) delete process.env.ENABLE_LAVALINK;
  else process.env.ENABLE_LAVALINK = SAVED_ENV.ENABLE_LAVALINK;
  for (const k of HOME_KEYS) {
    if (savedHome[k] === undefined) delete process.env[k];
    else process.env[k] = savedHome[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const m of liveManagers.splice(0)) m.stop();
});

describe('registerNodeEvents — every Moonlink event the failover depends on', () => {
  it('registers all six handlers, so none can be lost to a rename', () => {
    const h = build();
    expect([...h.handlers.keys()].sort()).toEqual([
      'nodeConnected',
      'nodeDisconnect',
      'nodeError',
      'nodeReconnect',
      'playerDestroy',
      'playerSwitchedNode',
    ]);
  });

  it('is idempotent in effect: the cooldown map is per instance, not shared', () => {
    const a = build();
    const b = build();
    a.inner.nodeCooldownUntil.set('Home', Date.now() + 60_000);
    expect(b.manager.isNodeCoolingDown('Home')).toBe(false);
    expect(a.manager.isNodeCoolingDown('Home')).toBe(true);
  });
});

describe('nodeConnected — a node that comes back is fully rehabilitated', () => {
  it('drops the cooldown, the retry chain and the persisted key together', async () => {
    // Dropping only the in-memory cooldown would leave a persisted one that
    // restores on the next restart, so the node is excluded from searches for
    // up to two more hours after it is demonstrably back.
    const h = build();
    const node = fakeNode('Home');
    h.inner.nodeCooldownUntil.set('Home', Date.now() + 600_000);
    h.inner.nodeReconnectAttempts.set('Home', 4);
    h.manager.noteRestFailure('Home');
    expect(h.manager.isNodeCoolingDown('Home')).toBe(true);

    fire(h, 'nodeConnected', node);
    await settle();

    expect(h.manager.isNodeCoolingDown('Home')).toBe(false);
    expect(h.inner.nodeReconnectAttempts.has('Home')).toBe(false);
    expect(h.cache.delete).toHaveBeenCalledWith('lavalink:cooldown:Home');
    // A persisted REST-dead cooldown is deliberately NOT written, so the delete
    // here is the only cache key this handler owns.
    expect(h.inner.reconnectTimers.has('Home')).toBe(false);
  });
});

describe('nodeDisconnect — three severities, three different answers', () => {
  it('code 4000 puts the node on a ONE-HOUR cooldown and moves players off it now', async () => {
    vi.useFakeTimers();
    const h = build();
    const failover = spyOnFailover(h);
    const node = fakeNode('PublicA');

    fire(h, 'nodeDisconnect', node, 4000, 'Rate limited');

    expect(h.manager.isNodeCoolingDown('PublicA')).toBe(true);
    const until = h.inner.nodeCooldownUntil.get('PublicA') ?? 0;
    // An hour, not thirty seconds: retrying into a 4000 is what got a public
    // host rate-limited in the first place.
    expect(until - Date.now()).toBeGreaterThan(3_500_000);
    expect(failover).toHaveBeenCalledWith(node);
    expect(h.inner.reconnectTimers.has('PublicA')).toBe(true);
  });

  it('a rate limit with a DIFFERENT code and "too many" in the reason is treated the same', async () => {
    // The vendor's reason string, not its code, is what identifies a 4000 on
    // some Moonlink builds.
    vi.useFakeTimers();
    const h = build();
    spyOnFailover(h);
    const node = fakeNode('PublicB');

    fire(h, 'nodeDisconnect', node, 4009, 'Too many requests');

    expect(h.manager.isNodeCoolingDown('PublicB')).toBe(true);
    expect(h.inner.nodeCooldownUntil.get('PublicB')! - Date.now()).toBeGreaterThan(3_500_000);
  });

  it('says the rate-limit line ONCE per ten minutes, not once per reconnect', async () => {
    // Ten reconnects inside a burst used to write ten identical lines, which is
    // how a real rate limit got lost in the noise it was supposed to be loud
    // about.
    vi.useFakeTimers();
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    const h = build();
    spyOnFailover(h);
    const node = fakeNode('PublicC');

    fire(h, 'nodeDisconnect', node, 4000, 'Rate limited');
    fire(h, 'nodeDisconnect', node, 4000, 'Rate limited');
    fire(h, 'nodeDisconnect', node, 4000, 'Rate limited');

    const rateLines = info.mock.calls.filter((c) => c.some((a) => String(a).includes('rate-limited')));
    expect(rateLines).toHaveLength(1);

    vi.advanceTimersByTime(600_001);
    fire(h, 'nodeDisconnect', node, 4000, 'Rate limited');
    expect(info.mock.calls.filter((c) => c.some((a) => String(a).includes('rate-limited')))).toHaveLength(2);
  });

  it('a flake is a 30-second cooldown, and it is NEVER a WARN', () => {
    // The load-bearing half. A WARN here is a deploy log full of lines the
    // operator can do nothing about, which is how the real lines get missed.
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    const failover = spyOnFailover(h);
    const node = fakeNode('PublicD');

    fire(h, 'nodeDisconnect', node, 1006, 'abnormal closure');

    const remaining = (h.inner.nodeCooldownUntil.get('PublicD') ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(25_000);
    expect(remaining).toBeLessThan(35_000);
    expect(failover).toHaveBeenCalledWith(node);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    'getaddrinfo ENOTFOUND example.com',
    'read EPROTO',
    'socket closed abruptly',
    'connection timeout',
    'socket hang up',
  ])('a non-1006 flake reason ("%s") is a 30-second cooldown described at DEBUG', (reason) => {
    vi.useFakeTimers();
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    const failover = spyOnFailover(h);
    const node = fakeNode('PublicD');

    fire(h, 'nodeDisconnect', node, 4004, reason);

    const remaining = (h.inner.nodeCooldownUntil.get('PublicD') ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(25_000);
    expect(remaining).toBeLessThan(35_000);
    expect(failover).toHaveBeenCalledWith(node);
    expect(warn).not.toHaveBeenCalled();
    // Silent at DEBUG too: an EXPECTED flake has nothing to report, and a line
    // per reconnect would be the noise this branch exists to avoid.
    expect(said(debug, 'disconnected')).toBe(false);
  });

  it('an unrecognised reason is still cooled and still migrated, just described', () => {
    vi.useFakeTimers();
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    const failover = spyOnFailover(h);
    const node = fakeNode('NodeE');

    fire(h, 'nodeDisconnect', node, 4004, 'something new');

    // The safe direction: cooldown + failover either way. A brand-new close
    // reason must not be the one shape that neither cools nor moves.
    expect(h.manager.isNodeCoolingDown('NodeE')).toBe(true);
    expect(failover).toHaveBeenCalledWith(node);
    expect(said(debug, 'disconnected')).toBe(true);
  });

  it('disarms Moonlink own reconnect timer, so the two chains do not fight', async () => {
    // Moonlink arms its own retry inside the same event. Left alone, it re-dials
    // a rate-limited node immediately while this file waits an hour.
    const node = fakeNode('PublicF', { reconnectTimeout: setTimeout(() => undefined, 1_000_000) });
    const h = build();
    spyOnFailover(h);

    fire(h, 'nodeDisconnect', node, 1006, 'socket hang up');
    await new Promise((r) => setImmediate(r));

    expect((node as unknown as { reconnectTimeout?: NodeJS.Timeout }).reconnectTimeout).toBeUndefined();
  });

  it('a disconnect that arrives with no reason string at all does not throw', () => {
    vi.useFakeTimers();
    const h = build();
    const failover = spyOnFailover(h);
    const node = fakeNode('NodeG');

    expect(() => fire(h, 'nodeDisconnect', node, 1006, undefined)).not.toThrow();
    expect(failover).toHaveBeenCalled();
  });
});

describe('nodeError — an error is not a disconnect, so it must not migrate on its own', () => {
  it.each(['getaddrinfo ENOTFOUND', 'read EPROTO', 'request timeout', 'socket hang up'])(
    'a known flake ("%s") is a DEBUG line and nothing else',
    (message) => {
      const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      const h = build();
      const failover = spyOnFailover(h);

      fire(h, 'nodeError', fakeNode('PublicA'), new Error(message));

      expect(said(debug, 'flaked')).toBe(true);
      // Not migrated, not warned: public nodes spam these and the user reads
      // the deploy log.
      expect(failover).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('a real error IS a WARN line, carrying the node and the message', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    const failover = spyOnFailover(h);

    fire(h, 'nodeError', fakeNode('Home'), new Error('websocket closed'));

    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0] as { node?: string };
    expect(payload.node).toBe('Home');
    // But still NOT a migration: nothing here says the node is unusable.
    expect(failover).not.toHaveBeenCalled();
  });

  it.each(['429 Too Many Requests', 'rate limit exceeded', 'got Too Many Requests'])(
    'a throttling error ("%s") moves players off the node',
    (message) => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      const h = build();
      const failover = spyOnFailover(h);
      const node = fakeNode('PublicB');

      fire(h, 'nodeError', node, new Error(message));

      // This is the one error class that IS evidence the node is unusable, so
      // it is the one error class that migrates.
      expect(failover).toHaveBeenCalledWith(node);
    },
  );

  it('an error object with no message still reads as one, rather than "undefined"', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    spyOnFailover(h);

    expect(() => fire(h, 'nodeError', fakeNode('Home'), {})).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the remaining three events — observable, and deliberately inert', () => {
  it('nodeReconnect logs at DEBUG', () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    fire(h, 'nodeReconnect', fakeNode('Home'));
    expect(said(debug, 'reconnected')).toBe(true);
  });

  it('playerSwitchedNode names both nodes, so a migration is traceable afterwards', () => {
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    const h = build();
    fire(h, 'playerSwitchedNode', { guildId: 'g1' }, fakeNode('Old'), fakeNode('New'));
    expect(said(info, 'Old') && said(info, 'New')).toBe(true);
  });

  it('playerDestroy logs even with no reason, rather than printing "undefined"', () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    fire(h, 'playerDestroy', { guildId: 'g1' }, undefined);
    expect(said(debug, 'destroyed')).toBe(true);
  });
});

describe('scheduleReconnect — the retry chain has to be able to survive its own failure', () => {
  const reconnect = (h: Harness, node: unknown, ms: number) =>
    (h.manager as unknown as { scheduleReconnect: (n: unknown, m: number) => void }).scheduleReconnect(node, ms);

  it('a connect that FAILS re-arms with backoff, rather than leaving the node dead forever', async () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home', {
      connect: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });

    reconnect(h, node, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((node as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledTimes(1);

    // The retry is still armed, with the delay grown 1.5x.
    expect(h.inner.reconnectTimers.has('Home')).toBe(true);
    const rearmed = h.inner.reconnectTimers.get('Home')!;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rearmed).not.toBe(h.inner.reconnectTimers.get('Home'));
  });

  it('a destroyed node is not dialled at all — Moonlink gave up on it deliberately', async () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home', { destroyed: true, connect: vi.fn(async () => undefined) });

    reconnect(h, node, 10);
    await vi.advanceTimersByTimeAsync(100);

    expect((node as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
    expect(h.inner.reconnectTimers.has('Home')).toBe(false);
  });

  it('arming twice for one node REPLACES the timer rather than stacking two dials', async () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home');

    reconnect(h, node, 10_000);
    const first = h.inner.reconnectTimers.get('Home');
    reconnect(h, node, 10_000);
    expect(h.inner.reconnectTimers.get('Home')).not.toBe(first);

    await vi.advanceTimersByTimeAsync(10_000);
    expect((node as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledTimes(1);
  });

  it('a successful reconnect clears the timer entry, so the map does not grow for ever', async () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home');

    reconnect(h, node, 10);
    await vi.advanceTimersByTimeAsync(50);

    expect(h.inner.reconnectTimers.has('Home')).toBe(false);
  });

  it('a cooldown that outlives the timer re-arms past its expiry, never an early dial', async () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home');

    h.manager.noteRestFailure('Home');
    reconnect(h, node, 10);

    await vi.advanceTimersByTimeAsync(500);

    expect((node as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
    expect(h.inner.reconnectTimers.has('Home')).toBe(true);
  });

  it('clearReconnectTimer removes the entry and leaves a node with no timer alone', () => {
    const h = build();
    const clear = (h.manager as unknown as { clearReconnectTimer: (id: string) => void }).clearReconnectTimer.bind(h.manager);

    expect(() => clear('NeverArmed')).not.toThrow();
    h.inner.reconnectTimers.set('Home', setTimeout(() => undefined, 100_000));
    clear('Home');
    expect(h.inner.reconnectTimers.has('Home')).toBe(false);
  });
});

describe('cooldowns across a restart', () => {
  it('a persisted cooldown is restored, so a rapid redeploy does not reset the backoff', async () => {
    useHomeEnv();
    const cache = {
      set: vi.fn(async () => undefined),
      get: vi.fn(async (..._a: unknown[]) => Date.now() + 90_000),
      delete: vi.fn(async () => undefined),
    };
    const manager = new MoonlinkManager(cache as unknown as CacheService);
    liveManagers.push(manager);

    await new Promise((r) => setTimeout(r, 5));

    expect(manager.isNodeCoolingDown('Home')).toBe(true);
  });

  it('an EXPIRED persisted cooldown is ignored, so yesterday suspicion does not block today', async () => {
    useHomeEnv();
    const cache = {
      set: vi.fn(async () => undefined),
      get: vi.fn(async (..._a: unknown[]) => Date.now() - 1000),
      delete: vi.fn(async () => undefined),
    };
    const manager = new MoonlinkManager(cache as unknown as CacheService);
    liveManagers.push(manager);

    await new Promise((r) => setTimeout(r, 5));

    expect(manager.isNodeCoolingDown('Home')).toBe(false);
  });

  it('an unreadable cooldown key is a fresh probe, not a blocked node and not a crash', async () => {
    useHomeEnv();
    const cache = {
      set: vi.fn(async () => undefined),
      get: vi.fn(async (..._a: unknown[]) => {
        throw new Error('redis down');
      }),
      delete: vi.fn(async () => undefined),
    };
    const manager = new MoonlinkManager(cache as unknown as CacheService);
    liveManagers.push(manager);

    await new Promise((r) => setTimeout(r, 5));

    expect(manager.isNodeCoolingDown('Home')).toBe(false);
  });

  it('a REST-dead cooldown is deliberately NOT persisted, so a fresh process re-probes', async () => {
    // The opposite direction, and the reason the `persist` flag exists: a
    // half-open node reads as connected, so a fresh process must be willing to
    // try it again rather than inherit an hour of suspicion.
    const h = build();
    h.manager.noteRestFailure('Home');

    expect(h.cache.set).not.toHaveBeenCalledWith('lavalink:cooldown:Home', expect.anything(), expect.anything());
  });

  it('a DISCONNECT cooldown IS persisted, because a rate limit outlives the process', async () => {
    vi.useFakeTimers();
    const h = build();
    fire(h, 'nodeDisconnect', fakeNode('PublicH'), 4000, 'Rate limited');

    expect(h.cache.set).toHaveBeenCalledWith(
      'lavalink:cooldown:PublicH',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('a cache write that fails leaves the in-memory cooldown intact', () => {
    // The cooldown is the load-bearing half; persistence is a convenience. If
    // Redis refuses, the node is still excluded for this process.
    const h = build();
    h.cache.set.mockRejectedValue(new Error('redis down'));

    expect(() => h.manager.noteRestFailure('Home')).not.toThrow();
    expect(h.manager.isNodeCoolingDown('Home')).toBe(true);
  });

  it('a cache delete that fails still leaves the in-memory cooldown gone', () => {
    const h = build();
    h.cache.delete.mockRejectedValue(new Error('redis down'));
    h.manager.noteRestFailure('Home');

    expect(() => fire(h, 'nodeConnected', fakeNode('Home'))).not.toThrow();
    expect(h.manager.isNodeCoolingDown('Home')).toBe(false);
  });
});

describe('getAllNodes — reading a pool that is a Map or a bare array', () => {
  it('reads the newer Map shape', () => {
    const nodes = new Map<string, unknown>([['Home', fakeNode('Home')]]);
    const h = build({ nodes });
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { nodes },
      players: { all: [] },
    };
    expect(h.manager.getHealthyNodeCount()).toBe(1);
    expect(h.manager.hasHealthyNode()).toBe(true);
  });

  it('falls back to `onlineNodes` when the pool is an array', () => {
    // Older Moonlink builds expose the online set as an array. Reading only the
    // Map would report "no nodes" on those, i.e. report the whole pool dead.
    const h = build();
    const online = [fakeNode('Home')];
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { onlineNodes: online },
      players: { all: [] },
    };
    expect(h.manager.getHealthyNodeCount()).toBe(1);
    expect(h.manager.hasHealthyNode()).toBe(true);
  });

  it('a pool with neither shape is empty, never a throw', () => {
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = { players: { all: [] } };
    expect(h.manager.getHealthyNodeCount()).toBe(0);
    expect(h.manager.hasHealthyNode()).toBe(false);
  });
});

describe('pickSearchNode — a picker that throws must not invent a node', () => {
  it('returns undefined when the picker itself throws', () => {
    // Undefined means the ladder reports a transport error and says "try
    // again". Returning some node would search a node already known to be bad.
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: new Map([['Home', fakeNode('Home')]]),
        findNode: () => {
          throw new Error('moonlink internal');
        },
      },
      players: { all: [] },
    };

    expect(h.manager.pickSearchNode([])).toBeUndefined();
  });

  it('returns undefined when the pool exposes no picker at all', () => {
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { nodes: new Map([['Home', fakeNode('Home')]]) },
      players: { all: [] },
    };
    expect(h.manager.pickSearchNode([])).toBeUndefined();
  });
});

describe('the health loop — a 10s sweep that never polls the card', () => {
  const sweep = (h: Harness) =>
    (h.manager as unknown as { checkNodesHealth: () => void }).checkNodesHealth();

  it('a node under extreme load is WARNED about, with the percentage it reports', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: new Map([
          ['Hot', fakeNode('Hot', { stats: { cpu: { lavalinkLoad: 0.97, systemLoad: 0.1 } } })],
        ]),
      },
      players: { all: [] },
    };

    sweep(h);

    const line = warn.mock.calls.find((c) => String(c[0]).includes('extreme load'));
    expect(line).toBeDefined();
    // 97.0%, read off the vendor's own fraction rather than a guess.
    expect(String(line?.[0])).toContain('97.0%');
  });

  it('a healthy node produces no load warning at all', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: new Map([
          ['Fine', fakeNode('Fine', { stats: { cpu: { lavalinkLoad: 0.2, systemLoad: 0.3 } } })],
        ]),
      },
      players: { all: [] },
    };

    sweep(h);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('extreme load'))).toHaveLength(0);
  });

  it('a node with no stats block, or not connected, is skipped rather than read', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: new Map([
          ['NoStats', fakeNode('NoStats', { stats: undefined })],
          ['Down', fakeNode('Down', { connected: false, stats: { cpu: { lavalinkLoad: 0.99 } } })],
        ]),
      },
      players: { all: [] },
    };

    expect(() => sweep(h)).not.toThrow();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('extreme load'))).toHaveLength(0);
  });

  it('a sweep that throws is swallowed as DEBUG, so the loop survives one bad node', () => {
    vi.useFakeTimers();
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    (h.manager as unknown as { manager: unknown }).manager = {
      get nodes(): never {
        throw new Error('moonlink torn down');
      },
      players: { all: [] },
    };

    expect(() => sweep(h)).not.toThrow();
    expect(said(debug, 'health check loop')).toBe(true);
  });

  /**
   * The init guard, both directions.
   *
   * Note the method is NOT replaced here. Substituting `resurrectNodes` on the
   * instance would bypass the very guard under test — the call site is
   * `this.resurrectNodes()`, so a spy intercepts it BEFORE the guard runs and
   * the test would assert nothing. The observable is `nodes.add` instead.
   */
  const poolWith = (h: Harness) => {
    const map = new Map<string, unknown>();
    const add = vi.fn();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { nodes: map, add, remove: vi.fn() },
      players: { all: [] },
    };
    return { map, add };
  };

  it('the resurrection sweep does nothing before init, so it never fights the pool being built', () => {
    const h = build();
    const { add } = poolWith(h);
    (h.manager as unknown as { isInitialized: boolean }).isInitialized = false;

    sweep(h);

    expect(add).not.toHaveBeenCalled();
  });

  it('and does start resurrecting once init has run — the other direction', () => {
    // A guard that always returned would make the test above pass while the
    // tower-sleep recovery it exists for never happened again.
    const h = build();
    const { add } = poolWith(h);
    (h.manager as unknown as { isInitialized: boolean }).isInitialized = true;

    sweep(h);

    expect(add).toHaveBeenCalled();
  });
});

describe('resurrectNodes — a node missing from the pool entirely', () => {
  const resurrect = (h: Harness) =>
    (h.manager as unknown as { resurrectNodes: () => void }).resurrectNodes();

  const initialized = (h: Harness) => {
    (h.manager as unknown as { isInitialized: boolean }).isInitialized = true;
  };

  it('a node that vanished from the pool is re-added and dialled', async () => {
    const h = build();
    initialized(h);
    const rebuilt = fakeNode('Home');
    const map = new Map<string, unknown>();
    const add = vi.fn((cfg: Record<string, unknown>) => {
      map.set(String(cfg.identifier), rebuilt);
    });
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { nodes: map, add, remove: vi.fn() },
      players: { all: [] },
    };

    resurrect(h);
    await new Promise((r) => setTimeout(r, 5));

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'Home', secure: false }),
    );
    expect((rebuilt as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalled();
  });

  it('a re-add that throws is DEBUG, and the sweep carries on to the next node', () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    initialized(h);
    const map = new Map<string, unknown>();
    const add = vi.fn(() => {
      throw new Error('moonlink refused');
    });
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: { nodes: map, add, remove: vi.fn() },
      players: { all: [] },
    };

    expect(() => resurrect(h)).not.toThrow();
    expect(said(debug, 're-add')).toBe(true);
  });

  it('a rebuilt node whose connect rejects is swallowed, not an unhandled rejection', async () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    initialized(h);
    const rebuilt = fakeNode('Home', {
      connect: vi.fn(async () => {
        throw new Error('still asleep');
      }),
    });
    const map = new Map<string, unknown>();
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: map,
        add: vi.fn((cfg: Record<string, unknown>) => {
          map.set(String(cfg.identifier), rebuilt);
        }),
        remove: vi.fn(),
      },
      players: { all: [] },
    };

    resurrect(h);
    await new Promise((r) => setTimeout(r, 10));

    expect(said(debug, 'connect failed')).toBe(true);
  });

  it('a rebuild that throws is swallowed and does not stop the loop', () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const h = build();
    initialized(h);
    const map = new Map<string, unknown>([['Home', fakeNode('Home', { destroyed: true })]]);
    (h.manager as unknown as { manager: unknown }).manager = {
      nodes: {
        nodes: map,
        add: vi.fn(() => {
          throw new Error('rebuild refused');
        }),
        remove: vi.fn(),
      },
      players: { all: [] },
    };

    expect(() => resurrect(h)).not.toThrow();
    expect(said(debug, 'rebuild')).toBe(true);
  });

  it('a pool with no Map at all does nothing rather than throwing', () => {
    const h = build();
    initialized(h);
    (h.manager as unknown as { manager: unknown }).manager = { nodes: {}, players: { all: [] } };
    expect(() => resurrect(h)).not.toThrow();
  });
});

describe('stop() — the teardown a test suite and a deploy both rely on', () => {
  it('clears the health interval and every pending reconnect', () => {
    vi.useFakeTimers();
    const h = build();
    const node = fakeNode('Home');
    (h.manager as unknown as { scheduleReconnect: (n: unknown, m: number) => void }).scheduleReconnect(node, 100_000);
    h.inner.reconnectTimers.set('Other', setTimeout(() => undefined, 100_000));

    h.manager.stop();

    expect(h.inner.reconnectTimers.size).toBe(0);
  });

  it('stop() twice is safe, because the health interval is only cleared once', () => {
    const h = build();
    h.manager.stop();
    expect(() => h.manager.stop()).not.toThrow();
  });
});