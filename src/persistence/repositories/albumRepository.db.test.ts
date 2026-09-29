import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AlbumRepository } from './albumRepository';
import { connect, resetTables, skipReason, useScratchSchema } from '../../tests/dbHarness';

/**
 * The ONE raw query in albumRepository.ts - L97-99, the case-insensitive "twins"
 * pass inside `getOrCreateAlbumsBulk` - executed by a real Postgres.
 *
 *     SELECT album_id AS "albumId", name, artist_id AS "artistId" FROM albums
 *     WHERE artist_id = ANY($1) AND UPPER(name) = ANY($2)
 *
 * Identical in shape to the track version (trackRepository.db.test.ts covers
 * that one), so this file deliberately does not restate its tests. What is
 * different and worth proving here:
 *
 *  1. `albums` is keyed `@@unique([artistId, name])`, and album identity really
 *     is per-artist - the same album title under two artists is two albums, not
 *     one. So the artist scoping is load-bearing here for a way it is not for
 *     tracks, and a request for "Kid A" from the wrong artist must create a row
 *     rather than adopt the other artist's.
 *  2. `getOrCreateAlbum` (the non-bulk twin of this method) lowercases what it
 *     stores, and this bulk path has to agree with it or the same album ends up
 *     under two spellings.
 *
 * No `public.` prefix in this query, so `search_path` isolation is enough.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: AlbumRepository | null = null;

let artistSeq = 0;
const seedArtist = async (name?: string): Promise<number> => {
  artistSeq += 1;
  const row = await prisma!.artist.create({ data: { name: name ?? `Artist ${artistSeq}` } });
  return row.artistId;
};

/** Runs `body` with the client's `$queryRaw` observed, always restoring it. */
const countTwinQueries = async <T>(body: () => Promise<T>): Promise<{ result: T; twinQueries: number }> => {
  const spy = vi.spyOn(prisma!, '$queryRaw');
  try {
    const result = await body();
    return { result, twinQueries: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
};

suite('AlbumRepository raw query against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (prisma) {
      await useScratchSchema(prisma);
      repo = new AlbumRepository(prisma);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
  });

  describe('getOrCreateAlbumsBulk - the case-insensitive twin pass (L97)', () => {
    it('returns the existing ProperCase album instead of creating a lowercase twin', async () => {
      const artistId = await seedArtist('Radiohead');
      const existing = await prisma!.album.create({ data: { artistId, name: 'Kid A' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateAlbumsBulk([{ albumName: 'KID A', artistId }]),
      );

      expect(map.get(`${artistId}|kid a`)).toBe(existing.albumId);
      expect(twinQueries).toBe(1);
      expect(await prisma!.album.count()).toBe(1);
    });

    it('does not adopt the same album title from a different artist', async () => {
      const radiohead = await seedArtist('Radiohead');
      const portishead = await seedArtist('Portishead');
      const theirs = await prisma!.album.create({ data: { artistId: portishead, name: 'Kid A' } });

      const map = await repo!.getOrCreateAlbumsBulk([{ albumName: 'Kid A', artistId: radiohead }]);

      expect(map.get(`${radiohead}|kid a`)).not.toBe(theirs.albumId);
      const row = await prisma!.album.findFirstOrThrow({ where: { albumId: map.get(`${radiohead}|kid a`)! } });
      expect(row.artistId).toBe(radiohead);
      expect(row.name).toBe('kid a');
      expect(await prisma!.album.count()).toBe(2);
    });

    it('resolves both artists in a cross-matched batch', async () => {
      const alpha = await seedArtist('Alpha');
      const beta = await seedArtist('Beta');
      const alphaAlbum = await prisma!.album.create({ data: { artistId: alpha, name: 'Second' } });
      const betaAlbum = await prisma!.album.create({ data: { artistId: beta, name: 'First' } });

      const map = await repo!.getOrCreateAlbumsBulk([
        { albumName: 'First', artistId: beta },
        { albumName: 'Second', artistId: alpha },
      ]);

      expect(map.get(`${beta}|first`)).toBe(betaAlbum.albumId);
      expect(map.get(`${alpha}|second`)).toBe(alphaAlbum.albumId);
      expect(await prisma!.album.count()).toBe(2);
    });

    it('does not run the query when the exact pass already matched', async () => {
      const artistId = await seedArtist('Radiohead');
      const existing = await prisma!.album.create({ data: { artistId, name: 'kid a' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateAlbumsBulk([{ albumName: 'kid a', artistId }]),
      );

      expect(map.get(`${artistId}|kid a`)).toBe(existing.albumId);
      expect(twinQueries).toBe(0);
      expect(await prisma!.album.count()).toBe(1);
    });

    it('stores the same lowercase spelling as the single-item getOrCreateAlbum', async () => {
      // If the two paths disagreed on the stored spelling, the first one to run
      // would create a row and the second would then find a "twin" of it - which
      // is a duplicate wearing a disguise, and exactly what ReconcileService's
      // duplicate check counts.
      const artistId = await seedArtist('Radiohead');
      const single = await repo!.getOrCreateAlbum('Kid A', artistId);
      const bulk = await repo!.getOrCreateAlbumsBulk([{ albumName: 'Kid A', artistId }]);
      expect(bulk.get(`${artistId}|kid a`)).toBe(single.albumId);
      expect(await prisma!.album.count()).toBe(1);
    });

    it('is an exact match, so a title that is a prefix of another is not a twin', async () => {
      const artistId = await seedArtist('Radiohead');
      const longer = await prisma!.album.create({ data: { artistId, name: 'Kid A (Deluxe)' } });

      const map = await repo!.getOrCreateAlbumsBulk([{ albumName: 'Kid A', artistId }]);

      expect(map.get(`${artistId}|kid a`)).not.toBe(longer.albumId);
      expect(await prisma!.album.count()).toBe(2);
    });

    it('survives a title containing an apostrophe', async () => {
      // Seeded ProperCase so the twins query is the thing that has to carry the
      // apostrophe - the repository lowercases every REQUEST, so an upper-case
      // request for an already-lowercase row would be answered by the exact pass.
      const artistId = await seedArtist('Miley Cyrus');
      await prisma!.album.create({ data: { artistId, name: "Can't Be Tamed" } });

      const map = await repo!.getOrCreateAlbumsBulk([{ albumName: "can't be tamed", artistId }]);

      const row = await prisma!.album.findUniqueOrThrow({ where: { albumId: map.get(`${artistId}|can't be tamed`)! } });
      expect(row.name).toBe("Can't Be Tamed");
      expect(await prisma!.album.count()).toBe(1);
    });

    it('drops a blank album name and keeps the rest of the batch', async () => {
      const artistId = await seedArtist('Radiohead');
      const map = await repo!.getOrCreateAlbumsBulk([
        { albumName: '', artistId },
        { albumName: 'Kid A', artistId },
      ]);
      expect([...map.keys()]).toEqual([`${artistId}|kid a`]);
      expect(await prisma!.album.count()).toBe(1);
    });

    it('returns an empty map for an empty batch without touching the database', async () => {
      const { result, twinQueries } = await countTwinQueries(() => repo!.getOrCreateAlbumsBulk([]));
      expect(result.size).toBe(0);
      expect(twinQueries).toBe(0);
      expect(await prisma!.album.count()).toBe(0);
    });

    it('crosses the 400-item chunk boundary without losing or duplicating a row', async () => {
      const artistId = await seedArtist('Bulk');
      const items = Array.from({ length: 401 }, (_, i) => ({
        albumName: `Bulk Album ${String(i).padStart(4, '0')}`,
        artistId,
      }));

      const map = await repo!.getOrCreateAlbumsBulk(items);

      expect(map.size).toBe(401);
      expect(await prisma!.album.count()).toBe(401);
    });

    it('crosses the chunk boundary while every title is a ProperCase twin', async () => {
      const artistId = await seedArtist('Twinful');
      const names = Array.from({ length: 401 }, (_, i) => `Twin Album ${String(i).padStart(4, '0')}`);
      await prisma!.album.createMany({ data: names.map((name) => ({ artistId, name })) });

      const map = await repo!.getOrCreateAlbumsBulk(names.map((albumName) => ({ albumName: albumName.toUpperCase(), artistId })));

      expect(map.size).toBe(401);
      expect(await prisma!.album.count()).toBe(401);
    });

    it('binds a many-element artist array without collapsing it to one value', async () => {
      const artistIds: number[] = [];
      for (let i = 0; i < 25; i++) {
        const id = await seedArtist(`Many ${i}`);
        await prisma!.album.create({ data: { artistId: id, name: 'Greatest Hits' } });
        artistIds.push(id);
      }

      const map = await repo!.getOrCreateAlbumsBulk(artistIds.map((artistId) => ({ albumName: 'greatest hits', artistId })));

      expect(map.size).toBe(25);
      for (const artistId of artistIds) {
        const id = map.get(`${artistId}|greatest hits`);
        expect(id).toBeTypeOf('number');
        const row = await prisma!.album.findUniqueOrThrow({ where: { albumId: id! } });
        expect(row.artistId).toBe(artistId);
        expect(row.name).toBe('Greatest Hits');
      }
      expect(await prisma!.album.count()).toBe(25);
    });

    it('every key it returns is a real row whose artist and name match that key', async () => {
      const alpha = await seedArtist('Alpha');
      const beta = await seedArtist('Beta');
      await prisma!.album.create({ data: { artistId: alpha, name: 'One' } });
      await prisma!.album.create({ data: { artistId: beta, name: 'Two' } });

      const map = await repo!.getOrCreateAlbumsBulk([
        { albumName: 'One', artistId: alpha },
        { albumName: 'Two', artistId: beta },
        { albumName: 'Three', artistId: alpha },
      ]);

      expect(map.size).toBe(3);
      const rows = await prisma!.album.findMany();
      const byKey = new Map(rows.map((r) => [`${r.artistId}|${r.name.toLowerCase()}`, r.albumId]));
      for (const [key, id] of map) {
        expect(byKey.get(key)).toBe(id);
      }
    });

    it('is idempotent: a second identical batch creates nothing new', async () => {
      const artistId = await seedArtist('Radiohead');
      const items = [
        { albumName: 'Kid A', artistId },
        { albumName: 'Amnesiac', artistId },
      ];
      const first = await repo!.getOrCreateAlbumsBulk(items);
      const second = await repo!.getOrCreateAlbumsBulk(items);
      expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
      expect(await prisma!.album.count()).toBe(2);
    });
  });
});
