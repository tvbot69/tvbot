/**
 * `getCurrentStreak` used to reset `artistPlaycount = 0` BEFORE the deeper
 * lookup's loop and swallow any error from it. The deeper lookup only runs once
 * the Last.fm count hits its 50-track ceiling, so the case that mattered was
 * exactly the case that broke: a user with a streak longer than 50 plays. A
 * dropped connection did not merely fail to improve the number - it destroyed
 * the 50 that had already been measured, and `streakBuilders` then rendered
 * "No active streak found." to someone with a 500-play streak.
 *
 * The Last.fm count is a real measurement, merely a CAPPED one, so on failure
 * the correct behaviour is to keep it and say so, not to substitute 0. These
 * tests drive the real service rather than reimplementing the loop, because a
 * model-based test here would pass just as happily against the broken code.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreakService, getEmojiForStreakCount } from './streakService';

const db = vi.hoisted(() => ({
  userPlay: { findMany: vi.fn() },
  artist: { findFirst: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

const track = (artistName: string, name: string, albumName: string | null, t: string) => ({
  artistName,
  name,
  albumName,
  timePlayed: new Date(t),
  imageUrl: '',
});

/** 50 consecutive plays of the same artist - the Last.fm ceiling case. */
const fiftyStreak = () =>
  Array.from({ length: 50 }, (_, i) =>
    track('Radiohead', 'Airbag', 'OK Computer', `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`),
  );

const build = (recent: unknown[]) =>
  new StreakService({ getUserRecentTracks: vi.fn(async () => recent) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  db.artist.findFirst.mockResolvedValue(null);
  db.userPlay.findMany.mockResolvedValue([]);
});

describe('StreakService.getCurrentStreak — a failed deeper lookup must not erase a real streak', () => {
  it('keeps the Last.fm count when the database is unreachable', async () => {
    db.userPlay.findMany.mockRejectedValue(new Error("Can't reach database server"));

    const streak = await build(fiftyStreak()).getCurrentStreak(1, 'DreadRock');

    // The load-bearing assertion. The old code returned 0 here, which made
    // streakBuilders report "No active streak found."
    expect(streak?.artistPlaycount).toBe(50);
  });

  it('still counts deeper when the lookup succeeds', async () => {
    db.userPlay.findMany.mockResolvedValue([
      { artistName: 'Radiohead', timePlayed: new Date('2023-06-01T00:00:00Z') },
      { artistName: 'Radiohead', timePlayed: new Date('2023-05-01T00:00:00Z') },
      { artistName: 'Muse', timePlayed: new Date('2023-04-01T00:00:00Z') },
    ]);

    const streak = await build(fiftyStreak()).getCurrentStreak(1, 'DreadRock');

    expect(streak?.artistPlaycount).toBe(2);
    // The deeper lookup also extends the start date, which the old
    // partial-update-on-error path could leave inconsistent with the count.
    expect(streak?.streakStarted.toISOString()).toBe(new Date('2023-05-01T00:00:00Z').toISOString());
  });

  it('reports a real zero when the deeper lookup runs and finds nothing', async () => {
    db.userPlay.findMany.mockResolvedValue([]);

    const streak = await build(fiftyStreak()).getCurrentStreak(1, 'DreadRock');

    // A query that RAN and found no matching plays is a truthful zero. This is
    // the direction that must not change, and it is why the fix is not simply
    // "never reset the count".
    expect(streak?.artistPlaycount).toBe(0);
  });

  it('does not attempt the deeper lookup below the Last.fm ceiling', async () => {
    const three = [
      track('Radiohead', 'Airbag', 'OK Computer', '2024-03-03T00:00:00Z'),
      track('Radiohead', 'Karma Police', 'OK Computer', '2024-03-02T00:00:00Z'),
      track('Radiohead', 'Creep', 'Pablo Honey', '2024-03-01T00:00:00Z'),
    ];

    const streak = await build(three).getCurrentStreak(1, 'DreadRock');

    expect(streak?.artistPlaycount).toBe(3);
    expect(db.userPlay.findMany).not.toHaveBeenCalled();
  });

  it('omits the genre line when the genre lookup fails', async () => {
    db.artist.findFirst.mockRejectedValue(new Error('relation "artists" does not exist'));

    const streak = await build(fiftyStreak()).getCurrentStreak(1, 'DreadRock');

    // Genre is enrichment; the streak is the answer. Losing the whole streak to
    // a missing genre join would be a worse regression than the one being fixed.
    // (artistPlaycount is 0 here because the deeper lookup RAN and found no
    // plays - that is a truthful zero, covered by its own test above.)
    expect(streak?.genreName).toBeNull();
  });

  it('omits the genre line while keeping a DEEPER streak when only the genre lookup fails', async () => {
    // The case where the deeper lookup succeeded, so the streak number is not
    // 50 and the assertion above would pass for the wrong reason.
    db.userPlay.findMany.mockResolvedValue([
      { artistName: 'Radiohead', timePlayed: new Date('2023-05-01T00:00:00Z') },
      { artistName: 'Radiohead', timePlayed: new Date('2023-04-01T00:00:00Z') },
    ]);
    db.artist.findFirst.mockRejectedValue(new Error('relation "artists" does not exist'));

    const streak = await build(fiftyStreak()).getCurrentStreak(1, 'DreadRock');

    expect(streak?.genreName).toBeNull();
    expect(streak?.artistPlaycount).toBe(2);
  });
});

describe('getEmojiForStreakCount', () => {
  it('returns null below the threshold and an emoji at it', () => {
    expect(getEmojiForStreakCount(0)).toBeNull();
    expect(getEmojiForStreakCount(100)).toBe('💯');
  });

  it('gives a 500-play streak a real streak emoji, and a failed one nothing', () => {
    // Documents the user-visible consequence directly. The old bug left
    // artistPlaycount at 0, and 0 has no emoji AND fails the builder's
    // `> 1` check, so the whole streak section disappeared.
    expect(getEmojiForStreakCount(500)).toBe('🔥');
    expect(getEmojiForStreakCount(0)).toBeNull();
  });
});