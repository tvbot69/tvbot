import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ReconcileService } from './reconcileService';
import type { IndexService } from './indexService';
import { connect, resetTables, seedPlays, seedUser, skipReason, useScratchSchema } from '../../tests/dbHarness';

/**
 * The ONE raw query in reconcileService.ts - L53-57, the nightly entity-duplicate
 * sweep - executed by a real Postgres, plus the arithmetic that consumes it.
 *
 *     SELECT
 *       (SELECT COUNT(*) FROM (SELECT 1 FROM artists
 *          GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1) a) AS artists,
 *       (SELECT COUNT(*) FROM (SELECT 1 FROM albums
 *          GROUP BY artist_id, LOWER(TRIM(name)) HAVING COUNT(*) > 1) b) AS albums,
 *       (SELECT COUNT(*) FROM (SELECT 1 FROM tracks
 *          GROUP BY artist_id, LOWER(TRIM(name)) HAVING COUNT(*) > 1) c) AS tracks
 *
 * Three things make this query worth executing rather than reading.
 *
 *  1. IT IS A COUNT OF GROUPS, NOT OF ROWS. The inner `SELECT 1 ... GROUP BY ...
 *     HAVING COUNT(*) > 1` collapses a group of three case-variant rows to a
 *     single row, so three duplicates read as 1. A query counting rows would
 *     have read 3. Which number an operator sees is the whole job.
 *  2. `artists.name`, `albums.(artist_id, name)` and `tracks.(artist_id, name)`
 *     are all UNIQUE - as case-SENSITIVE btrees, which is exactly why this query
 *     lowercases. The duplicates it hunts are therefore reachable through the
 *     ordinary write path, and the repository twins passes are the ones that
 *     would create them; see trackRepository.db.test.ts and
 *     albumRepository.db.test.ts.
 *  3. `TRIM` is in the grouping key, so a name differing only by surrounding
 *     whitespace counts. Nothing in the write path trims, so that is reachable
 *     too.
 *
 * The rest of `runAsync` is the other half of the brief: it reconciles DERIVED
 * state (user_artists / user_albums / user_tracks playcounts) against a source of
 * truth (the raw `user_plays` rows) and decides with arithmetic. Those decisions
 * run here against real rows, because the mocked version had every number
 * supplied by the same mind that wrote the comparison.
 *
 * No `public.` prefix in this query, so `search_path` isolation is enough and
 * this file runs unchanged against a non-public scratch schema.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let userId = 1;

/**
 * The scratch client, handed to the service through the module mock below.
 *
 * A Proxy rather than a plain object because `reconcileService` imports the
 * singleton at module scope, long before `beforeAll` has connected anything. The
 * trap resolves `$queryRaw` on the client at CALL time. Functions are bound to
 * the real client, because Prisma's model methods read `this`.
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

/**
 * `artists.name` is UNIQUE, so a fixture helper that uniquified its input would
 * make every duplicate test in this file impossible to write. Names are therefore
 * passed through verbatim, and each test picks names that are distinct as STRINGS
 * even where they are meant to collide once lowercased.
 */
const seedArtistRow = async (name: string): Promise<number> => {
  const row = await prisma!.artist.create({ data: { name } });
  return row.artistId;
};

const EPOCH = Date.UTC(2023, 2, 1, 0, 0, 0);
const at = (offsetSeconds: number): Date => new Date(EPOCH + offsetSeconds * 1000);

/** `count` plays, all by one artist and all carrying an album and a track name. */
const seedPlaysCount = async (count: number, artistName: string, forUser: number = userId): Promise<void> => {
  await seedPlays(
    prisma!,
    Array.from({ length: count }, (_, i) => ({
      userId: forUser,
      artistName,
      trackName: 'Airbag',
      albumName: 'Kid A',
      timePlayed: at(i),
    })),
  );
};

/**
 * A user who is genuinely healthy: `n` raw plays, and all three aggregates
 * summing to `n`.
 *
 * All THREE have to be written, not just the artist one. The job checks each
 * aggregate against its own countable base, and every play above carries an
 * album and a track name - so a user with plays but no `user_albums` rows at all
 * is read as 20 plays against an album total of 0, which is drift, and the job
 * would correctly rebuild their top lists. That is right, and it means a fixture
 * that only writes `user_artist` silently stops testing what it says it does.
 */
const seedConsistentUser = async (n: number, artistName: string, forUser: number = userId): Promise<number> => {
  await seedPlaysCount(n, artistName, forUser);
  const artistId = await seedArtistRow(artistName);
  const album = await prisma!.album.create({ data: { artistId, name: 'kid a' } });
  const track = await prisma!.track.create({ data: { artistId, name: 'airbag' } });
  await prisma!.userArtist.create({ data: { userId: forUser, artistId, name: artistName, playcount: n } });
  await prisma!.userAlbum.create({ data: { userId: forUser, albumId: album.albumId, name: 'kid a', playcount: n } });
  await prisma!.userTrack.create({ data: { userId: forUser, trackId: track.trackId, name: 'airbag', playcount: n } });
  return artistId;
};

/** Break ONE aggregate, leaving the other two at the truth. */
const setArtistAggregate = async (playcount: number, forUser: number = userId): Promise<void> => {
  await prisma!.userArtist.updateMany({ where: { userId: forUser }, data: { playcount } });
};

const makeService = () => {
  const indexService = {
    recalculateTopLists: vi.fn(async () => undefined),
    enqueueUser: vi.fn(() => true),
  };
  return { svc: new ReconcileService(indexService as unknown as IndexService), indexService };
};

suite('ReconcileService raw query against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    holder.client = prisma;
  });

  afterAll(async () => {
    holder.client = null;
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await seedUser(prisma, userId);
  });

  describe('the entity-duplicate sweep (L53)', () => {
    it('reports nothing on a catalogue with no duplicates', async () => {
      await seedArtistRow('Radiohead');
      await seedArtistRow('Portishead');
      const { svc } = makeService();

      const report = await svc.runAsync();

      expect(report.entityDupes).toEqual({ artists: 0, albums: 0, tracks: 0 });
    });

    it('reports nothing when the catalogue is completely empty', async () => {
      const { svc } = makeService();
      const report = await svc.runAsync();
      expect(report.entityDupes).toEqual({ artists: 0, albums: 0, tracks: 0 });
      expect(report.checkedUsers).toBe(0);
    });

    it('sees an artist duplicate that differs only by case', async () => {
      // `artists.name` is UNIQUE, but as a case-sensitive btree, so both of these
      // rows are legal to create through the ordinary write path - which is
      // precisely why the query lowercases before grouping.
      await seedArtistRow('Radiohead');
      await seedArtistRow('radiohead');

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.artists).toBe(1);
    });

    it('sees an artist duplicate that differs only by surrounding whitespace', async () => {
      await seedArtistRow('Radiohead');
      await seedArtistRow(' Radiohead ');

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.artists).toBe(1);
    });

    it('counts a group of three case variants as ONE duplicate, not three', async () => {
      // The shape of the whole query. `SELECT 1 ... GROUP BY ... HAVING > 1`
      // emits one row per offending GROUP, so the outer COUNT(*) counts groups.
      // A query that counted rows instead would say 3 here, and an operator
      // would read that as three separate regressions.
      await seedArtistRow('Radiohead');
      await seedArtistRow('radiohead');
      await seedArtistRow('RADIOHEAD');

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.artists).toBe(1);
      expect(await prisma!.artist.count()).toBe(3);
    });

    it('counts two separate duplicate groups as two', async () => {
      // The control for the test above: a group-counting query returns 2 here
      // and a row-counting one would return 4.
      await seedArtistRow('Radiohead');
      await seedArtistRow('radiohead');
      await seedArtistRow('Portishead');
      await seedArtistRow('portishead');

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.artists).toBe(2);
    });

    it('scopes album and track duplicates to the artist', async () => {
      // Two artists with the same album title is normal - only the same artist
      // holding two spellings is a duplicate. With `artist_id` missing from the
      // GROUP BY this would read 2.
      const radiohead = await seedArtistRow('Radiohead');
      const portishead = await seedArtistRow('Portishead');
      await prisma!.album.createMany({
        data: [{ artistId: radiohead, name: 'Kid A' }, { artistId: portishead, name: 'Kid A' }],
      });
      await prisma!.track.createMany({
        data: [{ artistId: radiohead, name: 'Airbag' }, { artistId: portishead, name: 'Airbag' }],
      });

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes).toEqual({ artists: 0, albums: 0, tracks: 0 });
    });

    it('sees an album duplicate under one artist and ignores the other artist', async () => {
      const radiohead = await seedArtistRow('Radiohead');
      const portishead = await seedArtistRow('Portishead');
      await prisma!.album.createMany({
        data: [
          { artistId: radiohead, name: 'Kid A' },
          { artistId: radiohead, name: 'kid a' },
          { artistId: portishead, name: 'Kid A' },
        ],
      });

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.albums).toBe(1);
      expect(report.entityDupes.tracks).toBe(0);
    });

    it('sees a track duplicate the same way', async () => {
      const artistId = await seedArtistRow('Radiohead');
      await prisma!.track.createMany({ data: [{ artistId, name: 'Airbag' }, { artistId, name: 'AIRBAG' }] });

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes.tracks).toBe(1);
      expect(report.entityDupes.albums).toBe(0);
    });

    it('sees all three kinds at once', async () => {
      const artistId = await seedArtistRow('Radiohead');
      await seedArtistRow('radiohead');
      await prisma!.album.createMany({ data: [{ artistId, name: 'Kid A' }, { artistId, name: 'kid a' }] });
      await prisma!.track.createMany({ data: [{ artistId, name: 'Airbag' }, { artistId, name: 'airbag' }] });

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.entityDupes).toEqual({ artists: 1, albums: 1, tracks: 1 });
    });

    it('returns the counts as JS numbers, not BigInt', async () => {
      // `COUNT(*)` is bigint in Postgres and the consumer calls `Number(...)`.
      // If that were ever dropped, a JSON-serialised report would throw on every
      // BigInt - the shape of a nightly job that dies just after the sweep it
      // successfully completed.
      await seedArtistRow('Radiohead');
      await seedArtistRow('radiohead');
      const { svc } = makeService();
      const report = await svc.runAsync();
      expect(typeof report.entityDupes.artists).toBe('number');
      expect(typeof report.entityDupes.albums).toBe('number');
      expect(typeof report.entityDupes.tracks).toBe('number');
      expect(() => JSON.stringify(report)).not.toThrow();
    });
  });

  describe('reconciling derived aggregates against the raw plays', () => {
    it('leaves a user whose aggregates already match the raw plays alone', async () => {
      await seedConsistentUser(20, 'Radiohead');

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.checkedUsers).toBe(1);
      expect(report.healedUsers).toBe(0);
      expect(report.escalatedUsers).toBe(0);
      expect(report.details[0]).toMatchObject({ userId: userId, action: 'healthy', artistDrift: 0, historyGap: 0 });
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('rebuilds the top lists when the aggregate sum is below the raw count', async () => {
      // The drift that every historical playcount bug looked like: derived state
      // far below the source of truth, silently, forever.
      await seedConsistentUser(100, 'Radiohead');
      await setArtistAggregate(40);

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.healedUsers).toBe(1);
      expect(report.details[0]?.action).toBe('healed-aggregates');
      expect(report.details[0]?.artistDrift).toBe(60);
      expect(indexService.recalculateTopLists).toHaveBeenCalledWith(userId);
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('tolerates a small overshoot, because the tolerance is symmetric', async () => {
      // `exceeds` is `Math.abs(actual - expected)`, so a derived total slightly
      // ABOVE the source of truth is tolerated exactly like a small shortfall.
      // The asymmetry the job actually cares about is between the RAW plays and
      // the Last.fm total, which is the historyGap branch two tests below.
      await seedConsistentUser(30, 'Radiohead');
      await setArtistAggregate(35);

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.healedUsers).toBe(0);
      expect(report.details[0]?.action).toBe('healthy');
      expect(report.details[0]?.artistDrift).toBe(-5);
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    });

    it('does not escalate a user whose LOCAL plays exceed their Last.fm total', async () => {
      // This is the import-inflated case the class comment describes: a Spotify
      // or Apple import adds plays Last.fm never saw, so `user_plays` is
      // legitimately ahead of `total_play_count`. Escalating here would enqueue
      // a full index for every imported user, nightly, forever - and a full
      // index cannot invent a play Last.fm does not have, so it would not even
      // close the gap.
      await seedConsistentUser(120, 'Radiohead');
      await prisma!.user.update({ where: { userId }, data: { totalPlayCount: 100 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.escalatedUsers).toBe(0);
      expect(report.details[0]?.action).toBe('healthy');
      // The gap is computed only when Last.fm is AHEAD, so an import-inflated
      // user reports 0 rather than a negative number.
      expect(report.details[0]?.historyGap).toBe(0);
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('skips a user with no raw plays entirely, rather than healing zeroes', async () => {
      // `if (rawPlays === 0) continue`. Healing a user who has not scrobbled
      // would rebuild empty top lists and, worse, escalate them for a full index.
      const artistId = await seedArtistRow('Radiohead');
      await prisma!.userArtist.create({ data: { userId, artistId, name: 'Radiohead', playcount: 0 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.checkedUsers).toBe(0);
      expect(report.details).toEqual([]);
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('checks albums and tracks against their own countable base', async () => {
      // 20 raw plays, of which 5 have no album name and 3 have no track name -
      // a tagger that never sent the fields. The album and track aggregates can
      // only ever reach 15 and 17, so exactly that is HEALTHY. Comparing them
      // to 20 instead would rebuild every such user's top lists nightly,
      // forever, and would look in the logs like nothing but a growing counter.
      await seedPlays(
        prisma!,
        Array.from({ length: 20 }, (_, i) => ({
          userId,
          artistName: 'Radiohead',
          trackName: i < 3 ? null : 'Airbag',
          albumName: i < 5 ? null : 'Kid A',
          timePlayed: at(i),
        })),
      );
      const artistId = await seedArtistRow('Radiohead');
      const album = await prisma!.album.create({ data: { artistId, name: 'kid a' } });
      const track = await prisma!.track.create({ data: { artistId, name: 'airbag' } });
      await prisma!.userArtist.create({ data: { userId, artistId, name: 'Radiohead', playcount: 20 } });
      await prisma!.userAlbum.create({ data: { userId, albumId: album.albumId, name: 'kid a', playcount: 15 } });
      await prisma!.userTrack.create({ data: { userId, trackId: track.trackId, name: 'airbag', playcount: 17 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.healedUsers).toBe(0);
      expect(report.details[0]?.action).toBe('healthy');
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    });

    it('heals when ONLY the album aggregate has drifted', async () => {
      // The artist and track aggregates are exact and the album one is not. The
      // condition is an OR across all three, so a single drifted layer is
      // enough - and each layer is checked against its own base, so the album
      // one is compared to 20 album-bearing plays and not to 20 total plays.
      await seedConsistentUser(20, 'Radiohead');
      const album = await prisma!.album.findFirstOrThrow({ where: { name: 'kid a' } });
      await prisma!.userAlbum.updateMany({ where: { userId, albumId: album.albumId }, data: { playcount: 2 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.healedUsers).toBe(1);
      expect(indexService.recalculateTopLists).toHaveBeenCalledWith(userId);
    });

    it('escalates to a full index when the local history is far below the Last.fm total', async () => {
      // Deltas cannot invent plays that were never imported, so the fix here is
      // a full index rather than a recalculation.
      await seedConsistentUser(100, 'Radiohead');
      await prisma!.user.update({ where: { userId }, data: { totalPlayCount: 5000 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.escalatedUsers).toBe(1);
      expect(report.details[0]).toMatchObject({ action: 'escalated-full-index', historyGap: 4900 });
      expect(indexService.enqueueUser).toHaveBeenCalledWith(userId);
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    });

    it('does not escalate when the Last.fm total is only marginally ahead', async () => {
      // 100 local, 115 on Last.fm. The gap is 15 and the threshold is
      // max(20, 115 * 0.02) = 20, so 15 < 20 and there is nothing to do.
      await seedConsistentUser(100, 'Radiohead');
      await prisma!.user.update({ where: { userId }, data: { totalPlayCount: 115 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.escalatedUsers).toBe(0);
      expect(report.details[0]?.action).toBe('healthy');
      expect(report.details[0]?.historyGap).toBe(15);
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('does not escalate for a user whose Last.fm total is unknown', async () => {
      // `total_play_count` is NULL until the first delta sync. Reading NULL as
      // zero, or as "we are missing everything", would enqueue a full index for
      // every freshly linked account on the first night it ran.
      await seedConsistentUser(20, 'Radiohead');

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.escalatedUsers).toBe(0);
      expect(report.details[0]?.historyGap).toBe(0);
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('heals rather than escalates when both drift and a history gap are present', async () => {
      // The `else if` is the interesting part. A full reindex is strictly more
      // expensive than a recalculation, so drift is repaired first and the
      // escalation is not ALSO raised - otherwise every user whose aggregates
      // were once wrong would be re-indexed in full, nightly, for as long as the
      // gap persisted.
      await seedConsistentUser(100, 'Radiohead');
      await setArtistAggregate(40);
      await prisma!.user.update({ where: { userId }, data: { totalPlayCount: 5000 } });

      const { svc, indexService } = makeService();
      const report = await svc.runAsync();

      expect(report.healedUsers).toBe(1);
      expect(report.escalatedUsers).toBe(0);
      expect(indexService.recalculateTopLists).toHaveBeenCalledWith(userId);
      expect(indexService.enqueueUser).not.toHaveBeenCalled();
    });

    it('keeps the absolute tolerance at exactly ten, and trips at eleven', async () => {
      // ABS_TOLERANCE is 10 and the comparison is `>`, so a drift of exactly 10
      // is tolerated and 11 is not. The boundary is the point: an off-by-one
      // would rebuild the top lists of a large slice of the userbase every
      // single night, forever, and would look in the logs like nothing at all
      // except a counter that quietly goes up.
      await seedConsistentUser(20, 'Radiohead');
      await setArtistAggregate(10);

      const { svc, indexService } = makeService();
      const atTolerance = await svc.runAsync();
      expect(atTolerance.healedUsers).toBe(0);
      expect(atTolerance.details[0]?.artistDrift).toBe(10);
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();

      await setArtistAggregate(9);
      const beyondTolerance = await svc.runAsync();
      expect(beyondTolerance.healedUsers).toBe(1);
      expect(beyondTolerance.details[0]?.artistDrift).toBe(11);
      expect(indexService.recalculateTopLists).toHaveBeenCalledWith(userId);
    });

    it('scales the tolerance with the size of the library, not just the floor', async () => {
      // max(10, expected * 0.02). At 1000 raw plays the threshold is 20, so a
      // drift of 20 is tolerated and 21 is not. A fixed absolute tolerance
      // would eventually make the nightly job rebuild the biggest libraries'
      // top lists every night, because a two-percent drift at that scale is
      // normal rather than a regression.
      await seedConsistentUser(1000, 'Radiohead');
      await setArtistAggregate(980);

      const { svc, indexService } = makeService();
      const tolerated = await svc.runAsync();
      expect(tolerated.healedUsers).toBe(0);
      expect(tolerated.details[0]?.artistDrift).toBe(20);
      expect(indexService.recalculateTopLists).not.toHaveBeenCalled();

      await setArtistAggregate(979);
      const beyond = await svc.runAsync();
      expect(beyond.healedUsers).toBe(1);
      expect(beyond.details[0]?.artistDrift).toBe(21);
      expect(indexService.recalculateTopLists).toHaveBeenCalledWith(userId);
    });

    it('checks every user in the database, not just the first', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedConsistentUser(20, 'Radiohead', userId);
      await seedConsistentUser(30, 'Portishead', other);

      const { svc } = makeService();
      const report = await svc.runAsync();

      expect(report.checkedUsers).toBe(2);
      expect(report.details.map((d) => d.userId).sort()).toEqual([userId, other].sort());
      expect(report.healedUsers).toBe(0);
    });
  });
});
