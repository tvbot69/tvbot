import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TopTrack } from '@domain/models/topLists';
import { TrackService } from '@bot/services/library/trackService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../../testSupport/dbHarness';

/**
 * The three raw queries behind the track top-lists.
 *
 * Each one is a thing a mock cannot check. `LOWER(artist_name) = LOWER($2)`
 * is a case-insensitive comparison that a fake `findMany` agrees with no
 * matter what the code says. `COUNT(*)::bigint` comes back as a `bigint` and
 * only becomes a `number` because of a `Number()` in a `.map`. And the
 * 20-day cutoff in getRecentTopTracks is `Date.now()` arithmetic computed
 * inside the method, so a fixture has to be seeded relative to the clock.
 *
 * Positional constructors are the other trap, and this one is worse than
 * artistsService's: `prisma` is the SEVENTH parameter here, not the fifth or
 * the first. Passing it first compiles fine when the other six are `as never`,
 * and then every query fails inside the service's own `catch { return [] }` -
 * which is indistinguishable from "this user has no plays". That failure mode
 * has already cost this repo a test file that went 8/9 red for exactly this
 * reason.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: TrackService | null = null;
let userId = 1;

const at = (iso: string) => new Date(iso);
const DAY = 86400000;

/**
 * `count` plays of one track, one second apart.
 *
 * The seconds are padded rather than derived from an index offset because the
 * dedup index on user_plays is (user_id, time_played, lower(artist),
 * lower(track), play_source) and deliberately EXCLUDES user_play_id. Two
 * fixtures in the same second are ONE row no matter how many distinct ids they
 * were given, so a "play the same track twice" fixture that forgets this
 * silently becomes a single play and the assertion below it passes for the
 * wrong reason.
 */
const plays = (artist: string, track: string, count: number, album?: string) =>
  Array.from({ length: count }, (_, i) => ({
    userId,
    artistName: artist,
    trackName: track,
    albumName: album,
    timePlayed: at(`2021-01-01T00:00:${String(i).padStart(2, '0')}Z`),
  }));

/**
 * `count` plays of DISTINCT tracks, all in the same second.
 *
 * The dedup identity includes lower(track), so distinct names are distinct
 * rows at one timestamp - which is what makes a 101-row fixture cheap.
 */
const distinctTracks = (artist: string, count: number, iso: string) =>
  Array.from({ length: count }, (_, i) => ({
    userId,
    artistName: artist,
    trackName: `Track ${i}`,
    timePlayed: at(iso),
  }));

/**
 * Relative to the clock, because the 20-day cutoff is computed from Date.now().
 *
 * The `seconds` offset is load-bearing, not decoration. `Date.now()` has
 * millisecond resolution, so two `daysAgo(1)` calls made in the same tick are
 * the SAME instant - and `user_plays_identity_uniq` coalesces a NULL track name
 * and an empty one into one key, which makes a NULL/empty pair at one instant a
 * 23505 rather than two rows. Distinct offsets make the rows distinct by
 * construction; two of them can only collide if the clock moved backwards
 * between calls, which a 1s offset against a millisecond clock cannot do.
 */
const daysAgo = (days: number, seconds = 0): Date =>
  new Date(Date.now() - days * DAY + seconds * 1000);

/** seedUser derives this, so the two have to agree for the findFirst to find a row. */
const discordIdFor = (id: number) => String(BigInt(id) * 1000n);

/**
 * A cache double that records what it was asked to do.
 *
 * The threshold in getUserAllTimeTopTracks is `tracks.length > 100` and the TTL
 * in getRecentTopTracks is 120, and neither is visible in the return value -
 * a stub that ignores writes makes both untestable.
 */
const cacheState = {
  store: new Map<string, unknown>(),
  gets: [] as string[],
  sets: [] as Array<{ key: string; value: unknown; ttl: number | undefined }>,
};
const cache = {
  get: async (key: string): Promise<unknown> => {
    cacheState.gets.push(key);
    return cacheState.store.get(key) ?? null;
  },
  set: async (key: string, value: unknown, ttl?: number): Promise<void> => {
    cacheState.sets.push({ key, value, ttl });
    cacheState.store.set(key, value);
  },
};

/** A catalogue row, created through the Prisma model so the FK and casts are Prisma's problem. */
const seedCatalogueTrack = async (name: string): Promise<void> => {
  const artist = await prisma!.artist.create({ data: { name: `Probe ${name}` } });
  await prisma!.track.create({ data: { artistId: artist.artistId, name } });
};

suite('TrackService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    // prisma is the SEVENTH parameter. The other six are unused by the three
    // queries under test, so they go in as `as never` - which is exactly what
    // makes a miscounted position compile cleanly.
    service = new TrackService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      cache as never,
      prisma,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await seedUser(prisma, userId);
    cacheState.store.clear();
    cacheState.gets.length = 0;
    cacheState.sets.length = 0;
  });

  // ---------------------------------------------------------------- L302 ---

  it('returns an empty list rather than failing when the user has no plays', async () => {
    await expect(service!.getUserAllTimeTopTracks(userId)).resolves.toEqual([]);
    await expect(service!.getArtistUserTracks(userId, 'Nobody')).resolves.toEqual([]);
  });

  it('ranks all-time tracks by playcount, grouped by track AND artist', async () => {
    await seedPlays(prisma!, [
      ...plays('Rare', 'Rare Track', 1),
      ...plays('Common', 'Top Track', 3),
      // Same track name, different artist: the GROUP BY is (track, artist), so
      // these are two rows and not one merged count.
      ...plays('Other Artist', 'Top Track', 2),
    ]);
    const result = await service!.getUserAllTimeTopTracks(userId);
    expect(result[0]).toEqual({ name: 'Top Track', artistName: 'Common', playcount: 3 });
    expect(result[1]).toEqual({ name: 'Top Track', artistName: 'Other Artist', playcount: 2 });
    expect(result[2]).toEqual({ name: 'Rare Track', artistName: 'Rare', playcount: 1 });
  });

  it('drops a NULL or empty track name from the all-time list', async () => {
    await seedPlays(prisma!, [
      ...plays('Artist', 'Real Track', 1),
      { userId, artistName: 'Artist', trackName: null, timePlayed: at('2021-03-01T00:00:00Z') },
      { userId, artistName: 'Artist', trackName: '', timePlayed: at('2021-03-01T00:00:01Z') },
    ]);
    const tracks = await service!.getUserAllTimeTopTracks(userId);
    expect(tracks.map((t) => t.name)).toEqual(['Real Track']);
  });

  it('does not leak another user plays into the all-time list', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      ...plays('Mine', 'My Track', 2),
      { userId: other, artistName: 'Theirs', trackName: 'Their Track', timePlayed: at('2021-04-01T00:00:00Z') },
    ]);
    const mine = await service!.getUserAllTimeTopTracks(userId);
    expect(mine.map((t) => t.name)).toEqual(['My Track']);
    expect(mine[0]?.playcount).toBe(2);
  });

  it('converts the bigint playcount to a JS number', async () => {
    // COUNT(*)::bigint arrives as a bigint. The map has to Number() it or every
    // downstream comparison silently does string maths.
    await seedPlays(prisma!, plays('Solo', 't', 2));
    const [first] = await service!.getUserAllTimeTopTracks(userId);
    expect(typeof first?.playcount).toBe('number');
  });

  it('writes to the cache only above 100 rows, with a 600s TTL', async () => {
    // The threshold is `tracks.length > 100`, so 100 is not enough and 101 is.
    // Both halves run in one test because the boundary is the entire claim.
    await seedPlays(prisma!, distinctTracks('Catalog', 100, '2021-05-01T00:00:00Z'));
    expect(await service!.getUserAllTimeTopTracks(userId)).toHaveLength(100);
    expect(cacheState.sets).toHaveLength(0);

    await seedPlays(prisma!, [
      { userId, artistName: 'Catalog', trackName: 'Track 100', timePlayed: at('2021-05-01T00:00:00Z') },
    ]);
    expect(await service!.getUserAllTimeTopTracks(userId)).toHaveLength(101);
    expect(cacheState.sets).toHaveLength(1);
    expect(cacheState.sets[0]?.key).toBe(`user-${userId}-toptracks-alltime`);
    expect(cacheState.sets[0]?.ttl).toBe(600);
  });

  it('serves the all-time list from the cache when useCache is on', async () => {
    const sentinel: TopTrack[] = [{ name: 'Cached', artistName: 'From Cache', playcount: 42 }];
    cacheState.store.set(`user-${userId}-toptracks-alltime`, sentinel);
    // No plays seeded: a real query would return [], so a hit proves the short-circuit.
    expect(await service!.getUserAllTimeTopTracks(userId, true)).toEqual(sentinel);
    expect(cacheState.gets).toContain(`user-${userId}-toptracks-alltime`);

    // And the default is to ignore the cache entirely.
    expect(await service!.getUserAllTimeTopTracks(userId)).toEqual([]);
  });

  // ---------------------------------------------------------------- L340 ---

  it('matches the artist name case-insensitively', async () => {
    // The whole reason this file exists: `LOWER(artist_name) = LOWER($2)`.
    // A case-SENSITIVE rewrite still passes every mock-based test in the repo.
    await seedPlays(prisma!, plays('Radiohead', 'Airbag', 1));
    expect(await service!.getArtistUserTracks(userId, 'radiohead')).toHaveLength(1);
    expect(await service!.getArtistUserTracks(userId, 'RADIOHEAD')).toHaveLength(1);
    expect(await service!.getArtistUserTracks(userId, 'rAdIoHeAd')).toHaveLength(1);
  });

  it('excludes a different artist', async () => {
    await seedPlays(prisma!, [
      ...plays('Radiohead', 'Airbag', 1),
      ...plays('Portishead', 'Glory Box', 1),
    ]);
    const tracks = await service!.getArtistUserTracks(userId, 'Radiohead');
    expect(tracks.map((t) => t.name)).toEqual(['Airbag']);
  });

  it('treats two spellings of one artist as the same artist', async () => {
    // LOWER on both sides means 'Radiohead' and 'RADIOHEAD' are one group, so
    // the counts combine. A case-sensitive rewrite would split them into two.
    await seedPlays(prisma!, [
      ...plays('Radiohead', 'Airbag', 1),
      ...plays('RADIOHEAD', 'Airbag', 1).map((p) => ({ ...p, timePlayed: at('2021-06-01T00:00:00Z') })),
    ]);
    const tracks = await service!.getArtistUserTracks(userId, 'radiohead');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({ name: 'Airbag', playcount: 2 });
  });

  it('drops a NULL track name but keeps an empty one', async () => {
    // Asymmetric on purpose, and pinned so it stays a decision rather than an
    // accident: this query filters `IS NOT NULL` but NOT `!= ''`, unlike
    // getUserAllTimeTopTracks which drops both. Distinct seconds, because the
    // dedup index coalesces NULL and '' into one key at the same timestamp.
    await seedPlays(prisma!, [
      ...plays('Artist', 'Real Track', 1),
      { userId, artistName: 'Artist', trackName: null, timePlayed: at('2021-07-01T00:00:00Z') },
      { userId, artistName: 'Artist', trackName: '', timePlayed: at('2021-07-01T00:00:01Z') },
    ]);
    const tracks = await service!.getArtistUserTracks(userId, 'Artist');
    expect(tracks.map((t) => t.name).sort()).toEqual(['', 'Real Track']);
  });

  it('scopes the artist track list to one user', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      ...plays('Shared', 'Mine', 1),
      { userId: other, artistName: 'Shared', trackName: 'Theirs', timePlayed: at('2021-08-01T00:00:00Z') },
    ]);
    const mine = await service!.getArtistUserTracks(userId, 'Shared');
    expect(mine.map((t) => t.name)).toEqual(['Mine']);
  });

  it('honours the LIMIT of 50 artist tracks', async () => {
    await seedPlays(prisma!, distinctTracks('Prolific', 51, '2021-09-01T00:00:00Z'));
    expect(await service!.getArtistUserTracks(userId, 'Prolific')).toHaveLength(50);
  });

  // ------------------------------------------------- array marshalling ----

  it('sends the track-name list as a real text[] parameter', async () => {
    // `WHERE name = ANY($1::text[])` needs a real array parameter, and Prisma
    // sends parameters untyped - so the cast is what makes a JS string[] arrive
    // as a text[]. No service query does this any more (the audio-feature one
    // that did selected columns `tracks` does not have, and was deleted), but
    // the marshalling is a fact about $queryRawUnsafe worth keeping pinned.
    await seedCatalogueTrack(`In The Array ${userId}`);
    const rows = await prisma!.$queryRawUnsafe<Array<{ name: string }>>(
      'SELECT name FROM tracks WHERE name = ANY($1::text[])',
      [`In The Array ${userId}`, `Not A Row ${userId}`],
    );
    expect(rows.map((r) => r.name)).toEqual([`In The Array ${userId}`]);
  });

  // ---------------------------------------------------------------- L442 ---

  it('includes plays inside the 20-day window and excludes older ones', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Recent', trackName: 'This Week', timePlayed: daysAgo(1) },
      { userId, artistName: 'Recent', trackName: 'Nineteen Days', timePlayed: daysAgo(19) },
      { userId, artistName: 'Recent', trackName: 'Twenty-One Days', timePlayed: daysAgo(21) },
      { userId, artistName: 'Recent', trackName: 'Last Year', timePlayed: daysAgo(400) },
    ]);
    const names = (await service!.getRecentTopTracks(discordIdFor(userId), false)).map((t) => t.name);
    expect(names.sort()).toEqual(['Nineteen Days', 'This Week']);
  });

  it('returns an empty list for a discord id that is not registered', async () => {
    await seedPlays(prisma!, plays('Recent', 't', 1));
    // The user.findFirst runs first and returns nothing, so the query never runs.
    const unknown = discordIdFor(userId) + '7';
    expect(await service!.getRecentTopTracks(unknown, false)).toEqual([]);
  });

  it('drops a NULL or empty track name from the recent list', async () => {
    // Distinct seconds, and the reason is the dedup index rather than taste:
    // `coalesce(lower(track_name), '')` maps NULL and '' onto ONE key, so at a
    // single instant these two rows are the same row. The identity deliberately
    // excludes user_play_id, so re-iding the second insert does not help - only
    // a different instant does. The all-time and artist-track copies of this
    // fixture get it right for the same reason.
    await seedPlays(prisma!, [
      { userId, artistName: 'Artist', trackName: 'Real Track', timePlayed: daysAgo(1) },
      { userId, artistName: 'Artist', trackName: null, timePlayed: daysAgo(1, 1) },
      { userId, artistName: 'Artist', trackName: '', timePlayed: daysAgo(1, 2) },
    ]);
    const tracks = await service!.getRecentTopTracks(discordIdFor(userId), false);
    expect(tracks.map((t) => t.name)).toEqual(['Real Track']);
  });

  it('groups recent plays by artist and track and ranks by playcount', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Common', trackName: 'Top', timePlayed: daysAgo(2) },
      { userId, artistName: 'Common', trackName: 'Top', timePlayed: new Date(daysAgo(2).getTime() - 1000) },
      { userId, artistName: 'Common', trackName: 'Top', timePlayed: new Date(daysAgo(2).getTime() - 2000) },
      { userId, artistName: 'Other', trackName: 'Top', timePlayed: daysAgo(1) },
    ]);
    const tracks = await service!.getRecentTopTracks(discordIdFor(userId), false);
    expect(tracks[0]).toEqual({ name: 'Top', artistName: 'Common', playcount: 3 });
    expect(tracks[1]).toEqual({ name: 'Top', artistName: 'Other', playcount: 1 });
  });

  it('converts the recent bigint playcount to a JS number', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Solo', trackName: 't', timePlayed: daysAgo(1) },
      { userId, artistName: 'Solo', trackName: 't', timePlayed: new Date(daysAgo(1).getTime() - 1000) },
    ]);
    const [first] = await service!.getRecentTopTracks(discordIdFor(userId), false);
    expect(typeof first?.playcount).toBe('number');
  });

  it('writes the recent list to the cache with a 120s TTL even when empty', async () => {
    await service!.getRecentTopTracks(discordIdFor(userId), false);
    expect(cacheState.sets).toHaveLength(1);
    expect(cacheState.sets[0]?.key).toBe(`user-recent-top-tracks-${discordIdFor(userId)}`);
    expect(cacheState.sets[0]?.ttl).toBe(120);
    expect(cacheState.sets[0]?.value).toEqual([]);
  });

  it('serves the recent list from the cache when one is there', async () => {
    const discordId = discordIdFor(userId);
    const sentinel: TopTrack[] = [{ name: 'Cached', artistName: 'From Cache', playcount: 9 }];
    cacheState.store.set(`user-recent-top-tracks-${discordId}`, sentinel);
    expect(await service!.getRecentTopTracks(discordId, true)).toEqual(sentinel);
    expect(cacheState.gets).toContain(`user-recent-top-tracks-${discordId}`);
  });

  it('skips the cache read when cacheEnabled is false but still writes', async () => {
    const discordId = discordIdFor(userId);
    await seedPlays(prisma!, [
      { userId, artistName: 'Direct', trackName: 'Straight From Postgres', timePlayed: daysAgo(1) },
    ]);
    // The cached value is deliberately wrong, so returning it would mean the
    // read happened.
    cacheState.store.set(`user-recent-top-tracks-${discordId}`, []);
    const tracks = await service!.getRecentTopTracks(discordId, false);
    expect(tracks.map((t) => t.name)).toEqual(['Straight From Postgres']);
    expect(cacheState.gets).toHaveLength(0);
    expect(cacheState.sets).toHaveLength(1);
  });

  it('maps the recent list to artistName/trackName for autocomplete', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Boards', trackName: 'Roygbiv', timePlayed: daysAgo(1) },
    ]);
    expect(await service!.getRecentTopTracksAutoComplete(discordIdFor(userId), false)).toEqual([
      { artistName: 'Boards', trackName: 'Roygbiv' },
    ]);
  });

  it('uses the (user_id, lower(artist)) index for the artist track list', async () => {
    // Mirrors getArtistUserTracks. Mutation check: dropping the migration
    // removes the index from pg_indexes (red), while plan-choice on a tiny
    // table is not deterministic — EXPLAIN may pick any valid index even
    // with enable_seqscan=OFF — so the plan name itself is not asserted.
    await seedPlays(prisma!, plays('Radiohead', 'Airbag', 2));
    const sql =
      'SELECT track_name, COUNT(*)::bigint AS playcount FROM user_plays ' +
      'WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND track_name IS NOT NULL ' +
      'GROUP BY track_name ORDER BY playcount DESC LIMIT 50';
    const rows = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = OFF');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF) ${sql}`,
        userId,
        'Radiohead',
      );
    });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).not.toContain('Seq Scan');
    const indexes = await prisma!.$queryRawUnsafe<Array<{ indexname: string }>>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_plays'",
    );
    expect(indexes.map((r) => r.indexname)).toContain('user_plays_user_lower_artist_idx');
  });

  it('uses the (user_id, lower(artist), lower(track)) index for the track week/month window', async () => {
    // Same week/month window shape as PlayRepository.getRecentEntityPlaycounts
    // with trackName supplied. Proves the track composite serves it here too.
    await seedPlays(prisma!, plays('Radiohead', 'Airbag', 2));
    const monthAgo = new Date('2024-02-01T00:00:00.000Z');
    const weekAgo = new Date('2024-02-20T00:00:00.000Z');
    const sql =
      'SELECT (COUNT(*) FILTER (WHERE time_played >= $5))::int AS week, COUNT(*)::int AS month ' +
      'FROM user_plays WHERE user_id = $1 AND time_played >= $2 AND LOWER(artist_name) = LOWER($3) ' +
      'AND LOWER(track_name) = LOWER($4)';
    const rows = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = OFF');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF) ${sql}`,
        userId,
        monthAgo,
        'Radiohead',
        'Airbag',
        weekAgo,
      );
    });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('user_plays_user_lower_artist_track_idx');
    expect(plan).not.toContain('Seq Scan');
  });
});
