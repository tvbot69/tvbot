import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicEventListeners } from './music/musicEventListeners';
import { Logger } from '@domain/logger';

/**
 * The dead-air invariant.
 *
 * AGENTS.md calls this "the scariest class: no error, just silence". A stall
 * that falls out of the recovery machinery without either advancing playback
 * or leaving a log line produces a channel that simply stops - and INV-5 cannot
 * see it, because INV-5 only fires when a `Track stuck` line is followed by
 * nothing.
 *
 * onTrackStuck has many early returns (seek-stall re-issue, seek-grace hold,
 * song exhausted, duplicate in-flight claim, budget exhausted, alternate found,
 * no alternate, null track). Each is individually reasonable. The risk is
 * cumulative: one of them grows a bare `return` and there is no test that
 * notices, because every existing test asserts only the path it happens to
 * exercise.
 *
 * So this asserts the property across ALL of them, driven through the REAL
 * MusicEventListeners - not a re-implementation. Per AGENTS.md's rule, a test
 * that re-implements the logic it is testing is decoration.
 */

const LOG_INFO = 30;
const LOG_WARN = 40;

interface Captured {
  level: number;
  text: string;
}

const makeTrack = (over: Record<string, unknown> = {}) => ({
  identifier: 'v-stuck',
  encoded: 'enc-stuck',
  uri: 'https://youtube.com/watch?v=stuck0',
  title: 'Stuck Set',
  author: 'DJ',
  duration: 3_600_000,
  ...over,
});

/**
 * A player double that is deliberately uncooperative about one thing: whether
 * the stuck track is still current. `stillCurrent` is what decides between
 * "skip to the alternate" and "play it directly", and a double that always
 * reports "still current" would agree with the code's assumption by accident.
 */
const makePlayer = (opts: {
  current?: unknown;
  store?: Record<string, unknown>;
  live?: boolean;
  playing?: boolean;
  paused?: boolean;
  queueSize?: number;
} = {}) => {
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}));
  const player = {
    guildId: 'g-dead-air',
    node: { identifier: 'node-a' },
    current: opts.current === undefined ? { ...makeTrack(), position: 0 } : opts.current,
    playing: opts.playing ?? true,
    paused: opts.paused ?? false,
    queue: {
      unshift: vi.fn(),
      size: opts.queueSize ?? 1,
      isEmpty: false,
    },
    skip: vi.fn(async () => true),
    play: vi.fn(async () => true),
    seek: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    setVolume: vi.fn(),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
    on: vi.fn(),
  };
  return player;
};

type Player = ReturnType<typeof makePlayer>;

interface HarnessOptions {
  alternate?: unknown;
  songExhausted?: boolean;
  budgetOk?: boolean;
}

const makeHarness = (opts: HarnessOptions = {}) => {
  const inFlight = new Map<string, string>();
  const host = {
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
    frozenPosition: vi.fn(() => 0),
    resumeFallbackAt: vi.fn(async () => undefined),
  };

  const listeners = new MusicEventListeners(
    host as never,
    { getManager: () => ({ on: vi.fn() }) } as never,
    { getQueueInfo: () => null, is247: () => false } as never,
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

describe('onTrackStuck leaves evidence on every path (dead-air invariant)', () => {
  let captured: Captured[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    captured = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      spies.push(
        vi.spyOn(Logger, level).mockImplementation((...args: unknown[]) => {
          // The logger is called as warn(context, 'message'), so the message is
          // the STRING arg - the first arg is the structured context object.
          // Capturing only arg 0 records JSON of the context, never the marker
          // INV-5 greps for, and every assertion below fails for that reason
          // rather than because the behaviour is missing.
          const text = args
            .filter((a): a is string => typeof a === 'string')
            .join(' ');
          captured.push({
            level: { debug: LOG_INFO - 10, info: LOG_INFO, warn: LOG_WARN, error: 50, fatal: 60 }[level],
            text: text || JSON.stringify(args[0] ?? ''),
          });
        }) as never,
      );
    }
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
  });

  const manager = { on: vi.fn(), players: { get: () => undefined } } as never;

  /**
   * The invariant itself. Every path out of onTrackStuck must either advance
   * playback or log. "Neither" is the dead-air failure.
   */
  const expectNoDeadAir = (player: Player, host: ReturnType<typeof makeHarness>['host']) => {
    const advanced =
      player.skip.mock.calls.length > 0 ||
      player.play.mock.calls.length > 0 ||
      player.seek.mock.calls.length > 0 ||
      host.findAlternatePlayableTrack.mock.calls.length > 0;
    const logged = captured.length > 0;
    expect(advanced || logged).toBe(true);
  };

  it('no track at all: logs rather than returning silently', async () => {
    const { listeners, host } = makeHarness();
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, null as never, 10_000);

    expectNoDeadAir(player, host);
    expect(captured.some((c) => c.text.includes('no track'))).toBe(true);
  });

  it('stall right after a user seek: re-issues the seek and says so', async () => {
    const { listeners, host } = makeHarness();
    const player = makePlayer({ store: { lastUserSeekAt: Date.now() - 2_000, lastUserSeekPos: 1_500_000 } });
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(player.seek).toHaveBeenCalledWith(1_500_000);
    // Critically: it must NOT burn fallback budget on a seek-stall.
    expect(host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expectNoDeadAir(player, host);
  });

  it('post-seek stall inside the grace window: holds and logs the cycle', async () => {
    const { listeners, host } = makeHarness();
    const player = makePlayer({
      store: {
        lastUserSeekAt: Date.now() - 3_000,
        lastUserSeekPos: 900_000,
        seekStallRetried: true,
        stuckCount: 2,
      },
    });
    // Long-form live video, so the grace branch applies.
    await listeners.onTrackStuck(manager, player as never, makeTrack({ duration: 3_600_000 }) as never, 10_000);

    expect(host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(captured.some((c) => c.text.includes('grace'))).toBe(true);
    expectNoDeadAir(player, host);
  });

  it('song already exhausted: gives up loudly and skips if it is still current', async () => {
    const { listeners, host } = makeHarness({ songExhausted: true });
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(captured.some((c) => c.text.includes('Giving up'))).toBe(true);
    expectNoDeadAir(player, host);
  });

  it('duplicate in-flight claim: returns without searching twice, and still logs', async () => {
    const { listeners, host, inFlight } = makeHarness();
    inFlight.set('g-dead-air', 'enc-stuck');
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    // The dedupe itself must hold: no second search, no second skip.
    expect(host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
    // ...and the return is not silent. Assert the SPECIFIC marker, not just
    // "something was logged": a neighbouring log line satisfies the weaker
    // check, which is exactly how this test survived mutation before. The
    // dedupe is the one path that legitimately does nothing but return, so its
    // own line is the only evidence the duplicate was dropped on purpose.
    expect(captured.some((c) => c.text.includes('already in flight'))).toBe(true);
    expectNoDeadAir(player, host);
  });

  it('fallback budget exhausted: logs rather than searching anyway', async () => {
    const { listeners, host } = makeHarness({ budgetOk: false });
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(host.findAlternatePlayableTrack).not.toHaveBeenCalled();
    expect(captured.some((c) => c.text.includes('budget'))).toBe(true);
    expectNoDeadAir(player, host);
  });

  it('alternate found: unshift, skip, and resume - all three happen', async () => {
    const alternate = makeTrack({ encoded: 'enc-alt', identifier: 'v-alt' });
    const { listeners, host } = makeHarness({ alternate });
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(host.findAlternatePlayableTrack).toHaveBeenCalledTimes(1);
    expect(player.queue.unshift).toHaveBeenCalledWith(alternate);
    expect(player.skip).toHaveBeenCalledTimes(1);
    expect(host.resumeFallbackAt).toHaveBeenCalledTimes(1);
    expectNoDeadAir(player, host);
  });

  it('the player moved on while the search ran: play the orphan directly', async () => {
    // The uncooperative case. Moonlink stopped the player mid-search, so
    // stillCurrent() is false and a plain skip() would leave the alternate
    // sitting in the queue forever - the exact dead-air this guards.
    const alternate = makeTrack({ encoded: 'enc-alt', identifier: 'v-alt' });
    const { listeners, host } = makeHarness({ alternate });
    const player = makePlayer({ current: { ...makeTrack(), encoded: 'something-else' }, playing: false, paused: false });
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(player.skip).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expectNoDeadAir(player, host);
  });

  it('no alternate exists: logs the "no alternate" line INV-5 needs', async () => {
    const { listeners, host } = makeHarness({ alternate: null });
    const player = makePlayer();
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    // This exact wording is what logInvariants INV-5 looks for. If it changes,
    // the monitor silently stops being able to distinguish "handled" from
    // "dead", so assert on the marker rather than on log count.
    expect(captured.some((c) => c.text.includes('no alternate upload'))).toBe(true);
    expectNoDeadAir(player, host);
  });

  it('releases the in-flight claim even when the search throws', async () => {
    // A stuck claim would wedge the guild permanently: every later stuck track
    // for that player would take the dedupe branch and never be retried, so
    // the channel would just stop - dead air with no error, which is the exact
    // failure this file exists to prevent. Assert the map, not just the throw.
    const { listeners, host, inFlight } = makeHarness();
    host.findAlternatePlayableTrack.mockRejectedValueOnce(new Error('resolver exploded'));
    const player = makePlayer();

    await expect(
      listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000),
    ).rejects.toThrow('resolver exploded');

    expect(host.findAlternatePlayableTrack).toHaveBeenCalledTimes(1);
    expect(inFlight.has('g-dead-air')).toBe(false);
  });

  it('releases the in-flight claim on the success path too', async () => {
    // A claim left behind after a SUCCESSFUL fallback would make the NEXT
    // stuck track - a different one - take the dedupe branch if it happened to
    // share a key, and would double-count against the budget.
    const { listeners, inFlight } = makeHarness({ alternate: makeTrack({ encoded: 'enc-alt' }) });

    await listeners.onTrackStuck(manager, makePlayer() as never, makeTrack() as never, 10_000);

    expect(inFlight.has('g-dead-air')).toBe(false);
  });

  it('a second stuck event for the same track is dropped while the first is in flight', async () => {
    // The real duplicate-event scenario from AGENTS.md: Moonlink raises
    // trackStuck AND trackException for one track. Without the claim, both run
    // identical searches and enqueue the same alternate twice, then skip twice.
    const { listeners, host } = makeHarness({ alternate: null });
    const player = makePlayer();

    // First call claims; hold it open by never resolving the first search.
    let release!: () => void;
    host.findAlternatePlayableTrack.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(null); }),
    );
    const first = listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);
    await Promise.resolve();
    await Promise.resolve();

    // Second event for the SAME track arrives while the first is still working.
    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);
    expect(host.findAlternatePlayableTrack).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('a seek-stall does not consume the fallback budget', async () => {
    // A seek-stall is a range-request failure, not a poison upload. If it
    // burned budget, repeated seeking would silently exhaust the guild's
    // fallback allowance and leave genuinely dead tracks with no recovery.
    const { listeners, host } = makeHarness();
    const player = makePlayer({ store: { lastUserSeekAt: Date.now() - 1_000, lastUserSeekPos: 42_000 } });

    await listeners.onTrackStuck(manager, player as never, makeTrack() as never, 10_000);

    expect(host.checkFallbackBudget).not.toHaveBeenCalled();
    expect(player.seek).toHaveBeenCalledWith(42_000);
  });
});
