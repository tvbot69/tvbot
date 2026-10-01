import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AbuseFlagRepository } from '../abuseFlagRepository';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The two velocity aggregates in abuseFlagRepository.ts (L57 and L72), executed
 * by a real Postgres. 2 raw queries, both `$queryRaw` tagged templates, and
 * until now neither had ever been parsed by a database.
 *
 * This is the file where a wrong assumption is a security hole rather than a
 * cosmetic bug. `scanAndFlag` takes the ids these queries return, puts them in
 * a `Set<number>`, and writes each one through `abuseFlag.upsert`. A single
 * BigInt in that set reaches Prisma's where-clause, the whole scan throws, the
 * one `catch` in `AbuseFilterService.scanAndFlag` logs it and returns 0 - and
 * an abuse control that silently flags nobody is indistinguishable from an
 * abuse control that is working.
 *
 * So the headline assertion in this file is `typeof userId`, not the id
 * itself. The source comment on `AbuseVelocityRow` claims `user_plays.user_id`
 * is Int so the id arrives as a JS number, and contrasts it with
 * `whoKnowsRepository`. That claim was never checked against a database. It is
 * correct - `UserPlay.userId` is `Int @map("user_id")` in schema.prisma L212, so
 * int4 maps to a JS number, while `COUNT(*)` is int8 and does map to a BigInt.
 * The assertions below are what make that a measured fact instead of a comment
 * that will be believed until someone changes the column.
 *
 * The windows are relative to `NOW()`, so the fixture times come off the clock -
 * but each row still gets its own second, because `user_plays_identity_uniq` is
 * (user_id, time_played, lower(artist_name), coalesce(lower(track_name),''),
 * play_source) and EXCLUDES user_play_id: two plays one second apart are two
 * plays, and a fixture that reused an instant would silently lose rows.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: AbuseFlagRepository | null = null;
let userId = 1;

/**
 * A distinct instant `secondsAgo` in the past.
 *
 * The window predicates are `time_played > NOW() - INTERVAL '8 days'`, so the
 * fixture has to sit relative to the database clock rather than to a fixed
 * date. Distinct offsets give distinct instants, which is what the dedup index
 * needs; see the header.
 */
const ago = (secondsAgo: number): Date => new Date(Date.now() - secondsAgo * 1000);

const DAY = 24 * 60 * 60;

/** An expiry comfortably in the future, so nothing is swept mid-test. */
const TTL = new Date(Date.now() + 90 * DAY * 1000);
/** An expiry in the past, so the flag is a lapsed one. */
const LAPSED = new Date(Date.now() - DAY * 1000);

suite('AbuseFlagRepository raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    repo = new AbuseFlagRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    // resetTables truncates abuse_flags as of 2026-09-29; it used to be the one
    // table it missed, and this line was the per-file workaround for that. Kept
    // because a flag written by one test suppressing a user in the next is the
    // exact failure it prevents, and a free DELETE is cheaper than a re-run.
    await prisma!.abuseFlag.deleteMany({});
    userId += 1;
    await seedUser(prisma!, userId);
  });

  describe('the column types the aggregates depend on', () => {
    it('user_plays.user_id is int4, which is why userId is a number and not a BigInt', async () => {
      // Asked of Postgres rather than of schema.prisma, because the deployed
      // database is the thing that decides. A migration that widened this column
      // to BigInt would turn every id in this file into a BigInt, and
      // `abuseFlag.upsert({ where: { userId: 123n } })` would be rejected at
      // runtime while the build stayed green.
      const columns = await prisma!.$queryRawUnsafe<Array<{ column_name: string; data_type: string; udt_name: string }>>(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'user_plays' AND column_name = 'user_id'`,
      );
      expect(columns).toHaveLength(1);
      expect(columns[0]?.udt_name).toBe('int4');
      expect(columns[0]?.data_type).toBe('integer');
    });

    it('abuse_flags.user_id is int4 too, so the upsert key and the query key are the same type', async () => {
      // The two halves of the nightly path have to agree. If this were int8 while
      // the query side stayed int4 the ids would still be numbers, and the
      // mismatch would show up as a coercion rather than as an error.
      const columns = await prisma!.$queryRawUnsafe<Array<{ udt_name: string }>>(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'abuse_flags' AND column_name = 'user_id'`,
      );
      expect(columns[0]?.udt_name).toBe('int4');
    });

    it('COUNT(*) comes back as a BigInt, so the two columns in one row have different JS types', async () => {
      // The contrast the source comment draws, measured rather than asserted. If
      // this ever returns a number, Prisma's int8 handling changed and the
      // `recent: bigint` field on AbuseVelocityRow is stale. A play is seeded
      // first, because a GROUP BY over an empty table produces no row and the
      // assertion would then be reading `undefined` - which is how a test ends
      // up passing for the wrong reason.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
      ]);
      const rows = await prisma!.$queryRawUnsafe<Array<{ user_id: number; recent: bigint }>>(
        `SELECT user_id, COUNT(*) AS recent FROM user_plays GROUP BY user_id`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(userId);
      expect(typeof rows[0]?.user_id).toBe('number');
      expect(rows[0]?.recent).toBe(1n);
      expect(typeof rows[0]?.recent).toBe('bigint');
    });
  });

  describe('findEightDayVolumeOffenders (L57)', () => {
    it('returns nothing when no user has scrobbled at all', async () => {
      await expect(repo!.findEightDayVolumeOffenders(1)).resolves.toEqual([]);
    });

    it('returns the id of a user over the threshold in the last 8 days', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(3 * DAY) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(4 * DAY) },
        { userId, artistName: 'A', trackName: 't3', timePlayed: ago(5 * DAY) },
      ]);
      await expect(repo!.findEightDayVolumeOffenders(2)).resolves.toEqual([userId]);
    });

    it('returns userId as a JS number, so it survives Set<number> and the upsert where-clause', async () => {
      // THE assertion. `scanAndFlag` does `new Set<number>([...offenders])` and
      // then `upsertFlag(userId, ...)`; a BigInt here would throw inside Prisma
      // and the whole nightly scan would return 0 behind a single Logger.error.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(120) },
        { userId, artistName: 'A', trackName: 't3', timePlayed: ago(180) },
      ]);
      const offenders = await repo!.findEightDayVolumeOffenders(2);
      expect(offenders).toHaveLength(1);
      expect(typeof offenders[0]).toBe('number');
      // And not merely number-shaped: exactly the id that was written.
      expect(offenders[0]).toBe(userId);
    });

    it('is strictly greater than the threshold, so a user exactly on it is not an offender', async () => {
      // The boundary that decides whether the control is armed. `>` against
      // `>=` is a one-character change with a policy-sized consequence: at 2500
      // exactly, the fmbot-parity threshold must not fire.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(120) },
        { userId, artistName: 'A', trackName: 't3', timePlayed: ago(180) },
      ]);
      await expect(repo!.findEightDayVolumeOffenders(3)).resolves.toEqual([]);
      await expect(repo!.findEightDayVolumeOffenders(2)).resolves.toEqual([userId]);
    });

    it('excludes plays older than 8 days even when the recent count is below the threshold', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'recent', timePlayed: ago(1 * DAY) },
        { userId, artistName: 'A', trackName: 'd7', timePlayed: ago(7 * DAY) },
        { userId, artistName: 'A', trackName: 'd9a', timePlayed: ago(9 * DAY) },
        { userId, artistName: 'A', trackName: 'd9b', timePlayed: ago(10 * DAY) },
      ]);
      // Exactly two plays are inside the window, so a threshold of 2 must not
      // fire. Were the 9-day and 10-day plays counted, this would be four and it
      // would return the user - which is what makes this the boundary test for
      // the window rather than for the threshold.
      await expect(repo!.findEightDayVolumeOffenders(2)).resolves.toEqual([]);
      await expect(repo!.findEightDayVolumeOffenders(1)).resolves.toEqual([userId]);
    });

    it('counts a play exactly on the 8-day boundary as inside the window', async () => {
      // `time_played > NOW() - INTERVAL '8 days'` is a strict `>` against a
      // moving NOW(), so a row seeded at exactly 8 days is genuinely ambiguous
      // and is NOT used to assert either way. What is asserted is the side that
      // has no ambiguity: 7 days in counts, 9 days out does not.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'in7', timePlayed: ago(7 * DAY) },
        { userId, artistName: 'A', trackName: 'out9', timePlayed: ago(9 * DAY) },
        { userId, artistName: 'A', trackName: 'in7b', timePlayed: ago(7 * DAY - 60) },
      ]);
      await expect(repo!.findEightDayVolumeOffenders(1)).resolves.toEqual([userId]);
    });

    it('returns only the users over the threshold, and returns every one of them', async () => {
      const quiet = userId + 5000;
      const loud = userId + 6000;
      const louder = userId + 7000;
      await seedUser(prisma!, quiet);
      await seedUser(prisma!, loud);
      await seedUser(prisma!, louder);
      await seedPlays(prisma!, [
        { userId: quiet, artistName: 'A', trackName: 'q1', timePlayed: ago(60) },
        { userId: loud, artistName: 'A', trackName: 'l1', timePlayed: ago(60) },
        { userId: loud, artistName: 'A', trackName: 'l2', timePlayed: ago(120) },
        { userId: louder, artistName: 'A', trackName: 'x1', timePlayed: ago(60) },
        { userId: louder, artistName: 'A', trackName: 'x2', timePlayed: ago(120) },
        { userId: louder, artistName: 'A', trackName: 'x3', timePlayed: ago(180) },
      ]);
      const offenders = await repo!.findEightDayVolumeOffenders(1);
      expect(offenders).toHaveLength(2);
      expect([...offenders].sort((a, b) => a - b)).toEqual([loud, louder]);
      expect(offenders).not.toContain(quiet);
    });

    it('binds the threshold as a parameter, so a threshold of 0 returns every recent user', async () => {
      // The control for a query that quietly hardcoded the fmbot-parity number:
      // if `$1` were ignored, 0 and 2 would return the same rows. It also pins
      // that the aggregate has no lower bound of its own.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'a', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 'b', timePlayed: ago(120) },
      ]);
      await expect(repo!.findEightDayVolumeOffenders(0)).resolves.toEqual([userId]);
      await expect(repo!.findEightDayVolumeOffenders(2)).resolves.toEqual([]);
    });

    it('runs as a real GROUP BY / HAVING aggregate, so a user_id inside an expression is not the only group key', async () => {
      // The shape Postgres rejects when the grouping key is only reachable
      // through an aggregate. Here `user_id` is a plain GROUP BY term, so the
      // statement parses - and the test proves it by executing, not by reading.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'a', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 'b', timePlayed: ago(120) },
      ]);
      const offenders = await repo!.findEightDayVolumeOffenders(1);
      expect(offenders).toEqual([userId]);
    });
  });

  describe('findDaySpikeOffenders (L72)', () => {
    it('returns nothing when no user has scrobbled at all', async () => {
      await expect(repo!.findDaySpikeOffenders(1)).resolves.toEqual([]);
    });

    it('returns the id of a user over the threshold in the last day', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(120) },
        { userId, artistName: 'A', trackName: 't3', timePlayed: ago(180) },
      ]);
      await expect(repo!.findDaySpikeOffenders(2)).resolves.toEqual([userId]);
    });

    it('returns userId as a JS number here too, not only in the 8-day aggregate', async () => {
      // The two methods are separate statements. A `::bigint` cast added to one
      // and not the other would be invisible in the type-checker, because both
      // declare `Promise<number[]>` and neither converts.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(120) },
      ]);
      const offenders = await repo!.findDaySpikeOffenders(1);
      expect(offenders).toHaveLength(1);
      expect(typeof offenders[0]).toBe('number');
      expect(offenders[0]).toBe(userId);
    });

    it('is strictly greater than the threshold', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 't1', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 't2', timePlayed: ago(120) },
      ]);
      await expect(repo!.findDaySpikeOffenders(2)).resolves.toEqual([]);
      await expect(repo!.findDaySpikeOffenders(1)).resolves.toEqual([userId]);
    });

    it('ignores yesterday-plus scrobbles, so a sustained listener is not a spike', async () => {
      // The control that proves the 1-day window is not the 8-day one wearing
      // the other one's label: three plays across three days is over the 8-day
      // volume threshold and under the day-spike threshold at the same time.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'd1', timePlayed: ago(1 * DAY + 3600) },
        { userId, artistName: 'A', trackName: 'd2', timePlayed: ago(2 * DAY) },
        { userId, artistName: 'A', trackName: 'd3', timePlayed: ago(3 * DAY) },
      ]);
      await expect(repo!.findDaySpikeOffenders(2)).resolves.toEqual([]);
      await expect(repo!.findEightDayVolumeOffenders(2)).resolves.toEqual([userId]);
    });

    it('keeps a NULL track name in the count rather than skipping the row', async () => {
      // An unidentified scrobble is still a scrobble. The aggregate has no
      // `track_name IS NOT NULL` predicate, so this only holds because none is
      // needed - and only an execution proves that.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: null, timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: null, timePlayed: ago(120) },
        { userId, artistName: 'A', trackName: '', timePlayed: ago(180) },
      ]);
      await expect(repo!.findDaySpikeOffenders(2)).resolves.toEqual([userId]);
    });

    it('counts every play source, so an import is not a free pass', async () => {
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'a', timePlayed: ago(60), playSource: 'LastFm' },
        { userId, artistName: 'A', trackName: 'b', timePlayed: ago(120), playSource: 'SpotifyImport' },
        { userId, artistName: 'A', trackName: 'c', timePlayed: ago(180), playSource: 'AppleMusicImport' },
      ]);
      await expect(repo!.findDaySpikeOffenders(2)).resolves.toEqual([userId]);
    });
  });

  describe('the nightly round trip these two queries feed', () => {
    it('carries an offender id from the aggregate all the way into a persisted flag', async () => {
      // The end-to-end shape of `AbuseFilterService.scanAndFlag`, minus the
      // service. Nothing here converts the id, so a green run proves the id that
      // came out of Postgres is the id Prisma accepted on the way back in.
      await seedPlays(prisma!, [
        { userId, artistName: 'A', trackName: 'a', timePlayed: ago(60) },
        { userId, artistName: 'A', trackName: 'b', timePlayed: ago(120) },
        { userId, artistName: 'A', trackName: 'c', timePlayed: ago(180) },
      ]);
      const offenders = await repo!.findEightDayVolumeOffenders(2);
      for (const id of new Set<number>([...offenders, ...(await repo!.findDaySpikeOffenders(99))])) {
        await repo!.upsertFlag(id, 'scrobble-velocity', TTL);
      }
      expect(await repo!.getActiveFlaggedUserIds()).toEqual([userId]);
      const row = await prisma!.abuseFlag.findUniqueOrThrow({ where: { userId } });
      expect(row.userId).toBe(userId);
      expect(typeof row.userId).toBe('number');
      expect(row.expiresAt).toEqual(TTL);
    });

    it('re-flagging an already-flagged user pushes the expiry out instead of failing', async () => {
      await repo!.upsertFlag(userId, 'scrobble-velocity', LAPSED);
      await repo!.upsertFlag(userId, 'scrobble-velocity', TTL);
      expect(await prisma!.abuseFlag.count({ where: { userId } })).toBe(1);
      expect((await prisma!.abuseFlag.findUniqueOrThrow({ where: { userId } })).expiresAt).toEqual(TTL);
    });

    it('a permanent flag has no expiry, and the active mirror keeps it', async () => {
      await prisma!.abuseFlag.create({ data: { userId, reason: 'manual', expiresAt: null } });
      expect(await repo!.getActiveFlaggedUserIds()).toEqual([userId]);
      // Not swept: the predicate is `expiresAt < NOW()`, and NULL is not less
      // than anything. Deleting permanent flags on a schedule would silently
      // un-ban everyone.
      expect(await repo!.deleteExpiredFlags()).toBe(0);
      expect(await repo!.getActiveFlaggedUserIds()).toEqual([userId]);
    });

    it('a lapsed flag is dropped by the sweep and by the mirror', async () => {
      await repo!.upsertFlag(userId, 'scrobble-velocity', LAPSED);
      expect(await repo!.getActiveFlaggedUserIds()).toEqual([]);
      expect(await repo!.deleteExpiredFlags()).toBe(1);
      expect(await prisma!.abuseFlag.count()).toBe(0);
    });

    it('deleteFlagsForUser removes only that user, so an unflag is not a guild-wide pardon', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await repo!.upsertFlag(userId, 'scrobble-velocity', TTL);
      await repo!.upsertFlag(other, 'scrobble-velocity', TTL);
      expect(await repo!.deleteFlagsForUser(userId)).toBe(1);
      expect(await repo!.getActiveFlaggedUserIds()).toEqual([other]);
    });
  });
});
