import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { LibrarySearchService, SearchTab } from '../librarySearchService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The four raw queries in librarySearchService.ts (L34 artists, L55 albums,
 * L79 tracks, L103 plays), executed by a real Postgres.
 *
 * These are the four tabs of the library autocomplete. Every one of them is a
 * `$queryRaw` tagged template wrapping a window function in a CTE, which is
 * the single most under-tested shape a query can have: the unit suite mocks
 * Prisma, so nothing had ever checked that Postgres can parse `ROW_NUMBER()
 * OVER (ORDER BY playcount DESC)` inside a CTE, that `rank` is a legal output
 * name, or that the ILIKE concatenation does not swallow rows.
 *
 * The service reads a module-level `prisma` singleton rather than taking one in
 * its constructor, so the module is mocked to hand it the SCRATCH client. The
 * mock replaces the client only - every statement, parameter and cast under
 * test is the real one from librarySearchService.ts, which is the only thing
 * this file is allowed to be a test OF.
 *
 * ONE PROPERTY OF THIS FILE WORTH READING TWICE: all four queries are written
 * UNQUALIFIED - `FROM user_artists`, `FROM user_plays` and friends. They were
 * `FROM public.user_artists`, and a schema qualifier bypasses `search_path`
 * entirely, so the harness seeding the scratch tables and the query reading
 * `public` agree only when the scratch schema happens to BE `public` - which is
 * what CI configures, and therefore why the defect was invisible until the
 * scratch schema was read properly. Pointed at a non-public scratch schema the
 * suite would seed rows these four queries cannot see, and the failure would be
 * an empty search box rather than an error. Ratcheted shut at the bottom.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: LibrarySearchService | null = null;
let userId = 1;

/**
 * The scratch client, handed to the service through the module mock below.
 *
 * A Proxy rather than a plain object because the service imports the singleton
 * once, at module scope, long before `beforeAll` has connected anything. The
 * trap is what lets that import be live: it resolves `$queryRaw` on the client
 * at CALL time. Functions are bound to the real client, because Prisma's model
 * methods read `this`.
 */
const holder = vi.hoisted(() => ({ client: null as PrismaClient | null }));

vi.mock('@persistence/prismaClient', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      const client = holder.client as unknown as Record<string, unknown> | null;
      if (!client) {
        throw new Error('TEST_DATABASE_URL is not set - the real-Postgres suite needs a database.');
      }
      const value: unknown = client[prop as string];
      if (typeof value === 'function') {
        return (value as (this: unknown, ...args: unknown[]) => unknown).bind(client);
      }
      return value;
    },
  }),
}));

const EPOCH = Date.UTC(2022, 4, 1, 0, 0, 0);

/**
 * Distinct instants, derived arithmetically from one epoch.
 *
 * `user_plays_identity_uniq` is (user_id, time_played, lower(artist_name),
 * coalesce(lower(track_name),''), play_source) and excludes user_play_id, so
 * every seeded play needs its own second or the insert dies 23505. The Plays tab
 * has no time window, so a fixed epoch is fine here - unlike the abuse file,
 * whose predicates are relative to NOW().
 */
const at = (offsetSeconds: number): Date => new Date(EPOCH + offsetSeconds * 1000);

/**
 * A real artists row, because user_artists.artist_id is a foreign key rather
 * than a free integer.
 *
 * The name is used VERBATIM, not suffixed. Two of the tests below search for a
 * phrase that spans the artist and the album ("Radiohead Kid"), and the Albums
 * and Tracks tabs concatenate the catalogue name with the item name - so a
 * uniqueness suffix would sit between the two and the phrase could never match.
 * `artists.name` is UNIQUE, so the fixture only has to be unique within a test,
 * and every test here uses distinct artist names.
 */
const seedCatalogueArtist = async (name: string): Promise<number> => {
  const artist = await prisma!.artist.create({ data: { name } });
  return artist.artistId;
};

const seedTopArtist = async (id: number, name: string, playcount: number): Promise<void> => {
  await prisma!.userArtist.create({
    data: { userId: id, artistId: await seedCatalogueArtist(name), name, playcount },
  });
};

/** An album under a real artist; the Albums tab reads the artist name off `artists`. */
const seedTopAlbum = async (id: number, albumName: string, artistName: string, playcount: number): Promise<void> => {
  const artistId = await seedCatalogueArtist(artistName);
  const album = await prisma!.album.create({ data: { artistId, name: albumName } });
  await prisma!.userAlbum.create({ data: { userId: id, albumId: album.albumId, name: albumName, playcount } });
};

const seedTopTrack = async (id: number, trackName: string, artistName: string, playcount: number): Promise<void> => {
  const artistId = await seedCatalogueArtist(artistName);
  const track = await prisma!.track.create({ data: { artistId, name: trackName } });
  await prisma!.userTrack.create({ data: { userId: id, trackId: track.trackId, name: trackName, playcount } });
};

suite('LibrarySearchService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    holder.client = prisma;
    service = new LibrarySearchService();
  });

  afterAll(async () => {
    holder.client = null;
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await seedUser(prisma!, userId);
  });

  describe('the arguments that must never reach SQL', () => {
    it('returns an empty list for a blank query', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      await expect(service!.search(userId, '', SearchTab.Artists)).resolves.toEqual([]);
      await expect(service!.search(userId, '   ', SearchTab.Plays)).resolves.toEqual([]);
    });

    it('returns an empty list for a user id that is not a real Last.fm id', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      await expect(service!.search(0, 'Radiohead', SearchTab.Artists)).resolves.toEqual([]);
      await expect(service!.search(-5, 'Radiohead', SearchTab.Artists)).resolves.toEqual([]);
    });

    it('returns an empty list for a tab outside the enum', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      await expect(service!.search(userId, 'Radiohead', 99 as SearchTab)).resolves.toEqual([]);
    });
  });

  describe('SearchTab.Artists (L34)', () => {
    it('returns the matching artist with its playcount and rank', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      const rows = await service!.search(userId, 'Radiohead', SearchTab.Artists);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Radiohead');
      expect(rows[0]?.count).toBe(100);
      expect(rows[0]?.rank).toBe(1);
    });

    it('returns an empty list when nothing matches', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      await expect(service!.search(userId, 'Portishead', SearchTab.Artists)).resolves.toEqual([]);
    });

    it('ranks against the WHOLE library, not against the filtered set', async () => {
      // The CTE ranks every artist the user has and the ILIKE is applied
      // outside it. So the top artist does not appear - and the one that does
      // keeps the rank it has in the library, not rank 1 in the results. An
      // autocomplete that renumbered its results on every keystroke would show
      // "1" for everything the user just filtered down to.
      await seedTopArtist(userId, 'Aphex Twin', 300);
      await seedTopArtist(userId, 'Boards of Canada', 200);
      await seedTopArtist(userId, 'Radiohead', 100);
      const rows = await service!.search(userId, 'Radio', SearchTab.Artists);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Radiohead');
      expect(rows[0]?.rank).toBe(3);
    });

    it('orders the matches by playcount descending', async () => {
      await seedTopArtist(userId, 'Radiohead A', 10);
      await seedTopArtist(userId, 'Radiohead B', 50);
      await seedTopArtist(userId, 'Radiohead C', 30);
      const rows = await service!.search(userId, 'Radiohead', SearchTab.Artists);
      expect(rows.map((r) => r.primary)).toEqual(['Radiohead B', 'Radiohead C', 'Radiohead A']);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    });

    it('matches case-insensitively, because the predicate is ILIKE', async () => {
      await seedTopArtist(userId, 'Radiohead', 100);
      // The await is load-bearing. `expect(promise).toHaveLength(1)` inspects the
      // PROMISE object synchronously and fails with "expected Promise{...} to have
      // property 'length'" - a statement about the ORM, not about the search.
      expect((await service!.search(userId, 'radiohead', SearchTab.Artists))).toHaveLength(1);
      expect((await service!.search(userId, 'RADIO', SearchTab.Artists))).toHaveLength(1);
      expect((await service!.search(userId, 'HeAd', SearchTab.Artists))).toHaveLength(1);
    });

    it('treats a % in the query as a wildcard, so it matches everything', async () => {
      // The pattern is built as `%${query}%` and handed to ILIKE, which honours
      // the user's own metacharacters. Not a crash and not a security problem -
      // the scope is still one user - but it means a search for "100%" returns
      // the whole library rather than nothing. Pinned because the fix, if it is
      // wanted, is to escape the input, and this test should be the thing that
      // changes.
      await seedTopArtist(userId, 'Radiohead', 100);
      await seedTopArtist(userId, 'Portishead', 90);
      expect((await service!.search(userId, '%', SearchTab.Artists))).toHaveLength(2);
    });

    it('never leaks another user library', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedTopArtist(userId, 'Mine', 10);
      await seedTopArtist(other, 'Theirs', 999);
      const rows = await service!.search(userId, 'e', SearchTab.Artists);
      expect(rows.map((r) => r.primary)).toEqual(['Mine']);
    });

    it('returns count and rank as JS numbers', async () => {
      // playcount is int4 and rank is `CAST(... AS int)`; if either cast went the
      // consumer would do arithmetic on a BigInt.
      await seedTopArtist(userId, 'Radiohead', 100);
      const [row] = await service!.search(userId, 'Radiohead', SearchTab.Artists);
      expect(typeof row?.count).toBe('number');
      expect(typeof row?.rank).toBe('number');
    });

    it('returns an empty list for a user with an empty library rather than erroring', async () => {
      await expect(service!.search(userId, 'anything', SearchTab.Artists)).resolves.toEqual([]);
    });

    it('caps the result at 100 rows', async () => {
      // 101 matching artists, so a LIMIT of 100 and a LIMIT of 99 or 101 are
      // distinguishable. The autocomplete is driven by this number.
      const names = Array.from({ length: 101 }, (_, i) => `Bulk Artist ${String(i).padStart(3, '0')}`);
      const artists = await prisma!.artist.createMany({
        data: names.map((name) => ({ name: `${name} #bulk` })),
      });
      expect(artists.count).toBe(101);
      const catalogue = await prisma!.artist.findMany({
        where: { name: { endsWith: '#bulk' } },
        orderBy: { artistId: 'asc' },
      });
      expect(catalogue).toHaveLength(101);
      await prisma!.userArtist.createMany({
        data: catalogue.map((artist, i) => ({
          userId,
          artistId: artist.artistId,
          name: names[i] ?? '',
          playcount: 101 - i,
        })),
      });
      expect(await service!.search(userId, 'Bulk Artist', SearchTab.Artists)).toHaveLength(100);
    });
  });

  describe('SearchTab.Albums (L55)', () => {
    it('returns the album with the artist name as the secondary line', async () => {
      await seedTopAlbum(userId, 'Kid A', 'Radiohead', 100);
      const rows = await service!.search(userId, 'Kid A', SearchTab.Albums);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Kid A');
      expect(rows[0]?.secondary).toBe('Radiohead');
      expect(rows[0]?.count).toBe(100);
      expect(rows[0]?.rank).toBe(1);
    });

    it('returns an empty list when nothing matches', async () => {
      await seedTopAlbum(userId, 'Kid A', 'Radiohead', 100);
      await expect(service!.search(userId, 'Amnesiac', SearchTab.Albums)).resolves.toEqual([]);
    });

    it('matches the ARTIST name too, because the ILIKE spans both columns', async () => {
      // `(artist_name || ' ' || name) ILIKE '%radiohead%'` is what makes typing
      // an artist surface their albums. Dropping the artist from the predicate
      // would leave the tab working and useless.
      await seedTopAlbum(userId, 'Kid A', 'Radiohead', 100);
      await seedTopAlbum(userId, 'Kid A', 'The Smashing Pumpkins', 50);
      const byArtist = await service!.search(userId, 'Radiohead', SearchTab.Albums);
      expect(byArtist).toHaveLength(1);
      expect(byArtist[0]?.primary).toBe('Kid A');
    });

    it('matches a phrase spanning the artist and the album name', async () => {
      // The concatenation is `artist || ' ' || album`, so the space between them
      // is searchable. A query of "Radiohead Kid" only matches because of it.
      await seedTopAlbum(userId, 'Kid A', 'Radiohead', 100);
      expect((await service!.search(userId, 'Radiohead Kid', SearchTab.Albums))).toHaveLength(1);
    });

    it('ranks against the whole album library, not the filtered set', async () => {
      await seedTopAlbum(userId, 'Album One', 'Artist One', 300);
      await seedTopAlbum(userId, 'Album Two', 'Artist Two', 200);
      await seedTopAlbum(userId, 'Album Three', 'Artist Three', 100);
      const rows = await service!.search(userId, 'Album Three', SearchTab.Albums);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rank).toBe(3);
    });

    it('never leaks another user library', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedTopAlbum(userId, 'Mine', 'Artist A', 10);
      await seedTopAlbum(other, 'Theirs', 'Artist B', 999);
      expect((await service!.search(userId, 'e', SearchTab.Albums)).map((r) => r.primary)).toEqual(['Mine']);
    });

    it('returns an empty list for a user with no albums', async () => {
      await expect(service!.search(userId, 'anything', SearchTab.Albums)).resolves.toEqual([]);
    });
  });

  describe('SearchTab.Tracks (L79)', () => {
    it('returns the track with the artist name as the secondary line', async () => {
      await seedTopTrack(userId, 'Airbag', 'Radiohead', 100);
      const rows = await service!.search(userId, 'Airbag', SearchTab.Tracks);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Airbag');
      expect(rows[0]?.secondary).toBe('Radiohead');
      expect(rows[0]?.count).toBe(100);
      expect(rows[0]?.rank).toBe(1);
    });

    it('returns an empty list when nothing matches', async () => {
      await seedTopTrack(userId, 'Airbag', 'Radiohead', 100);
      await expect(service!.search(userId, 'Karma Police', SearchTab.Tracks)).resolves.toEqual([]);
    });

    it('matches the artist name as well as the track name', async () => {
      await seedTopTrack(userId, 'Airbag', 'Radiohead', 100);
      expect((await service!.search(userId, 'Radiohead', SearchTab.Tracks))).toHaveLength(1);
    });

    it('takes the primary from user_tracks and the secondary from artists, so the two can disagree', async () => {
      // The tab reads `ut.name` for the row and `a.name` for the artist, never
      // the other way round. Worth pinning: a library whose denormalised track
      // name has drifted must still search and still show the real artist.
      await seedTopTrack(userId, 'Airbag', 'Radiohead', 100);
      await prisma!.userTrack.updateMany({ where: { userId }, data: { name: 'Airbag (remaster)' } });
      const rows = await service!.search(userId, 'remaster', SearchTab.Tracks);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Airbag (remaster)');
      expect(rows[0]?.secondary).toBe('Radiohead');
    });

    it('never leaks another user library', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedTopTrack(userId, 'Mine', 'Artist A', 10);
      await seedTopTrack(other, 'Theirs', 'Artist B', 999);
      expect((await service!.search(userId, 'e', SearchTab.Tracks)).map((r) => r.primary)).toEqual(['Mine']);
    });
  });

  describe('SearchTab.Plays (L103)', () => {
    it('returns the play with a count of one and a real Date', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Radiohead', trackName: 'Airbag', albumName: 'Kid A', timePlayed: at(0) },
      ]);
      const rows = await service!.search(userId, 'Airbag', SearchTab.Plays);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Airbag');
      expect(rows[0]?.secondary).toBe('Radiohead');
      expect(rows[0]?.count).toBe(1);
      expect(rows[0]?.timePlayed).toBeInstanceOf(Date);
      expect(rows[0]?.timePlayed?.toISOString()).toBe(new Date(EPOCH).toISOString());
    });

    it('returns an empty list when nothing matches', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at(0) },
      ]);
      await expect(service!.search(userId, 'Portishead', SearchTab.Plays)).resolves.toEqual([]);
    });

    it('files a NULL track name under Unknown Track and still matches on the artist', async () => {
      // The concatenation COALESCEs both nullable columns. Without it, a play
      // with no track name would concatenate to NULL, the ILIKE would be NULL,
      // and the row would be invisible - which is most scrobbles from a tagger
      // that never sent a title.
      await seedPlays(prisma!, [
        { userId, artistName: 'Mystery', trackName: null, albumName: null, timePlayed: at(0) },
      ]);
      const rows = await service!.search(userId, 'Mystery', SearchTab.Plays);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primary).toBe('Unknown Track');
      expect(rows[0]?.secondary).toBe('Mystery');
    });

    it('matches on the album name for a play with no track name', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'Mystery', trackName: null, albumName: 'Untitled Rip', timePlayed: at(0) },
      ]);
      await expect(service!.search(userId, 'Untitled', SearchTab.Plays)).resolves.toHaveLength(1);
    });

    it('orders the newest play first', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'Radiohead Oldest', timePlayed: at(0) },
        { userId, artistName: 'A', trackName: 'Radiohead Newest', timePlayed: at(2) },
        { userId, artistName: 'A', trackName: 'Radiohead Middle', timePlayed: at(1) },
      ]);
      const rows = await service!.search(userId, 'Radiohead', SearchTab.Plays);
      expect(rows.map((r) => r.primary)).toEqual([
        'Radiohead Newest',
        'Radiohead Middle',
        'Radiohead Oldest',
      ]);
    });

    it('never leaks another user plays', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedPlays(prisma!, [
        { userId, artistName: 'Mine', trackName: 'e1', timePlayed: at(0) },
        { userId: other, artistName: 'Theirs', trackName: 'e2', timePlayed: at(1) },
      ]);
      const rows = await service!.search(userId, 'e', SearchTab.Plays);
      expect(rows.map((r) => r.primary)).toEqual(['e1']);
    });

    it('caps the result at 60 rows and keeps the 60 most recent', async () => {
      // 61 plays, distinct seconds so the dedup index keeps all of them. The
      // limit is 60 here and 100 in the other three tabs, so a copy-paste that
      // changed one of them would be caught.
      await seedPlays(prisma!, Array.from({ length: 61 }, (_, i) => ({
        userId,
        artistName: 'Bulk',
        trackName: `Bulk Track ${String(i).padStart(3, '0')}`,
        timePlayed: at(i),
      })));
      const rows = await service!.search(userId, 'Bulk Track', SearchTab.Plays);
      expect(rows).toHaveLength(60);
      // Newest survives, oldest is the one dropped.
      expect(rows[0]?.primary).toBe('Bulk Track 060');
      expect(rows.map((r) => r.primary)).not.toContain('Bulk Track 000');
    });

    it('returns an empty list for a user with no plays', async () => {
      await expect(service!.search(userId, 'anything', SearchTab.Plays)).resolves.toEqual([]);
    });
  });
});

/**
 * THE RATCHET, replacing a test that asserted the defect.
 *
 * This file used to carry `reads public explicitly, so search_path cannot
 * redirect it away from the seeded rows`, gated behind `SCRATCH_IS_PUBLIC`. It
 * passed, and it was pinning the BUG: a schema-qualified `FROM public.user_artists`
 * does ignore `search_path`, so the four queries were reading the one schema
 * dbHarness exists to isolate the suite from. The gate also meant a non-public
 * scratch schema silently dropped these queries instead of testing them.
 *
 * The SQL experiment was also the wrong instrument, and its own comment said so:
 * `SET search_path` lands on whichever pooled connection Prisma picks, so it can
 * only fail if the query turns out to DEPEND on search_path. It cannot prove the
 * absence of a dependency, which is the half that was broken. So the property is
 * asserted on the source, where it is deterministic and needs no database.
 *
 * A plain `describe`, not `suite`: it is outside the skip wrapper, so it runs in
 * the default `npm test` as well as the real-Postgres job.
 */
describe('librarySearchService raw SQL is not pinned to a schema', () => {
  it('qualifies no table with `public.`, so search_path decides which one it reads', () => {
    // `process.cwd()` rather than `import.meta.url`: this project compiles to
    // CommonJS, where `import.meta` is a type error, and both vitest configs are
    // invoked from the repo root. A wrong root makes `readFileSync` throw, which
    // is the failure mode we want - never a silent pass over zero bytes.
    const src = readFileSync(
      resolve(process.cwd(), 'src/bot/services/librarySearchService.ts'),
      'utf8',
    );
    // Comments are stripped first: this file's own prose names the qualifier it
    // is ratcheting, and a grep that trips over its own documentation is a grep
    // nobody trusts.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const offenders = [...code.matchAll(/\b(public)\s*\./g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});
