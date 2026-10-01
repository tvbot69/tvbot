import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AlbumService } from '../albumService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The four raw queries behind the album top-lists, executed by a real Postgres.
 *
 * A mock cannot catch the failure mode this suite exists for. Every one of
 * these methods ends in a `catch { return [] }`, and three of the four end in a
 * fallback that returns plausible data, so a broken query and a genuinely empty
 * table are the same value. Only the database can tell them apart.
 *
 * The harness is shared on purpose: `seedPlays` owns the parameter casts, and a
 * hand-written INSERT is how this suite's failures get misdiagnosed.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: AlbumService | null = null;
let userId = 1;

const EPOCH = Date.UTC(2021, 0, 1, 0, 0, 0);
/**
 * Distinct instants, derived arithmetically rather than by string formatting.
 *
 * Two reasons, both learned the hard way. Seconds past 59 are not a valid ISO
 * time, so a 101-row fixture cannot be written as `00:00:${i}`. And the
 * `user_plays_identity_uniq` index collapses two plays that share
 * (user, second, artist, track, source) - note album_name is deliberately NOT
 * part of that identity - so every row in a fixture needs its own second.
 */
const at = (offsetSeconds: number): Date => new Date(EPOCH + offsetSeconds * 1000);
const DAY = 24 * 60 * 60 * 1000;

/** The `discord_user_id` that `seedUser` wrote for a given `user_id`. */
const discordIdFor = (id: number): string => String(BigInt(id) * 1000n);

/**
 * A repository double that answers every method with `null`.
 *
 * The four methods under test reach none of these repositories, but handing over
 * a bare `{}` is a trap: an accidental reach throws a TypeError straight into
 * the method's own `catch { return [] }`, which is indistinguishable from "no
 * data" - the exact confusion the constructor note below warns about. Answering
 * `null` instead means a wrong wiring shows up as a wrong answer rather than as
 * a swallowed exception. `then` is excluded so the proxy is never mistaken for
 * a thenable.
 */
const nullRepository = (): unknown =>
  new Proxy({}, {
    get: (target, prop) =>
      typeof prop === 'string' && prop !== 'then'
        ? async (): Promise<null> => null
        : Reflect.get(target, prop),
  });

/** A cache double that records every access, so the cache gates are provable. */
const cacheGets: string[] = [];
const cacheSets: Array<{ key: string; value: unknown; ttl?: number }> = [];
/** Pre-armed cache payload, so the cache-hit paths can be exercised for real. */
const armed = { value: null as unknown };
const cache = {
  get: async (key: string): Promise<unknown> => {
    cacheGets.push(key);
    return armed.value;
  },
  set: async (key: string, value: unknown, ttl?: number): Promise<void> => {
    cacheSets.push({ key, value, ttl });
  },
};

/**
 * Recorded calls into the two resolution steps that run BEFORE the L618
 * fallback. They are the reason the fallback has to be forced rather than
 * assumed: with a tracklist from either source, the method returns at step 2 or
 * 3 and never reaches the raw query.
 */
const lastfmLookups: Array<[string, string]> = [];
const spotifyLookups: Array<[string, string, number]> = [];

suite('AlbumService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    // TEN parameters, and prisma is the EIGHTH - not the first, not the last.
    // Getting this wrong compiles fine when the rest are `as never`, and then
    // every query fails inside the service's own catch, which looks exactly like
    // a user with no scrobbles.
    service = new AlbumService(
      {
        getAlbumInfo: async (artistName: string, albumName: string) => {
          lastfmLookups.push([artistName, albumName]);
          return null;
        },
      } as never,
      nullRepository() as never,
      nullRepository() as never,
      nullRepository() as never,
      nullRepository() as never,
      nullRepository() as never,
      {
        getAlbumTrackNames: async (albumName: string, artistName: string, limit: number) => {
          spotifyLookups.push([albumName, artistName, limit]);
          return [];
        },
      } as never,
      prisma,
      cache as never,
      undefined,
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
    cacheGets.length = 0;
    cacheSets.length = 0;
    armed.value = null;
    lastfmLookups.length = 0;
    spotifyLookups.length = 0;
  });

  describe('getUserAllTimeTopAlbums (L508)', () => {
    it('returns an empty list rather than failing when the user has no plays', async () => {
      await expect(service!.getUserAllTimeTopAlbums(userId)).resolves.toEqual([]);
    });

    it('ranks albums by playcount descending', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Rare', trackName: 't1', albumName: 'Rare Album', timePlayed: at(0) },
        { userId, artistName: 'Top', trackName: 't2', albumName: 'Top Album', timePlayed: at(1) },
        { userId, artistName: 'Top', trackName: 't3', albumName: 'Top Album', timePlayed: at(2) },
        { userId, artistName: 'Top', trackName: 't4', albumName: 'Top Album', timePlayed: at(3) },
      ]);
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums.map((a) => a.name)).toEqual(['Top Album', 'Rare Album']);
      expect(albums.map((a) => a.playcount)).toEqual([3, 1]);
    });

    it('counts a bigint playcount as a JS number, not a string', async () => {
      // COUNT(*)::bigint comes back as a bigint. Without Number() the map
      // leaks a BigInt, and every downstream comparison does string maths.
      await seedPlays(prisma!, [
        { userId, artistName: 'Solo', trackName: 't', albumName: 'Only', timePlayed: at(0) },
      ]);
      const [first] = await service!.getUserAllTimeTopAlbums(userId);
      expect(typeof first?.playcount).toBe('number');
    });

    it('groups by album AND artist, so one album title under two artists is two rows', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Artist A', trackName: 'a1', albumName: 'Greatest Hits', timePlayed: at(0) },
        { userId, artistName: 'Artist A', trackName: 'a2', albumName: 'Greatest Hits', timePlayed: at(1) },
        { userId, artistName: 'Artist B', trackName: 'b1', albumName: 'Greatest Hits', timePlayed: at(2) },
      ]);
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums.map((a) => `${a.artistName} | ${a.name}`)).toEqual([
        'Artist A | Greatest Hits',
        'Artist B | Greatest Hits',
      ]);
    });

    it('drops a NULL or empty album name rather than listing a blank row', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', albumName: 'Real Album', timePlayed: at(0) },
        { userId, artistName: 'A', trackName: 't2', albumName: '', timePlayed: at(1) },
        { userId, artistName: 'A', trackName: 't3', albumName: null, timePlayed: at(2) },
      ]);
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums.map((a) => a.name)).toEqual(['Real Album']);
    });

    it('scopes the list to one user', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Mine', timePlayed: at(0) },
        { userId: other, artistName: 'A', trackName: 'y', albumName: 'Theirs', timePlayed: at(1) },
      ]);
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums.map((a) => a.name)).toEqual(['Mine']);
    });

    it('does not read the cache unless the caller asks for it', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Cold', timePlayed: at(0) },
      ]);
      await expect(service!.getUserAllTimeTopAlbums(userId, false)).resolves.toHaveLength(1);
      expect(cacheGets).toEqual([]);
    });

    it('serves a cache hit without touching the database', async () => {
      armed.value = [{ name: 'Cached', artistName: 'Cached Artist', playcount: 999 }];
      const albums = await service!.getUserAllTimeTopAlbums(userId, true);
      expect(albums.map((a) => a.name)).toEqual(['Cached']);
      expect(cacheGets).toEqual([`user-${userId}-topalbums-alltime`]);
    });

    it('returns 101 albums, so the LIMIT is 1000 and not the 100-row cache threshold', async () => {
      await seedPlays(prisma!, Array.from({ length: 101 }, (_, i) => ({
        userId,
        artistName: `Bulk Artist ${i}`,
        trackName: `Bulk Track ${i}`,
        albumName: `Bulk Album ${i}`,
        timePlayed: at(i),
      })));
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums).toHaveLength(101);
    });

    it('does not write the cache at exactly 100 albums', async () => {
      // The write is gated on `albums.length > 100`, which is NOT the same
      // number as the query's LIMIT 1000. Pinning the boundary matters: a
      // results cache that only warms on the largest libraries never helps the
      // common case.
      await seedPlays(prisma!, Array.from({ length: 100 }, (_, i) => ({
        userId,
        artistName: `Bulk Artist ${i}`,
        trackName: `Bulk Track ${i}`,
        albumName: `Bulk Album ${i}`,
        timePlayed: at(i),
      })));
      const albums = await service!.getUserAllTimeTopAlbums(userId);
      expect(albums).toHaveLength(100);
      expect(cacheSets).toEqual([]);
    });

    it('writes the cache past 100 albums, even when the caller did not ask for it', async () => {
      await seedPlays(prisma!, Array.from({ length: 101 }, (_, i) => ({
        userId,
        artistName: `Bulk Artist ${i}`,
        trackName: `Bulk Track ${i}`,
        albumName: `Bulk Album ${i}`,
        timePlayed: at(i),
      })));
      await service!.getUserAllTimeTopAlbums(userId, false);
      expect(cacheSets).toHaveLength(1);
      expect(cacheSets[0]?.key).toBe(`user-${userId}-topalbums-alltime`);
      expect(cacheSets[0]?.ttl).toBe(600);
    });
  });

  describe('getTopTracksForAlbum (L618, the album_name fallback)', () => {
    it('only reaches the raw query after Last.fm AND Spotify both come up empty', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Boards of Canada', trackName: 'Music Is Math', albumName: 'Geogaddi', timePlayed: at(0) },
        { userId, artistName: 'Boards of Canada', trackName: 'Telephasian Workshop', albumName: 'Geogaddi', timePlayed: at(1) },
      ]);
      const tracks = await service!.getTopTracksForAlbum('Boards of Canada', 'Geogaddi', 3, userId);
      // Both earlier rungs ran and both declined. Without these assertions a
      // green result would not distinguish "the fallback worked" from "step 1
      // happened to return a tracklist", and the fallback would stay unproven.
      expect(lastfmLookups).toEqual([['Boards of Canada', 'Geogaddi']]);
      expect(spotifyLookups).toEqual([['Geogaddi', 'Boards of Canada', 50]]);
      expect(tracks).toEqual(['Music Is Math', 'Telephasian Workshop']);
    });

    it('matches the artist and the album name case-insensitively', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', albumName: 'Music Has the Right to Children', timePlayed: at(0) },
      ]);
      const lower = await service!.getTopTracksForAlbum('boards of canada', 'music has the right to children', 3, userId);
      const upper = await service!.getTopTracksForAlbum('BOARDS OF CANADA', 'MUSIC HAS THE RIGHT TO CHILDREN', 3, userId);
      expect(lower).toEqual(['Roygbiv']);
      expect(upper).toEqual(['Roygbiv']);
    });

    it('does not leak a track that belongs to a different album or artist', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'Wanted', albumName: 'Right Album', timePlayed: at(0) },
        { userId, artistName: 'A', trackName: 'Wrong Album', albumName: 'Other Album', timePlayed: at(1) },
        { userId, artistName: 'B', trackName: 'Wrong Artist', albumName: 'Right Album', timePlayed: at(2) },
      ]);
      const tracks = await service!.getTopTracksForAlbum('A', 'Right Album', 10, userId);
      expect(tracks).toEqual(['Wanted']);
    });

    it('orders the fallback by playcount and honours the LIMIT parameter', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'One', albumName: 'Lp', timePlayed: at(0) },
        { userId, artistName: 'A', trackName: 'One', albumName: 'Lp', timePlayed: at(1) },
        { userId, artistName: 'A', trackName: 'One', albumName: 'Lp', timePlayed: at(2) },
        { userId, artistName: 'A', trackName: 'Two', albumName: 'Lp', timePlayed: at(3) },
        { userId, artistName: 'A', trackName: 'Two', albumName: 'Lp', timePlayed: at(4) },
        { userId, artistName: 'A', trackName: 'Three', albumName: 'Lp', timePlayed: at(5) },
        { userId, artistName: 'A', trackName: 'Four', albumName: 'Lp', timePlayed: at(6) },
        { userId, artistName: 'A', trackName: 'Five', albumName: 'Lp', timePlayed: at(7) },
      ]);
      // LIMIT is bound as $4, so a wrong arity or a non-numeric bind shows up
      // as a Postgres error that the method's catch would otherwise hide.
      await expect(service!.getTopTracksForAlbum('A', 'Lp', 2, userId)).resolves.toEqual(['One', 'Two']);
      await expect(service!.getTopTracksForAlbum('A', 'Lp', 1, userId)).resolves.toEqual(['One']);
      await expect(service!.getTopTracksForAlbum('A', 'Lp', 99, userId)).resolves.toHaveLength(5);
    });

    it('drops a NULL or empty track name from the fallback', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'Real', albumName: 'Lp', timePlayed: at(0) },
        { userId, artistName: 'A', trackName: '', albumName: 'Lp', timePlayed: at(1) },
        { userId, artistName: 'A', trackName: null, albumName: 'Lp', timePlayed: at(2) },
      ]);
      const tracks = await service!.getTopTracksForAlbum('A', 'Lp', 10, userId);
      expect(tracks).toEqual(['Real']);
    });

    it('scopes the fallback to one user', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'Mine', albumName: 'Lp', timePlayed: at(0) },
        { userId: other, artistName: 'A', trackName: 'Theirs', albumName: 'Lp', timePlayed: at(1) },
      ]);
      const tracks = await service!.getTopTracksForAlbum('A', 'Lp', 10, userId);
      expect(tracks).toEqual(['Mine']);
    });

    it('returns [] for a global call even when matching plays exist', async () => {
      // The fallback is inside `if (userId)`. A global caller reaches the end
      // and gets nothing, which is only correct while the two earlier rungs are
      // still the normal path - worth pinning so a change to that gate is loud.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'Real', albumName: 'Lp', timePlayed: at(0) },
      ]);
      await expect(service!.getTopTracksForAlbum('A', 'Lp')).resolves.toEqual([]);
    });

    it('returns [] when nothing matches the album', async () => {
      await expect(service!.getTopTracksForAlbum('Nobody', 'Nothing', 3, userId)).resolves.toEqual([]);
    });
  });

  describe('getUserAllTimeTopAlbumsByReleasePrefix (L647)', () => {
    /**
     * Seed a real artist -> album -> user_album chain through the Prisma model.
     *
     * This is the only query here that needs a second table, and it is seeded
     * with the models rather than raw SQL on purpose: `user_albums.album_id`
     * and `albums.album_id` are declared, not spelled, and a raw INSERT would
     * let a column-name mistake masquerade as a production bug.
     */
    const seedTopAlbum = async (
      artistName: string,
      albumName: string,
      playcount: number,
      releaseDate: Date | null,
      albumType: string | null = 'album',
    ): Promise<void> => {
      const artist = await prisma!.artist.create({ data: { name: artistName } });
      const album = await prisma!.album.create({
        data: {
          artistId: artist.artistId,
          name: albumName,
          releaseDate,
          spotifyAlbumType: albumType,
        },
      });
      await prisma!.userAlbum.create({
        data: { userId, albumId: album.albumId, name: albumName, playcount },
      });
    };

    it('returns only the albums whose release year matches the prefix', async () => {
      // Was: 'returns nothing even though the user has top albums, because the
      // join cannot execute' - a test that asserted the bug. Three rows exist in
      // user_albums and one matches the prefix, so the correct answer is that one
      // row, and it now comes back. Driving the real method, not a hand-written
      // copy of the query, so a regression in albumService.ts fails this.
      await seedTopAlbum('Slowdive', 'Souvlaki', 40, new Date('1993-04-27'));
      await seedTopAlbum('Boards of Canada', 'Geogaddi', 30, new Date('2002-02-11'));
      const albums = await service!.getUserAllTimeTopAlbumsByReleasePrefix(userId, '1993', 4);
      expect(albums.map((a) => a.name)).toEqual(['Souvlaki']);
      expect(albums[0]?.artistName).toBe('Slowdive');
      expect(albums[0]?.playcount).toBe(40);
      expect(albums[0]?.releaseDate).toBeInstanceOf(Date);
    });

    it('excludes an album outside the prefix instead of returning it anyway', async () => {
      // Was: 'silently ignores the release prefix and returns the unfiltered
      // all-time list' - the user-visible symptom, asking for the 90s and being
      // handed a 2020s album in a confident embed. The fallback in the catch
      // branch returned unfiltered data, so a failed query looked like a
      // working filter. The 2020s album is seeded as a real user_albums row so
      // that returning it would mean the filter is not applied, not that the row
      // is missing.
      await seedTopAlbum('Slowdive', 'Souvlaki', 40, new Date('1993-04-27'));
      await seedTopAlbum('Caroline Polachek', 'Pang', 90, new Date('2019-06-14'));
      const albums = await service!.getUserAllTimeTopAlbumsByReleasePrefix(userId, '1993', 4);
      expect(albums.map((a) => a.name)).toEqual(['Souvlaki']);
    });

    it('orders by playcount and honours the prefixLength parameter', async () => {
      // The 42883 was `function left(text, bigint) does not exist`: $2 arrives as
      // bigint, so the cast to int is load-bearing, and this is what covers it.
      await seedTopAlbum('Slowdive', 'Souvlaki', 40, new Date('1993-04-27'));
      await seedTopAlbum('My Bloody Valentine', 'Loveless', 30, new Date('1991-04-22'));
      await seedTopAlbum('Talk Talk', 'Laughing Stock', 50, new Date('1991-11-01'));
      expect((await service!.getUserAllTimeTopAlbumsByReleasePrefix(userId, '1991', 4))
        .map((a) => a.name)).toEqual(['Laughing Stock', 'Loveless']);
      expect((await service!.getUserAllTimeTopAlbumsByReleasePrefix(userId, '199', 3))
        .map((a) => a.name)).toEqual(['Laughing Stock', 'Souvlaki', 'Loveless']);
    });

    it('the albums table has neither an `id` nor a `type` column, which is why the join failed', async () => {
      // Kept as-is. This is the root cause, asked of Postgres rather than of the
      // schema file, so the assertion is a fact about the deployed database and
      // would catch someone "fixing" the query back to a.id / a.type.
      //
      // The L647 query read `a.id`, `a.type` and `ua.artist_name`. The Album
      // model's primary key is mapped to `album_id`, the album type column is
      // `spotify_album_type`, and user_albums has no artist_name at all - the
      // artist name is only reachable through albums.artist_id. Every reference
      // was unresolvable, so the statement failed with 42703 on every call and
      // the method took its `catch` branch every single time.
      const columns = await prisma!.$queryRawUnsafe<Array<{ column_name: string }>>(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'albums'
      `);
      const names = columns.map((c) => c.column_name);
      expect(names).toContain('release_date');
      expect(names).toContain('album_id');
      expect(names).toContain('spotify_album_type');
      expect(names).not.toContain('id');
      expect(names).not.toContain('type');

      const userAlbumColumns = await prisma!.$queryRawUnsafe<Array<{ column_name: string }>>(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'user_albums'
      `);
      // The third leg of the bug: the fix needs a join to artists, because this
      // column genuinely does not exist and cannot be selected from here.
      expect(userAlbumColumns.map((c) => c.column_name)).not.toContain('artist_name');
    });

    it('a null release_date is dropped by INNER JOIN + IS NOT NULL, and a LEFT JOIN keeps it', async () => {
      // Unchanged in intent: the row is genuinely joinable, and the two
      // predicates are what remove it. Keeping such rows is a production
      // change, not something a test can grant.
      await seedTopAlbum('Slowdive', 'Souvlaki', 40, new Date('1993-04-27'));
      await seedTopAlbum('Bootleg', 'Undated Rip', 90, null);
      const undated = await prisma!.album.findFirst({ where: { name: 'Undated Rip' } });

      const innerRows = await prisma!.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT ua.name FROM user_albums ua
        INNER JOIN albums a ON ua.album_id = a.album_id
        WHERE ua.user_id = $1 AND a.release_date IS NOT NULL AND LEFT(a.release_date::text, $2::int) = $3
      `, userId, 3, '199');
      expect(innerRows.map((r) => r.name)).toEqual(['Souvlaki']);

      const leftRows = await prisma!.$queryRawUnsafe<Array<{ name: string; release_date: Date | null }>>(`
        SELECT ua.name, a.release_date FROM user_albums ua
        LEFT JOIN albums a ON ua.album_id = a.album_id
        WHERE ua.user_id = $1
      `, userId);
      const undatedRow = leftRows.find((r) => r.name === 'Undated Rip');
      expect(undatedRow).toBeDefined();
      expect(undatedRow?.release_date).toBeNull();
      expect(undated?.releaseDate).toBeNull();
    });
  });

  describe('getRecentTopAlbums (L816)', () => {
    it('returns [] for a discord id that was never registered', async () => {
      // The user.findFirst guard runs first, so an unknown id never reaches the
      // raw query - including when that user has plenty of recent plays.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Recent', timePlayed: new Date(Date.now() - DAY) },
      ]);
      const unregistered = String(BigInt(userId) * 1000n + 7n);
      await expect(service!.getRecentTopAlbums(unregistered, false)).resolves.toEqual([]);
    });

    it('returns [] for a non-numeric discord id rather than throwing', async () => {
      // BigInt('abc') throws a SyntaxError inside the try block, so the catch
      // returns []. Autocomplete must not surface that as a crash.
      await expect(service!.getRecentTopAlbums('not-a-number', false)).resolves.toEqual([]);
    });

    it('includes plays inside the 20-day window and excludes older ones', async () => {
      const now = Date.now();
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Yesterday', timePlayed: new Date(now - 1 * DAY) },
        { userId, artistName: 'B', trackName: 'y', albumName: 'Ancient', timePlayed: new Date(now - 25 * DAY) },
        { userId, artistName: 'C', trackName: 'z', albumName: 'Also Ancient', timePlayed: new Date(now - 400 * DAY) },
      ]);
      const recent = await service!.getRecentTopAlbums(discordIdFor(userId), false);
      expect(recent.map((r) => r.albumName)).toEqual(['Yesterday']);
    });

    it('drops a NULL or empty album name', async () => {
      const now = Date.now();
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Real', timePlayed: new Date(now - 1 * DAY) },
        { userId, artistName: 'A', trackName: 'y', albumName: '', timePlayed: new Date(now - 2 * DAY) },
        { userId, artistName: 'A', trackName: 'z', albumName: null, timePlayed: new Date(now - 3 * DAY) },
      ]);
      const recent = await service!.getRecentTopAlbums(discordIdFor(userId), false);
      expect(recent.map((r) => r.albumName)).toEqual(['Real']);
    });

    it('scopes the list to the user the discord id resolves to', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      const now = Date.now();
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Mine', timePlayed: new Date(now - 1 * DAY) },
        { userId: other, artistName: 'B', trackName: 'y', albumName: 'Theirs', timePlayed: new Date(now - 1 * DAY) },
      ]);
      const recent = await service!.getRecentTopAlbums(discordIdFor(userId), false);
      expect(recent.map((r) => r.albumName)).toEqual(['Mine']);
    });

    it('caps the list at 25 albums and keeps the most-played ones', async () => {
      const now = Date.now();
      await seedPlays(prisma!, [
        ...Array.from({ length: 26 }, (_, i) => ({
          userId,
          artistName: `Artist ${i}`,
          trackName: `Track ${i}`,
          albumName: i === 0 ? 'Keeper' : `Album ${String(i).padStart(2, '0')}`,
          // A plain single date for 26 rows would collapse under the dedup index.
          timePlayed: new Date(now - (i + 1) * 60_000),
        })),
        // Two plays for one album, one second and one track apart, so the
        // identity is distinct and the playcount is really 2.
        { userId, artistName: 'Artist 0', trackName: 'Track 0b', albumName: 'Keeper', timePlayed: new Date(now - 60_000) },
      ]);
      const recent = await service!.getRecentTopAlbums(discordIdFor(userId), false);
      expect(recent).toHaveLength(25);
      expect(recent.map((r) => r.albumName)).toContain('Keeper');
    });

    it('writes the autocomplete result to the cache with a 120s TTL', async () => {
      const now = Date.now();
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'x', albumName: 'Cached', timePlayed: new Date(now - 1 * DAY) },
      ]);
      const discordId = discordIdFor(userId);
      await service!.getRecentTopAlbums(discordId);
      expect(cacheGets).toEqual([`user-recent-top-albums-${discordId}`]);
      expect(cacheSets).toHaveLength(1);
      expect(cacheSets[0]?.key).toBe(`user-recent-top-albums-${discordId}`);
      expect(cacheSets[0]?.ttl).toBe(120);
    });

    it('serves a cache hit before it even resolves the user', async () => {
      // 'not-a-number' would throw in BigInt() if the cache were skipped, so a
      // successful return also proves the database was never reached.
      armed.value = [{ artistName: 'Cached Artist', albumName: 'Cached Album' }];
      const recent = await service!.getRecentTopAlbums('not-a-number');
      expect(recent).toEqual([{ artistName: 'Cached Artist', albumName: 'Cached Album' }]);
      expect(cacheSets).toEqual([]);
    });
  });
});
