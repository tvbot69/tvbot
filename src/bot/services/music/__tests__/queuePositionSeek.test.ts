import { describe, it, expect } from 'vitest';
import { QueueService } from '@bot/services/music/queueService';
import { USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';

/**
 * Regression from a local test log on 2026-09-27, found while reviewing the
 * chapter rewind guard:
 *
 *   [05:46:35] .seek 50:00
 *   [05:46:37] statusText: 'Mac DeMarco - Ode To Viceroy'   (chapter 15, correct)
 *   [05:46:38] Chapter art { idx: 15, ok: true }
 *   [05:46:38] Stale position read — refusing to rewind { from: 15, to: 0,
 *                  positionMs: 15206, committedAt: 3000000 }
 *   ... 13 more, positionMs climbing 15206 -> 19531
 *
 * The seek target was 3,000,000ms. The position reader returned ~15,000ms and
 * counted up from there, because `current.position`/`current.time` belong to
 * moonlink: the node rewrites them from the PRE-seek position for a few seconds
 * after a seek lands. The chapter rewind guard was correctly refusing to act on
 * that value, but the underlying reader was still seek-unaware — which is the
 * "several position readers, none authoritative" problem showing up as a real
 * user-visible symptom.
 */
const makePlayer = (opts: {
  position: number;
  time: number;
  seekAt?: number;
  seekPos?: number;
  playing?: boolean;
  paused?: boolean;
  duration?: number;
}) => {
  const store: Record<string, unknown> = {};
  if (opts.seekAt !== undefined) store.lastUserSeekAt = opts.seekAt;
  if (opts.seekPos !== undefined) store.lastUserSeekPos = opts.seekPos;
  return {
    playing: opts.playing ?? true,
    paused: opts.paused ?? false,
    lastPosition: 0,
    current: { duration: opts.duration ?? 5_950_000, position: opts.position, time: opts.time },
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as never;
};

const service = () => new QueueService({ get: () => null } as never, {} as never);

describe('QueueService.calculatePosition — seek awareness', () => {
  it('trusts a fresh forward seek over moonlink pre-seek position/time', () => {
    const now = Date.now();
    const player = makePlayer({
      // moonlink still reporting the pre-seek clock...
      position: 15_000,
      time: now - 16_000,
      // ...while seek() recorded where the user actually went.
      seekAt: now - 500,
      seekPos: 3_000_000,
    });
    const ms = service().calculatePosition(player);
    // Must be near the seek target, not ~15s.
    expect(ms).toBeGreaterThan(2_990_000);
    expect(ms).toBeLessThan(3_010_000);
  });

  it('keeps counting forward from the seek target while playing', () => {
    const now = Date.now();
    const player = makePlayer({ position: 15_000, time: now - 16_000, seekAt: now - 4000, seekPos: 600_000 });
    const ms = service().calculatePosition(player);
    // ~4s of playback since the seek, not 16s of wall clock from track start.
    expect(ms).toBeGreaterThan(602_000);
    expect(ms).toBeLessThan(606_000);
  });

  it('never rewinds on a stale-but-recent BACKWARD seek (node clock owns that)', () => {
    const now = Date.now();
    // Position is already past the seek target: the node has caught up.
    const player = makePlayer({ position: 900_000, time: now - 1000, seekAt: now - 1000, seekPos: 100_000 });
    const ms = service().calculatePosition(player);
    expect(ms).toBeGreaterThan(890_000);
  });

  it('ignores a seek intent that has gone stale', () => {
    const now = Date.now();
    const player = makePlayer({
      position: 20_000,
      time: now - 1000,
      seekAt: now - USER_SEEK_INTENT_WINDOW_MS - 5000,
      seekPos: 3_000_000,
    });
    // Falls back to the node's own clock.
    expect(service().calculatePosition(player)).toBeLessThan(60_000);
  });

  it('is unaffected when no seek was recorded', () => {
    const now = Date.now();
    const player = makePlayer({ position: 20_000, time: now - 5000 });
    const ms = service().calculatePosition(player);
    expect(ms).toBeGreaterThanOrEqual(24_000);
    expect(ms).toBeLessThan(27_000);
  });

  it('clamps the seek target to the track duration', () => {
    const now = Date.now();
    const player = makePlayer({ position: 0, time: now, seekAt: now, seekPos: 9_999_999, duration: 180_000 });
    expect(service().calculatePosition(player)).toBe(180_000);
  });
});
