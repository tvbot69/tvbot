import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PlayerRegistry,
  isDestroyedPlayer,
  ensureFilterDefinedOn,
  FILTER_DEFINITIONS,
  EQ_EXCLUSIVE_GROUP,
} from '@bot/services/music/musicPlayerRegistry';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { QueueService } from '@bot/services/music/queueService';
import type { FilterName } from '@domain/models/music/musicQueue';
import { HOME_NODE } from '@bot/services/music/youtubeHealth';

/**
 * Player acquisition and creation.
 *
 * The whole module exists because of one failure: handing out a DESTROYED
 * player. A destroyed player stays in moonlink's map until its REST teardown
 * finishes. Hand out that corpse and a `/stop` during an in-flight ladder
 * search lets the search land afterwards — `queue.add` onto the dead player,
 * `play()` reconnects the bot to voice, and a moment later the map entry is
 * deleted, so nothing owned the connection and the bot sat in a channel muted
 * until someone manually disconnected it.
 *
 * The second job: a recreated player must come back with the guild's persisted
 * preferences already applied, because a rejoin / failover / restart should not
 * silently reset volume, loop, autoplay or filters.
 */

const { resolverEnabledFlag } = vi.hoisted(() => ({ resolverEnabledFlag: { value: false } }));

vi.mock('../ytResolver', () => ({ resolverEnabled: () => resolverEnabledFlag.value }));

type Filters = {
  enabled: FilterName[];
  define: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
};

const filters = (over: Partial<Filters> = {}): Filters => ({
  enabled: [],
  define: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  clear: vi.fn(),
  apply: vi.fn(async () => undefined),
  ...over,
});

const player = (over: Record<string, unknown> = {}) => ({
  guildId: 'g-1',
  voiceChannelId: 'vc-1',
  textChannelId: 'tc-1',
  connected: false,
  destroyed: false,
  filters: filters(),
  setLoop: vi.fn(),
  setVoiceChannelId: vi.fn(function (this: { voiceChannelId: string }, id: string) {
    this.voiceChannelId = id;
  }),
  setTextChannelId: vi.fn(function (this: { textChannelId: string }, id: string) {
    this.textChannelId = id;
  }),
  transferNode: vi.fn(async () => undefined),
  ...over,
});

/**
 * Mirrors `GuildMusicPrefs`, which stores `loopMode` and `filters` as plain
 * strings — the registry re-validates neither, which is exactly what the
 * unknown-filter test below depends on. Typing them as `FilterName` here would
 * have made an out-of-range stored name unrepresentable.
 */
type Prefs = { autoplay: boolean; volume: number; loopMode: string; filters: string[] };

const build = (
  opts: {
    existing?: Record<string, unknown> | null;
    created?: Record<string, unknown>;
    prefs?: Partial<Prefs>;
    cooling?: string[];
    playersHasDelete?: boolean;
    resolver?: boolean;
  } = {},
) => {
  const prefs: Prefs = { autoplay: false, volume: 100, loopMode: 'off', filters: [], ...opts.prefs };
  const existing = opts.existing === undefined ? player() : opts.existing;
  const created = opts.created ?? player();
  const players: Record<string, unknown> = {
    get: vi.fn((g: string) => (g === 'g-1' ? existing : undefined)),
    create: vi.fn(() => created),
  };
  if (opts.playersHasDelete !== false) players.delete = vi.fn(() => true);
  const manager = {
    getManager: () => ({ players }),
    isNodeCoolingDown: (id: string) => (opts.cooling ?? []).includes(id),
  };
  const queueService = { getSettings: vi.fn(() => prefs) };
  const registry = new PlayerRegistry(
    manager as unknown as MoonlinkManager,
    queueService as unknown as QueueService,
  );
  return { registry, players, created, prefs, manager, queueService };
};

beforeEach(() => {
  resolverEnabledFlag.value = false;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('isDestroyedPlayer', () => {
  it('is true only for an exactly-destroyed player', () => {
    expect(isDestroyedPlayer({ destroyed: true } as never)).toBe(true);
    expect(isDestroyedPlayer({ destroyed: false } as never)).toBe(false);
    expect(isDestroyedPlayer({} as never)).toBe(false);
  });

  it('a missing player is not "destroyed" — it is absent, and the two read differently', () => {
    expect(isDestroyedPlayer(undefined)).toBe(false);
    expect(isDestroyedPlayer(null)).toBe(false);
  });

  it('a truthy non-boolean destroyed flag is NOT treated as destroyed', () => {
    // `=== true` is load-bearing: a truthy string from some other layer must
    // not make a perfectly good player look like a corpse.
    expect(isDestroyedPlayer({ destroyed: 'true' } as never)).toBe(false);
    expect(isDestroyedPlayer({ destroyed: 1 } as never)).toBe(false);
  });
});

describe('ensureFilterDefinedOn', () => {
  it('registers the custom definition before an enable, because Moonlink does not ship them', () => {
    const p = player();
    ensureFilterDefinedOn(p as never, 'tremolo');
    expect((p.filters.define as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('tremolo');
  });

  it('passes the shape Moonlink expects, for each custom filter', () => {
    const p = player();
    for (const name of Object.keys(FILTER_DEFINITIONS) as FilterName[]) {
      ensureFilterDefinedOn(p as never, name);
    }
    expect((p.filters.define as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(Object.keys(FILTER_DEFINITIONS));
  });

  it('a built-in filter has no custom definition and is not re-registered', () => {
    const p = player();
    ensureFilterDefinedOn(p as never, 'karaoke');
    expect(p.filters.define).not.toHaveBeenCalled();
    ensureFilterDefinedOn(p as never, 'not-a-filter' as FilterName);
    expect(p.filters.define).not.toHaveBeenCalled();
  });

  it('a define that throws is silent — idempotent, and enable decides', () => {
    const p = player({
      filters: filters({
        define: vi.fn(() => {
          throw new Error('already defined');
        }),
      }),
    });
    expect(() => ensureFilterDefinedOn(p as never, 'bassboost')).not.toThrow();
  });
});

describe('the custom filter definitions', () => {
  it('bassboost and audiophile are 15-band equalizers, because Moonlink CONCATENATES the arrays', () => {
    // Two active EQ presets produced 30 band entries, which Lavalink resolves
    // unpredictably — in practice, mud. Hence the exclusive group below.
    for (const name of ['bassboost', 'audiophile'] as FilterName[]) {
      const bands = (FILTER_DEFINITIONS[name] as { equalizer: { gain: number }[] }).equalizer;
      expect(bands).toHaveLength(15);
      for (const band of bands) expect(typeof band.gain).toBe('number');
    }
  });

  it('audiophile is mostly SUBTRACTION — cuts cannot clip, boosts on small drivers do', () => {
    const bands = (FILTER_DEFINITIONS.audiophile as { equalizer: { gain: number }[] }).equalizer;
    const boosts = bands.filter((b) => b.gain > 0).length;
    const cuts = bands.filter((b) => b.gain < 0).length;
    expect(cuts).toBeGreaterThan(boosts);
  });

  it('bassboost lifts the lows and leaves everything above band 3 flat', () => {
    const bands = (FILTER_DEFINITIONS.bassboost as { equalizer: { gain: number }[] }).equalizer;
    expect(bands[0]!.gain).toBeGreaterThan(0);
    expect(bands[4]!.gain).toBe(0);
    expect(bands[14]!.gain).toBe(0);
  });

  it('only the two EQ presets are mutually exclusive', () => {
    expect(EQ_EXCLUSIVE_GROUP).toEqual(['bassboost', 'audiophile']);
  });
});

describe('getPlayer', () => {
  it('hands out a live player', () => {
    const { registry } = build();
    expect(registry.getPlayer('g-1')).not.toBeUndefined();
  });

  it('never hands out a destroyed player, even though the map still lists it', () => {
    const { registry } = build({ existing: player({ destroyed: true }) });
    expect(registry.getPlayer('g-1')).toBeUndefined();
  });

  it('a guild with no player is undefined, not a throw', () => {
    const { registry } = build({ existing: null });
    expect(registry.getPlayer('g-missing')).toBeUndefined();
  });
});

describe('getOrCreatePlayer — existing sessions', () => {
  it('returns the live player without creating or reconfiguring one', async () => {
    const { registry, players } = build({ existing: player({ connected: true }) });
    const p = await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((players.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(p).toMatchObject({ guildId: 'g-1' });
  });

  it('does NOT move a playing session onto Home — failover owns node choice', async () => {
    resolverEnabledFlag.value = true;
    const existing = player({ connected: true, node: { identifier: 'public-1' } });
    const { registry } = build({ existing });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(existing.transferNode).not.toHaveBeenCalled();
  });

  it('does not retarget the voice channel of a live session — it never moves the connection', async () => {
    // Retargeting here made the bot's own bookkeeping lie: the empty-channel
    // timer read the CALLER's channel, so any member could trigger a pause and
    // destroy from an empty one while audio kept playing where the bot was.
    const existing = player({ connected: true, voiceChannelId: 'vc-real' });
    const { registry } = build({ existing });
    await registry.getOrCreatePlayer('g-1', 'vc-someone-else', 'tc-1');
    expect(existing.voiceChannelId).toBe('vc-real');
    expect(existing.setVoiceChannelId).not.toHaveBeenCalled();
  });

  it('retargets a disconnected player, which is safe to do locally', async () => {
    const existing = player({ connected: false, voiceChannelId: 'vc-real' });
    const { registry } = build({ existing });
    await registry.getOrCreatePlayer('g-1', 'vc-other', 'tc-1');
    expect(existing.voiceChannelId).toBe('vc-other');
  });

  it('the card channel is always retargeted, even while live', async () => {
    const existing = player({ connected: true, textChannelId: 'tc-old' });
    const { registry } = build({ existing });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-new');
    // The card channel is a local pointer, unlike the voice connection.
    expect(existing.textChannelId).toBe('tc-new');
  });

  it('does not touch the channels when they already match', async () => {
    const existing = player({ connected: false });
    const { registry } = build({ existing });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(existing.setVoiceChannelId).not.toHaveBeenCalled();
    expect(existing.setTextChannelId).not.toHaveBeenCalled();
  });
});

describe('getOrCreatePlayer — recreating a session', () => {
  it('reapplies the persisted volume, autoplay and self-deaf', async () => {
    const { registry, players } = build({
      existing: null,
      prefs: { autoplay: true, volume: 42, loopMode: 'off', filters: [] },
    });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((players.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      guildId: 'g-1',
      voiceChannelId: 'vc-1',
      textChannelId: 'tc-1',
      autoPlay: true,
      volume: 42,
      selfDeaf: true,
    });
  });

  it('reapplies a non-off loop mode', async () => {
    const created = player();
    const { registry } = build({ existing: null, created, prefs: { loopMode: 'queue' } });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(created.setLoop).toHaveBeenCalledWith('queue');
  });

  it('does not touch loop for the default off', async () => {
    const created = player();
    const { registry } = build({ existing: null, created, prefs: { loopMode: 'off' } });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(created.setLoop).not.toHaveBeenCalled();
  });

  it('an invalid stored loop value is ignored rather than thrown on', async () => {
    const created = player({
      setLoop: vi.fn(() => {
        throw new Error('invalid loop mode');
      }),
    });
    const { registry } = build({ existing: null, created, prefs: { loopMode: 'sideways' } });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
  });

  it('re-enables every persisted filter, after defining the custom ones', async () => {
    const created = player();
    const { registry } = build({
      existing: null,
      created,
      prefs: { filters: ['tremolo', 'bassboost'] },
    });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    // Order is load-bearing: an enable before its define throws `Filter does
    // not exist` on the node.
    expect((created.filters.enable as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(['tremolo', 'bassboost']);
    expect(created.filters.define).toHaveBeenCalledTimes(2);
  });

  it('sanitises stacked EQ presets down to the most recent one', async () => {
    // Settings saved while EQ presets could stack hold both. Sending both to
    // the node concatenates the band arrays — the mud in EQ_EXCLUSIVE_GROUP.
    const created = player();
    const { registry } = build({
      existing: null,
      created,
      prefs: { filters: ['bassboost', 'audiophile'] },
    });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((created.filters.enable as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(['audiophile']);
  });

  it('keeps the FIRST EQ preset when only one is stored', async () => {
    const created = player();
    const { registry } = build({ existing: null, created, prefs: { filters: ['bassboost'] } });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((created.filters.enable as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(['bassboost']);
  });

  it('does not reorder the non-EQ filters around the sanitisation', async () => {
    const created = player();
    const { registry } = build({
      existing: null,
      created,
      prefs: { filters: ['tremolo', 'lowpass', 'bassboost'] },
    });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((created.filters.enable as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(['tremolo', 'lowpass', 'bassboost']);
  });

  it('an unknown persisted filter name is skipped, not thrown on', async () => {
    // A stored name is an arbitrary string, so the node double is typed on
    // `string` and the refusal is a real runtime branch — not a comparison
    // the type checker already ruled impossible.
    const STORED_NOT_A_FILTER = 'not-a-real-filter';
    const created = player({
      filters: filters({
        enable: vi.fn((name: string) => {
          if (name === STORED_NOT_A_FILTER) throw new Error('Filter does not exist');
        }),
      }),
    });
    const { registry } = build({
      existing: null,
      created,
      prefs: { filters: [STORED_NOT_A_FILTER, 'tremolo'] },
    });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
    expect((created.filters.enable as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(['not-a-real-filter', 'tremolo']);
  });

  it('a push to the node that fails costs the effect, not the session', async () => {
    const created = player({ filters: filters({ apply: vi.fn(async () => Promise.reject(new Error('rest dead'))) }) });
    const { registry } = build({ existing: null, created, prefs: { filters: ['tremolo'] } });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
    // Unguarded, this rejection would be unhandled and fatal to the process.
  });
});

describe('getOrCreatePlayer — the destroyed-player guard', () => {
  it('evicts a corpse still sitting in the map before creating', async () => {
    // `players.create` hands the corpse straight back, so without the evict the
    // guild is stuck with an unplayable player until moonlink's own teardown.
    const { registry, players } = build({ existing: player({ destroyed: true }) });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect((players.delete as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('g-1');
    expect((players.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('an older players shape with no delete still creates, letting create decide', async () => {
    const { registry, players } = build({
      existing: player({ destroyed: true }),
      playersHasDelete: false,
    });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
    expect((players.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('a player born already destroyed is refused loudly, not handed out', async () => {
    const { registry } = build({ existing: null, created: player({ destroyed: true }) });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).rejects.toThrow('player-destroyed');
  });
});

describe('getOrCreatePlayer — the Home pin on a fresh player', () => {
  it('pins a fresh player to Home when the resolver is configured', async () => {
    // Local files only exist there, and Home-first is the standing preference.
    resolverEnabledFlag.value = true;
    const created = player();
    const { registry } = build({ existing: null, created });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(created.transferNode).toHaveBeenCalledWith(HOME_NODE);
  });

  it('does NOT pin when the resolver is not configured — Home cannot serve anything', async () => {
    resolverEnabledFlag.value = false;
    const created = player();
    const { registry } = build({ existing: null, created });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(created.transferNode).not.toHaveBeenCalled();
  });

  it('does NOT pin onto a REST-dead Home; the least-load pick stands', async () => {
    resolverEnabledFlag.value = true;
    const created = player();
    const { registry } = build({ existing: null, created, cooling: [HOME_NODE] });
    await registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1');
    expect(created.transferNode).not.toHaveBeenCalled();
  });

  it('a transfer that rejects does not fail the session', async () => {
    resolverEnabledFlag.value = true;
    const created = player({
      transferNode: vi.fn(async () => {
        throw new Error('Home missing');
      }),
    });
    const { registry } = build({ existing: null, created });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
  });

  it('a transfer that rejects without a promise still does not fail the session', async () => {
    resolverEnabledFlag.value = true;
    const created = player({
      transferNode: vi.fn(() => {
        throw new Error('Home missing, synchronously');
      }),
    });
    const { registry } = build({ existing: null, created });
    await expect(registry.getOrCreatePlayer('g-1', 'vc-1', 'tc-1')).resolves.toBeDefined();
  });
});
