import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TopTrack } from '@domain/models/topLists';
import type { AudioFeaturesOverview } from './trackService';
import { TrackService } from './trackService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../tests/dbHarness';

/**
 * The four raw queries behind the track top-lists.
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

const ZERO_FEATURES: AudioFeaturesOverview = {
  total: 0,
  average: { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0 },
};

/** A catalogue row, created through the Prisma model so the FK and casts are Prisma's problem. */
const seedCatalogueTrack = async (name: string): Promise<void> => {
  const artist = await prisma!.artist.create({ data: { name: `Probe ${name}` } });
  await prisma!.track.create({ data: { artistId: artist.artistId, name } });
};

/**
 * Do the audio-feature columns exist on `tracks`?
 *
 * A static IN list, not a parameterised one, so this probe cannot itself be
 * broken by the array-parameter question it is guarding.
 */
const audioFeatureColumnsExist = async (): Promise<boolean> => {
  const rows = await prisma!.$queryRawUnsafe<Array<{ present: bigint }>>(
    `SELECT count(*)::bigint AS present
       FROM information_schema.columns
      WHERE table_name = 'tracks'
        AND column_name IN ('danceability', 'energy', 'valence', 'tempo', 'acousticness')`,
  );
  return Number(rows[0]?.present ?? 0n) === 5;
};

suite('TrackService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    // prisma is the SEVENTH parameter. The other six are unused by the four
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

  // ---------------------------------------------------------------- L311 ---

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

  // ---------------------------------------------------------------- L343 ---

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

  // ---------------------------------------------------------------- L371 ---

  it('returns the zero shape for an empty input', async () => {
    // Short-circuits before the query, so this holds whatever the schema is.
    expect(await service!.getAverageTrackAudioFeaturesForTopTracks([])).toEqual(ZERO_FEATURES);
  });

  it('returns the zero shape for a track name with no catalogue row', async () => {
    // A real catalogue row exists, so an empty result is the filter working
    // rather than an empty table.
    await seedCatalogueTrack(`Catalogue Hit ${userId}`);
    expect(
      await service!.getAverageTrackAudioFeaturesForTopTracks([
        { name: `No Such Track ${userId}`, artistName: 'Nobody', playcount: 1 },
      ]),
    ).toEqual(ZERO_FEATURES);
  });

  it('sends the track-name list as a real text[] parameter', async () => {
    // The same marshalling the averaging query depends on, run against columns
    // that exist. Prisma sends parameters untyped; `= ANY($1::text[])` is the
    // shape that decides whether a JS string[] arrives as a text[] at all.
    await seedCatalogueTrack(`In The Array ${userId}`);
    const rows = await prisma!.$queryRawUnsafe<Array<{ name: string }>>(
      'SELECT name FROM tracks WHERE name = ANY($1::text[])',
      [`In The Array ${userId}`, `Not A Row ${userId}`],
    );
    expect(rows.map((r) => r.name)).toEqual([`In The Array ${userId}`]);
  });

  it('averages only the rows that carry a valence, treating a NULL field as 0', async () => {
    if (!(await audioFeatureColumnsExist())) {
      // Unreachable today: `tracks` has no audio-feature columns, which the
      // last test in this group asserts and explains. The arithmetic is written
      // out anyway so it starts proving something the moment they land, rather
      // than needing a rewrite.
      return;
    }
    const artist = await prisma!.artist.create({ data: { name: `Averaged ${userId}` } });
    for (const [name, row] of [
      ['A', { danceability: 0.5, energy: 0.7, valence: 0.3, tempo: 120, acousticness: 0.1 }],
      ['B', { danceability: 0.3, energy: 0.5, valence: 0.6, tempo: 100, acousticness: 0.2 }],
      // Valence set, everything else NULL: it is averaged in, contributing zeros.
      ['C', { danceability: null, energy: null, valence: 0.6, tempo: null, acousticness: null }],
    ] as const) {
      const track = await prisma!.track.create({ data: { artistId: artist.artistId, name: `${name} ${userId}` } });
      await prisma!.$executeRawUnsafe(
        `UPDATE tracks SET danceability = $2::real, energy = $3::real, valence = $4::real,
                          tempo = $5::real, acousticness = $6::real WHERE track_id = $1::int4`,
        track.trackId,
        row.danceability,
        row.energy,
        row.valence,
        row.tempo,
        row.acousticness,
      );
    }
    const result = await service!.getAverageTrackAudioFeaturesForTopTracks(
      ['A', 'B', 'C'].map((n) => ({ name: `${n} ${userId}`, artistName: `Averaged ${userId}`, playcount: 1 })),
    );
    expect(result.total).toBe(3);
    expect(result.average).toEqual({
      danceability: 0.267,
      energy: 0.4,
      valence: 0.5,
      tempo: 73,
      acousticness: 0.1,
    });
  });

  it('excludes a catalogue row whose valence is NULL from the average', async () => {
    if (!(await audioFeatureColumnsExist())) return;
    const artist = await prisma!.artist.create({ data: { name: `Null Valence ${userId}` } });
    for (const [name, valence] of [['A', 0.3], ['B', 0.6], ['C', null]] as const) {
      const track = await prisma!.track.create({ data: { artistId: artist.artistId, name: `${name} ${userId}` } });
      await prisma!.$executeRawUnsafe(
        `UPDATE tracks SET danceability = $2::real, valence = $3::real WHERE track_id = $1::int4`,
        track.trackId,
        valence === null ? null : 0.5,
        valence,
      );
    }
    const result = await service!.getAverageTrackAudioFeaturesForTopTracks(
      ['A', 'B', 'C'].map((n) => ({ name: `${n} ${userId}`, artistName: `Null Valence ${userId}`, playcount: 1 })),
    );
    // WHERE valence IS NOT NULL drops C entirely, so it is not a zero in the
    // divisor: total is 2, not 3.
    expect(result.total).toBe(2);
    expect(result.average.valence).toBe(0.45);
    expect(result.average.danceability).toBe(0.5);
  });

  it('returns zero features because tracks has no audio-feature columns to read', async () => {
    // The averaging query selects danceability/energy/valence/tempo/acousticness
    // from `tracks`, and NO migration creates those columns - so it fails with
    // 42703 and the method's own `.catch(() => [])` turns that into the zero
    // shape. This is the bug class the real-Postgres suite exists for: a green
    // build, a green unit suite, and a feature that can never work.
    if (await audioFeatureColumnsExist()) {
      throw new Error(
        'tracks now HAS the audio-feature columns, so this schema fact is obsolete. ' +
          'The two averaging tests above now run their real assertions - delete this one.',
      );
    }
    expect(
      await service!.getAverageTrackAudioFeaturesForTopTracks([
        { name: 'Whatever', artistName: 'Nobody', playcount: 1 },
      ]),
    ).toEqual(ZERO_FEATURES);
  });

  // ---------------------------------------------------------------- L509 ---

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
});
