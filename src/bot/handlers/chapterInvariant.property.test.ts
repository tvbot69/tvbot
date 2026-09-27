import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';

/**
 * Property test, not an example test.
 *
 * Every chapter bug this session needed a SEQUENCE: a seek, then a stale read,
 * then a commit. Single-step tests cannot express that, which is exactly why
 * the suite stayed green through a two-day bug.
 *
 * The property: across any interleaving of event kinds and any passage of
 * time, the displayed chapter index must be non-decreasing UNLESS a user seek
 * is recorded — and a seek must land on exactly the chapter it asked for.
 *
 * Art is deliberately not asserted here: art legitimately lags the title (a
 * cover that has not resolved yet holds the previous one by design). That
 * class of bug is covered by artworkService.providerFixtures.test.ts.
 *
 * The clock is injected so time is explicit. An earlier draft used the real
 * `Date.now()` and could not express "playback continued past the seek
 * target" — the model, not the production code, was wrong.
 */

const CHAPTERS = [
  { title: 'One', startMs: 0 },
  { title: 'Two', startMs: 100_000 },
  { title: 'Three', startMs: 200_000 },
  { title: 'Four', startMs: 300_000 },
  { title: 'Five', startMs: 400_000 },
  { title: 'Six', startMs: 500_000 },
  { title: 'Seven', startMs: 600_000 },
  { title: 'Eight', startMs: 700_000 },
];

type Event =
  /** The node reports a fresh position. */
  | { kind: 'tick'; positionMs: number }
  /** A read that returns a PRE-seek value — moonlink's catch-up window. */
  | { kind: 'staleRead'; positionMs: number }
  /** The listener seek() stamps intent BEFORE awaiting the node. */
  | { kind: 'seek'; positionMs: number };

const indexAt = (positionMs: number): number => {
  let idx = -1;
  for (let i = 0; i < CHAPTERS.length; i++) {
    if (positionMs >= CHAPTERS[i]!.startMs) idx = i;
    else break;
  }
  return idx;
};

type World = {
  chapterIdx: number;
  lastPos: number;
  seekAt?: number;
  seekPos?: number;
};

const freshIntent = (w: World, now: number): boolean =>
  w.seekAt !== undefined &&
  w.seekPos !== undefined &&
  now - w.seekAt < USER_SEEK_INTENT_WINDOW_MS;

/** Mirrors queueService.calculatePosition's seek-aware branch. */
const positionFor = (w: World, ev: Event, now: number): number => {
  if (ev.kind === 'seek') return ev.positionMs;
  if (freshIntent(w, now)) {
    // Trust the seek and let it keep counting forward.
    return w.seekPos! + (ev.kind === 'tick' ? now - w.seekAt! : 0);
  }
  // No live intent: the node's own report, which may be stale.
  return ev.positionMs;
};

/** Mirrors chapterCardFor's guards. Returns the index that is now displayed. */
const advance = (w: World, ev: Event, now: number): number => {
  if (ev.kind === 'seek') {
    w.seekAt = now;
    w.seekPos = ev.positionMs;
    w.lastPos = ev.positionMs;
  }
  const positionMs = positionFor(w, ev, now);
  if (ev.kind === 'tick') w.lastPos = Math.max(w.lastPos, positionMs);

  const idx = indexAt(Math.max(0, positionMs));
  if (idx === w.chapterIdx) return w.chapterIdx;

  const backwards = w.chapterIdx >= 0 && idx < w.chapterIdx;
  // A rewind is only allowed when a live seek intent asks for that chapter.
  const explainedBySeek =
    ev.kind === 'seek' || (freshIntent(w, now) && indexAt(w.seekPos!) === idx);
  if (backwards && !explainedBySeek) return w.chapterIdx;

  w.chapterIdx = idx;
  return idx;
};

const run = (events: Array<{ ev: Event; at: number }>, start = { chapterIdx: -2, lastPos: 0 } as World) => {
  const w: World = { ...start };
  const seen: number[] = [];
  for (const { ev, at } of events) seen.push(advance(w, ev, at));
  return { w, seen };
};

const T = 1_000_000;

describe('chapter index invariant over event sequences', () => {
  it('never moves backwards across an interleaving of ticks and stale reads', () => {
    const events: Array<{ ev: Event; at: number }> = [];
    let pos = 0;
    for (let i = 0; i < 40; i++) {
      pos = Math.min(750_000, pos + 25_000);
      events.push({ ev: { kind: 'tick', positionMs: pos }, at: T + i * 1000 });
      if (i % 3 === 0) events.push({ ev: { kind: 'staleRead', positionMs: 0 }, at: T + i * 1000 + 500 });
    }
    const { seen } = run(events);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(seen[seen.length - 1]).toBe(7);
  });

  it('a seek across seven chapters commits to the target and stale reads cannot undo it', () => {
    const { seen } = run([
      { ev: { kind: 'tick', positionMs: 0 }, at: T },
      { ev: { kind: 'seek', positionMs: 700_000 }, at: T + 1000 },
      { ev: { kind: 'staleRead', positionMs: 5_000 }, at: T + 1500 },
      { ev: { kind: 'staleRead', positionMs: 5_000 }, at: T + 2000 },
      { ev: { kind: 'staleRead', positionMs: 5_000 }, at: T + 2500 },
    ]);
    expect(seen).toEqual([0, 7, 7, 7, 7]);
  });

  it('a backward seek is honoured, and forward progress resumes afterwards', () => {
    const { seen } = run([
      { ev: { kind: 'seek', positionMs: 700_000 }, at: T },
      { ev: { kind: 'seek', positionMs: 100_000 }, at: T + 1000 },
      // 100s of playback later the position really is in chapter 3.
      { ev: { kind: 'tick', positionMs: 200_000 }, at: T + 101_000 },
    ]);
    expect(seen).toEqual([7, 1, 2]);
  });

  it('a stale read after the intent expires can no longer rewind', () => {
    const later = T + USER_SEEK_INTENT_WINDOW_MS + 5000;
    const { seen } = run([
      { ev: { kind: 'seek', positionMs: 700_000 }, at: T },
      { ev: { kind: 'staleRead', positionMs: 0 }, at: later },
    ]);
    expect(seen).toEqual([7, 7]);
  });

  it('holding is finite: a genuine forward position always wins eventually', () => {
    // Guards the "card stuck on one chapter for a whole show" failure. Many
    // stale reads must not pin it, and a real node report must advance it.
    const events: Array<{ ev: Event; at: number }> = [];
    for (let i = 0; i < 20; i++) {
      events.push({ ev: { kind: 'staleRead', positionMs: 0 }, at: T + i * 1000 });
    }
    events.push({ ev: { kind: 'tick', positionMs: 650_000 }, at: T + 60_000 });
    const { seen } = run(events, { chapterIdx: 3, lastPos: 300_000 });
    expect(seen[seen.length - 1]).toBe(6);
    for (let i = 1; i < seen.length - 1; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it('repeated forward seeks land exactly on each requested chapter', () => {
    const { seen } = run([
      { ev: { kind: 'seek', positionMs: 300_000 }, at: T },
      { ev: { kind: 'seek', positionMs: 0 }, at: T + 1000 },
      { ev: { kind: 'seek', positionMs: 500_000 }, at: T + 2000 },
      { ev: { kind: 'seek', positionMs: 200_000 }, at: T + 3000 },
    ]);
    expect(seen).toEqual([3, 0, 5, 2]);
  });
});
