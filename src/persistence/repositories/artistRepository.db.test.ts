import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ArtistRepository } from './artistRepository';
import { connect, resetTables, skipReason, useScratchSchema } from '../../tests/dbHarness';

/**
 * The ONE raw query in artistRepository.ts - L51-53, the case-insensitive
 * "twins" pass inside `getOrCreateArtistsBulk` - executed by a real Postgres.
 *
 *     SELECT artist_id AS "artistId", name FROM artists
 *     WHERE UPPER(name) = ANY($1)
 *
 * Until this file, that statement had never been parsed by a database. It is
 * the load-bearing half of a get-or-create: the exact pass above it is a
 * case-SENSITIVE `name = ANY`, so it misses a ProperCase twin ("Mac DeMarco")
 * every single time, and this query is the only thing standing between that miss
 * and a parallel `artists` row. Two properties make it non-obvious enough to be
 * worth proving rather than eyeballing:
 *
 *  1. It binds a JS ARRAY as a Postgres array parameter, twice over in the
 *     track/album equivalents. That is a claim about Prisma's serialiser, not
 *     about Postgres, and it is exactly the sort of thing a mock cannot check.
 *  2. Its own comment says "never interpolate names (quotes/apostrophes)". The
 *     only way to believe that is to run a name containing an apostrophe
 *     through the real query and see it come back.
 *
 * It also is NOT the interesting part for correctness of the returned map: a
 * "completeness" test further down pins the property that matters - every
 * requested name that has a case-variant twin in the table comes back with the
 * twin's real id and no second row is created.
 *
 * The failure this guards against is a duplicate `artists` row per ProperCase
 * twin, which is precisely what `ReconcileService`'s nightly duplicate check
 * reports as a write-path regression. See reconcileService.db.test.ts.
 *
 * No `public.` prefix in this query, so `search_path` isolation is enough and
 * this file runs unchanged against a non-public scratch schema.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: ArtistRepository | null = null;

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

suite('ArtistRepository raw query against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (prisma) {
      await useScratchSchema(prisma);
      repo = new ArtistRepository(prisma);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
  });

  describe('getOrCreateArtistsBulk - the case-insensitive twin pass (L51)', () => {
    it('returns the existing ProperCase row instead of creating a lowercase twin', async () => {
      const existing = await prisma!.artist.create({ data: { name: 'Mac DeMarco' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateArtistsBulk(['mac demarco']),
      );

      expect(map.get('mac demarco')).toBe(existing.artistId);
      // The exact pass missed (Prisma `in` is case-sensitive), so this run is
      // the only proof the query actually executed rather than being dead code.
      expect(twinQueries).toBe(1);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('keys the returned map by the lowercased REQUESTED name, not the stored spelling', async () => {
      // A caller doing `map.get('Mac DeMarco')` - which is the spelling it
      // passed - would miss and then re-create the row. The lowercase key is the
      // contract.
      await prisma!.artist.create({ data: { name: 'Sigur Ros' } });
      const map = await repo!.getOrCreateArtistsBulk(['SIGUR ROS']);
      expect([...map.keys()]).toEqual(['sigur ros']);
      expect(map.has('SIGUR ROS')).toBe(false);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('does not run the query at all when the exact pass already matched', async () => {
      await prisma!.artist.create({ data: { name: 'radiohead' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateArtistsBulk(['radiohead']),
      );

      expect(map.get('radiohead')).toBeTypeOf('number');
      expect(twinQueries).toBe(0);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('matches an already-uppercase stored row', async () => {
      const existing = await prisma!.artist.create({ data: { name: 'AIRBAG' } });
      const map = await repo!.getOrCreateArtistsBulk(['airbag']);
      expect(map.get('airbag')).toBe(existing.artistId);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('resolves every requested name in one pass, not just the first', async () => {
      const a = await prisma!.artist.create({ data: { name: 'Mac DeMarco' } });
      const b = await prisma!.artist.create({ data: { name: 'Radiohead' } });
      const c = await prisma!.artist.create({ data: { name: 'Portishead' } });

      const map = await repo!.getOrCreateArtistsBulk(['mac demarco', 'radiohead', 'portishead']);

      expect(map.get('mac demarco')).toBe(a.artistId);
      expect(map.get('radiohead')).toBe(b.artistId);
      expect(map.get('portishead')).toBe(c.artistId);
      expect(await prisma!.artist.count()).toBe(3);
    });

    it('creates a genuinely new artist when no twin exists', async () => {
      const map = await repo!.getOrCreateArtistsBulk(['Boards of Canada']);
      const id = map.get('boards of canada');
      expect(id).toBeTypeOf('number');
      const row = await prisma!.artist.findUniqueOrThrow({ where: { artistId: id! } });
      expect(row.name).toBe('boards of canada');
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('is an exact match, so a name that is a prefix of another is not a twin', async () => {
      // `UPPER(name) = ANY(...)` is equality. A `LIKE` here would match
      // "radiohead" for a request of "radio" and silently return the wrong id.
      const radio = await prisma!.artist.create({ data: { name: 'Radiohead' } });
      const map = await repo!.getOrCreateArtistsBulk(['radio']);
      expect(map.get('radio')).not.toBe(radio.artistId);
      expect(await prisma!.artist.count()).toBe(2);
    });

    it('survives a name containing an apostrophe, a slash and an accent', async () => {
      // The point of the comment on L50. If these were interpolated the statement
      // would be a syntax error and the call would throw; bound as parameters
      // they are just strings.
      //
      // The rows are seeded ProperCase on purpose. The repository lowercases
      // every REQUEST, so asking for "GUNS N' ROSES" would lowercase to the
      // same string as a lowercase row and the twins query - the thing being
      // tested - would never run.
      await prisma!.artist.createMany({ data: [{ name: "Guns N' Roses" }, { name: 'AC/DC' }, { name: 'Björk' }] });

      const map = await repo!.getOrCreateArtistsBulk(["guns n' roses", 'ac/dc', 'BJÖRK']);

      expect([...map.keys()].sort()).toEqual(["ac/dc", "guns n' roses", 'björk']);
      const stored = await prisma!.artist.findMany({ orderBy: { name: 'asc' } });
      const byName = new Map(stored.map((r) => [r.name, r.artistId]));
      expect(map.get("guns n' roses")).toBe(byName.get("Guns N' Roses"));
      expect(map.get('ac/dc')).toBe(byName.get('AC/DC'));
      expect(map.get('björk')).toBe(byName.get('Björk'));
      // The real assertion: three rows in, three rows out. A query that could not
      // carry the apostrophe would have thrown; one that dropped it would have
      // written a fourth row.
      expect(await prisma!.artist.count()).toBe(3);
    });

    it('collapses two spellings of one name into a single row', async () => {
      // `new Set` on the lowercased names happens BEFORE the query, so the array
      // parameter never carries a duplicate and no second row is created.
      const map = await repo!.getOrCreateArtistsBulk(['Radiohead', 'radiohead', 'RADIOHEAD']);
      expect(map.size).toBe(1);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('returns an empty map for no input without touching the database', async () => {
      const { result, twinQueries } = await countTwinQueries(() => repo!.getOrCreateArtistsBulk([]));
      expect(result.size).toBe(0);
      expect(twinQueries).toBe(0);
      expect(await prisma!.artist.count()).toBe(0);
    });

    it('drops an empty name and keeps the rest', async () => {
      // `.filter(Boolean)` after the lowercase Set: an empty string is the only
      // thing that can be dropped, and dropping it matters because
      // `UPPER('') = ANY('')` would otherwise ask the database a question
      // about a row that cannot exist.
      const map = await repo!.getOrCreateArtistsBulk(['', 'Boards of Canada', '']);
      expect([...map.keys()]).toEqual(['boards of canada']);
      expect(await prisma!.artist.count()).toBe(1);
    });

    it('crosses the 500-name chunk boundary without losing or duplicating a row', async () => {
      // chunkSize is 500 (L36), so 501 names is two chunks and two array
      // parameters of different sizes. A bad slice shows up here as a map that
      // is not 501 long, or as a table that is not 501 rows.
      const names = Array.from({ length: 501 }, (_, i) => `Chunk Artist ${String(i).padStart(4, '0')}`);

      const map = await repo!.getOrCreateArtistsBulk(names);

      expect(map.size).toBe(501);
      expect(await prisma!.artist.count()).toBe(501);
      // Fetched once rather than 501 times: the point is that every id the map
      // holds is the id of a row that actually exists under that exact name.
      const rows = await prisma!.artist.findMany();
      const byId = new Map(rows.map((r) => [r.artistId, r.name]));
      for (const [key, id] of map) {
        expect(byId.get(id)).toBe(key);
      }
    });

    it('crosses the chunk boundary while half of the names are ProperCase twins', async () => {
      // The hard version of the boundary: the twins query runs on a 500-name
      // array in the first chunk, then a 1-name array in the second, and the
      // second chunk's answer must still land.
      const existing = Array.from({ length: 501 }, (_, i) => `Twin Artist ${String(i).padStart(4, '0')}`);
      await prisma!.artist.createMany({ data: existing.map((name) => ({ name })) });

      const map = await repo!.getOrCreateArtistsBulk(existing.map((n) => n.toUpperCase()));

      expect(map.size).toBe(501);
      expect(await prisma!.artist.count()).toBe(501);
    });

    it('every key it returns is a real row whose name matches that key', async () => {
      // The completeness property, stated as an invariant so it survives a
      // rewrite of the query. `UPPER(name) = ANY($1)` matches a whole column
      // independently of the other names in the array, so a row can come back
      // for a name nobody asked about. That over-return is harmless, but only
      // because every entry is still a true (name -> id) mapping - which is
      // what this asserts, and what would catch a rewrite that started
      // pairing a name with an unrelated id.
      await prisma!.artist.createMany({ data: [{ name: 'Alpha' }, { name: 'Beta' }] });
      const map = await repo!.getOrCreateArtistsBulk(['alpha', 'beta', 'gamma']);
      expect(map.size).toBe(3);
      for (const [key, id] of map) {
        const row = await prisma!.artist.findUniqueOrThrow({ where: { artistId: id } });
        expect(row.name.toLowerCase()).toBe(key);
      }
    });
  });
});
