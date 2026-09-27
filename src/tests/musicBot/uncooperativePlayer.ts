import type { Player } from 'moonlink.js';

/**
 * A DELIBERATELY UNCOOPERATIVE Moonlink player double.
 *
 * Why this exists
 * ---------------
 * Every other player double in this suite behaves the way our own code
 * assumes the node behaves. That is the exact cooperation that hid a
 * two-day production bug:
 *
 *   [05:46:35] .seek 50:00
 *   [05:46:37] statusText: 'Mac DeMarco - Ode To Viceroy'   (chapter 15, correct)
 *   [05:46:38] Stale position read - refusing rewind { from: 15, to: 0,
 *                  positionMs: 15206, committedAt: 3000000 }
 *
 * The bug was that `current.position`/`current.time` belong to moonlink, and
 * the node rewrites them from the PRE-seek position for several seconds after
 * a seek lands. Every double set `position` to the value the code expected,
 * so the code's wrong assumption and the double's cooperation cancelled out
 * and 935 tests stayed green while the card snapped back to chapter 0.
 *
 * This double removes that safety net on purpose. It is driven by an explicit
 * `NodeClock` the test moves by hand, so a test can say "the node is still
 * reporting the old position" and mean it.
 *
 * It is NOT a general-purpose mock. Use a plain literal in tests that are not
 * about position trust; use THIS one when the test is about what happens when
 * the node disagrees with us.
 */

/** The node's view of time — the part we do not control and must not trust. */
export interface NodeClock {
  /** What `current.position` reports, in ms. */
  positionMs: number;
  /** What `current.time` reports (epoch ms) — node clock, not wall clock. */
  time: number;
}

export interface UncooperativePlayerOptions {
  durationMs?: number;
  playing?: boolean;
  paused?: boolean;
  /** Starting node clock. Defaults to a sane 0. */
  clock?: Partial<NodeClock>;
  /** Chapters to seed into the store under `chapters`. */
  chapters?: { title: string; startMs: number }[];
  /** Seed a displayed card, so the "hold the last cover" path is reachable. */
  chapterCard?: { title: string; artworkUrl?: string | null } | null;
}

export interface UncooperativePlayer {
  player: Player;
  /** The node's clock. Move it directly to simulate lag, freezing or drift. */
  clock: NodeClock;
  /**
   * Record a user seek the way production `seek()` does: stamp the intent
   * BEFORE awaiting the node. This is what makes a deliberate seek
   * distinguishable from a stale read.
   */
  seekTo(positionMs: number, now: number): void;
  /**
   * Let the node catch up: move its clock to `positionMs`. Models the node
   * finally agreeing with reality, several seconds after the seek.
   */
  nodeCatchesUp(positionMs: number, time: number): void;
  /** Advance the node clock as real playback would. */
  advance(ms: number): void;
  read<T>(key: string): T | undefined;
  write(key: string, value: unknown): void;
  /** The chapter index currently DISPLAYED, per the production store. */
  displayedIndex(): number;
}

export const makeUncooperativePlayer = (
  opts: UncooperativePlayerOptions = {},
): UncooperativePlayer => {
  const store: Record<string, unknown> = {};
  const clock: NodeClock = {
    positionMs: opts.clock?.positionMs ?? 0,
    time: opts.clock?.time ?? 0,
  };
  const duration = opts.durationMs ?? 3_600_000;
  const playing = opts.playing ?? true;
  const paused = opts.paused ?? false;

  if (opts.chapters) store.chapters = opts.chapters;
  if (opts.chapterCard !== undefined) store.chapterCard = opts.chapterCard;
  // -2 is the production "nothing derived yet" sentinel.
  store.chapterIdx = -2;

  const player = {
    guildId: '100000000000000001',
    playing,
    paused,
    lastPosition: 0,
    // The single most important line in this file: `position` and `time` come
    // from the node clock, NOT from any recorded seek intent.
    current: {
      duration,
      get position() {
        return clock.positionMs;
      },
      get time() {
        return clock.time;
      },
    },
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as Player;

  return {
    player,
    clock,
    seekTo(positionMs: number, now: number) {
      // Intentionally does NOT touch clock.positionMs. The node still believes
      // it is playing the old position; that disagreement is the whole point.
      store.lastUserSeekAt = now;
      store.lastUserSeekPos = positionMs;
    },
    nodeCatchesUp(positionMs: number, time: number) {
      clock.positionMs = positionMs;
      clock.time = time;
    },
    advance(ms: number) {
      clock.positionMs = Math.min(duration, clock.positionMs + ms);
      clock.time += ms;
    },
    read<T>(key: string) {
      return store[key] as T | undefined;
    },
    write(key: string, value: unknown) {
      store[key] = value;
    },
    displayedIndex() {
      return (store.chapterIdx as number | undefined) ?? -2;
    },
  };
};

/**
 * A chapter list with even 100s spacing — the shape a real DJ set produces,
 * and dense enough that a stale read lands on a visibly different chapter.
 */
export const EVEN_CHAPTERS = (count: number, stepMs = 100_000) =>
  Array.from({ length: count }, (_, i) => ({ title: `Chapter ${i}`, startMs: i * stepMs }));
