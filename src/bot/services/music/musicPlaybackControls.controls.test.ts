import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { MusicPlaybackControls } from './musicPlaybackControls';
import type { PlayerRegistry } from './musicPlayerRegistry';
import type { QueueService } from './queueService';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';
import type { GuildMusicPrefs } from '@persistence/repositories/guildMusicSettingsRepository';
import type { Player } from 'moonlink.js';
import { SEEK_REST_TIMEOUT_MS } from './musicConstants';

/**
 * Transport controls and the single playback-control policy.
 *
 * Two failure classes this module exists to prevent:
 *
 *  1. A control that reports success it did not have. `pause`, `resume`,
 *     `setFilter` and `seek` each return a boolean or a position, and every
 *     caller turns that into a user-facing sentence. A swallowed REST
 *     rejection is a "Paused!" that did not pause, or an "Applied!" filter
 *     that is still off on the node.
 *  2. A control that DESTRUCTS state before it knows the operation worked.
 *     `previous()` fronts the history track, then discovers skip() refused, and
 *     used to leave both the history and the queue damaged while telling the
 *     user "No previous track in history". Everything here restores.
 */

type Filters = {
  enabled: string[];
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

const makeQueue = () => {
  const tracks: unknown[] = [];
  return {
    tracks,
    get all() {
      return tracks;
    },
    get size() {
      return tracks.length;
    },
    unshift: vi.fn((t: unknown) => {
      tracks.unshift(t);
    }),
    add: vi.fn((t: unknown) => {
      tracks.push(t);
    }),
    remove: vi.fn((i: number) => tracks.splice(i, 1)[0] ?? null),
    shift: vi.fn(() => tracks.shift()),
  };
};

/**
 * The double is built from a typed default and then spread with unchecked
 * overrides, so a test can pass a `queue` that lacks `size` or a `set` that
 * throws without fighting the type of every other field.
 */
type PlayerDouble = {
  guildId: string;
  paused: boolean;
  playing: boolean;
  current: Record<string, unknown> | null;
  previous: unknown[];
  queue: ReturnType<typeof makeQueue>;
  volume: number | undefined;
  loop: string;
  autoPlay: boolean;
  filters: Filters;
  data: Map<string, unknown>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setAutoPlay: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

const makePlayer = (over: Record<string, unknown> = {}): PlayerDouble => {
  const data = new Map<string, unknown>();
  const base = {
    guildId: 'g-1',
    paused: false,
    playing: false,
    current: null,
    previous: [],
    queue: makeQueue(),
    volume: 100,
    loop: 'off',
    autoPlay: false,
    filters: filters(),
    data,
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    skip: vi.fn(async () => true),
    setVolume: vi.fn(),
    setLoop: vi.fn(),
    setAutoPlay: vi.fn(),
    get: vi.fn((k: string) => data.get(k)),
    set: vi.fn((k: string, v: unknown) => {
      data.set(k, v);
    }),
  };
  return { ...base, ...over } as unknown as PlayerDouble;
};

type Built = {
  ctl: MusicPlaybackControls;
  player: PlayerDouble;
  registry: { getPlayer: ReturnType<typeof vi.fn>; ensureFilterDefined: ReturnType<typeof vi.fn> };
  queueService: QueueServiceDouble;
  getQueueInfo: ReturnType<typeof vi.fn>;
};

/**
 * The `QueueService` legs these controls actually call, each typed as the real
 * method it stands in for — a `Record<string, Mock>` double would let a typo
 * read as `undefined` at runtime and pass a test that proves nothing.
 */
type QueueServiceDouble = {
  calculatePosition: Mock<(player: Player) => number>;
  saveSettings: Mock<(guildId: string, partial: Partial<GuildMusicPrefs>) => void>;
  is247: Mock<(guildId: string) => boolean>;
  set247: Mock<(guildId: string, enabled: boolean) => void>;
  isKaraokeEnabled: Mock<(guildId: string) => boolean>;
  toggleKaraoke: Mock<(guildId: string, enabled?: boolean) => boolean>;
};

const build = (opts: { player?: PlayerDouble | null; queueInfo?: MusicQueueInfo | null } = {}): Built => {
  const p = opts.player === undefined ? makePlayer() : opts.player;
  const registry = {
    getPlayer: vi.fn(() => p ?? undefined),
    ensureFilterDefined: vi.fn(),
  };
  const queueService: QueueServiceDouble = {
    calculatePosition: vi.fn(() => 12_000),
    saveSettings: vi.fn(),
    is247: vi.fn(() => false),
    set247: vi.fn(),
    isKaraokeEnabled: vi.fn(() => false),
    toggleKaraoke: vi.fn(() => true),
  };
  const getQueueInfo = vi.fn(() => opts.queueInfo ?? null);
  const ctl = new MusicPlaybackControls(
    registry as unknown as PlayerRegistry,
    queueService as unknown as QueueService,
    getQueueInfo as unknown as (g: string) => MusicQueueInfo | null,
  );
  return { ctl, player: p as PlayerDouble, registry, queueService, getQueueInfo };
};

const NO_PLAYER = { player: null };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pause', () => {
  it('refuses without a player rather than claiming a pause', async () => {
    const { ctl } = build(NO_PLAYER);
    await expect(ctl.pause('g-1')).resolves.toBe(false);
  });

  it('pauses a playing track and reports success', async () => {
    const { ctl, player } = build();
    await expect(ctl.pause('g-1')).resolves.toBe(true);
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('an already-paused player is a no-op success, with no second REST call', async () => {
    const { ctl, player } = build({ player: makePlayer({ paused: true }) });
    await expect(ctl.pause('g-1')).resolves.toBe(true);
    expect(player.pause).not.toHaveBeenCalled();
  });

  it('stamps the position and wall clock before pausing, so resume extrapolates', async () => {
    const { ctl, player } = build();
    player.current = { identifier: 't1', position: 0 };
    await ctl.pause('g-1');
    expect(player.current!.position).toBe(12_000);
    expect(player.current!.time).toBeGreaterThan(0);
  });

  it('a REST refusal is reported as a failure, never swallowed into a "Paused!"', async () => {
    const { ctl } = build({
      player: makePlayer({
        pause: vi.fn(async () => {
          throw new Error('rest dead');
        }),
      }),
    });
    await expect(ctl.pause('g-1')).resolves.toBe(false);
  });
});

describe('resume', () => {
  it('refuses without a player', async () => {
    const { ctl } = build(NO_PLAYER);
    await expect(ctl.resume('g-1')).resolves.toBe(false);
  });

  it('resumes and stamps the wall clock on the current track', async () => {
    const { ctl, player } = build();
    player.current = { identifier: 't1', position: 5_000 };
    await expect(ctl.resume('g-1')).resolves.toBe(true);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(player.current!.time).toBeGreaterThan(0);
  });

  it('a REST refusal is reported as a failure', async () => {
    const { ctl } = build({
      player: makePlayer({
        resume: vi.fn(async () => {
          throw new Error('rest dead');
        }),
      }),
    });
    await expect(ctl.resume('g-1')).resolves.toBe(false);
  });
});

describe('seek', () => {
  const seeking = (over: Record<string, unknown> = {}) =>
    build({
      player: makePlayer({
        current: { identifier: 't1', title: 'Long Show', duration: 3_821_000, isStream: false },
        ...over,
      }),
    });

  it('refuses without a player or without a current track', async () => {
    await expect(build(NO_PLAYER).ctl.seek('g-1', 10)).resolves.toBeNull();
    await expect(build().ctl.seek('g-1', 10)).resolves.toBeNull();
  });

  it('refuses a live stream, instead of jumping it to the start and saying "seeked"', async () => {
    // duration is 0 on a stream, so a clamp against `duration || 0` turned
    // EVERY seek on a stream into a jump to 0 — and still reported success.
    const { ctl, player } = seeking({ current: { identifier: 't1', duration: 0, isStream: true } });
    await expect(ctl.seek('g-1', 650)).resolves.toBeNull();
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('refuses when the duration is unknown, because the target cannot be honoured', async () => {
    const { ctl, player } = seeking({ current: { identifier: 't1', duration: 0, isStream: false } });
    await expect(ctl.seek('g-1', 650)).resolves.toBeNull();
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('returns the position actually applied, so the caller can report the truth', async () => {
    const { ctl, player } = seeking();
    await expect(ctl.seek('g-1', 650)).resolves.toBe(650_000);
    expect(player.seek).toHaveBeenCalledWith(650_000);
  });

  it('clamps to the track end and reports the CLAMPED position, not the request', async () => {
    // The bug this shape invites: "Jumped to 9999 seconds" after jumping to the
    // end of a 63-minute show.
    const { ctl, player } = seeking();
    await expect(ctl.seek('g-1', 9999)).resolves.toBe(3_821_000);
    expect(player.seek).toHaveBeenCalledWith(3_821_000);
  });

  it('a negative request becomes position zero, never a negative offset', async () => {
    const { ctl, player } = seeking();
    await expect(ctl.seek('g-1', -30)).resolves.toBe(0);
    expect(player.seek).toHaveBeenCalledWith(0);
  });

  it('records seek markers BEFORE awaiting the slow REST round-trip', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { ctl, player } = seeking({ seek: vi.fn(() => gate) });
    const pending = ctl.seek('g-1', 650);
    await Promise.resolve();
    // The stall detector reads these; stamping them after the await would make
    // a stalled seek invisible to its own recovery.
    expect(player.data.get('lastUserSeekAt')).toBeGreaterThan(0);
    expect(player.data.get('lastUserSeekPos')).toBe(650_000);
    expect(player.data.get('seekStallRetried')).toBe(false);
    release();
    await expect(pending).resolves.toBe(650_000);
  });

  it('a player whose set() throws still seeks — the metadata is non-critical', async () => {
    const { ctl, player } = seeking({
      set: vi.fn(() => {
        throw new Error('data API is gone');
      }),
    });
    await expect(ctl.seek('g-1', 650)).resolves.toBe(650_000);
    expect(player.seek).toHaveBeenCalledWith(650_000);
  });

  it('a REST that stalls still resolves, so the command never hangs forever', async () => {
    const { ctl } = seeking({ seek: vi.fn(() => new Promise(() => undefined)) });
    await expect(ctl.seek('g-1', 650, 50)).resolves.toBe(650_000);
  });

  it('a REST that rejects still resolves with the applied position', async () => {
    const { ctl } = seeking({
      seek: vi.fn(async () => {
        throw new Error('rest dead');
      }),
    });
    // The event already fired and the clock is pinned server-side; the stalled
    // detector owns recovery, so rejecting here would be a lie too.
    await expect(ctl.seek('g-1', 650)).resolves.toBe(650_000);
  });

  it('does NOT stamp the position onto a DIFFERENT track after a stalled REST', async () => {
    const { ctl, player } = seeking({ seek: vi.fn(() => new Promise(() => undefined)) });
    const pending = ctl.seek('g-1', 650, 50);
    // The track ends and the next one starts while our REST is in flight.
    player.current = { identifier: 't2', title: 'Next Song', duration: 200_000 };
    await expect(pending).resolves.toBe(650_000);
    expect(player.current!.position).toBeUndefined();
  });

  it('stamps the position onto the SAME track once REST settles', async () => {
    const { ctl, player } = seeking();
    await ctl.seek('g-1', 650);
    expect(player.current!.position).toBe(650_000);
    expect(player.current!.time).toBeGreaterThan(0);
  });

  it('the default REST budget is the shared constant, not a per-call literal', () => {
    expect(SEEK_REST_TIMEOUT_MS).toBe(8_000);
  });
});

describe('replay', () => {
  it('seeks to zero and pins the clock, so the card really is at 0:00', async () => {
    const { ctl, player } = build({
      player: makePlayer({ current: { identifier: 't1', duration: 200_000, isStream: false, position: 90_000 } }),
    });
    await expect(ctl.replay('g-1')).resolves.toBe(true);
    expect(player.seek).toHaveBeenCalledWith(0);
    expect(player.current!.position).toBe(0);
  });

  it('refuses on a track that cannot be seeked, rather than claiming a restart', async () => {
    const { ctl } = build({
      player: makePlayer({ current: { identifier: 't1', duration: 0, isStream: true } }),
    });
    await expect(ctl.replay('g-1')).resolves.toBe(false);
  });

  it('refuses without a player', async () => {
    const { ctl } = build(NO_PLAYER);
    await expect(ctl.replay('g-1')).resolves.toBe(false);
  });
});

describe('canControlPlayback — the one policy every surface shares', () => {
  const info = (requesterId?: string): MusicQueueInfo =>
    ({ current: requesterId ? { requester: { id: requesterId } } : undefined }) as unknown as MusicQueueInfo;

  it('the person who queued the current track controls it', () => {
    const { ctl } = build({ queueInfo: info('owner') });
    expect(ctl.canControlPlayback('g-1', 'owner')).toBe(true);
    expect(ctl.canControlPlayback('g-1', 'somebody-else')).toBe(false);
  });

  it('an admin can always recover the bot', () => {
    // The buttons enforced requester-only while NO command did, so any member
    // could stop, clear, mute or skipto a session they had nothing to do with.
    const { ctl } = build({ queueInfo: info('owner') });
    expect(ctl.canControlPlayback('g-1', 'somebody-else', true)).toBe(true);
  });

  it('a track with no requester stays open, or nobody could stop it', () => {
    // Autoplay, 24/7 and a restored session all land here.
    const { ctl } = build({ queueInfo: null });
    expect(ctl.canControlPlayback('g-1', 'anyone')).toBe(true);
  });

  it('a queue read that FAILS does not lock the owner out of their own bot', () => {
    const { ctl, getQueueInfo } = build();
    getQueueInfo.mockImplementation(() => {
      throw new Error('queue service unavailable');
    });
    expect(ctl.canControlPlayback('g-1', 'anyone')).toBe(true);
  });
});

describe('volume', () => {
  it('refuses without a player rather than reporting a volume it did not set', () => {
    const { ctl } = build(NO_PLAYER);
    expect(ctl.setVolume('g-1', 50)).toBeNull();
    expect(ctl.adjustVolume('g-1', -10)).toBeNull();
  });

  it('clamps to 0-150 and persists what it actually set', () => {
    const { ctl, player, queueService } = build();
    expect(ctl.setVolume('g-1', 999)).toBe(150);
    expect(player.setVolume).toHaveBeenCalledWith(150);
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { volume: 150 });
    expect(ctl.setVolume('g-1', -5)).toBe(0);
    expect(player.setVolume).toHaveBeenLastCalledWith(0);
  });

  it('rounds a fractional request, so the card never shows a value it did not set', () => {
    const { ctl, player } = build();
    expect(ctl.setVolume('g-1', 55.6)).toBe(56);
    expect(player.setVolume).toHaveBeenCalledWith(56);
  });

  it('adjusts by a delta from the player, and clamps the result', () => {
    const { ctl, player } = build();
    expect(ctl.adjustVolume('g-1', 10)).toBe(110);
    expect(player.setVolume).toHaveBeenCalledWith(110);
    expect(ctl.adjustVolume('g-1', 1000)).toBe(150);
    expect(ctl.adjustVolume('g-1', -1000)).toBe(0);
  });

  it('an unknown current volume is treated as 100, not as 0', () => {
    // Reading a missing volume as 0 would make `volume +10` mean 10.
    const { ctl } = build({ player: makePlayer({ volume: undefined }) });
    expect(ctl.adjustVolume('g-1', -10)).toBe(90);
  });
});

describe('filters', () => {
  const withFilters = (enabled: string[] = []) =>
    build({ player: makePlayer({ filters: filters({ enabled }) }) });

  it('refuses without a player', async () => {
    const { ctl } = build(NO_PLAYER);
    await expect(ctl.setFilter('g-1', 'tremolo', true)).resolves.toEqual({ applied: false, replaced: [] });
    await expect(ctl.clearFilters('g-1')).resolves.toBe(false);
  });

  it('defines the custom filter before enabling it, because Moonlink does not ship it', async () => {
    const { ctl, registry } = withFilters();
    await expect(ctl.setFilter('g-1', 'tremolo', true)).resolves.toEqual({ applied: true, replaced: [] });
    expect(registry.ensureFilterDefined).toHaveBeenCalledWith(expect.anything(), 'tremolo');
  });

  it('enabling one EQ preset SWITCHES the other off rather than stacking them', async () => {
    // Moonlink CONCATENATES the band arrays, which Lavalink resolves
    // unpredictably — in practice, mud.
    const { ctl, player } = withFilters(['bassboost']);
    const res = await ctl.setFilter('g-1', 'audiophile', true);
    expect(res.replaced).toEqual(['bassboost']);
    expect((player.filters.disable as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('bassboost');
  });

  it('a non-EQ filter never switches another off', async () => {
    const { ctl } = withFilters(['bassboost']);
    await expect(ctl.setFilter('g-1', 'tremolo', true)).resolves.toEqual({ applied: true, replaced: [] });
  });

  it('enabling the EQ preset that is ALREADY on replaces nothing', async () => {
    const { ctl } = withFilters(['audiophile']);
    await expect(ctl.setFilter('g-1', 'audiophile', true)).resolves.toEqual({ applied: true, replaced: [] });
  });

  it('a switch-off that throws still enables the new one, and only claims what really switched off', async () => {
    const { ctl, player } = build({
      player: makePlayer({
        filters: filters({
          enabled: ['bassboost'],
          disable: vi.fn(() => {
            throw new Error('node refused');
          }),
        }),
      }),
    });
    // `replaced` lists only what really was switched off — a claim the user
    // can verify by listening.
    await expect(ctl.setFilter('g-1', 'audiophile', true)).resolves.toEqual({ applied: true, replaced: [] });
    expect((player.filters.enable as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('audiophile');
  });

  it('an enable that throws is reported as not applied, and nothing is persisted', async () => {
    const { ctl, queueService } = build({
      player: makePlayer({
        filters: filters({
          enable: vi.fn(() => {
            throw new Error('Filter does not exist');
          }),
        }),
      }),
    });
    await expect(ctl.setFilter('g-1', 'not-a-filter' as never, true)).resolves.toEqual({ applied: false, replaced: [] });
    expect(queueService.saveSettings).not.toHaveBeenCalled();
  });

  it('an apply that rejects is NOT a success — the user would hear nothing change', async () => {
    const { ctl, queueService } = build({
      player: makePlayer({
        filters: filters({ apply: vi.fn(async () => Promise.reject(new Error('rest dead'))) }),
      }),
    });
    await expect(ctl.setFilter('g-1', 'tremolo', true)).resolves.toEqual({ applied: false, replaced: [] });
    expect(queueService.saveSettings).not.toHaveBeenCalled();
  });

  it('persists the filters the PLAYER reports as on, not the ones that were requested', async () => {
    const { ctl, queueService } = build();
    await ctl.setFilter('g-1', 'tremolo', true);
    // Reading the player back is what keeps a stored preference true; writing
    // the request would drift the moment the node disagreed.
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { filters: [] });
  });

  it('disabling goes through the same apply-before-persist gate', async () => {
    // `disable` here mutates the player's own state, the way Moonlink does, so
    // the persisted preference reflects what is actually on the node.
    const { ctl, player, queueService } = build({
      player: makePlayer({
        filters: filters({
          enabled: ['tremolo'],
          disable: vi.fn(function (this: { enabled: string[] }) {
            this.enabled = [];
          }),
        }),
      }),
    });
    await expect(ctl.setFilter('g-1', 'tremolo', false)).resolves.toEqual({ applied: true, replaced: [] });
    expect((player.filters.disable as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('tremolo');
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { filters: [] });
  });

  it('a disable that throws is reported as not applied', async () => {
    const { ctl } = build({
      player: makePlayer({
        filters: filters({
          disable: vi.fn(() => {
            throw new Error('node refused');
          }),
        }),
      }),
    });
    await expect(ctl.setFilter('g-1', 'tremolo', false)).resolves.toEqual({ applied: false, replaced: [] });
  });

  it('clearFilters empties the node and the stored preference', async () => {
    const { ctl, player, queueService } = withFilters(['tremolo', 'bassboost']);
    await expect(ctl.clearFilters('g-1')).resolves.toBe(true);
    expect(player.filters.clear).toHaveBeenCalledTimes(1);
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { filters: [] });
  });

  it('a clear whose apply rejects is a failure, and is caught rather than unhandled', async () => {
    // Unguarded, this became an UNHANDLED rejection — fatal to the process on
    // Node's default policy — from a command as ordinary as "clear the filters".
    const { ctl, queueService } = build({
      player: makePlayer({
        filters: filters({ apply: vi.fn(async () => Promise.reject(new Error('rest dead'))) }),
      }),
    });
    await expect(ctl.clearFilters('g-1')).resolves.toBe(false);
    expect(queueService.saveSettings).not.toHaveBeenCalled();
  });
});

describe('24/7 and karaoke', () => {
  it('247 toggles from the stored state when no argument is given', () => {
    const { ctl, queueService } = build();
    queueService.is247.mockReturnValue(false);
    expect(ctl.toggle247('g-1')).toBe(true);
    queueService.is247.mockReturnValue(true);
    expect(ctl.toggle247('g-1')).toBe(false);
  });

  it('247 with an explicit argument sets exactly that, without flipping', () => {
    const { ctl, queueService } = build();
    queueService.is247.mockReturnValue(true);
    expect(ctl.toggle247('g-1', true)).toBe(true);
    expect(queueService.set247).toHaveBeenLastCalledWith('g-1', true);
  });

  it('247 works with no player, because it is a guild preference', () => {
    // The registry is never consulted here, so a stopped session can still be
    // re-armed for next time.
    const { ctl } = build(NO_PLAYER);
    expect(ctl.toggle247('g-1', true)).toBe(true);
  });

  it('a karaoke toggle refreshes the card, because the card is event-driven', () => {
    const notify = vi.fn();
    const { ctl, queueService } = build();
    ctl.setKaraokeToggleNotifier(notify);
    queueService.toggleKaraoke.mockReturnValue(true);
    expect(ctl.toggleKaraoke('g-1')).toBe(true);
    expect(notify).toHaveBeenCalledWith('g-1');
  });

  it('a notifier that throws does not undo the toggle', () => {
    const { ctl } = build();
    ctl.setKaraokeToggleNotifier(() => {
      throw new Error('card publish blew up');
    });
    expect(ctl.toggleKaraoke('g-1')).toBe(true);
  });

  it('the stored karaoke state is read back rather than cached', () => {
    const { ctl, queueService } = build();
    queueService.isKaraokeEnabled.mockReturnValue(false);
    expect(ctl.isKaraokeEnabled('g-1')).toBe(false);
    queueService.isKaraokeEnabled.mockReturnValue(true);
    expect(ctl.isKaraokeEnabled('g-1')).toBe(true);
  });
});

describe('loop and autoplay', () => {
  it('loop refuses without a player', () => {
    const { ctl } = build(NO_PLAYER);
    expect(ctl.setLoop('g-1', 'track')).toBeNull();
    expect(ctl.cycleLoop('g-1')).toBeNull();
  });

  it('loop is set and persisted, and the value it returns is the one applied', () => {
    const { ctl, player, queueService } = build();
    expect(ctl.setLoop('g-1', 'queue')).toBe('queue');
    expect(player.setLoop).toHaveBeenCalledWith('queue');
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { loopMode: 'queue' });
  });

  it('cycling walks off -> track -> queue -> off', () => {
    const { ctl, player } = build();
    expect(ctl.cycleLoop('g-1')).toBe('track');
    player.loop = 'track';
    expect(ctl.cycleLoop('g-1')).toBe('queue');
    player.loop = 'queue';
    expect(ctl.cycleLoop('g-1')).toBe('off');
  });

  it('an unrecognised stored loop mode cycles to off, not to something invented', () => {
    const { ctl, player } = build();
    player.loop = 'sideways';
    expect(ctl.cycleLoop('g-1')).toBe('off');
  });

  it('autoplay refuses without a player', () => {
    const { ctl } = build(NO_PLAYER);
    expect(ctl.toggleAutoplay('g-1')).toBeNull();
  });

  it('autoplay toggles from the PLAYER state, not from a cache', () => {
    const { ctl, player, queueService } = build();
    expect(ctl.toggleAutoplay('g-1')).toBe(true);
    expect(player.setAutoPlay).toHaveBeenCalledWith(true);
    expect(queueService.saveSettings).toHaveBeenCalledWith('g-1', { autoplay: true });
    player.autoPlay = true;
    expect(ctl.toggleAutoplay('g-1')).toBe(false);
  });

  it('an explicit autoplay argument sets exactly that', () => {
    const { ctl, player } = build();
    expect(ctl.toggleAutoplay('g-1', false)).toBe(false);
    expect(player.setAutoPlay).toHaveBeenCalledWith(false);
  });
});

describe('previous — restoring both sides of an unsuccessful toggle', () => {
  it('refuses without a player', async () => {
    const { ctl } = build(NO_PLAYER);
    await expect(ctl.previous('g-1')).resolves.toBe(false);
  });

  it('refuses with an empty history, and does not touch the queue', async () => {
    const { ctl, player } = build();
    await expect(ctl.previous('g-1')).resolves.toBe(false);
    expect(player.queue.unshift).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
  });

  it('advances to the history track without re-queueing the current one', async () => {
    // player.skip()/play() already pushes the old current into history, so
    // re-adding it duplicates the queue on EVERY toggle.
    const prev = { identifier: 'prev' };
    const { ctl, player } = build({ player: makePlayer({ current: { identifier: 'cur' }, previous: [prev] }) });
    await expect(ctl.previous('g-1')).resolves.toBe(true);
    expect(player.queue.tracks).toEqual([prev]);
    expect(player.skip).toHaveBeenCalledTimes(1);
  });

  it('a skip that refuses restores the history entry AND removes the duplicate', async () => {
    const prev = { identifier: 'prev' };
    const { ctl, player } = build({
      player: makePlayer({ current: { identifier: 'cur' }, previous: [prev], skip: vi.fn(async () => false) }),
    });
    // The old code lost the history entry and left the track duplicated in the
    // queue, then told the user "No previous track in history".
    await expect(ctl.previous('g-1')).resolves.toBe(false);
    expect(player.previous).toEqual([prev]);
    expect(player.queue.tracks).toEqual([]);
  });

  it('a restore step that throws still returns an honest "could not go back"', async () => {
    const prev = { identifier: 'prev' };
    const { ctl } = build({
      player: makePlayer({
        current: { identifier: 'cur' },
        previous: [prev],
        skip: vi.fn(async () => false),
        queue: {
          unshift: vi.fn(),
          all: prev,
          remove: vi.fn(() => {
            throw new Error('queue is gone');
          }),
        },
      }),
    });
    // Best effort restore on a path that has ALREADY failed: throwing would
    // replace the honest answer with an unhandled rejection.
    await expect(ctl.previous('g-1')).resolves.toBe(false);
  });
});
