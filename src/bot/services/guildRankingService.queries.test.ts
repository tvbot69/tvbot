import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { GuildRankingService, OrderType } from './guildRankingService';
import type { GuildRankingSettings } from './guildRankingService';

/**
 * The four guild ranking charts are eight `$queryRaw` templates, and the only
 * existing coverage of them needs a real Postgres — so locally they ran
 * zero times. This file runs them against a double that returns rows, which is
 * enough for everything the raw SQL is NOT responsible for: the row mapping,
 * the branch selection, the cache, and — the part that actually matters for
 * A1 — what happens when the query does not answer.
 *
 * The property under test first and last: **a database that does not answer
 * must not become an empty leaderboard.** These charts publish a guild-wide
 * ranking that outlives the sweep, and a `catch(() => [])` here would render
 * "nobody in this server listens to anything" with total confidence. Each
 * method is therefore tested in both directions — the rejection propagates,
 * AND a query that genuinely matched nothing still returns an empty array and
 * caches it.
 */

const GUILD = '987654321012345678';
const OTHER_GUILD = '111222333444555666';

const windowed = (over: Partial<GuildRankingSettings> = {}): GuildRankingSettings => ({
  chartTimePeriod: 'custom',
  timeDescription: 'windowed',
  orderType: OrderType.Listeners,
  amountOfDays: 7,
  startDateTime: new Date('2026-01-01T00:00:00.000Z'),
  endDateTime: null,
  billboardStartDateTime: null,
  billboardEndDateTime: null,
  billboardTimeDescription: null,
  newSearchValue: null,
  ...over,
});

const allTime = (over: Partial<GuildRankingSettings> = {}): GuildRankingSettings =>
  windowed({
    chartTimePeriod: 'alltime',
    timeDescription: 'all-time',
    amountOfDays: 0,
    startDateTime: new Date(0),
    ...over,
  });

/**
 * A `$queryRaw` double that keeps the `Prisma.Sql` argument intact, so the
 * assertions below can read the assembled SQL and its bound values. A double
 * that only counted calls could not tell `FROM user_plays` from
 * `FROM user_artists`, and that difference is the whole point of the
 * all-time/windowed split.
 */
const prismaWith = (rows: unknown[] | (() => unknown[])) => {
  const $queryRaw = vi.fn(async (..._args: unknown[]) =>
    typeof rows === 'function' ? rows() : rows,
  );
  return { prisma: { $queryRaw } as never, $queryRaw };
};

/**
 * `GuildRankingService` calls `$queryRaw` as a TAGGED TEMPLATE, not as
 * `$queryRaw(Prisma.sql\`...\`)`. The double therefore receives
 * `(stringsArray, ...interpolations)` — there is no `.text` to read off the
 * first argument. Both helpers below reconstruct what the driver would see:
 * the string parts joined around their placeholders.
 *
 * Anything else is a shape change, and it throws. Returning `''` or `[]` would
 * make every `toContain` fail loudly but — far worse — every `not.toContain`
 * (the "no artist filter was added" and "no window on the all-time branch"
 * assertions) pass VACUOUSLY, which is how a dropped privacy clause hides.
 */
const isPrismaSql = (value: unknown): value is { text: string; values: unknown[] } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { text?: unknown }).text === 'string' &&
  Array.isArray((value as { values?: unknown }).values);

/** A nested `Prisma.sql` fragment, rendered back to the SQL it stands for. */
const renderFragment = (value: unknown): string =>
  isPrismaSql(value) ? value.text.replace(/\$\d+/g, '?') : '?';

const sqlCall = (queryRaw: ReturnType<typeof vi.fn>, call: number): unknown[] => {
  const args = queryRaw.mock.calls[call];
  if (!args) throw new Error(`$queryRaw was not called ${call + 1} time(s) — the test asserted against a call that never happened`);
  if (!Array.isArray(args[0])) {
    throw new Error(`$queryRaw call ${call} was not a tagged template; the SQL helpers would read nothing`);
  }
  return args;
};

/** The assembled SQL text of the nth `$queryRaw` call. */
const sqlText = (queryRaw: ReturnType<typeof vi.fn>, call = 0): string => {
  const args = sqlCall(queryRaw, call);
  const strings = args[0] as readonly string[];
  const values = args.slice(1);
  let out = '';
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) out += renderFragment(values[i]);
  });
  return out;
};

/**
 * The values Prisma bound into that template, in order. Nested `Prisma.sql`
 * fragments are flattened, because Prisma flattens them too: a bound date or
 * filter arrives inside a fragment (`${settings.endDateTime ? Prisma.sql\`...\` : Prisma.empty}`)
 * and is still a bound value.
 */
const sqlValues = (queryRaw: ReturnType<typeof vi.fn>, call = 0): unknown[] => {
  const [, ...values] = sqlCall(queryRaw, call);
  return values.flatMap((v) => (isPrismaSql(v) ? v.values : [v]));
};

/**
 * The ORDER BY tail of a statement. Asserting `indexOf` on the WHOLE statement
 * would find the SELECT list first — `"totalPlaycount" AS` is emitted before
 * `"listenerCount" AS` — so an ordering assertion over the full text proves
 * nothing about the ordering.
 */
const sqlOrderBy = (queryRaw: ReturnType<typeof vi.fn>, call = 0): string => {
  const sql = sqlText(queryRaw, call);
  const at = sql.indexOf('ORDER BY');
  if (at < 0) throw new Error(`$queryRaw call ${call} has no ORDER BY clause`);
  return sql.slice(at);
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('GuildRankingService.getGuildTopArtists', () => {
  it('reads the denormalised rollup for an all-time chart', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', totalPlaycount: 245, listenerCount: 14 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopArtists(GUILD, allTime());

    expect(items).toEqual([{ name: 'Radiohead', totalPlaycount: 245, listenerCount: 14 }]);
    expect(sqlText($queryRaw)).toContain('FROM user_artists');
  });

  it('reads the scrobble rows for a windowed chart', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', totalPlaycount: 12, listenerCount: 3 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopArtists(GUILD, windowed());

    expect(items[0]?.name).toBe('Radiohead');
    expect(sqlText($queryRaw)).toContain('FROM user_plays');
  });

  it('binds the guild id as a bigint, so a snowflake is not truncated', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, allTime());

    expect(sqlValues($queryRaw)).toContain(BigInt(GUILD));
  });

  it('binds the window start, and the end only when there is one', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);
    const end = new Date('2026-01-08T00:00:00.000Z');

    await service.getGuildTopArtists(GUILD, windowed({ endDateTime: null }));
    expect(sqlValues($queryRaw, 0)).not.toContain(end);
    expect(sqlText($queryRaw, 0)).toContain('time_played >=');

    await service.getGuildTopArtists(GUILD, windowed({ endDateTime: end, startDateTime: new Date(1000) }));
    expect(sqlValues($queryRaw, 1)).toContain(end);
    expect(sqlText($queryRaw, 1)).toContain('time_played <');
  });

  it('orders by listeners first, then plays', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, allTime({ orderType: OrderType.Listeners }));

    const orderBy = sqlOrderBy($queryRaw);
    expect(orderBy.indexOf('"listenerCount"')).toBeGreaterThanOrEqual(0);
    expect(orderBy.indexOf('"listenerCount"')).toBeLessThan(orderBy.indexOf('"totalPlaycount"'));
  });

  it('orders by plays first when that is what was asked for', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, allTime({ orderType: OrderType.Playcount }));

    const orderBy = sqlOrderBy($queryRaw);
    expect(orderBy.indexOf('"totalPlaycount"')).toBeGreaterThanOrEqual(0);
    expect(orderBy.indexOf('"totalPlaycount"')).toBeLessThan(orderBy.indexOf('"listenerCount"'));
  });

  it('coerces a bigint SUM into a number, so the builder never sees 245n', async () => {
    // Postgres `SUM(...)::int` comes back through Prisma as a number, but the
    // mapping is explicit here and this is what pins it.
    const { prisma } = prismaWith([
      { artistName: 'A', totalPlaycount: 9007199254740993n, listenerCount: 2n },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopArtists(GUILD, allTime());

    expect(typeof items[0]?.totalPlaycount).toBe('number');
    expect(typeof items[0]?.listenerCount).toBe('number');
  });

  it('propagates a failed query instead of reporting an empty guild', async () => {
    // A1. The alternative — catching and returning [] — is a guild-wide
    // leaderboard that says "no one has ever played music here".
    const $queryRaw = vi.fn(async () => {
      throw new Error('connection terminated');
    });
    const service = new GuildRankingService({ $queryRaw } as never);

    await expect(service.getGuildTopArtists(GUILD, allTime())).rejects.toThrow('connection terminated');
  });

  it('caches nothing when the query failed, so the next sweep retries', async () => {
    const $queryRaw = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([{ artistName: 'Radiohead', totalPlaycount: 3, listenerCount: 2 }]);
    const service = new GuildRankingService({ $queryRaw } as never);
    const settings = allTime();

    await expect(service.getGuildTopArtists(GUILD, settings)).rejects.toThrow();
    await expect(service.getGuildTopArtists(GUILD, settings)).resolves.toHaveLength(1);
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('returns a genuine empty result as an empty array, not as an error', async () => {
    // The other direction of the same pairing: a query that ran and matched
    // nothing SUCCEEDS. Turning that into a visible error would page the
    // operator every time a new guild joins.
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await expect(service.getGuildTopArtists(GUILD, allTime())).resolves.toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('serves the second identical request from memory', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', totalPlaycount: 245, listenerCount: 14 },
    ]);
    const service = new GuildRankingService(prisma);
    const settings = allTime();

    const first = await service.getGuildTopArtists(GUILD, settings);
    const second = await service.getGuildTopArtists(GUILD, settings);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('does not share an entry between two guilds', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, allTime());
    await service.getGuildTopArtists(OTHER_GUILD, allTime());

    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not share an entry between two windows', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, windowed({ startDateTime: new Date(1000) }));
    await service.getGuildTopArtists(GUILD, windowed({ startDateTime: new Date(2000) }));

    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not share an entry between the two orderings', async () => {
    // Same rows, different ranking: a cache hit would serve listeners order
    // to a user who asked for plays.
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopArtists(GUILD, allTime({ orderType: OrderType.Listeners }));
    await service.getGuildTopArtists(GUILD, allTime({ orderType: OrderType.Playcount }));

    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('re-queries once the cached entry has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);
    const settings = allTime();

    await service.getGuildTopArtists(GUILD, settings);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await service.getGuildTopArtists(GUILD, settings);

    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('still serves the entry just before it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);
    const settings = allTime();

    await service.getGuildTopArtists(GUILD, settings);
    vi.advanceTimersByTime(5 * 60 * 1000 - 1000);
    await service.getGuildTopArtists(GUILD, settings);

    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('sweeps expired entries once the cache grows past its ceiling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    // 600 distinct windows, so the map is over its 500-entry ceiling. Nothing
    // is expired yet, so the sweep has nothing to remove — which is exactly
    // why this needs the clock moved afterwards: without the sweep the process
    // grows a new key per chart request for the life of the deployment.
    for (let i = 0; i < 600; i++) {
      await service.getGuildTopArtists(GUILD, allTime({ startDateTime: new Date(i * 1000) }));
    }
    expect((service as unknown as { cache: Map<string, unknown> }).cache.size).toBe(600);

    // One TTL later, a single further write must evict all 600 dead entries.
    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));
    await service.getGuildTopArtists(GUILD, allTime({ startDateTime: new Date(9_000_000) }));
    expect((service as unknown as { cache: Map<string, unknown> }).cache.size).toBe(1);

    // And the evicted key is genuinely gone: the chart re-reads the database
    // rather than serving a 30-minute-old ranking.
    await service.getGuildTopArtists(GUILD, allTime({ startDateTime: new Date(10_000) }));
    expect($queryRaw).toHaveBeenCalledTimes(602);
  });
});

describe('GuildRankingService.getGuildTopAlbums', () => {
  it('carries the album id on the all-time chart', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', albumName: 'OK Computer', albumId: 7n, totalPlaycount: 120, listenerCount: 8 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopAlbums(GUILD, allTime());

    expect(items[0]).toEqual({
      name: 'OK Computer',
      secondaryName: 'Radiohead',
      totalPlaycount: 120,
      listenerCount: 8,
      id: 7,
    });
    expect(sqlText($queryRaw)).toContain('FROM user_albums');
  });

  it('carries no id on the windowed chart, which reads scrobble rows', async () => {
    // The two branches are not interchangeable: the windowed chart groups by
    // the names ON the play row and has no album identity to expose, so a
    // builder that assumed `id` would be present would render "undefined".
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', albumName: 'OK Computer', totalPlaycount: 4, listenerCount: 2 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopAlbums(GUILD, windowed());

    expect(items[0]?.id).toBeUndefined();
    expect(sqlText($queryRaw)).toContain('FROM user_plays');
  });

  it('adds the artist filter only when one was supplied', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopAlbums(GUILD, allTime(), null);
    expect(sqlText($queryRaw, 0)).not.toContain('LOWER(');

    await service.getGuildTopAlbums(GUILD, allTime(), '  Radiohead  ');
    expect(sqlText($queryRaw, 1)).toContain('LOWER(');
    expect(sqlValues($queryRaw, 1)).toContain('Radiohead');
  });

  it('treats a whitespace-only filter as no filter', async () => {
    // `''` reaching the WHERE clause would return an empty chart and look like
    // a guild with no albums.
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopAlbums(GUILD, allTime(), '   ');

    expect(sqlText($queryRaw)).not.toContain('LOWER(');
  });

  it('keeps the filter in the cache key, so two artists never share a chart', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);
    const settings = allTime();

    await service.getGuildTopAlbums(GUILD, settings, 'Radiohead');
    await service.getGuildTopAlbums(GUILD, settings, 'Portishead');
    await service.getGuildTopAlbums(GUILD, settings, 'Radiohead');

    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed query and still returns [] for a genuine empty guild', async () => {
    const failing = new GuildRankingService({
      $queryRaw: vi.fn(async () => {
        throw new Error('deadlock detected');
      }),
    } as never);
    await expect(failing.getGuildTopAlbums(GUILD, allTime())).rejects.toThrow('deadlock detected');

    const { prisma } = prismaWith([]);
    const empty = new GuildRankingService(prisma);
    await expect(empty.getGuildTopAlbums(GUILD, allTime())).resolves.toEqual([]);
  });
});

describe('GuildRankingService.getGuildTopTracks', () => {
  it('carries the track id on the all-time chart and reads the rollup', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', trackName: 'Airbag', trackId: 11n, totalPlaycount: 90, listenerCount: 6 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopTracks(GUILD, allTime());

    expect(items[0]).toEqual({
      name: 'Airbag',
      secondaryName: 'Radiohead',
      totalPlaycount: 90,
      listenerCount: 6,
      id: 11,
    });
    expect(sqlText($queryRaw)).toContain('FROM user_tracks');
  });

  it('reads scrobble rows and carries no id on the windowed chart', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { artistName: 'Radiohead', trackName: 'Airbag', totalPlaycount: 2, listenerCount: 1 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopTracks(GUILD, windowed());

    expect(items[0]?.id).toBeUndefined();
    expect(sqlText($queryRaw)).toContain('FROM user_plays');
  });

  it('orders by the requested metric', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopTracks(GUILD, allTime({ orderType: OrderType.Playcount }));

    const orderBy = sqlOrderBy($queryRaw);
    expect(orderBy.indexOf('"totalPlaycount"')).toBeGreaterThanOrEqual(0);
    expect(orderBy.indexOf('"totalPlaycount"')).toBeLessThan(orderBy.indexOf('"listenerCount"'));
  });

  it('propagates a failed query, and treats a genuine empty result as empty', async () => {
    const failing = new GuildRankingService({
      $queryRaw: vi.fn(async () => {
        throw new Error('too many connections');
      }),
    } as never);
    await expect(failing.getGuildTopTracks(GUILD, allTime())).rejects.toThrow('too many connections');

    const { prisma } = prismaWith([]);
    await expect(new GuildRankingService(prisma).getGuildTopTracks(GUILD, allTime())).resolves.toEqual([]);
  });
});

describe('GuildRankingService.getGuildTopGenres', () => {
  it('maps a genre row on the all-time branch', async () => {
    const { prisma, $queryRaw } = prismaWith([
      { genreName: 'Art Rock', totalPlaycount: 300, listenerCount: 20 },
    ]);
    const service = new GuildRankingService(prisma);

    const items = await service.getGuildTopGenres(GUILD, allTime());

    expect(items).toEqual([{ name: 'Art Rock', totalPlaycount: 300, listenerCount: 20 }]);
    expect(sqlText($queryRaw)).toContain('FROM user_artists');
    expect(sqlText($queryRaw)).toContain('artist_genres');
  });

  it('reads the scrobble rows on the windowed branch, where the counts are play counts', async () => {
    // The all-time branch SUMs a rollup; the windowed branch COUNTs scrobbles.
    // Same column name, different meaning — the SQL text is what proves which.
    const { prisma, $queryRaw } = prismaWith([
      { genreName: 'Art Rock', totalPlaycount: 44, listenerCount: 9 },
    ]);
    const service = new GuildRankingService(prisma);

    await service.getGuildTopGenres(GUILD, windowed());

    const sql = sqlText($queryRaw);
    expect(sql).toContain('FROM user_plays');
    expect(sql).toContain('COUNT(*)::int AS "totalPlaycount"');
  });

  it('binds the window on the windowed branch and no window at all on all-time', async () => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);
    const start = new Date('2026-01-01T00:00:00.000Z');

    await service.getGuildTopGenres(GUILD, allTime());
    expect(sqlText($queryRaw, 0)).not.toContain('time_played');

    await service.getGuildTopGenres(GUILD, windowed({ startDateTime: start }));
    expect(sqlText($queryRaw, 1)).toContain('time_played');
    expect(sqlValues($queryRaw, 1)).toContain(start);
  });

  it('propagates a failed query, and treats a genuine empty result as empty', async () => {
    const failing = new GuildRankingService({
      $queryRaw: vi.fn(async () => {
        throw new Error('statement timeout');
      }),
    } as never);
    await expect(failing.getGuildTopGenres(GUILD, allTime())).rejects.toThrow('statement timeout');

    const { prisma } = prismaWith([]);
    await expect(new GuildRankingService(prisma).getGuildTopGenres(GUILD, allTime())).resolves.toEqual([]);
  });
});

describe('GuildRankingService privacy and ban clauses are present in every query', () => {
  /**
   * The mute rules are SQL, not code: a listener who set `privacy_level` to
   * Hide, or who is flagged for abuse, must not appear in a guild ranking.
   * These assertions do not prove the query is correct — the db suite does
   * that — they prove the filter was not dropped from a template while
   * something else in the file changed.
   *
   * `noUncheckedIndexedAccess` makes a string-indexed lookup `| undefined`, and
   * the interesting failure here is a RENAMED chart method: an absent method
   * must fail this test, not quietly satisfy it. So the lookup resolves the
   * function or throws by name — never a `!` on a value that may be missing.
   *
   * The method is returned BOUND to the instance. The chart methods read
   * `this.getCached` / `this.prisma`, and a detached function invoked as
   * `fn(guild, settings)` runs with `this === undefined` under ESM strict mode,
   * which throws before a single line of SQL is built.
   */
  const chartMethod = (
    service: GuildRankingService,
    name: string,
  ): ((g: string, s: GuildRankingSettings) => Promise<unknown>) => {
    const candidate = (service as unknown as Record<string, unknown>)[name];
    if (typeof candidate !== 'function') {
      throw new Error(`GuildRankingService has no chart method named ${name}`);
    }
    return (candidate as (g: string, s: GuildRankingSettings) => Promise<unknown>).bind(service);
  };

  it.each([
    ['getGuildTopArtists', 'artists'],
    ['getGuildTopAlbums', 'albums'],
    ['getGuildTopTracks', 'tracks'],
    ['getGuildTopGenres', 'genres'],
  ] as const)('%s excludes hidden, flagged, banned and self-blocked members', async (method, _kind) => {
    const { prisma, $queryRaw } = prismaWith([]);
    const service = new GuildRankingService(prisma);

    await chartMethod(service, method)(GUILD, allTime());

    const sql = sqlText($queryRaw);
    expect(sql).toContain("privacy_level <> 'Hide'");
    expect(sql).toContain('abuse_flags');
    expect(sql).toContain('NOT gu.who_knows_banned');
    expect(sql).toContain('NOT gu.self_block_from_who_knows');
  });
});

describe('Prisma.sql fragments used for the ordering', () => {
  it('produce a non-empty text body', () => {
    // Guards the sqlText helper above: if `Prisma.Sql` ever stopped exposing
    // `text`, every "contains" assertion in this file would pass vacuously.
    const frag = Prisma.sql`"totalPlaycount" DESC`;
    expect(frag.text).toContain('"totalPlaycount"');
    expect(Prisma.empty.text).toBe('');
  });
});
