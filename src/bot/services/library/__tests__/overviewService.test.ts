import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OverviewService } from '@bot/services/library/overviewService';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { GenreService } from '@bot/services/library/genreService';

/**
 * `OverviewService` turns a user's recent scrobbles into per-day blocks for
 * the overview chart: play counts, listened time, top artist/album/track and
 * top genres.
 *
 * The prisma handle here is a module singleton, not an injected dependency,
 * so the database is replaced at the module boundary rather than through the
 * constructor. Only two models are reachable: `user.findFirst` and
 * `userPlay.findMany`.
 *
 * The early returns are the contract worth pinning, because both of them
 * produce `{ dailyBlocks: [] }` and both are indistinguishable to the caller
 * from "you have not scrobbled". One is "no such user" and one is "no recent
 * plays" - and only the second should have run a play query at all.
 *
 * The other thing worth pinning is that the day bucketing is done in the
 * *user's* timezone. Two plays twenty minutes apart can land in two different
 * blocks, and getting that wrong is a one-hour error in every daily total.
 *
 * THE SILENT-FAILURE CLASS, which was the last query in this file to be
 * converted. The genre batch swallowed its error and fell through, and
 * `overviewBuilders` renders the genre line as
 * `block.genres.length > 0 ? ... : ''` while the footer still advertises
 * "Top genres, artist, album and track". So a dropped connection deleted a
 * clause the card had promised, on all 32 day blocks, and left every other
 * number real - which is exactly the shape a user cannot distrust. The
 * replacement is the PAIR: the failure RAISES, and a map that ran and found no
 * genres for the played artist still yields a block with no genre line.
 */

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  userPlay: { findMany: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

// One `as any` at the boundary so a test can retarget a single query.
// Warn-only rule.
const mockOf = (fn: unknown) => fn as any;

interface PlayRow {
  artistName: string | null;
  albumName: string | null;
  trackName: string | null;
  timePlayed: Date | null;
  msPlayed: number | null;
}

const play = (over: Partial<PlayRow> = {}): PlayRow => ({
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  trackName: 'Airbag',
  timePlayed: new Date('2026-03-10T15:00:00Z'),
  msPlayed: 180000,
  ...over,
});

/** A `timePlayed` offset from an arbitrary anchor, so tests never drift. */
const at = (iso: string) => new Date(iso);

const build = (over: { genreService?: unknown } = {}) => {
  const genreService = (over.genreService ?? {
    getGenresForArtistNames: vi.fn(async () => new Map<string, string[]>()),
  }) as { getGenresForArtistNames: ReturnType<typeof vi.fn> };
  return { service: new OverviewService(genreService as unknown as GenreService), genreService };
};

/** A user row with the fields the service reads, plus a spare for assertions. */
const userRow = (over: Record<string, unknown> = {}) =>
  ({ userId: 1, userNameLastFm: 'DreadRock', timeZone: 'America/New_York', ...over }) as never;

const setPlays = (rows: PlayRow[]) => db.userPlay.findMany.mockResolvedValue(rows);

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue(userRow());
  setPlays([]);
});

// `vi.spyOn(Logger, 'error')` is used in the genre-failure test below, and a spy
// left in place is the exact bug class this repo has been bitten by before:
// `mockRestore()` on a shared module singleton can leave an own property set to
// `undefined`, and every later test then fails silently against it. Restore
// after every test rather than per-test, so a new failure test cannot forget.
// Safe here because `beforeEach` re-arms both module-level doubles every time.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('OverviewService.getOverview - early returns', () => {
  it('returns no blocks when the user is not registered', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const { service } = build();

    await expect(service.getOverview('nobody')).resolves.toEqual({ dailyBlocks: [] });
  });

  it('looks the user up by last.fm username', async () => {
    const { service } = build();

    await service.getOverview('DreadRock');

    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { userNameLastFm: 'DreadRock' } });
  });

  it('does not query plays at all when the user is unknown', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const { service } = build();

    await service.getOverview('nobody');

    expect(db.userPlay.findMany).not.toHaveBeenCalled();
  });

  it('returns no blocks when there are no plays in the window', async () => {
    const { service } = build();

    await expect(service.getOverview('DreadRock')).resolves.toEqual({ dailyBlocks: [] });
  });

  it('returns no blocks for an explicitly null play list', async () => {
    // The guard is `!plays ||`, so a null from the driver is tolerated too.
    db.userPlay.findMany.mockResolvedValue(null);
    const { service } = build();

    await expect(service.getOverview('DreadRock')).resolves.toEqual({ dailyBlocks: [] });
  });

  it('skips the genre lookup when there are no plays', async () => {
    const { service, genreService } = build();

    await service.getOverview('DreadRock');

    expect(genreService.getGenresForArtistNames).not.toHaveBeenCalled();
  });
});

describe('OverviewService.getOverview - the play query', () => {
  it('reads a bounded, ascending, recent window', async () => {
    const { service } = build();
    setPlays([play()]);

    await service.getOverview('DreadRock');

    const args = db.userPlay.findMany.mock.calls[0]![0];
    expect(args.where.userId).toBe(1);
    expect(args.orderBy).toEqual({ timePlayed: 'asc' });
    expect(args.take).toBe(10000);
    expect(args.select).toEqual({
      artistName: true,
      albumName: true,
      trackName: true,
      timePlayed: true,
      msPlayed: true,
    });
  });

  it('asks for a 34-day window, not 33', async () => {
    // The column is misnamed against its value; the extra day is deliberate
    // slack for a partially elapsed boundary day.
    const { service } = build();
    setPlays([play()]);

    await service.getOverview('DreadRock');

    const gte = db.userPlay.findMany.mock.calls[0]![0].where.timePlayed.gte as Date;
    const daysOut = (Date.now() - gte.getTime()) / 86400000;
    expect(daysOut).toBeGreaterThan(33.9);
    expect(daysOut).toBeLessThan(34.1);
  });

  it('propagates a failed user lookup rather than swallowing it', async () => {
    db.user.findFirst.mockRejectedValue(new Error('db down'));
    const { service } = build();

    await expect(service.getOverview('DreadRock')).rejects.toThrow('db down');
  });

  it('propagates a failed play query', async () => {
    db.userPlay.findMany.mockRejectedValue(new Error('db down'));
    const { service } = build();

    await expect(service.getOverview('DreadRock')).rejects.toThrow('db down');
  });
});

describe('OverviewService.getOverview - day bucketing', () => {
  it('produces one block per calendar day in the user timezone', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ timePlayed: at('2026-03-10T16:00:00Z') }),
      play({ timePlayed: at('2026-03-12T15:00:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toHaveLength(2);
    // Newest day first, so index 0 is the single play on the 12th.
    expect(dailyBlocks[0]?.date.toISOString().slice(0, 10)).toBe('2026-03-12');
    expect(dailyBlocks[0]?.playCount).toBe(1);
    expect(dailyBlocks[1]?.date.toISOString().slice(0, 10)).toBe('2026-03-10');
    expect(dailyBlocks[1]?.playCount).toBe(2);
  });

  it('orders the blocks newest day first', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-01T15:00:00Z') }),
      play({ timePlayed: at('2026-03-20T15:00:00Z') }),
      play({ timePlayed: at('2026-03-10T15:00:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    const days = dailyBlocks.map(b => b.date.toISOString().slice(0, 10));
    expect(days).toEqual(['2026-03-20', '2026-03-10', '2026-03-01']);
  });

  it('splits plays that straddle local midnight in the user timezone', async () => {
    // 03:00 and 04:30 UTC on 2026-03-10 are 22:00 on the 9th and 00:30 on the
    // 10th in New York. One calendar day in UTC, two in the user's own day.
    setPlays([
      play({ timePlayed: at('2026-03-10T03:00:00Z') }),
      play({ timePlayed: at('2026-03-10T04:30:00Z') }),
    ]);
    const { service } = build();

    const eastern = await service.getOverview('DreadRock');
    expect(eastern.dailyBlocks).toHaveLength(2);

    db.user.findFirst.mockResolvedValue(userRow({ timeZone: 'UTC' }));
    const utc = await service.getOverview('DreadRock');
    expect(utc.dailyBlocks).toHaveLength(1);
  });

  it('falls back to eastern time when the user has no timezone set', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T03:00:00Z') }),
      play({ timePlayed: at('2026-03-10T04:30:00Z') }),
    ]);
    db.user.findFirst.mockResolvedValue(userRow({ timeZone: null }));
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toHaveLength(2);
  });

  it('survives an unusable timezone instead of throwing', async () => {
    setPlays([play()]);
    db.user.findFirst.mockResolvedValue(userRow({ timeZone: 'Not/AZone' }));
    const { service } = build();

    await expect(service.getOverview('DreadRock')).resolves.toHaveProperty('dailyBlocks');
  });

  it('reports the epoch second of local midnight for each block', async () => {
    setPlays([play({ timePlayed: at('2026-03-10T15:00:00Z') })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');
    const block = dailyBlocks[0]!;

    // 2026-03-10 00:00 in New York is 04:00 UTC: US daylight saving began on
    // 2026-03-08, so the zone is UTC-4 rather than UTC-5. Using a date inside
    // DST is deliberate - a hardcoded -5 would pass all year except these
    // seven months.
    expect(new Date(block.epochSeconds * 1000).toISOString()).toBe('2026-03-10T04:00:00.000Z');
  });

  it('shifts the midnight epoch back an hour outside daylight saving', async () => {
    setPlays([play({ timePlayed: at('2026-01-10T15:00:00Z') })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    // Standard time, so 00:00 EST is 05:00 UTC.
    expect(new Date(dailyBlocks[0]!.epochSeconds * 1000).toISOString()).toBe('2026-01-10T05:00:00.000Z');
  });

  it('ignores plays with no timestamp', async () => {
    setPlays([play(), play({ timePlayed: null })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toHaveLength(1);
    expect(dailyBlocks[0]?.playCount).toBe(1);
  });

  it('returns nothing when every play lacks a timestamp', async () => {
    setPlays([play({ timePlayed: null }), play({ timePlayed: null, trackName: 'Karma Police' })]);
    const { service } = build();

    await expect(service.getOverview('DreadRock')).resolves.toEqual({ dailyBlocks: [] });
  });

  it('keeps at most 32 days, dropping the oldest', async () => {
    // 40 consecutive days ending 2026-03-01, so the 8 oldest fall off the end.
    setPlays(
      Array.from({ length: 40 }, (_, i) =>
        play({ timePlayed: new Date(Date.UTC(2026, 0, 21 + i, 15, 0, 0)) }),
      ),
    );
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toHaveLength(32);
    // 40 consecutive days ending 2026-03-01; the 8 oldest (Jan 21-28) drop.
    expect(dailyBlocks[0]?.date.toISOString().slice(0, 10)).toBe('2026-03-01');
    expect(dailyBlocks[31]?.date.toISOString().slice(0, 10)).toBe('2026-01-29');
  });
});

describe('OverviewService.getOverview - listened time', () => {
  it('sums msPlayed when the scrobble carries it', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T15:00:00Z'), msPlayed: 200000 }),
      play({ timePlayed: at('2026-03-10T15:05:00Z'), msPlayed: 100000, trackName: 'Karma Police' }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.durationMs).toBe(300000);
  });

  it('falls back to the gap to the next play when msPlayed is missing', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T15:00:00Z'), msPlayed: null }),
      play({ timePlayed: at('2026-03-10T15:04:00Z'), msPlayed: null, trackName: 'Karma Police' }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    // 4 minutes of gap, then 180s for the last play which has nothing to
    // measure against.
    expect(dailyBlocks[0]?.durationMs).toBe(240000 + 180000);
  });

  it('uses the 180-second default for a gap outside the 30s-10m window', async () => {
    // A 20-second gap is a skip, not a listen; a 2-hour gap is a session break.
    for (const gapMs of [20000, 2 * 3600 * 1000]) {
      setPlays([
        play({ timePlayed: at('2026-03-10T15:00:00Z'), msPlayed: null }),
        play({ timePlayed: new Date(at('2026-03-10T15:00:00Z').getTime() + gapMs), msPlayed: null }),
      ]);
      const { service } = build();
      const { dailyBlocks } = await service.getOverview('DreadRock');

      expect(dailyBlocks[0]?.durationMs, String(gapMs)).toBe(180000 + 180000);
    }
  });

  it('uses the 180-second default for the final play of a day', async () => {
    setPlays([play({ timePlayed: at('2026-03-10T15:00:00Z'), msPlayed: null })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.durationMs).toBe(180000);
  });

  it('treats a zero msPlayed as missing', async () => {
    setPlays([play({ msPlayed: 0 })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.durationMs).toBe(180000);
  });
});

describe('OverviewService.getOverview - top artist, album and track', () => {
  it('names the most-played artist with a play count', async () => {
    setPlays([
      play({ artistName: 'Portishead', trackName: 'Glory Box', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ artistName: 'Portishead', trackName: 'Wandering Star', timePlayed: at('2026-03-10T15:10:00Z') }),
      play({ artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at('2026-03-10T15:20:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topArtist).toBe('Portishead — *2 plays*');
  });

  it('uses the singular for a one-play artist', async () => {
    setPlays([play({ artistName: 'Radiohead' })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topArtist).toBe('Radiohead — *1 play*');
  });

  it('groups an artist by exact name, so a case variant counts separately', async () => {
    setPlays([
      play({ artistName: 'Radiohead', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ artistName: 'radiohead', timePlayed: at('2026-03-10T15:10:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topArtist).toBe('Radiohead — *1 play*');
  });

  it('reports the top album with its artist', async () => {
    setPlays([
      play({ albumName: 'Dummy', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ albumName: 'Dummy', timePlayed: at('2026-03-10T15:10:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topAlbum).toBe('Radiohead - Dummy — *2 plays*');
  });

  it('reports the top track with its artist', async () => {
    setPlays([
      play({ trackName: 'Airbag', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ trackName: 'Airbag', timePlayed: at('2026-03-10T15:10:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topTrack).toBe('Radiohead - Airbag — *2 plays*');
  });

  it('leaves topAlbum null when no play names one', async () => {
    setPlays([play({ albumName: null, trackName: null })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    // An unnamed album is skipped entirely, so there is no album to rank. A
    // track is always present, though - it falls back to a placeholder.
    expect(dailyBlocks[0]?.topAlbum).toBeNull();
    expect(dailyBlocks[0]?.topTrack).toBe('Radiohead - Unknown Track — *1 play*');
  });

  it('substitutes placeholders for missing artist and track names', async () => {
    setPlays([play({ artistName: null, trackName: null, albumName: null })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.topArtist).toBe('Unknown Artist — *1 play*');
    expect(dailyBlocks[0]?.topTrack).toBe('Unknown Artist - Unknown Track — *1 play*');
    expect(dailyBlocks[0]?.trackKeys).toEqual(['unknown artist|unknown track']);
  });

  it('lower-cases the track keys used for the chart', async () => {
    setPlays([play({ artistName: 'BEACH HOUSE', trackName: 'Space Song' })]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.trackKeys).toEqual(['beach house|space song']);
  });

  it('emits one track key per play, repeats included', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ timePlayed: at('2026-03-10T15:10:00Z') }),
    ]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.trackKeys).toHaveLength(2);
  });
});

describe('OverviewService.getOverview - genres', () => {
  it('batches every distinct artist into one lookup', async () => {
    setPlays([
      play({ artistName: 'Radiohead', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ artistName: 'Radiohead', timePlayed: at('2026-03-10T15:10:00Z') }),
      play({ artistName: 'Portishead', timePlayed: at('2026-03-10T15:20:00Z') }),
    ]);
    const { service, genreService } = build();

    await service.getOverview('DreadRock');

    expect(genreService.getGenresForArtistNames).toHaveBeenCalledTimes(1);
    expect(genreService.getGenresForArtistNames).toHaveBeenCalledWith(['Radiohead', 'Portishead']);
  });

  it('weights genres by how much each artist was played, and keeps three', async () => {
    setPlays([
      play({ artistName: 'A', timePlayed: at('2026-03-10T15:00:00Z') }),
      play({ artistName: 'A', timePlayed: at('2026-03-10T15:10:00Z') }),
      play({ artistName: 'B', timePlayed: at('2026-03-10T15:20:00Z') }),
      play({ artistName: 'C', timePlayed: at('2026-03-10T15:30:00Z') }),
      play({ artistName: 'D', timePlayed: at('2026-03-10T15:40:00Z') }),
    ]);
    const genreService = {
      getGenresForArtistNames: vi.fn(async () => new Map([
        ['a', ['indie', 'rock']],
        ['b', ['indie']],
        ['c', ['trip-hop']],
        ['d', ['ambient']],
      ])),
    };
    const { service } = build({ genreService });

    const { dailyBlocks } = await service.getOverview('DreadRock');

    // A played twice so `indie` and `rock` both score 2; the single-play genres
    // follow in insertion order, and only three are kept.
    expect(dailyBlocks[0]?.genres).toEqual(['indie', 'rock', 'trip-hop']);
  });

  it('looks genres up by lower-cased artist name', async () => {
    setPlays([play({ artistName: 'Radiohead' })]);
    const genreService = {
      getGenresForArtistNames: vi.fn(async () => new Map([['radiohead', ['art rock']]])),
    };
    const { service } = build({ genreService });

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.genres).toEqual(['art rock']);
  });

  it('reports no genres for a miss rather than an empty placeholder list', async () => {
    setPlays([play()]);
    const { service } = build();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.genres).toEqual([]);
  });

  it('raises rather than rendering the overview with its genre line silently dropped', async () => {
    // REPLACED. The assertion used to be a full block with `genres: []`, in a test
    // named 'still returns the blocks when the genre lookup throws' - which pinned
    // the bug exactly. Every other number on that block was real, so the card
    // looked healthy right up to the one clause that had been deleted, and the
    // footer promised "Top genres" the whole time.
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    setPlays([play()]);
    const genreService = {
      getGenresForArtistNames: vi.fn(async () => { throw new Error('genre db down'); }),
    };
    const { service } = build({ genreService });

    const err = await service.getOverview('DreadRock').catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain('overviewService.getOverview');
    expect(error).toHaveBeenCalled();
  });

  it('still returns blocks with no genres when the query RAN and found none', async () => {
    // The other half of the pair. A map that came back without an entry for the
    // played artist is a SUCCESS with a shorter result, so the honest answer is a
    // block whose genre line is absent - not an exception. Asserting only the
    // raise would pass against a service that always threw.
    setPlays([play()]);
    const genreService = {
      // A different artist carries the genres, so the miss is proved to come
      // from the map and not from a lookup that simply never ran.
      getGenresForArtistNames: vi.fn(async () => new Map([['portishead', ['trip-hop']]])),
    };
    const { service } = build({ genreService });

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toHaveLength(1);
    expect(dailyBlocks[0]?.playCount).toBe(1);
    expect(dailyBlocks[0]?.genres).toEqual([]);
  });

  it('works with no genre service at all', async () => {
    setPlays([play()]);
    const service = new OverviewService();

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks[0]?.playCount).toBe(1);
    expect(dailyBlocks[0]?.genres).toEqual([]);
  });

  it('does not consult the service for an unknown user', async () => {
    db.user.findFirst.mockResolvedValue(null);
    const genreService = { getGenresForArtistNames: vi.fn(async () => new Map()) };
    const { service } = build({ genreService });

    await service.getOverview('nobody');

    expect(genreService.getGenresForArtistNames).not.toHaveBeenCalled();
  });

  it('ignores artists with no name when building the batch', async () => {
    setPlays([play({ artistName: null }), play({ artistName: 'Radiohead' })]);
    const { service, genreService } = build();

    await service.getOverview('DreadRock');

    expect(mockOf(genreService.getGenresForArtistNames).mock.calls[0]![0]).toEqual(['Radiohead']);
  });
});

describe('OverviewService.getOverview - full result', () => {
  it('returns one block carrying every field', async () => {
    setPlays([
      play({ timePlayed: at('2026-03-10T15:00:00Z'), msPlayed: 240000 }),
      play({ timePlayed: at('2026-03-10T15:10:00Z'), msPlayed: 240000, trackName: 'Karma Police' }),
    ]);
    const genreService = {
      getGenresForArtistNames: vi.fn(async () => new Map([['radiohead', ['art rock']]])),
    };
    const { service } = build({ genreService });

    const { dailyBlocks } = await service.getOverview('DreadRock');

    expect(dailyBlocks).toEqual([
      {
        date: new Date('2026-03-10T00:00:00Z'),
        epochSeconds: Math.floor(new Date('2026-03-10T04:00:00Z').getTime() / 1000),
        playCount: 2,
        durationMs: 480000,
        topArtist: 'Radiohead — *2 plays*',
        topAlbum: 'Radiohead - OK Computer — *2 plays*',
        topTrack: 'Radiohead - Airbag — *1 play*',
        genres: ['art rock'],
        trackKeys: ['radiohead|airbag', 'radiohead|karma police'],
      },
    ]);
  });

  it('ignores the session key it is handed', async () => {
    setPlays([play()]);
    const { service } = build();

    const withKey = await service.getOverview('DreadRock', 'a-session-key');
    const withoutKey = await service.getOverview('DreadRock');

    expect(withKey).toEqual(withoutKey);
  });
});
