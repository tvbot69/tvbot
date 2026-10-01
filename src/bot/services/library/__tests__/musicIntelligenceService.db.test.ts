import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { MusicIntelligenceService } from '@bot/services/library/musicIntelligenceService';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import {
  connect,
  databaseUrl,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../../testSupport/dbHarness';
import type { PlayFixture } from '../../../../testSupport/dbHarness';

/**
 * The four window-function queries behind /listeninggaps and /discoveries.
 *
 * They are the heaviest SQL in the repo and the unit suite mocks Prisma, so
 * none of it had ever been parsed by Postgres. Everything that matters here is
 * a property of the DATABASE rather than of the code: `LAG(...) OVER
 * (PARTITION BY LOWER(...))` deciding which two plays form a gap,
 * `ROW_NUMBER() ... WHERE rn = 1` keeping exactly one row per entity,
 * `ROUND(...::numeric, 1)` against a JS `Math.round`, and the `>=`/`<=`
 * window bounds in getDiscoveries. A mock agrees with whatever the code does;
 * only a real database can disagree.
 *
 * Seeding goes through dbHarness.seedPlays. Do not hand-write an INSERT:
 * Prisma sends `$1` untyped and Postgres cannot resolve an untyped parameter
 * in an INSERT VALUES list, so the obvious inline form fails with 42804 while
 * the identical query with literals succeeds.
 *
 * THE TIMESTAMPS ARE LOAD-BEARING. `user_plays_identity_uniq` is
 * (user_id, time_played, lower(artist_name), coalesce(lower(track_name), ''),
 * play_source) and deliberately EXCLUDES user_play_id. Two scrobbles sharing a
 * timestamp are therefore one row, and a gap detection that needs two distinct
 * moments silently becomes "no data". `spaced()` below spaces plays by whole
 * days, which is both distinct and the only way to express a multi-day gap.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: MusicIntelligenceService | null = null;
let userId = 1;

const at = (iso: string) => new Date(iso);
const DAY = 86_400_000;
const BASE = at('2020-01-01T12:00:00Z').getTime();

/** A moment `days` whole days after the fixture epoch. */
const day = (days: number, hours = 0) => new Date(BASE + days * DAY + hours * 3_600_000);

/**
 * One play per day-offset. Whole-day spacing keeps the arithmetic exact in
 * both directions: `timestamptz` subtraction yields an interval, so
 * `EXTRACT(EPOCH FROM (a - b))` is absolute and immune to DST, and a day is
 * exactly 86400 seconds.
 */
const spaced = (
  days: number[],
  over: Omit<PlayFixture, 'userId' | 'timePlayed'>,
): PlayFixture[] => days.map((d) => ({ userId, timePlayed: day(d), ...over }));

const WINDOW_START = at('2020-06-01T00:00:00Z');
const WINDOW_END = at('2020-06-30T00:00:00Z');

/** A moment `days` after the discovery window opens (days may be negative). */
const inWindow = (days: number, ms = 0) =>
  new Date(WINDOW_START.getTime() + days * DAY + ms);

/**
 * Read the service's private client accessor.
 *
 * `private get db()` returns `this.prisma ?? defaultPrisma`, and
 * `defaultPrisma` is built from the real DATABASE_URL in .env - which on this
 * machine is the PRODUCTION Railway database. Everything below depends on the
 * constructor call in `beforeAll` putting the harness client in `this.prisma`;
 * a test that reads the accessor is what turns a future wiring change into a
 * loud failure instead of a suite that quietly TRUNCATEs production.
 */
const clientOf = (instance: MusicIntelligenceService): PrismaClient =>
  (instance as unknown as { db: PrismaClient }).db;

/**
 * A URL pointing at a schema in which `user_plays` does not exist.
 *
 * Used to produce a REAL Postgres error (42P01) for the fallback test. The
 * search_path lives in the URL rather than in a `SET search_path` statement
 * because Prisma pools connections: a bare SET is not guaranteed to land on
 * the same connection that runs the next query, which would make the test
 * intermittently "pass" by silently querying the scratch schema.
 */
const urlWithoutTables = (): string => {
  const url = databaseUrl() ?? '';
  return /([?&])schema=/.test(url)
    ? url.replace(/([?&])schema=[^&]*/, '$1schema=music_intelligence_suite_has_no_tables')
    : `${url}${url.includes('?') ? '&' : '?'}schema=music_intelligence_suite_has_no_tables`;
};

suite('MusicIntelligenceService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    // SAFETY-CRITICAL WIRING. prisma is the FIRST of two optional positional
    // parameters and countryService the second. Getting the order wrong
    // compiles fine (the second is optional), every query then runs against
    // `defaultPrisma` - the real production database - and each one fails
    // inside the service's own `.catch(() => [])`, which is indistinguishable
    // from "no data". `clientOf` below is the guard against that regression.
    service = new MusicIntelligenceService(prisma, undefined);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await seedUser(prisma, userId);
  });

  it('queries the injected Prisma client and never the default production one', () => {
    expect(clientOf(service!)).toBe(prisma);
  });

  it('returns an empty list for every raw query when the user has no plays', async () => {
    await expect(service!.getListeningGaps(userId, 'artist')).resolves.toEqual([]);
    await expect(service!.getListeningGaps(userId, 'album')).resolves.toEqual([]);
    await expect(service!.getListeningGaps(userId, 'track')).resolves.toEqual([]);
    await expect(service!.getDiscoveries(userId, WINDOW_START, WINDOW_END)).resolves.toEqual([]);
  });

  it('raises rather than answering [] when the database genuinely rejects the query', async () => {
    // REPLACED, not weakened, and the replacement is the point of the A1 work.
    //
    // This test used to be titled 'falls back to an empty array when the database
    // genuinely rejects the query' and asserted `resolves.toEqual([])` on a real
    // 42P01. It was pinning the defect: every query in this class ended in
    // `.catch(() => [])`, so a swallowed SQL error was indistinguishable from
    // "this user has no data", which is the exact reason this suite exists in
    // the first place. Asserting only the empty half would still pin the bug, so
    // both directions are now tested — and the empty half is covered by the
    // test above it, which runs the SAME queries against a real schema that
    // simply has no rows.
    //
    // The control assertion is kept and matters: without it, a client that
    // silently never queried could make every rejection look like a raise.
    const blind = new PrismaClient({ datasources: { db: { url: urlWithoutTables() } } });
    await blind.$connect();
    try {
      await expect(blind.$queryRawUnsafe('SELECT 1 FROM user_plays')).rejects.toThrow();

      const blindService = new MusicIntelligenceService(blind, undefined);
      for (const [what, run] of [
        ['gaps/artist', () => blindService.getListeningGaps(userId, 'artist')],
        ['gaps/album', () => blindService.getListeningGaps(userId, 'album')],
        ['gaps/track', () => blindService.getListeningGaps(userId, 'track')],
        ['discoveries', () => blindService.getDiscoveries(userId, WINDOW_START, WINDOW_END)],
      ] as const) {
        const thrown = await run().catch((e: unknown) => e);
        expect(isSourceUnavailable(thrown), `${what} did not surface its failure`).toBe(true);
      }
    } finally {
      await blind.$disconnect();
    }
  });

  // ---------------------------------------------------------------- artist --

  it('excludes a gap shorter than minGapDays', async () => {
    await seedPlays(prisma!, spaced([0, 30], { artistName: 'Brief', trackName: 't' }));

    await expect(service!.getListeningGaps(userId, 'artist', 90)).resolves.toEqual([]);

    // The bound is `>=`, so a gap of exactly minGapDays is kept.
    const included = await service!.getListeningGaps(userId, 'artist', 30);
    expect(included).toHaveLength(1);
    expect(included[0]!.gapDays).toBe(30);
  });

  it('keeps only the longest gap per artist, which is what rn = 1 does', async () => {
    // Gaps of 100, 20 and 280 days. At minGapDays 90 the 20-day gap is
    // filtered out and TWO rows still qualify - without the
    // ROW_NUMBER() ... WHERE rn = 1 this returns two artists-shaped rows for
    // one artist instead of the single longest hiatus.
    await seedPlays(prisma!, spaced([0, 100, 120, 400], { artistName: 'Busy', trackName: 't' }));

    const gaps = await service!.getListeningGaps(userId, 'artist', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.name).toBe('Busy');
    expect(gaps[0]!.gapDays).toBe(280);
    expect(gaps[0]!.prevPlayed).toEqual(day(120));
    expect(gaps[0]!.resumeDate).toEqual(day(400));
    // COUNT(*) OVER is computed before the gap filter, so a play that forms no
    // qualifying gap still counts towards the artist's total.
    expect(gaps[0]!.totalPlays).toBe(4);
  });

  it('rounds gapDays to a whole number and returns totalPlays as a number', async () => {
    // 200 days + 10 hours = 200.4166 days. SQL rounds to 200.4 and the
    // service rounds again to a whole number, so the interface never hands a
    // caller a fractional day count.
    await seedPlays(prisma!, [
      { userId, artistName: 'Fractional', trackName: 't', timePlayed: day(0) },
      { userId, artistName: 'Fractional', trackName: 't', timePlayed: day(200, 10) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'artist', 200);

    expect(gaps).toHaveLength(1);
    expect(Number.isInteger(gaps[0]!.gapDays)).toBe(true);
    expect(gaps[0]!.gapDays).toBe(200);
    // COUNT(*) OVER arrives as a Postgres bigint; the map has to convert it or
    // every downstream comparison silently does string maths.
    expect(typeof gaps[0]!.totalPlays).toBe('number');
    expect(gaps[0]!.totalPlays).toBe(2);
  });

  it('partitions by lower(artist_name), so Radiohead and radiohead are one artist', async () => {
    // If the partition were case-sensitive this would be two artists, each
    // with a single play, each therefore with NO gap at all.
    await seedPlays(prisma!, [
      { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: day(0) },
      { userId, artistName: 'radiohead', trackName: 'Airbag', timePlayed: day(200) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'artist', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.totalPlays).toBe(2);
    expect(gaps[0]!.gapDays).toBe(200);
    // `name` is the artist_name of the RESUMING row, so the casing of the
    // response follows the data rather than being normalised.
    expect(gaps[0]!.name.toLowerCase()).toBe('radiohead');
  });

  it('counts plays with no album or track name toward artist gaps', async () => {
    // The artist variant has no album/track predicate at all, unlike the two
    // below. A scrobble Last.fm delivered without a track must still count.
    await seedPlays(prisma!, spaced([0, 150], {
      artistName: 'Anonymous',
      trackName: null,
      albumName: null,
    }));

    const artistGaps = await service!.getListeningGaps(userId, 'artist', 90);
    expect(artistGaps).toHaveLength(1);
    expect(artistGaps[0]!.totalPlays).toBe(2);
    expect(artistGaps[0]!.gapDays).toBe(150);

    // ...and the album and track variants see nothing, because both predicates
    // drop these rows entirely.
    await expect(service!.getListeningGaps(userId, 'album', 90)).resolves.toEqual([]);
    await expect(service!.getListeningGaps(userId, 'track', 90)).resolves.toEqual([]);
  });

  it('orders the longest gaps first', async () => {
    await seedPlays(prisma!, [
      ...spaced([0, 300], { artistName: 'Middle', trackName: 't' }),
      ...spaced([0, 400], { artistName: 'Longest', trackName: 't' }),
    ]);

    const gaps = await service!.getListeningGaps(userId, 'artist', 90);

    expect(gaps.map((g) => g.name)).toEqual(['Longest', 'Middle']);
  });

  it('scopes gaps to one user', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      ...spaced([0], { artistName: 'Theirs', trackName: 't' }),
      { userId: other, artistName: 'Theirs', trackName: 't', timePlayed: day(0) },
      { userId: other, artistName: 'Theirs', trackName: 't', timePlayed: day(500) },
    ]);

    await expect(service!.getListeningGaps(userId, 'artist', 90)).resolves.toEqual([]);

    const theirs = await service!.getListeningGaps(other, 'artist', 90);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.gapDays).toBe(500);
  });

  // ----------------------------------------------------------------- album --

  it('excludes NULL and empty album names from album gaps', async () => {
    await seedPlays(prisma!, [
      ...spaced([0, 300], { artistName: 'A', trackName: 't1', albumName: 'Kid A' }),
      { userId, artistName: 'A', trackName: 't2', albumName: null, timePlayed: day(10) },
      { userId, artistName: 'A', trackName: 't3', albumName: '', timePlayed: day(20) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'album', 90);

    expect(gaps.map((g) => g.name)).toEqual(['Kid A']);
    // totalPlays is 2, not 4: the NULL/empty predicate sits in `ordered_plays`,
    // so those rows are gone BEFORE LAG() and COUNT(*) ever see them.
    expect(gaps[0]!.totalPlays).toBe(2);
    expect(gaps[0]!.artistName).toBe('A');
    expect(gaps[0]!.gapDays).toBe(300);
  });

  it('keeps only the longest gap per artist-and-album pair', async () => {
    await seedPlays(prisma!, spaced([0, 100, 120, 400], {
      artistName: 'A',
      trackName: 't',
      albumName: 'Kid A',
    }));

    const gaps = await service!.getListeningGaps(userId, 'album', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.gapDays).toBe(280);
    expect(gaps[0]!.totalPlays).toBe(4);
  });

  it('partitions albums by artist AND album name, case-insensitively', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'A', trackName: 't1', albumName: 'Kid A', timePlayed: day(0) },
      { userId, artistName: 'a', trackName: 't2', albumName: 'kid a', timePlayed: day(300) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'album', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.totalPlays).toBe(2);
    expect(gaps[0]!.gapDays).toBe(300);
    expect(gaps[0]!.name.toLowerCase()).toBe('kid a');
    expect(gaps[0]!.artistName!.toLowerCase()).toBe('a');
  });

  it('keeps the same album name under two artists apart', async () => {
    await seedPlays(prisma!, [
      ...spaced([0, 300], { artistName: 'Radiohead', trackName: 't', albumName: 'Kid A' }),
      ...spaced([0, 100], { artistName: 'Bowie', trackName: 't', albumName: 'Kid A' }),
    ]);

    const gaps = await service!.getListeningGaps(userId, 'album', 90);

    // Both partitions survive because LOWER(artist_name) is part of the key.
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.artistName).sort()).toEqual(['Bowie', 'Radiohead']);
    expect(gaps.every((g) => g.name === 'Kid A')).toBe(true);
    expect(gaps.every((g) => g.totalPlays === 2)).toBe(true);
  });

  // ----------------------------------------------------------------- track --

  it('excludes NULL and empty track names from track gaps', async () => {
    await seedPlays(prisma!, [
      ...spaced([0, 300], { artistName: 'A', trackName: 't1', albumName: 'X' }),
      { userId, artistName: 'A', trackName: null, albumName: 'X', timePlayed: day(10) },
      { userId, artistName: 'A', trackName: '', albumName: 'X', timePlayed: day(20) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'track', 90);

    expect(gaps.map((g) => g.name)).toEqual(['t1']);
    expect(gaps[0]!.totalPlays).toBe(2);
    expect(gaps[0]!.artistName).toBe('A');
    expect(gaps[0]!.gapDays).toBe(300);
  });

  it('keeps only the longest gap per artist-and-track pair', async () => {
    await seedPlays(prisma!, spaced([0, 100, 120, 400], {
      artistName: 'A',
      trackName: 't1',
      albumName: 'X',
    }));

    const gaps = await service!.getListeningGaps(userId, 'track', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.gapDays).toBe(280);
    expect(gaps[0]!.totalPlays).toBe(4);
  });

  it('partitions tracks by artist AND track name, case-insensitively', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Radiohead', trackName: 'Karma Police', albumName: 'X', timePlayed: day(0) },
      { userId, artistName: 'radiohead', trackName: 'karma police', albumName: 'X', timePlayed: day(210) },
    ]);

    const gaps = await service!.getListeningGaps(userId, 'track', 90);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.totalPlays).toBe(2);
    expect(gaps[0]!.gapDays).toBe(210);
    expect(gaps[0]!.name.toLowerCase()).toBe('karma police');
  });

  // ----------------------------------------------------------- discoveries --

  it('includes only artists with at least one play inside the window', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Inside', trackName: 't', timePlayed: inWindow(0) },
      { userId, artistName: 'Inside', trackName: 't', timePlayed: inWindow(1) },
      { userId, artistName: 'Outside', trackName: 't', timePlayed: inWindow(-1) },
    ]);

    const found = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    expect(found.map((d) => d.artistName)).toEqual(['Inside']);
    expect(found[0]!.playcount).toBe(2);
  });

  it('counts only the plays inside the window, not the artist lifetime', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'A', trackName: 't', timePlayed: inWindow(0) },
      { userId, artistName: 'A', trackName: 't', timePlayed: inWindow(1) },
      { userId, artistName: 'A', trackName: 't', timePlayed: inWindow(2) },
      // After the window closes: present in `artist_first_plays`, absent from
      // `period_plays`, so it must not reach the count.
      { userId, artistName: 'A', trackName: 't', timePlayed: inWindow(40) },
    ]);

    const [found] = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    expect(found!.playcount).toBe(3);
  });

  it('includes a play exactly on each window boundary and excludes one millisecond outside', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'StartEdge', trackName: 't', timePlayed: WINDOW_START },
      { userId, artistName: 'EndEdge', trackName: 't', timePlayed: WINDOW_END },
      { userId, artistName: 'JustBefore', trackName: 't', timePlayed: inWindow(0, -1) },
      { userId, artistName: 'JustAfter', trackName: 't', timePlayed: inWindow(29, 1) },
    ]);

    const found = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    // The bounds are `>=` and `<=`, so both edges are inside.
    expect(found.map((d) => d.artistName).sort()).toEqual(['EndEdge', 'StartEdge']);
    const start = found.find((d) => d.artistName === 'StartEdge');
    const end = found.find((d) => d.artistName === 'EndEdge');
    expect(start!.firstPlay).toEqual(WINDOW_START);
    expect(end!.firstPlay).toEqual(WINDOW_END);
    expect(start!.playcount).toBe(1);
    expect(end!.playcount).toBe(1);
  });

  it('omits an artist whose first-ever play predates the window', async () => {
    // The outer `WHERE a.first_play >= $2 AND a.first_play <= $3` decides
    // this, and it decides it the OTHER way round from a first glance at the
    // two CTEs suggests. `first_play` IS the all-time MIN, but the outer
    // filter then discards any artist whose MIN predates the window - so the
    // two-CTE shape cannot surface a pre-window first play. This artist is
    // DROPPED, not reported with its earlier date. Read getDiscoveries' SQL
    // again before "simplifying" that WHERE away.
    await seedPlays(prisma!, [
      { userId, artistName: 'Established', trackName: 't', timePlayed: inWindow(-1) },
      { userId, artistName: 'Established', trackName: 't', timePlayed: inWindow(3) },
    ]);

    // Control: the rows really are there, so the absence below is not vacuous.
    expect(await prisma!.userPlay.count({ where: { artistName: 'Established' } })).toBe(2);

    const found = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);
    expect(found.map((d) => d.artistName)).not.toContain('Established');
  });

  it('omits an artist with no play inside the window', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Absent', trackName: 't', timePlayed: inWindow(-2) },
      { userId, artistName: 'Absent', trackName: 't', timePlayed: inWindow(-1) },
    ]);

    await expect(service!.getDiscoveries(userId, WINDOW_START, WINDOW_END)).resolves.toEqual([]);
  });

  it('reports the artist earliest play overall as firstPlay, not the most recent', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Early', trackName: 't', timePlayed: inWindow(9) },
      { userId, artistName: 'Early', trackName: 't', timePlayed: inWindow(1) },
      { userId, artistName: 'Early', trackName: 't', timePlayed: inWindow(5) },
    ]);

    const [found] = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    expect(found!.firstPlay).toEqual(inWindow(1));
    expect(found!.playcount).toBe(3);
  });

  it('joins the two CTEs on a lowercased artist name', async () => {
    // `artist_first_plays` and `period_plays` each GROUP BY artist_name
    // exactly, while the join compares LOWER() - so a mixed-case artist is two
    // groups per side and the join fans out. The assertion is deliberately
    // about the SET of names rather than the row count: it proves the join is
    // case-insensitive today and will keep passing if the fan-out is ever
    // fixed. The fan-out itself is a live finding, not something to lock in.
    await seedPlays(prisma!, [
      { userId, artistName: 'Radiohead', trackName: 't', timePlayed: inWindow(0) },
      { userId, artistName: 'Radiohead', trackName: 't', timePlayed: inWindow(1) },
      { userId, artistName: 'radiohead', trackName: 't', timePlayed: inWindow(2) },
    ]);

    const found = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    expect(found.length).toBeGreaterThan(0);
    expect([...new Set(found.map((d) => d.artistName.toLowerCase()))]).toEqual(['radiohead']);
  });

  it('returns playcount as a number, not a bigint', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Solo', trackName: 't', timePlayed: inWindow(0) },
    ]);

    const [found] = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    // COUNT(*)::bigint arrives as a BigInt; the map has to convert it.
    expect(typeof found!.playcount).toBe('number');
  });

  it('orders discoveries by in-window playcount descending', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Rare', trackName: 't', timePlayed: inWindow(0) },
      { userId, artistName: 'Common', trackName: 't', timePlayed: inWindow(0) },
      { userId, artistName: 'Common', trackName: 't', timePlayed: inWindow(1) },
      { userId, artistName: 'Common', trackName: 't', timePlayed: inWindow(2) },
    ]);

    const found = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);

    expect(found.map((d) => d.artistName)).toEqual(['Common', 'Rare']);
    expect(found.map((d) => d.playcount)).toEqual([3, 1]);
  });

  it('does not leak one user plays into another discoveries', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      { userId, artistName: 'Mine', trackName: 't', timePlayed: inWindow(0) },
      { userId: other, artistName: 'Theirs', trackName: 't', timePlayed: inWindow(0) },
    ]);

    const mine = await service!.getDiscoveries(userId, WINDOW_START, WINDOW_END);
    const theirs = await service!.getDiscoveries(other, WINDOW_START, WINDOW_END);

    expect(mine.map((d) => d.artistName)).toEqual(['Mine']);
    expect(theirs.map((d) => d.artistName)).toEqual(['Theirs']);
  });
});
