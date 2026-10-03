import 'reflect-metadata';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { Logger } from '@domain/logging/logger';

/**
 * `handleNodeFailover` — the one place in the bot that moves live playback
 * between nodes — plus the two reporting surfaces a listener reads when music
 * will not start.
 *
 * The migration snapshot is the part worth reading twice. Node state (volume,
 * loop, autoplay, filters, position) is per-SESSION, not per-node, so a move
 * without a snapshot silently resets every migrated guild to 100% volume, no
 * filter, from 0:00. The tests below assert the restore in both directions:
 * a state that WAS set is pushed to the new node, and a state that was NOT set
 * is not invented.
 *
 * The second thing worth reading is the sorting: the target is the connected,
 * non-cooling node with the FEWEST players, because migrating three guilds onto
 * a busier node is how one failure becomes two.
 *
 * `transferNode` is the only move primitive, never `restart()` — Moonlink v5's
 * restart re-sends channelId-less voice, which Lavalink 4.2.2 rejects with 400.
 * The sibling `moonlinkManager.test.ts` pins that at the top level; the tests
 * here pin what happens once the transfer is in flight.
 */

const SAVED_ENV = { ...process.env };
const HOME_KEYS = ['HOME_LAVALINK_URL', 'HOME_LAVALINK_PASSWORD', 'HOME_LAVALINK_SECURE'] as const;
const savedHome: Record<string, string | undefined> = {};
for (const k of HOME_KEYS) savedHome[k] = SAVED_ENV[k];

const liveManagers: MoonlinkManager[] = [];

const useHomeEnv = () => {
  process.env.ENVIRONMENT = 'production';
  delete process.env.ENABLE_LAVALINK;
  process.env.HOME_LAVALINK_URL = 'http://127.0.0.1:1';
  process.env.HOME_LAVALINK_PASSWORD = 'test-pw';
  process.env.HOME_LAVALINK_SECURE = 'false';
};

const statsFor = (players: number, over: Record<string, unknown> = {}) => ({
  players,
  playingPlayers: Math.max(0, players - 1),
  cpu: { systemLoad: 0.05, lavalinkLoad: 0.05 },
  memory: { used: 100, allocated: 1000 },
  uptime: 999,
  ...over,
});

const statNode = (identifier: string, players: number, over: Record<string, unknown> = {}) => ({
  identifier,
  host: 'example.com',
  port: 443,
  connected: true,
  destroyed: false,
  connect: vi.fn(async () => undefined),
  destroy: vi.fn(),
  // Node-level overrides last, so a case can mark a node disconnected. The
  // stats override goes through `stats` explicitly.
  ...over,
  stats: (over as { stats?: unknown }).stats ?? statsFor(players, over.stats as Record<string, unknown>),
});

interface PlayerDouble {
  guildId: string;
  node: { identifier: string } | null;
  volume?: number;
  loop?: string;
  autoPlay?: boolean;
  filters: { enabled: string[]; enable: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
  current?: { position?: number } | null;
  transferNode: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setAutoPlay: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
}

const makePlayer = (over: Partial<PlayerDouble> = {}): PlayerDouble => ({
  guildId: 'g1',
  node: { identifier: 'Home' },
  volume: 100,
  loop: 'off',
  autoPlay: false,
  filters: {
    enabled: [],
    enable: vi.fn(),
    apply: vi.fn(async () => undefined),
  },
  current: null,
  transferNode: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
  setVolume: vi.fn(),
  setLoop: vi.fn(),
  setAutoPlay: vi.fn(),
  seek: vi.fn(async () => undefined),
  ...over,
});

const harness = (nodes: Map<string, unknown>, players: PlayerDouble[] = []) => {
  useHomeEnv();
  const manager = new MoonlinkManager();
  liveManagers.push(manager);
  (manager as unknown as { manager: unknown }).manager = {
    nodes: { nodes },
    players: { all: players },
  };
  return manager;
};

const settle = () => new Promise((r) => setTimeout(r, 10));

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

describe('handleNodeFailover — who moves, and who must not', () => {
  it('moves only the players that were ON the failed node', async () => {
    // Moving an unaffected guild would re-seek a song that was playing fine.
    const here = makePlayer({ guildId: 'here' });
    const elsewhere = makePlayer({ guildId: 'elsewhere', node: { identifier: 'PublicA' } });
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['PublicA', statNode('PublicA', 0)],
    ]);
    const manager = harness(nodes, [here, elsewhere]);

    manager.handleNodeFailover(nodes.get('Home') as never);
    await settle();

    expect(here.transferNode).toHaveBeenCalledTimes(1);
    expect(elsewhere.transferNode).not.toHaveBeenCalled();
  });

  it('a node with no players on it is a no-op, with no warning', async () => {
    // The common case after a restart. Logging "cannot migrate" here would put
    // a WARN in the deploy log for every node that simply had nothing playing.
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 0)],
      ['PublicA', statNode('PublicA', 0)],
    ]);
    const manager = harness(nodes, [makePlayer({ node: { identifier: 'PublicA' } })]);

    manager.handleNodeFailover(nodes.get('Home') as never);
    await settle();

    expect(warn).not.toHaveBeenCalled();
  });

  it('no healthy backup is a WARN and NO move, because leaving the player put is better than a doomed transfer', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const player = makePlayer();
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['PublicA', statNode('PublicA', 0, { connected: false })],
    ]);
    const manager = harness(nodes, [player]);

    manager.handleNodeFailover(nodes.get('Home') as never);
    await settle();

    // Said plainly, because "we did nothing" without a reason is the failure
    // mode this line exists to remove.
    expect(said(warn, 'no healthy backup')).toBe(true);
    expect(player.transferNode).not.toHaveBeenCalled();
  });

  it('a backup that is COOLING is not a target, even though it reports connected', async () => {
    // The tower-uplink-stall shape: Moonlink still says connected while every
    // REST call times out. Migrating onto it moves the failure, not the guild.
    const player = makePlayer();
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['Cooling', statNode('Cooling', 0)],
      ['Fine', statNode('Fine', 0)],
    ]);
    const manager = harness(nodes, [player]);
    manager.noteRestFailure('Cooling');

    manager.handleNodeFailover(nodes.get('Home') as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledWith(nodes.get('Fine'));
  });

  it('picks the node with the FEWEST players, so one failure does not become two', async () => {
    const player = makePlayer();
    const busy = statNode('Busy', 9);
    const idle = statNode('Idle', 1);
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['Busy', busy],
      ['Idle', idle],
    ]);
    const manager = harness(nodes, [player]);

    manager.handleNodeFailover(nodes.get('Home') as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledWith(idle);
  });

  it('a target with no stats block sorts as zero players rather than crashing the sort', async () => {
    const player = makePlayer();
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['NoStats', { identifier: 'NoStats', host: 'example.com', port: 443, connected: true }],
      ['Busy', statNode('Busy', 5)],
    ]);
    const manager = harness(nodes, [player]);

    expect(() => manager.handleNodeFailover(nodes.get('Home') as never)).not.toThrow();
    await settle();
    expect(player.transferNode).toHaveBeenCalledTimes(1);
  });
});

describe('handleNodeFailover — the session snapshot that must survive the move', () => {
  const onePlayer = (player: PlayerDouble) => {
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['PublicA', statNode('PublicA', 0)],
    ]);
    const manager = harness(nodes, [player]);
    return { manager, target: nodes.get('PublicA') };
  };

  it('restores a non-default volume, so the move does not deafen the guild', async () => {
    const player = makePlayer({ volume: 35 });
    const { manager, target } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledWith(target);
    expect(player.setVolume).toHaveBeenCalledWith(35);
  });

  it('leaves a DEFAULT volume alone, rather than pushing a redundant REST call', async () => {
    const player = makePlayer({ volume: 100 });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it('restores a loop mode, and not at all for "off"', async () => {
    const looping = makePlayer({ loop: 'queue' });
    const off = makePlayer({ loop: 'off' });
    const a = onePlayer(looping);
    const b = onePlayer(off);

    a.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(looping.setLoop).toHaveBeenCalledWith('queue');

    b.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(off.setLoop).not.toHaveBeenCalled();
  });

  it('restores autoplay only when it was on', async () => {
    const on = makePlayer({ autoPlay: true });
    const off = makePlayer({ autoPlay: false });
    const a = onePlayer(on);
    const b = onePlayer(off);

    a.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(on.setAutoPlay).toHaveBeenCalledWith(true);

    b.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(off.setAutoPlay).not.toHaveBeenCalled();
  });

  it('re-enables every filter and PUSHES them to the new node', async () => {
    // Enabling them on the client is not enough — the new node has to be told,
    // or the guild moves and loses the EQ it was listening to.
    const player = makePlayer({ filters: { enabled: ['bassboost', 'karaoke'], enable: vi.fn(), apply: vi.fn(async () => undefined) } });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.filters.enable).toHaveBeenCalledWith('bassboost');
    expect(player.filters.enable).toHaveBeenCalledWith('karaoke');
    expect(player.filters.apply).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply anything when there were no filters, so a plain move is not a no-op apply', async () => {
    const player = makePlayer();
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.filters.apply).not.toHaveBeenCalled();
  });

  it('a filter name this build does not know is swallowed, and the position restore still happens', async () => {
    // The documented reason: refusing the whole migration over one bad name
    // would leave the track at 0:00 on the new node. Losing one audio effect is
    // the cheaper degradation, and the next toggle re-applies it.
    const player = makePlayer({
      current: { position: 90_000 },
      filters: {
        enabled: ['a-filter-this-build-does-not-have', 'karaoke'],
        enable: vi.fn((name: string) => {
          if (name === 'a-filter-this-build-does-not-have') throw new Error('unknown filter');
        }),
        apply: vi.fn(async () => undefined),
      },
    });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    // The later filter still went through…
    expect(player.filters.enable).toHaveBeenCalledWith('karaoke');
    // …and the seek below the filter loop still ran.
    expect(player.seek).toHaveBeenCalledWith(90_000);
  });

  it('an apply that REJECTS does not skip the position restore', async () => {
    const player = makePlayer({
      current: { position: 42_000 },
      filters: { enabled: ['karaoke'], enable: vi.fn(), apply: vi.fn(async () => Promise.reject(new Error('rest dead'))) },
    });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.seek).toHaveBeenCalledWith(42_000);
  });

  it('seeks back to the position only past 5s, because a sub-5s position is a start, not a seek', async () => {
    // Seeking to 2s on a new node asks the track to jump backwards and can
    // restart a range request for nothing.
    const near = makePlayer({ current: { position: 2_000 } });
    const far = makePlayer({ current: { position: 200_000 } });
    const a = onePlayer(near);
    const b = onePlayer(far);

    a.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(near.seek).not.toHaveBeenCalled();

    b.manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();
    expect(far.seek).toHaveBeenCalledWith(200_000);
  });

  it('a refused seek-back is swallowed and playback CONTINUES, rather than rejecting the migration', async () => {
    const player = makePlayer({
      current: { position: 120_000 },
      seek: vi.fn(async () => Promise.reject(new Error('track gone'))),
    });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    // The guild is on the new node playing from the start: a real degradation,
    // and the documented alternative was worse.
    expect(player.transferNode).toHaveBeenCalledTimes(1);
  });

  it('a player with no current track is still moved, and is not seeked', async () => {
    const player = makePlayer({ current: null });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledTimes(1);
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('a transfer that REJECTS with a single backup is an ERROR with the guild id, cools the refuser, and tells the guild', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const player = makePlayer({ transferNode: vi.fn(async () => Promise.reject(new Error('voice 400'))) });
    const { manager } = onePlayer(player);
    const notices: Array<{ guildId: string; message: string }> = [];
    manager.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    // Only one backup exists, so no second candidate to try.
    expect(player.transferNode).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[0] as { guildId?: string };
    expect(payload.guildId).toBe('g1');
    // The state restore runs only after a successful transfer, so a rejected
    // transfer must not have re-applied anything to a player that never moved.
    expect(player.setVolume).not.toHaveBeenCalled();
    // The refusing target is re-cooled so searches route past it.
    expect(manager.isNodeCoolingDown('PublicA')).toBe(true);
    // The guild is told instead of sitting in silence on the dead node.
    expect(notices).toHaveLength(1);
    expect(notices[0]!.guildId).toBe('g1');
    expect(notices[0]!.message).toMatch(/could not be moved/);
  });

  it('a throwing notifier never breaks the failover', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const player = makePlayer({ transferNode: vi.fn(async () => Promise.reject(new Error('voice 400'))) });
    const { manager } = onePlayer(player);
    manager.setUnavailableNotifier(() => {
      throw new Error('channel gone');
    });

    expect(() => manager.handleNodeFailover({ identifier: 'Home' } as never)).not.toThrow();
    await settle();

    expect(player.transferNode).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it('a restore step that THROWS is a WARN, not a rejection out of the failover', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const player = makePlayer({
      volume: 50,
      setVolume: vi.fn(() => {
        throw new Error('node gone');
      }),
    });
    const { manager } = onePlayer(player);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(said(warn, 'Failed to restore player state')).toBe(true);
  });

  it('a players registry that throws is an ERROR, never a crash out of an event handler', () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    (manager as unknown as { manager: unknown }).manager = {
      get players(): never {
        throw new Error('moonlink torn down');
      },
    };

    expect(() => manager.handleNodeFailover({ identifier: 'Home' } as never)).not.toThrow();
    expect(said(error, 'Error during node failover')).toBe(true);
  });
});

describe('handleNodeFailover — a refusing backup is retried once, then the guild is told', () => {
  const twoBackups = (player: PlayerDouble) => {
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['First', statNode('First', 0)],
      ['Second', statNode('Second', 1)],
    ]);
    const manager = harness(nodes, [player]);
    return { manager, first: nodes.get('First'), second: nodes.get('Second') };
  };

  it('2-node pool, first transfer rejects: second node tried and state restored there', async () => {
    // The strand: one transferNode refusal left the guild on the dead node.
    // Now the refuser is cooled and the next-healthy node gets one attempt.
    const player = makePlayer({
      volume: 35,
      transferNode: vi
        .fn()
        .mockRejectedValueOnce(new Error('voice 400'))
        .mockResolvedValueOnce(undefined),
    });
    const { manager, first, second } = twoBackups(player);
    const notices: Array<{ guildId: string; message: string }> = [];
    manager.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledTimes(2);
    expect(player.transferNode).toHaveBeenNthCalledWith(1, first);
    expect(player.transferNode).toHaveBeenNthCalledWith(2, second);
    // Refuser cooled so searches and the next failover route past it.
    expect(manager.isNodeCoolingDown('First')).toBe(true);
    expect(manager.isNodeCoolingDown('Second')).toBe(false);
    // Success on retry restores session state and tells nobody.
    expect(player.setVolume).toHaveBeenCalledWith(35);
    expect(notices).toHaveLength(0);
  });

  it('2-node pool, both transfers reject: both cooled, guild told once, ERROR carries guild id', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const player = makePlayer({ transferNode: vi.fn(async () => Promise.reject(new Error('voice 400'))) });
    const { manager, first, second } = twoBackups(player);
    const notices: Array<{ guildId: string; message: string }> = [];
    manager.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    expect(player.transferNode).toHaveBeenCalledTimes(2);
    expect(player.transferNode).toHaveBeenNthCalledWith(1, first);
    expect(player.transferNode).toHaveBeenNthCalledWith(2, second);
    expect(manager.isNodeCoolingDown('First')).toBe(true);
    expect(manager.isNodeCoolingDown('Second')).toBe(true);
    const payload = error.mock.calls[0]?.[0] as { guildId?: string };
    expect(payload.guildId).toBe('g1');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toMatch(/could not be moved/);
    expect(player.setVolume).not.toHaveBeenCalled();
  });

  it('never a third attempt: two refusals stop after the one retry', async () => {
    const player = makePlayer({ transferNode: vi.fn(async () => Promise.reject(new Error('voice 400'))) });
    const nodes = new Map<string, unknown>([
      ['Home', statNode('Home', 1)],
      ['A', statNode('A', 0)],
      ['B', statNode('B', 0)],
      ['C', statNode('C', 0)],
    ]);
    const manager = harness(nodes, [player]);
    manager.setUnavailableNotifier(() => undefined);

    manager.handleNodeFailover({ identifier: 'Home' } as never);
    await settle();

    // "Try the next healthy node once" — not walk the whole pool.
    expect(player.transferNode).toHaveBeenCalledTimes(2);
  });
});

describe('hasHealthyNode / getHealthyNodeCount — what counts as usable', () => {
  it('counts a connected, non-cooling node', () => {
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0)]]));
    expect(manager.hasHealthyNode()).toBe(true);
    expect(manager.getHealthyNodeCount()).toBe(1);
  });

  it('a cooling node is not healthy, however connected it claims to be', () => {
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0)]]));
    manager.noteRestFailure('Home');
    expect(manager.hasHealthyNode()).toBe(false);
    expect(manager.getHealthyNodeCount()).toBe(0);
  });

  it('a disconnected node is not healthy', () => {
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0, { connected: false })]]));
    expect(manager.hasHealthyNode()).toBe(false);
  });

  it('with Lavalink disabled there is never a healthy node, whatever the pool says', () => {
    process.env.ENVIRONMENT = 'local';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    expect(manager.hasHealthyNode()).toBe(false);
    expect(manager.getHealthyNodeCount()).toBe(0);
  });
});

describe('getUnavailableReason — four causes, four different sentences', () => {
  it('"disabled" when the flag is off, and never a wait-the-rate-limit claim', () => {
    // The sentence this replaced told a local user to wait 30-60s for a rate
    // limit that waiting cannot clear.
    process.env.ENVIRONMENT = 'production';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    expect(manager.getUnavailableReason()).toEqual({ reason: 'disabled', retryAfterMs: 0 });
  });

  it('"disconnected" with no retry when the pool is empty', () => {
    const manager = harness(new Map<string, unknown>());
    expect(manager.getUnavailableReason()).toEqual({ reason: 'disconnected', retryAfterMs: 0 });
  });

  it('"disconnected" when nodes exist but none is connected', () => {
    const manager = harness(
      new Map<string, unknown>([['Home', statNode('Home', 0, { connected: false })]]),
    );
    expect(manager.getUnavailableReason().reason).toBe('disconnected');
  });

  it('"rate-limited" carrying the LONGEST live cooldown, not an invented 30-60s', () => {
    // The bug: a real one-hour 4000 reported as "try again in 30-60 seconds",
    // which a user retried and was still blocked.
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0)]]));
    manager.noteRestFailure('Home');

    const reason = manager.getUnavailableReason();

    expect(reason.reason).toBe('rate-limited');
    // 120s, read off the actual cooldown.
    expect(reason.retryAfterMs).toBeGreaterThan(115_000);
    expect(reason.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('picks the longest of SEVERAL cooldowns, so the answer is the real wait', () => {
    const manager = harness(
      new Map<string, unknown>([
        ['A', statNode('A', 0)],
        ['B', statNode('B', 0)],
      ]),
    );
    manager.noteRestFailure('A');
    const inner = (manager as unknown as { nodeCooldownUntil: Map<string, number> }).nodeCooldownUntil;
    inner.set('B', Date.now() + 3_600_000);

    const reason = manager.getUnavailableReason();

    expect(reason.reason).toBe('rate-limited');
    expect(reason.retryAfterMs).toBeGreaterThan(3_500_000);
  });

  it('"disconnected" once the cooldown has expired, not a stale "rate-limited"', () => {
    vi.useFakeTimers();
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0)]]));
    manager.noteRestFailure('Home');
    vi.advanceTimersByTime(200_000);

    expect(manager.getUnavailableReason().reason).toBe('disconnected');
  });

  it('a node that is BOTH connected and cooling reports rate-limited, because the cooldown is the blocker', () => {
    const manager = harness(new Map<string, unknown>([['Home', statNode('Home', 0)]]));
    manager.noteRestFailure('Home');
    const inner = (manager as unknown as { nodeCooldownUntil: Map<string, number> }).nodeCooldownUntil;
    inner.set('Home', Date.now() + 30_000);

    expect(manager.getUnavailableReason()).toMatchObject({ reason: 'rate-limited' });
  });
});

describe('getNodeStats — the shape an operator reads', () => {
  it('reports the real numbers, and labels a cooling node as such', () => {
    const manager = harness(
      new Map<string, unknown>([
        [
          'Home',
          {
            identifier: 'Home',
            host: 'example.com',
            port: 443,
            connected: true,
            ping: 42,
            stats: statsFor(3, { cpu: { systemLoad: 0.2567, lavalinkLoad: 0.5 }, memory: { used: 3 * 1024 * 1024, allocated: 4 * 1024 * 1024 } }),
          },
        ],
        ['Cooling', statNode('Cooling', 0)],
      ]),
    );
    manager.noteRestFailure('Cooling');

    // `getNodeStats` returns a plain array, so `noUncheckedIndexedAccess` makes
    // both elements `LavalinkNodeStats | undefined`. Asserting the length first
    // is the honest narrowing: it is a claim about the two nodes that went in,
    // not a cast that hides a missing one.
    const stats = manager.getNodeStats();
    expect(stats).toHaveLength(2);
    const home = stats[0]!;
    const cooling = stats[1]!;

    expect(home).toEqual({
      identifier: 'Home',
      host: 'example.com',
      port: 443,
      connected: true,
      players: 3,
      playingPlayers: 2,
      // One decimal, from the vendor's own fraction.
      cpuLoad: 25.7,
      lavalinkLoad: 50,
      memoryUsedMb: 3,
      memoryAllocatedMb: 4,
      uptimeMs: 999,
      ping: 42,
    });
    expect(cooling.identifier).toBe('Cooling (cooldown)');
    // Marked disconnected for the operator even though the socket is up.
    expect(cooling.connected).toBe(false);
  });

  it('a node with no stats block reports zeroes rather than undefined', () => {
    // A missing `undefined` in an operator card renders as a broken row.
    const manager = harness(
      new Map<string, unknown>([['Bare', { identifier: 'Bare', host: 'example.com', port: 443, connected: true }]]),
    );

    expect(manager.getNodeStats()[0]).toEqual({
      identifier: 'Bare',
      host: 'example.com',
      port: 443,
      connected: true,
      players: 0,
      playingPlayers: 0,
      cpuLoad: 0,
      lavalinkLoad: 0,
      memoryUsedMb: 0,
      memoryAllocatedMb: 0,
      uptimeMs: 0,
      ping: 0,
    });
  });

  it('a node with no ping reports 0, not NaN', () => {
    const manager = harness(new Map<string, unknown>([['Bare', { identifier: 'Bare', host: 'example.com', port: 443, connected: true }]]));
    expect(Number.isNaN(manager.getNodeStats()[0]!.ping)).toBe(false);
  });

  it('with Lavalink disabled the list is empty rather than a row for the placeholder node', () => {
    process.env.ENVIRONMENT = 'local';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    expect(manager.getNodeStats()).toEqual([]);
  });
});

describe('init() — the handshake with Discord, and its two exit doors', () => {
  const clientDouble = (userId: string | undefined) => ({
    user: userId ? { id: userId } : undefined,
    once: vi.fn(),
  });

  it('is a no-op when Lavalink is disabled, with no Moonlink init at all', async () => {
    process.env.ENVIRONMENT = 'local';
    process.env.ENABLE_LAVALINK = 'false';
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    const initSpy = vi.fn();
    const useSpy = vi.fn();
    (manager as unknown as { manager: unknown }).manager = { init: initSpy, use: useSpy, on: vi.fn() };
    const client = clientDouble('bot-1');

    await manager.init(client as never);

    // Connecting a "disabled" bot to a node would defeat the whole point of
    // the flag, which exists to keep rapid local reloads off public nodes.
    expect(initSpy).not.toHaveBeenCalled();
    expect(useSpy).not.toHaveBeenCalled();
    expect(client.once).not.toHaveBeenCalled();
  });

  it('a client with a user id is initialised immediately', async () => {
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    const initSpy = vi.fn(async () => manager.getManager());
    const useSpy = vi.fn();
    (manager as unknown as { manager: unknown }).manager = { init: initSpy, use: useSpy, on: vi.fn() };

    await manager.init(clientDouble('bot-1') as never);

    expect(useSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith('bot-1');
    expect((manager as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  it('a client with no user id yet waits for ready, then initialises exactly once', async () => {
    // The startup race: the gateway can emit the command before `user` is set,
    // and init() has to happen either way or the bot silently has no music.
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    const initSpy = vi.fn(async () => manager.getManager());
    (manager as unknown as { manager: unknown }).manager = { init: initSpy, use: vi.fn(), on: vi.fn() };
    const client = clientDouble(undefined);

    await manager.init(client as never);

    expect(initSpy).not.toHaveBeenCalled();
    expect(client.once).toHaveBeenCalledWith('ready', expect.any(Function));

    const readyHandler = client.once.mock.calls[0]?.[1] as (c: unknown) => Promise<void>;
    await readyHandler(clientDouble('bot-1'));
    await readyHandler(clientDouble('bot-1'));

    // Once, or two concurrent inits race the same node list.
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('init() twice with a ready client is a no-op the second time', async () => {
    useHomeEnv();
    const manager = new MoonlinkManager();
    liveManagers.push(manager);
    const initSpy = vi.fn(async () => manager.getManager());
    (manager as unknown as { manager: unknown }).manager = { init: initSpy, use: vi.fn(), on: vi.fn() };

    await manager.init(clientDouble('bot-1') as never);
    await manager.init(clientDouble('bot-1') as never);

    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});
