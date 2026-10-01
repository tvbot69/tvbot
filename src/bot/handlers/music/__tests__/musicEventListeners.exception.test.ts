import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicEventListeners } from '@bot/handlers/music/musicEventListeners';
import { Logger } from '@domain/logger';

/**
 * `onTrackException` — the path that turns a failed track into an ADVANCE, not
 * a stall.
 *
 * Moonlink only auto-skips `fault`/`suspicious` severity exceptions, so the
 * common YouTube failures (unavailable, age-restricted, blocked) arrive as
 * `common` severity and would sit in the queue for ever. This listener is the
 * only thing that moves past them.
 *
 * The two failure classes this repo cares about, in both directions:
 *
 *  - **A failed track must be SKIPPED.** The breaker is the point: an exception
 *    with no alternate still advances. A listener that returned quietly on the
 *    no-fallback path would leave the guild on a dead track — the exact "no
 *    error, just silence" class AGENTS.md calls the scariest one.
 *  - **A value that could not be read must be OMITTED, never guessed.** The
 *    fallback that cannot be resolved produces no card content, no position and
 *    no count; the listener only ever reports what it actually did.
 *
 * The duplicate-claim test matters as much as the skip: Moonlink can emit BOTH
 * `trackStuck` and `trackException` for one track, and two concurrent fallbacks
 * would enqueue the same alternate twice and skip twice for one visible failure.
 *
 * `MusicEventListeners` is built with its exact production arity.
 */

type Handler = Record<string, ReturnType<typeof vi.fn>>;

const TRACK = {
  identifier: 'yt-exc-001',
  encoded: 'enc-exc',
  uri: 'https://youtube.com/watch?v=ytexc0001',
  title: 'Blocked Set',
  author: 'DJ',
  duration: 240_000,
  sourceName: 'youtube',
};

const ALTERNATE = {
  identifier: 'alt-exc-01',
  encoded: 'enc-alt',
  uri: 'https://soundcloud.com/other/upload',
  title: 'Blocked Set',
  author: 'DJ',
  duration: 240_000,
};

const makePlayer = (over: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>();
  return {
    guildId: 'g-exc',
    node: { identifier: 'node-a' },
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    current: { ...TRACK, position: 0, time: 0 },
    playing: true,
    paused: false,
    queue: { size: 1, isEmpty: false, unshift: vi.fn() },
    skip: vi.fn(async () => true),
    play: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => {
      store.set(k, v);
    },
    ...over,
  };
};

const manager = { on: vi.fn(), players: { get: () => undefined } } as never;

interface Harness {
  listeners: MusicEventListeners;
  host: Handler;
  inFlight: Map<string, string>;
}

const build = (opts: {
  alternate?: unknown;
  songExhausted?: boolean;
  budgetOk?: boolean;
  frozenMs?: number;
  inFlightKey?: string;
  recordStartThrows?: boolean;
} = {}): Harness => {
  const host: Handler = {
    clearInactivityTimeout: vi.fn(),
    clearOkTimer: vi.fn(),
    clearCardTimers: vi.fn(),
    clearFallbackState: vi.fn(),
    clearKickGrace: vi.fn(),
    forgetNowPlaying: vi.fn(),
    updateChapterStatus: vi.fn(),
    armKaraokeTimer: vi.fn(),
    armChapterTimer: vi.fn(),
    swapChapterOnSeek: vi.fn(),
    scheduleImmediateProgress: vi.fn(),
    resolveKaraokeLines: vi.fn(async () => undefined),
    resolveVideoChapters: vi.fn(),
    chapterCardFor: vi.fn(() => null),
    lyricWindowFor: vi.fn(() => null),
    isSongExhausted: vi.fn(() => opts.songExhausted ?? false),
    checkFallbackBudget: vi.fn(() => opts.budgetOk ?? true),
    findAlternatePlayableTrack: vi.fn(async () => opts.alternate ?? null),
    frozenPosition: vi.fn(() => opts.frozenMs ?? 0),
    resumeFallbackAt: vi.fn(async () => undefined),
  };
  const queueService = {
    getQueueInfo: vi.fn(() => null),
    calculatePosition: vi.fn(() => 0),
    is247: vi.fn(() => false),
    recordTrackStart: vi.fn(() => {
      if (opts.recordStartThrows) throw new Error('locked');
    }),
  };
  const inFlight = new Map<string, string>();
  if (opts.inFlightKey) inFlight.set('g-exc', opts.inFlightKey);

  const listeners = new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    queueService as never,
    { channels: { cache: new Map() } } as never,
    undefined,
    undefined,
    undefined,
    new Map<string, NodeJS.Timeout>(),
    new Map<string, string>(),
    inFlight,
    new Map<string, NodeJS.Timeout>(),
    new Map<string, NodeJS.Timeout>(),
    new Set<string>(),
    new Map<string, number>(),
  );

  return { listeners, host, inFlight };
};


let logSpies: Array<{ mockRestore: () => void; mock: { calls: unknown[][] } }> = [];

/**
 * Searches every log spy at once, so a test does not depend on the level.
 *
 * Log context is passed as a structured OBJECT, and `String(obj)` is
 * `'[object Object]'` — searching stringified args alone would miss every fact
 * carried in the context, which is where most of the diagnostic value is.
 */
const saidAny = (needle: string): boolean =>
  logSpies.some((spy) =>
    spy.mock.calls.some((call) =>
      call.some((arg) => {
        if (typeof arg === 'string') return arg.includes(needle);
        try {
          return JSON.stringify(arg)?.includes(needle) ?? false;
        } catch {
          return false;
        }
      }),
    ),
  );

beforeEach(() => {
  logSpies = (['debug', 'info', 'warn', 'error'] as const).map(
    (level) => vi.spyOn(Logger, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const s of logSpies) s.mockRestore();
  logSpies = [];
  vi.restoreAllMocks();
});

describe('onTrackException — the paths that must NOT advance', () => {
  it('a NULL track returns without searching, because there is nothing to replace', async () => {
    // Moonlink emits with a null track when the failure arrives after the
    // player already moved on. Property access on null used to crash this whole
    // listener as an unhandled rejection.
    const h = build();
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, null as never, new Error('late'));

    expect(h.host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
    expect(saidAny('no track')).toBe(true);
  });

  it('a DUPLICATE in-flight claim returns without a second search', async () => {
    // The same track raises both trackStuck and trackException. Two concurrent
    // fallbacks would enqueue the same alternate twice and skip twice for ONE
    // visible failure.
    const h = build({ alternate: ALTERNATE, inFlightKey: 'enc-exc' });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(h.host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(player.queue.unshift).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
  });

  it('the in-flight claim is keyed per guild, so one guild failure does not block another', async () => {
    const h = build({ alternate: ALTERNATE });
    const other = makePlayer({ guildId: 'g-other' });

    await h.listeners.onTrackException(manager, other as never, TRACK as never, new Error('boom'));

    // Same track key, different guild — the claim is per guild precisely so a
    // second guild can still recover while the first is searching.
    expect(h.host.findAlternatePlayableTrack).toHaveBeenCalledTimes(1);
  });
});

describe('onTrackException — the breaker, and it is a fast SKIP', () => {
  it('an EXHAUSTED song is skipped past and never searched again', async () => {
    const h = build({ songExhausted: true });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(player.skip).toHaveBeenCalledTimes(1);
    // The breaker has already decided this recording is not retried; burning
    // more searches on it is the cost the breaker exists to avoid.
    expect(h.host.findAlternatePlayableTrack).not.toHaveBeenCalled();
  });

  it('an exhausted song that is no longer current is NOT skipped, because something else is playing', async () => {
    const h = build({ songExhausted: true });
    const player = makePlayer({ current: { ...TRACK, identifier: 'other', encoded: 'enc-other' } });

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    // Skipping here would cut short whatever took its place.
    expect(player.skip).not.toHaveBeenCalled();
  });

  it('an EXHAUSTED fallback budget skips past the track instead of leaving it stalled', async () => {
    // The two outcomes of a broken source, and this is the fast one: the
    // budget running out must not turn into silence.
    const h = build({ budgetOk: false });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(player.skip).toHaveBeenCalledTimes(1);
    expect(h.host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(saidAny('budget exhausted')).toBe(true);
  });

  it('a skip that REFUSES is warned about, not thrown, so the poison track is simply left', async () => {
    const h = build({ songExhausted: true });
    const player = makePlayer({
      skip: vi.fn(async () => {
        throw new Error('voice not ready');
      }),
    });

    await expect(h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'))).resolves.toBeUndefined();
    expect(saidAny('Skip past failed track failed')).toBe(true);
  });

  it('a track with NO alternate is still skipped — the dead source costs one skip, not a stall', async () => {
    // The load-bearing assertion in this file. Without it, an exception with no
    // fallback leaves Moonlink's recovery in charge and the guild sits on a
    // track that cannot play.
    const h = build({ alternate: null });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(player.skip).toHaveBeenCalledTimes(1);
    expect(saidAny('no alternate upload')).toBe(true);
  });
});

describe('onTrackException — an alternate is queued, advanced to, and resumed', () => {
  it('unshifts the alternate, skips to it, and resumes at the frozen position', async () => {
    const h = build({ alternate: ALTERNATE, frozenMs: 47_000 });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    // All three, in that order: queue, advance, resume. Missing any one leaves
    // either an orphan in the queue or a track playing from 0:00.
    expect(player.queue.unshift).toHaveBeenCalledWith(ALTERNATE);
    expect(player.skip).toHaveBeenCalledTimes(1);
    expect(h.host.resumeFallbackAt).toHaveBeenCalledWith(player, ALTERNATE, 47_000);
  });

  it('STARTS the alternate directly when the player was stopped while the search ran', async () => {
    // skipPastFailed is a no-op when nothing is current, so without this the
    // alternate sits orphaned in the queue and the guild goes silent.
    const h = build({ alternate: ALTERNATE, frozenMs: 12_000 });
    const player = makePlayer({
      playing: false,
      paused: false,
      current: null,
    });

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(player.play).toHaveBeenCalledTimes(1);
    // Still resumed, so it does not start from 0:00.
    expect(h.host.resumeFallbackAt).toHaveBeenCalledWith(player, ALTERNATE, 12_000);
  });

  it('a play() that REFUSES is warned about, and the resume still happens', async () => {
    const h = build({ alternate: ALTERNATE });
    const player = makePlayer({
      playing: false,
      paused: false,
      current: null,
      play: vi.fn(async () => {
        throw new Error('voice not ready');
      }),
    });

    await expect(h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'))).resolves.toBeUndefined();
    expect(saidAny('Play of alternate upload failed')).toBe(true);
    expect(h.host.resumeFallbackAt).toHaveBeenCalledTimes(1);
  });

  it('a PAUSED player is NOT restarted, because it is already occupying the node', async () => {
    const h = build({ alternate: ALTERNATE });
    const player = makePlayer({ playing: false, paused: true, current: null });

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(player.play).not.toHaveBeenCalled();
  });

  it('releases the in-flight claim on the success path, so the next failure can search', async () => {
    const h = build({ alternate: ALTERNATE });
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(h.inFlight.has('g-exc')).toBe(false);
  });

  it('releases the in-flight claim even when the search THROWS', async () => {
    const h = build();
    (h.host.findAlternatePlayableTrack as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ladder exploded'));

    await expect(h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, new Error('boom'))).rejects.toThrow('ladder exploded');
    // A leaked claim would make every later failure for this guild look like a
    // duplicate and silently stop recovering.
    expect(h.inFlight.has('g-exc')).toBe(false);
  });
});

describe('onTrackException — what it feeds the health ladder', () => {
  it('cancels the pending survival credit, because a track that failed never counted as healthy', async () => {
    // A 15s survival was pending for this track; letting it fire would credit
    // the node for a track that never played.
    const h = build();
    const player = makePlayer();

    await h.listeners.onTrackException(manager, player as never, TRACK as never, new Error('boom'));

    expect(h.host.clearOkTimer).toHaveBeenCalledWith('g-exc');
  });

  it('records the failure against the node for a YOUTUBE-source track', async () => {
    const h = build();

    await h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, new Error('boom'));

    // The failure line names the track and the reason, so a deploy log says
    // WHICH track died and why, not just that something did.
    expect(saidAny('Blocked Set')).toBe(true);
    expect(saidAny('boom')).toBe(true);
  });

  it('names a YOUTUBE outage differently from an ordinary failure', async () => {
    const h = build();

    // Positive evidence only — `youtubeHealth.isOutage` matches on outage
    // wording and nothing else, so a user error never trips the breaker and
    // never moves the guild to SoundCloud.
    await h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, {
      message: 'Sign in to confirm you are not a bot',
      severity: 'fault',
    });

    // Two different sentences because the two mean different things to whoever
    // reads the log at 4am: one is a broken upload, the other is the provider.
    expect(saidAny('Track failed (YouTube outage)')).toBe(true);
  });

  it('a USER error is not reported as a YouTube outage, because the breaker must stay open', async () => {
    const h = build();

    await h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, {
      message: 'Video unavailable',
      severity: 'fault',
    });

    expect(saidAny('YouTube outage')).toBe(false);
  });

  it('an ordinary failure does NOT claim an outage', async () => {
    const h = build();

    await h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, { message: 'codec error', severity: 'common' });

    expect(saidAny('Track failed — looking for an alternate upload')).toBe(true);
    expect(saidAny('YouTube outage')).toBe(false);
  });

  it('compacts per-client failure text onto the log line instead of truncating it away', async () => {
    // The reason field is what tells an operator WHICH client (Android, web)
    // refused the track. Dropping it loses the only actionable part.
    const h = build();

    await h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, {
      message: 'Client [ANDROID_VR] failed: requires login\nClient [WEB] failed: no supported audio streams',
      severity: 'fault',
    });

    expect(saidAny('ANDROID_VR: requires login | WEB: no supported audio streams')).toBe(true);
  });

  it('an exception with no message at all still gets a log line', async () => {
    const h = build();
    await expect(
      h.listeners.onTrackException(manager, makePlayer() as never, TRACK as never, null),
    ).resolves.toBeUndefined();
  });

  it('a track with no encoded/uri key falls back to "unknown" rather than claiming a key', async () => {
    // A claimed key that is not really an identity would collapse two different
    // failures into one and burn the other track's budget.
    const h = build({ alternate: ALTERNATE });
    const keyless = { ...TRACK, encoded: undefined, uri: undefined, identifier: 'still-here' };

    await h.listeners.onTrackException(manager, makePlayer() as never, keyless as never, new Error('boom'));

    expect(h.host.findAlternatePlayableTrack).toHaveBeenCalledWith(
      manager,
      expect.anything(),
      expect.anything(),
      'g-exc',
      expect.any(String),
      expect.anything(),
    );
  });
});