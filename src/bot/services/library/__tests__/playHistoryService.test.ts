/**
 * `getYearOverview` used to run six raw queries, each with `.catch(() => [])`
 * on the promise, so a database outage rendered as a year of zero plays, zero
 * artists, an empty top ten and a flat twelve-month chart - byte-identical to a
 * user who genuinely never pressed play in that year. Both callers then took
 * the `totalPlays === 0` branch and told the user "No plays found in 2023 for
 * <name>".
 *
 * That is the worst failure shape available: a confident wrong answer the user
 * has no way to distrust, and a chart that looks like a data-integrity result
 * rather than an outage. `lastFmRepository` had already solved the same problem
 * for Last.fm with `orUnavailable` + `LastFmUnavailableError`; this file locks
 * the same behaviour for our own Postgres.
 *
 * Both directions are asserted. A test that only checks "it throws now" passes
 * just as happily against a method that always throws, which would trade one
 * wrong answer for the other - so the empty-year case is pinned here too.
 *
 * The database is mocked, not connected: this is about the contract of the
 * failure path. The SQL itself is covered by `playHistoryService.db.test.ts`,
 * which needs a real Postgres to be worth anything.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PlayHistoryService } from '@bot/services/library/playHistoryService';
import { Logger } from '@domain/logger';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { isLastFmUnavailable } from '@domain/models/lastfmUnavailableError';

/** Prisma 5xx / driver-level connectivity failure, the realistic shape. */
const DB_DOWN = () => new Error("Can't reach database server at `host.docker.internal:5432`");

const ROWS = {
  topArtists: [{ artist_name: 'Radiohead', playcount: 3n }],
  topTracks: [{ track_name: 'Airbag', artist_name: 'Radiohead', playcount: 3n }],
  topAlbums: [{ album_name: 'OK Computer', artist_name: 'Radiohead', playcount: 3n }],
  totals: [{ total_plays: 3n, total_artists: 1n }],
  previousYearTotals: [{ total_plays: 1n }],
  monthlyBreakdown: [{ month: 5, count: 3n }],
};

/**
 * The six queries in the order `getYearOverview` issues them. Indexed so a test
 * can name the ONE that fails - the interesting cases are partial failures, not
 * a dead database, because a dead database would still have been caught by
 * `.catch` on the first query alone.
 */
const QUERY_ORDER = [
  'topArtists',
  'topTracks',
  'topAlbums',
  'totals',
  'previousYearTotals',
  'monthlyBreakdown',
] as const;

type QueryName = (typeof QUERY_ORDER)[number];

/**
 * A `$queryRawUnsafe` double that answers each of the six queries in order and
 * can be told to fail exactly one of them. Partial failures are the interesting
 * case: a dead database would have been caught by the first `.catch` anyway.
 */
const makeDb = (failAt: QueryName | null = null) => {
  const state = { calls: 0 };
  const query = vi.fn(async () => {
    const name = QUERY_ORDER[state.calls];
    state.calls += 1;
    if (name !== undefined && name === failAt) throw DB_DOWN();
    return ROWS[name as QueryName];
  });
  return { query, state };
};

const makeService = (db: { query: unknown }) =>
  new PlayHistoryService(
    {} as never,
    {} as never,
    { $queryRawUnsafe: db.query } as unknown as PrismaClient,
  );

/** A prisma double where exactly one named query rejects. */
const makeServiceFailingAt = (name: QueryName) => {
  const db = makeDb(name);
  return { service: makeService(db), db };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlayHistoryService.getYearOverview — a dead database is not a year of zeros', () => {
  it('raises instead of rendering zeros when the first query fails', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service, db } = makeServiceFailingAt('topArtists');

    // The old code returned `{ totalPlays: 0, topArtists: [], monthlyPlays:
    // [0 x 12] }` here, and both callers rendered "No plays found in 2023".
    await expect(service.getYearOverview(1, 2023)).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(error).toHaveBeenCalled();
    // Exactly one query ran. The old code issued all six and discarded five of
    // the results, so a failure was paid for in six round-trips and reported as
    // nothing at all.
    expect(db.state.calls).toBe(1);
  });

  it('raises when only the totals query fails, even though the others succeeded', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service } = makeServiceFailingAt('totals');

    // This is the load-bearing one. `totals` is the only query that produces
    // `totalPlays`, and `totalPlays === 0` is the exact condition both callers
    // use to declare the year empty. A failure here that degrades to 0 is
    // indistinguishable from the truthful answer.
    await expect(service.getYearOverview(1, 2023)).rejects.toThrow(/totals/);
  });

  it('raises when only the final monthly query fails, so a partial chart cannot render', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service, db } = makeServiceFailingAt('monthlyBreakdown');

    await expect(service.getYearOverview(1, 2023)).rejects.toThrow(/monthlyBreakdown/);
    // All five before it succeeded. A five-of-six chart is the more insidious
    // version: the numbers are real, only the shape is wrong.
    expect(db.state.calls).toBe(6);
  });

  it('names the failing query in the message and keeps the original error as the cause', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service } = makeServiceFailingAt('topAlbums');

    const err = await service.getYearOverview(1, 2023).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as Error).message).toContain('Database unavailable');
    expect((err as Error).message).toContain('playHistoryService.getYearOverview:topAlbums');
    expect((err as Error).message).toContain("Can't reach database server");
    expect((err as SourceUnavailableError).cause).toBeInstanceOf(Error);
  });

  it('produces an error the Last.fm family check does not claim', async () => {
    // `artworkService` treats isLastFmUnavailable as "do NOT cache this as a
    // definitive no-artwork answer". A database error must not be swept into
    // that branch by accident, so the two families stay distinguishable.
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { service } = makeServiceFailingAt('topArtists');

    const err = await service.getYearOverview(1, 2023).catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect(isLastFmUnavailable(err)).toBe(false);
  });
});

describe('PlayHistoryService.getYearOverview — a genuinely empty year is still an answer', () => {
  /** All six queries succeed and return no rows, which is what "no plays" is. */
  const emptyService = () => {
    const query = vi.fn(async () => []);
    const service = new PlayHistoryService(
      {} as never,
      {} as never,
      { $queryRawUnsafe: query } as unknown as PrismaClient,
    );
    return { service, query };
  };

  it('returns zeros rather than throwing when the database has nothing for that year', async () => {
    const { service, query } = emptyService();

    // The fix must not have flipped the default the other way. "You had no
    // plays in 2023" is TRUE and must keep rendering as an empty chart; only a
    // failure is a failure.
    const data = await service.getYearOverview(1, 2023);

    expect(data.year).toBe(2023);
    expect(data.totalPlays).toBe(0);
    expect(data.totalArtists).toBe(0);
    expect(data.previousTotalPlays).toBe(0);
    expect(data.topArtists).toEqual([]);
    expect(data.topTracks).toEqual([]);
    expect(data.topAlbums).toEqual([]);
    expect(data.topGenres).toEqual([]);
    expect(data.topCountries).toEqual([]);
    expect(data.monthlyPlays).toHaveLength(12);
    expect(data.monthlyPlays.every((n) => n === 0)).toBe(true);
    expect(query).toHaveBeenCalledTimes(6);
  });

  it('returns the real numbers when every query succeeds', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const service = makeService(makeDb());

    const data = await service.getYearOverview(1, 2023);

    expect(data.totalPlays).toBe(3);
    expect(data.totalArtists).toBe(1);
    expect(data.previousTotalPlays).toBe(1);
    expect(data.topArtists).toEqual([{ name: 'Radiohead', playcount: 3 }]);
    expect(data.topTracks).toEqual([{ trackName: 'Airbag', artistName: 'Radiohead', playcount: 3 }]);
    expect(data.topAlbums).toEqual([{ albumName: 'OK Computer', artistName: 'Radiohead', playcount: 3 }]);
    expect(data.monthlyPlays[4]).toBe(3);
    expect(data.monthlyPlays[0]).toBe(0);
  });

  it('scopes every query to the requested year and the year before it', async () => {
    const query = vi.fn(async () => []);
    const service = new PlayHistoryService(
      {} as never,
      {} as never,
      { $queryRawUnsafe: query } as unknown as PrismaClient,
    );

    await service.getYearOverview(7, 2023);

  // Args are (sql, userId, startDate, endDate), so the window is slice(2, 4).
  //
  // Two mistakes hide in this one line. slice(1, 3) grabs (userId, startDate)
  // and compares the *start* bound against the *end* bound being asserted, so
  // it matches nothing. And `String(date)` is locale text
  // ("Sat Jan 01 2022 ..."), not the ISO form it is compared against - so even
  // the right indices would still silently produce an empty match rather than
  // a failure. An assertion that passes on an empty array proves nothing.
  const bounds = query.mock.calls.map((c) => {
    const args = c as unknown as [string, number, Date, Date];
    return [args[2]!.toISOString(), args[3]!.toISOString()] as const;
  });
    // The previous-year query is the only one whose window starts in 2022.
    expect(bounds.filter(([, end]) => end === new Date(Date.UTC(2024, 0, 1)).toISOString())).toHaveLength(5);
    expect(bounds.filter(([, end]) => end === new Date(Date.UTC(2023, 0, 1)).toISOString())).toHaveLength(1);
  });
});
