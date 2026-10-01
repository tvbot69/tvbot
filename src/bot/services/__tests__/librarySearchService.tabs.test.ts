import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The search service reaches a MODULE-LEVEL prisma singleton, so an unmocked
// import would open a real connection mid-unit-test. The SQL itself is covered
// by librarySearchService.db.test.ts against a real database; what this file
// owns is the tab routing, the guard, the row mapping, and what happens when
// the query does not answer.
// `..._args: unknown[]` rather than no parameters at all: a zero-arg `vi.fn()`
// infers a `[]` call tuple, so `mock.calls[0][0]` below is a COMPILE error that
// vitest runs happily and `tsc` would not.
const prismaMock = vi.hoisted(() => ({ $queryRaw: vi.fn(async (..._args: unknown[]) => [] as unknown[]) }));

vi.mock('@persistence/prismaClient', () => ({ prisma: prismaMock }));

import { LibrarySearchService, SearchTab } from '../librarySearchService';

/**
 * A library search is the answer to "does this user have X?". Returning an
 * empty list for a database that did not answer is the worst possible failure
 * here, because the user reads it as "you have never played that" - and unlike
 * a chart, nothing else will ever contradict it.
 *
 * So the pairing is: a failed query propagates, AND a query that ran and matched
 * nothing returns a real empty array.
 */

const rows = (...values: unknown[]) => prismaMock.$queryRaw.mockResolvedValue(values as never);

/**
 * `LibrarySearchService` calls `prisma.$queryRaw` as a TAGGED TEMPLATE, so the
 * double receives `(stringsArray, ...interpolations)` — there is no `.text` and
 * no `.values` on the first argument. Reading `.text` off it yields `''`, which
 * fails every `toContain` here and passes every `not.toContain` vacuously.
 * These helpers reconstruct what the driver would see, and THROW rather than
 * return a blank when the call shape is not what the service really uses.
 */
const sqlCall = (call = 0): unknown[] => {
  const args = prismaMock.$queryRaw.mock.calls[call];
  if (!args) throw new Error(`$queryRaw was not called ${call + 1} time(s) — the test asserted against a call that never happened`);
  if (!Array.isArray(args[0])) {
    throw new Error(`$queryRaw call ${call} was not a tagged template; the SQL helpers would read nothing`);
  }
  return args;
};

/** The assembled SQL text of the nth `$queryRaw` call. */
const sql = (call = 0): string => {
  const [strings, ...values] = sqlCall(call);
  const parts = strings as readonly string[];
  let out = '';
  parts.forEach((part, i) => {
    out += part;
    if (i < values.length) out += '?';
  });
  return out;
};

/** The values the service bound into that template, in order. */
const sqlValues = (call = 0): unknown[] => sqlCall(call).slice(1);

let service: LibrarySearchService;

beforeEach(() => {
  prismaMock.$queryRaw.mockClear();
  prismaMock.$queryRaw.mockResolvedValue([]);
  service = new LibrarySearchService();
});

describe('LibrarySearchService.search — the guard', () => {
  it('answers empty for a blank query without touching the database', async () => {
    // `''` reaching an ILIKE pattern would match every row, or - depending on
    // the wildcard escaping - none, and neither is what the user asked for.
    await expect(service.search(1, '   ', SearchTab.Tracks)).resolves.toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers empty for a non-positive user id', async () => {
    await expect(service.search(0, 'radiohead', SearchTab.Artists)).resolves.toEqual([]);
    await expect(service.search(-1, 'radiohead', SearchTab.Artists)).resolves.toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('binds the trimmed pattern and the user id, rather than splicing them in', async () => {
    // A pattern with the user's spaces still bound would never match, and a
    // spliced one would be an injection.
    await service.search(7, '  radiohead  ', SearchTab.Artists);
    expect(sqlValues(0)).toEqual([7, '%radiohead%']);
    expect(sql(0)).toContain('ILIKE');
  });
});

describe('LibrarySearchService.search — the four tabs', () => {
  it('reads artists with their rank', async () => {
    rows({ name: 'Radiohead', playcount: 245, rank: 3 });

    const result = await service.search(1, 'radio', SearchTab.Artists);

    expect(sql()).toContain('FROM user_artists');
    expect(result).toEqual([{ primary: 'Radiohead', count: 245, rank: 3 }]);
  });

  it('reads albums with the artist alongside the title', async () => {
    rows({ name: 'OK Computer', artist_name: 'Radiohead', playcount: 120, rank: 1 });

    const result = await service.search(1, 'ok', SearchTab.Albums);

    expect(sql()).toContain('FROM user_albums');
    expect(result).toEqual([{ primary: 'OK Computer', secondary: 'Radiohead', count: 120, rank: 1 }]);
  });

  it('reads tracks with the artist alongside the title', async () => {
    rows({ name: 'Airbag', artist_name: 'Radiohead', playcount: 90, rank: 5 });

    const result = await service.search(1, 'air', SearchTab.Tracks);

    expect(sql()).toContain('FROM user_tracks');
    expect(result).toEqual([{ primary: 'Airbag', secondary: 'Radiohead', count: 90, rank: 5 }]);
  });

  it('reads plays newest first and labels the untitled ones', async () => {
    // A play row with no track name is still a play; rendering a blank row or
    // dropping it changes the count the user sees.
    const at = new Date('2026-01-01T00:00:00.000Z');
    rows({ track_name: null, album_name: 'Kid A', artist_name: 'Radiohead', time_played: at });

    const result = await service.search(1, 'radio', SearchTab.Plays);

    expect(sql()).toContain('FROM user_plays');
    expect(result).toEqual([{ primary: 'Unknown Track', secondary: 'Radiohead', count: 1, timePlayed: at }]);
  });

  it('coerces a bigint aggregate into a number', async () => {
    rows({ name: 'Radiohead', playcount: 9007199254740993n, rank: 1n });

    const result = await service.search(1, 'radio', SearchTab.Artists);

    expect(typeof result[0]?.count).toBe('number');
    expect(typeof result[0]?.rank).toBe('number');
  });

  it('answers an empty list for a tab it does not recognise', async () => {
    // An unhandled enum value must not fall through to the artists query and
    // show the wrong tab's results.
    await expect(service.search(1, 'radio', 99 as SearchTab)).resolves.toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('ranks within the whole library, not within the matches', async () => {
    // The rank is computed in a CTE over every rollup row, so filtering to the
    // top 100 matches cannot renumber them. Asserted on the SQL because a
    // renamed alias is invisible to the mapping.
    await service.search(1, 'radio', SearchTab.Artists);
    expect(sql()).toContain('ROW_NUMBER() OVER');
    expect(sql()).toContain('LIMIT 100');
  });

  it('matches albums and tracks on artist AND title together', async () => {
    await service.search(1, 'radio', SearchTab.Tracks);
    expect(sql()).toContain('artist_name');
  });

  it('gives the plays tab a tighter limit than the rollup tabs', async () => {
    // Sixty individual scrobbles rather than a hundred aggregate rows: the tab
    // renders plays, not a ranking.
    await service.search(1, 'radio', SearchTab.Plays);
    expect(sql()).toContain('LIMIT 60');
  });
});

describe('LibrarySearchService.search — a query that did not answer', () => {
  it('propagates a failed read instead of saying the user has nothing', async () => {
    // The A1 branch. `[]` here is indistinguishable from a real absence, and a
    // user who does own the album would conclude they never played it.
    prismaMock.$queryRaw.mockRejectedValue(new Error('connection terminated'));

    await expect(service.search(1, 'radio', SearchTab.Tracks)).rejects.toThrow('connection terminated');
  });

  it('propagates for every tab, not just the first one', async () => {
    for (const tab of [SearchTab.Tracks, SearchTab.Albums, SearchTab.Artists, SearchTab.Plays]) {
      prismaMock.$queryRaw.mockRejectedValueOnce(new Error('statement timeout'));
      await expect(service.search(1, 'radio', tab)).rejects.toThrow('statement timeout');
    }
  });

  it('returns a genuine empty result as an empty array', async () => {
    // The other direction: a query that RAN and matched nothing is a fact, and
    // raising here would make every miss look like an outage.
    prismaMock.$queryRaw.mockResolvedValue([]);
    await expect(service.search(1, 'nothing matches this', SearchTab.Tracks)).resolves.toEqual([]);
  });

  it('does not cache the failure, so the next search re-reads the database', async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(service.search(1, 'radio', SearchTab.Tracks)).rejects.toThrow();
    prismaMock.$queryRaw.mockResolvedValue([{ name: 'Airbag', artist_name: 'Radiohead', playcount: 1, rank: 1 }]);

    const result = await service.search(1, 'radio', SearchTab.Tracks);

    expect(result).toHaveLength(1);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
