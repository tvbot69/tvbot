import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TrackRepository } from './trackRepository';
import { connect, resetTables, skipReason, useScratchSchema } from '../../tests/dbHarness';

/**
 * The ONE raw query in trackRepository.ts - L76-78, the case-insensitive "twins"
 * pass inside `getOrCreateTracksBulk` - executed by a real Postgres.
 *
 *     SELECT track_id AS "trackId", name, artist_id AS "artistId" FROM tracks
 *     WHERE artist_id = ANY($1) AND UPPER(name) = ANY($2)
 *
 * Two JS arrays are bound as two Postgres array parameters, which is a claim
 * about Prisma's serialiser and not something a mock can check. It is the only
 * thing that stops `getOrCreateTracksBulk` writing a lowercase duplicate beside a
 * ProperCase row - and `tracks` has `@@unique([artistId, name])`, which is a
 * case-SENSITIVE btree, so nothing else stops it. A duplicate here is what
 * `ReconcileService`'s nightly check reports as a write-path regression; see
 * reconcileService.db.test.ts, which counts exactly these rows.
 *
 * A PROPERTY OF THE PREDICATE WORTH NAMING, because it looks like a bug and is
 * not: the artist filter and the name filter are INDEPENDENT, so the statement
 * is a cross product - it can return a row for a name nobody asked about, and it
 * can never MISS the row that answers a request, because every requested pair
 * satisfies both halves. The "every key it returns is a real row" test below is
 * the invariant that makes the over-return harmless, and it is what a rewrite
 * (say, a `name ILIKE`, or a tuple `IN`) would have to keep satisfying.
 *
 * No `public.` prefix in this query, so `search_path` isolation is enough.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: TrackRepository | null = null;

/** Distinct artists per test: `artists.name` is UNIQUE, so names must differ. */
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

suite('TrackRepository raw query against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (prisma) {
      await useScratchSchema(prisma);
      repo = new TrackRepository(prisma);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
  });

  describe('getOrCreateTracksBulk - the case-insensitive twin pass (L76)', () => {
    it('returns the existing ProperCase track instead of creating a lowercase twin', async () => {
      const artistId = await seedArtist('Radiohead');
      const existing = await prisma!.track.create({ data: { artistId, name: 'Airbag' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateTracksBulk([{ trackName: 'AIRBAG', artistId }]),
      );

      expect(map.get(`${artistId}|airbag`)).toBe(existing.trackId);
      // The exact pass missed (`name: { in: ['airbag'] }` is case-sensitive), so
      // this call count is the only evidence the query is not dead code.
      expect(twinQueries).toBe(1);
      expect(await prisma!.track.count()).toBe(1);
    });

    it('never returns a track belonging to a different artist', async () => {
      // `artist_id = ANY($1)` is what scopes the pass. Without it a "Radiohead"
      // request would happily resolve to Portishead's identically named track and
      // the caller would write a user_tracks row pointing at the wrong song.
      const radiohead = await seedArtist('Radiohead');
      const portishead = await seedArtist('Portishead');
      const theirs = await prisma!.track.create({ data: { artistId: portishead, name: 'Airbag' } });

      const map = await repo!.getOrCreateTracksBulk([{ trackName: 'Airbag', artistId: radiohead }]);

      expect(map.get(`${radiohead}|airbag`)).not.toBe(theirs.trackId);
      const row = await prisma!.track.findFirstOrThrow({ where: { trackId: map.get(`${radiohead}|airbag`)! } });
      expect(row.artistId).toBe(radiohead);
      expect(await prisma!.track.count()).toBe(2);
    });

    it('resolves both artists in a cross-matched batch, not just the one that lines up', async () => {
      // The cross product at its least obvious. The stored rows are the "wrong"
      // pairing for the requests - (A, 'Paranoid Android') and (B, 'Airbag') -
      // so a query that paired a name with a name instead of a name with an
      // artist would answer with the wrong id. It does not, and this is why.
      const alpha = await seedArtist('Alpha');
      const beta = await seedArtist('Beta');
      const alphaTrack = await prisma!.track.create({ data: { artistId: alpha, name: 'Paranoid Android' } });
      const betaTrack = await prisma!.track.create({ data: { artistId: beta, name: 'Airbag' } });

      const map = await repo!.getOrCreateTracksBulk([
        { trackName: 'Airbag', artistId: beta },
        { trackName: 'Paranoid Android', artistId: alpha },
      ]);

      expect(map.get(`${beta}|airbag`)).toBe(betaTrack.trackId);
      expect(map.get(`${alpha}|paranoid android`)).toBe(alphaTrack.trackId);
      expect(await prisma!.track.count()).toBe(2);
    });

    it('does not run the query when the exact pass already matched', async () => {
      const artistId = await seedArtist('Radiohead');
      const existing = await prisma!.track.create({ data: { artistId, name: 'airbag' } });

      const { result: map, twinQueries } = await countTwinQueries(() =>
        repo!.getOrCreateTracksBulk([{ trackName: 'airbag', artistId }]),
      );

      expect(map.get(`${artistId}|airbag`)).toBe(existing.trackId);
      expect(twinQueries).toBe(0);
      expect(await prisma!.track.count()).toBe(1);
    });

    it('creates a lowercase track when nothing matches at all', async () => {
      const artistId = await seedArtist('Radiohead');
      const map = await repo!.getOrCreateTracksBulk([{ trackName: 'Karma Police', artistId }]);
      const id = map.get(`${artistId}|karma police`);
      expect(id).toBeTypeOf('number');
      const row = await prisma!.track.findUniqueOrThrow({ where: { trackId: id! } });
      expect(row.name).toBe('karma police');
      expect(row.artistId).toBe(artistId);
    });

    it('is an exact match, so a name that is a prefix of another is not a twin', async () => {
      const artistId = await seedArtist('Radiohead');
      const longer = await prisma!.track.create({ data: { artistId, name: 'Airbag (live)' } });

      const map = await repo!.getOrCreateTracksBulk([{ trackName: 'Airbag', artistId }]);

      expect(map.get(`${artistId}|airbag`)).not.toBe(longer.trackId);
      expect(await prisma!.track.count()).toBe(2);
    });

    it('survives names containing an apostrophe and a slash', async () => {
      // L75 says "never interpolate names (quotes/apostrophes)". Bound as
      // parameters they are just strings; interpolated they would be a syntax
      // error thrown on 100% of calls.
      //
      // Seeded ProperCase on purpose: the repository lowercases every REQUEST,
      // so asking for the upper case of an already-lowercase stored name would
      // be answered by the exact pass and the twins query would never run.
      const artistId = await seedArtist("Guns N' Roses");
      const seeded = await prisma!.track.createMany({
        data: [{ artistId, name: "Don't Stop Me Now" }, { artistId, name: 'Rock N Roll' }],
      });
      expect(seeded.count).toBe(2);

      const map = await repo!.getOrCreateTracksBulk([
        { trackName: "don't stop me now", artistId },
        { trackName: 'ROCK N ROLL', artistId },
      ]);

      const rows = await prisma!.track.findMany({ orderBy: { name: 'asc' } });
      const byName = new Map(rows.map((r) => [r.name, r.trackId]));
      expect(map.get(`${artistId}|don't stop me now`)).toBe(byName.get("Don't Stop Me Now"));
      expect(map.get(`${artistId}|rock n roll`)).toBe(byName.get('Rock N Roll'));
      expect(await prisma!.track.count()).toBe(2);
    });

    it('drops a blank track name and keeps the rest of the batch', async () => {
      const artistId = await seedArtist('Radiohead');
      const map = await repo!.getOrCreateTracksBulk([
        { trackName: '', artistId },
        { trackName: 'Airbag', artistId },
      ]);
      expect([...map.keys()]).toEqual([`${artistId}|airbag`]);
      expect(await prisma!.track.count()).toBe(1);
    });

    it('returns an empty map for an empty batch without touching the database', async () => {
      const { result, twinQueries } = await countTwinQueries(() => repo!.getOrCreateTracksBulk([]));
      expect(result.size).toBe(0);
      expect(twinQueries).toBe(0);
      expect(await prisma!.track.count()).toBe(0);
    });

    it('crosses the 400-item chunk boundary without losing or duplicating a row', async () => {
      // chunkSize is 400 (L61), so 401 items is two chunks and two differently
      // sized array parameters. A bad slice shows up as a map that is not 401
      // long, or a table that is not 401 rows.
      const artistId = await seedArtist('Bulk');
      const items = Array.from({ length: 401 }, (_, i) => ({
        trackName: `Bulk Track ${String(i).padStart(4, '0')}`,
        artistId,
      }));

      const map = await repo!.getOrCreateTracksBulk(items);

      expect(map.size).toBe(401);
      expect(await prisma!.track.count()).toBe(401);
    });

    it('crosses the chunk boundary while every name is a ProperCase twin', async () => {
      const artistId = await seedArtist('Twinful');
      const names = Array.from({ length: 401 }, (_, i) => `Twin Track ${String(i).padStart(4, '0')}`);
      await prisma!.track.createMany({ data: names.map((name) => ({ artistId, name })) });

      const map = await repo!.getOrCreateTracksBulk(names.map((trackName) => ({ trackName: trackName.toUpperCase(), artistId })));

      expect(map.size).toBe(401);
      expect(await prisma!.track.count()).toBe(401);
    });

    it('binds a many-element artist array without collapsing it to one value', async () => {
      // `artist_id = ANY($1)` with a single artist is indistinguishable from
      // `artist_id = $1`, so a serialiser that dropped the array would still
      // pass every other test in this file. 50 artists in one chunk, each with
      // the same ProperCase twin, is the shape that catches it.
      const artistIds: number[] = [];
      for (let i = 0; i < 50; i++) {
        const id = await seedArtist(`Many ${i}`);
        await prisma!.track.create({ data: { artistId: id, name: 'Shared Title' } });
        artistIds.push(id);
      }

      const map = await repo!.getOrCreateTracksBulk(artistIds.map((artistId) => ({ trackName: 'shared title', artistId })));

      expect(map.size).toBe(50);
      for (const artistId of artistIds) {
        const id = map.get(`${artistId}|shared title`);
        expect(id).toBeTypeOf('number');
        const row = await prisma!.track.findUniqueOrThrow({ where: { trackId: id! } });
        expect(row.artistId).toBe(artistId);
        expect(row.name).toBe('Shared Title');
      }
      expect(await prisma!.track.count()).toBe(50);
    });

    it('every key it returns is a real row whose artist and name match that key', async () => {
      // The invariant that makes the cross-product over-return harmless, and the
      // one thing a rewrite of the predicate has to keep satisfying.
      const alpha = await seedArtist('Alpha');
      const beta = await seedArtist('Beta');
      await prisma!.track.create({ data: { artistId: alpha, name: 'One' } });
      await prisma!.track.create({ data: { artistId: beta, name: 'Two' } });

      const map = await repo!.getOrCreateTracksBulk([
        { trackName: 'One', artistId: alpha },
        { trackName: 'Two', artistId: beta },
        { trackName: 'Three', artistId: alpha },
      ]);

      expect(map.size).toBe(3);
      const rows = await prisma!.track.findMany();
      const byId = new Map(rows.map((r) => [`${r.artistId}|${r.name.toLowerCase()}`, r.trackId]));
      for (const [key, id] of map) {
        expect(byId.get(key)).toBe(id);
      }
    });

    it('is idempotent: a second identical batch creates nothing new', async () => {
      const artistId = await seedArtist('Radiohead');
      const items = [
        { trackName: 'Airbag', artistId },
        { trackName: 'Karma Police', artistId },
      ];
      const first = await repo!.getOrCreateTracksBulk(items);
      const second = await repo!.getOrCreateTracksBulk(items);
      expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
      expect(await prisma!.track.count()).toBe(2);
    });
  });
});
