import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChapterTimeline } from '@bot/handlers/music/chapterTimeline';
import { QueueService } from '@bot/services/music/queueService';
import { chapterIndexAt } from '@bot/services/music/videoChapters';
import { makeUncooperativePlayer, EVEN_CHAPTERS, type UncooperativePlayer } from './uncooperativePlayer';
import { USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';

/**
 * Invariant test over event SEQUENCES, driving the REAL position reader and
 * the REAL chapter derivation against a deliberately uncooperative node.
 *
 * This replaces the weakness in chapterInvariant.property.test.ts, which
 * re-implemented the indexing locally and so tested a hand-written model. Its
 * own comment conceded it: "the model, not the production code, was wrong."
 * A model-based test stays green while production code is wrong, which is the
 * exact failure mode this session was bitten by three times.
 *
 * Here nothing is re-implemented. `calculatePosition` and `chapterCardFor` are
 * the shipped functions, and the node clock is moved by hand to be wrong on
 * purpose.
 *
 * THE INVARIANT
 * -------------
 * For any sequence of fresh reads, stale reads, drifting clocks and user
 * seeks: the DISPLAYED chapter index never decreases unless a user seek was
 * recorded within the intent window, and a seek lands on exactly the chapter
 * the user asked for.
 *
 * Art is not asserted. A cover that has not resolved yet legitimately holds
 * the previous one, so asserting art here would encode a false invariant.
 */

const CHAPTERS = EVEN_CHAPTERS(8);
const DURATION = 800_000;

const harness = () => {
  const uo: UncooperativePlayer = makeUncooperativePlayer({
    durationMs: DURATION,
    chapters: CHAPTERS,
    clock: { positionMs: 0, time: 1_000_000 },
  });

  const scheduleImmediateProgress = vi.fn();
  const armChapterTimer = vi.fn();
  const timeline = new ChapterTimeline(
    { armChapterTimer, scheduleImmediateProgress },
    { scheduleChapterArtRetry: vi.fn() } as never,
  );
  const queue = new QueueService({ get: () => null } as never, {} as never);

  /** One publish tick: read the position the way production does, derive. */
  const tick = () => {
    const pos = queue.calculatePosition(uo.player);
    return { pos, card: timeline.chapterCardFor(uo.player, pos) };
  };

  return { uo, timeline, queue, tick, scheduleImmediateProgress, armChapterTimer };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('chapter invariant against an uncooperative node (production code)', () => {
  it('a seek to 50:00 shows chapter 5 even while the node still reports 15s', () => {
    const { uo, tick } = harness();
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Start legitimately inside chapter 0.
    uo.nodeCatchesUp(1_000, now);
    tick();

    // The user seeks to 50:00. Production seek() stamps intent first, then
    // awaits the node — so for a few seconds the node lies.
    uo.seekTo(500_000, Date.now());
    const afterSeek = tick();

    expect(chapterIndexAt(CHAPTERS, 500_000)).toBe(5);
    expect(afterSeek.pos).toBeGreaterThanOrEqual(500_000);
    // The card must not be chapter 0 just because the node says 15s.
    expect(uo.read<number>('chapterIdx')).toBe(5);
  });

  it('never rewinds across an interleaving of stale reads, drift and seeks', () => {
    const { uo, tick } = harness();
    let now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    uo.nodeCatchesUp(0, now);
    tick();

    // Deterministic pseudo-random: a fixed LCG so a failure is reproducible.
    let seed = 987654321;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    let highest = uo.displayedIndex();
    // Rewinds that a recorded seek actually authorised. Proving this is
    // non-empty is part of the test: a run that never rewinds would pass the
    // safety assertion vacuously while proving nothing about seeks.
    let authorisedRewinds = 0;

    /** Is the current display explained by a seek inside the intent window? */
    const explainedByFreshSeek = (shown: number) => {
      const seekAt = uo.read<number>('lastUserSeekAt');
      const seekPos = uo.read<number>('lastUserSeekPos');
      return (
        typeof seekAt === 'number' &&
        typeof seekPos === 'number' &&
        now - seekAt < USER_SEEK_INTENT_WINDOW_MS &&
        chapterIndexAt(CHAPTERS, seekPos) === shown
      );
    };

    for (let i = 0; i < 400; i++) {
      now += 1000 + Math.floor(rand() * 4000);
      vi.setSystemTime(now);

      const roll = rand();
      if (roll < 0.12) {
        // A deliberate user seek, forward or backward.
        const target = Math.floor(rand() * 8) * 100_000;
        uo.seekTo(target, now);
        // Node keeps reporting the OLD position for a while afterwards.
        for (let k = 0; k < 3; k++) {
          // Per-tick, not against an all-time watermark: a legitimate backward
          // seek permanently lowers the display, so only a change relative to
          // the immediately preceding tick can be called a rewind.
          const before = uo.displayedIndex();
          tick();
          const after = uo.displayedIndex();
          if (after >= 0 && before >= 0 && after < before) {
            expect(
              explainedByFreshSeek(after),
              `display rewound ${before} -> ${after} with no seek to explain it`,
            ).toBe(true);
            authorisedRewinds++;
          }
        }
        // Then the node finally agrees.
        uo.nodeCatchesUp(target, now);
        const beforeCatchUp = uo.displayedIndex();
        tick();
        const afterCatchUp = uo.displayedIndex();
        if (afterCatchUp >= 0 && beforeCatchUp >= 0 && afterCatchUp < beforeCatchUp) {
          expect(
            explainedByFreshSeek(afterCatchUp),
            `display rewound ${beforeCatchUp} -> ${afterCatchUp} on node catch-up with no seek`,
          ).toBe(true);
          authorisedRewinds++;
        }
      } else if (roll < 0.3) {
        // Stale read: node frozen at an old pre-seek-ish value.
        uo.clock.positionMs = Math.max(0, uo.clock.positionMs - 250_000);
        const before = uo.displayedIndex();
        tick();
        const after = uo.displayedIndex();
        if (after >= 0 && before >= 0 && after < before) {
          expect(
            explainedByFreshSeek(after),
            `stale read rewound ${before} -> ${after} with no seek to explain it`,
          ).toBe(true);
          authorisedRewinds++;
        }
      } else if (roll < 0.4) {
        // Drifting node clock: jumps forward implausibly.
        uo.clock.positionMs = Math.min(DURATION, uo.clock.positionMs + 400_000);
        tick();
      } else {
        // Honest playback.
        uo.advance(3000);
        tick();
      }

      highest = Math.max(highest, uo.displayedIndex());
    }

    // The run must have exercised interesting states, or it proves nothing.
    expect(highest, 'run never advanced past chapter 3').toBeGreaterThan(3);
    expect(authorisedRewinds, 'no rewind was ever authorised, so none was ever tested').toBeGreaterThan(0);
  });

  it('a stale read alone cannot move the displayed chapter backwards', () => {
    const { uo, tick } = harness();
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Legitimately advance to chapter 6.
    uo.nodeCatchesUp(600_000, now);
    tick();
    expect(uo.displayedIndex()).toBe(6);

    // No seek recorded at all. The node now reports a stale early position.
    uo.clock.positionMs = 5_000;
    uo.clock.time = now - 600_000;
    const { card } = tick();

    expect(uo.displayedIndex()).toBe(6);
    expect(card?.title).toBe('Chapter 6');
  });

  it('a deliberate BACKWARD seek is honoured, not treated as stale data', () => {
    const { uo, tick } = harness();
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    uo.nodeCatchesUp(600_000, now);
    tick();
    expect(uo.displayedIndex()).toBe(6);

    // User seeks back to 1:00 — chapter 1. The node still claims 600s.
    uo.seekTo(100_000, now);
    uo.nodeCatchesUp(100_000, now);
    tick();

    expect(uo.displayedIndex()).toBe(1);
  });
});
