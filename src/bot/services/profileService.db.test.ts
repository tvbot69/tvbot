import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ProfileService } from './profileService';
import { connect, resetTables, seedUser, scratchSchema, skipReason, useScratchSchema } from '../../tests/dbHarness';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { LastFmUser } from '@domain/models/lastFmUser';
import type { User } from '@persistence/domain/models/user';
import { DataSource, UserType } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';

/**
 * BOTH raw queries in profileService.ts, executed by a real Postgres:
 *
 *   getProfileHistory  L142-152  month rollup,  `FROM public.user_plays`, LIMIT 6
 *   getProfileHistory  L171-180  year rollup,   `FROM public.user_plays`, no LIMIT
 *
 * ** BOTH QUERIES ARE PINNED TO `public`. ** Read this before pointing the suite
 * at a non-public scratch schema. dbHarness isolates by `SET search_path`, and a
 * schema-qualified `FROM public.user_plays` ignores `search_path` entirely, so
 * the two agree only when the scratch schema IS `public` - which is what CI
 * configures (`TEST_DATABASE_URL=...?schema=public`). The query blocks below are
 * `describe.skipIf(!SCRATCH_IS_PUBLIC)` for that reason, the same guard
 * librarySearchService.db.test.ts uses for its four `public.`-pinned queries.
 *
 * WHY THIS FILE IS NOT PARROTTING. Both queries sit inside a bare
 *
 *     } catch {
 *       // Ignored, fallback to empty history
 *     }
 *
 * so a statement Postgres refuses and a user who has never scrobbled are the
 * same value at the call site: an empty history. That is the exact shape that
 * hid the `albumService` bug for the life of the query, and it is why the tests
 * below seed real `user_plays` rows and assert the history comes back POPULATED
 * rather than asserting the SQL text.
 *
 * A LATENT BUG, REPORTED NOT PINNED. `time_played` is `timestamptz`, so
 * `DATE_TRUNC('month', time_played)` truncates in the SESSION timezone, and the
 * code then reads the result with `getUTCMonth()` / `getUTCFullYear()`. If the
 * database session timezone is not UTC, a 1 January play is filed under December
 * of the previous year. Every fixture here is deliberately mid-month at midday
 * UTC, which is month-stable under every real offset (+14 at most), so the
 * assertions describe what the query is meant to do rather than what it does on
 * a server that is not set to UTC. The fix, if it is wanted, is
 * `DATE_TRUNC('month', time_played AT TIME ZONE 'UTC')`.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

/**
 * True when the scratch schema and the schema these two queries hardcode are the
 * same one. Undefined means no `?schema=` in the URL, i.e. plain `public`.
 */
const SCRATCH_IS_PUBLIC = (scratchSchema() ?? 'public') === 'public';

let prisma: PrismaClient | null = null;
let service: ProfileService | null = null;
let userId = 1;

/**
 * The scratch client, handed to the service through the module mock below.
 *
 * A Proxy rather than a plain object because `profileService` imports the
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
 * Mid-month, midday UTC. `DATE_TRUNC` on a timestamptz truncates in the session
 * timezone, so an instant near a month boundary would make these assertions
 * depend on how the server is configured. The 15th at noon has at least twelve
 * hours of slack on both sides under every offset Postgres accepts.
 */
const inMonth = (year: number, monthIndex: number, day = 15): Date =>
  new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));

/**
 * One play, with the two columns the queries actually read.
 *
 * Through the Prisma client rather than the harness `seedPlays`, because that
 * fixture cannot carry `ms_played` and `ms_played` is half of what is under
 * test. `user_plays_identity_uniq` is (user_id, time_played, lower(artist_name),
 * coalesce(lower(track_name),''), play_source), so every seeded play needs its
 * own instant.
 */
const seedPlay = (over: {
  timePlayed: Date;
  msPlayed?: number | null;
  artistName?: string;
  trackName?: string | null;
  albumName?: string | null;
  forUser?: number;
}): Promise<unknown> =>
  prisma!.userPlay.create({
    data: {
      userId: over.forUser ?? userId,
      artistName: over.artistName ?? 'Radiohead',
      trackName: over.trackName === undefined ? 'Airbag' : over.trackName,
      albumName: over.albumName === undefined ? 'Kid A' : over.albumName,
      timePlayed: over.timePlayed,
      msPlayed: over.msPlayed ?? null,
    },
  });

const lastfmUser: LastFmUser = {
  name: 'db_profile_user',
  playCount: 1234,
  registeredAt: new Date('2011-04-05T00:00:00.000Z'),
  trackCount: 500,
  albumCount: 60,
  artistCount: 30,
};

/** Only the two methods `getProfileHistory` reaches. */
const lastfmRepo = (user: LastFmUser | null): ILastfmRepository =>
  ({
    getUserInfo: async () => user,
    getTopArtists: async () => [],
  }) as unknown as ILastfmRepository;

const targetUser = (id: number): User => ({
  userId: id,
  userNameLastFm: 'db_profile_user',
  discordUserId: String(id),
  registeredOn: new Date('2011-04-05T00:00:00.000Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
});

const history = async (id: number = userId) =>
  service!.getProfileHistory('Someone', targetUser(id));

suite('ProfileService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    holder.client = prisma;
    service = new ProfileService(lastfmRepo(lastfmUser));
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

  describe('the paths that never reach SQL', () => {
    it('returns null when Last.fm has no such user, without querying', async () => {
      // A local instance, so the shared `service` keeps its Last.fm double for
      // the tests that follow.
      const unknown = new ProfileService(lastfmRepo(null));
      const spy = vi.spyOn(prisma!, '$queryRaw');
      try {
        await expect(unknown.getProfileHistory('Someone', targetUser(userId))).resolves.toBeNull();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('runs neither query for a user id of 0', async () => {
      // `targetUser.userId > 0` is the only gate. A Last.fm-only viewer has no
      // local id, and a `WHERE user_id = 0` would be a full scan of a 40-million
      // row table for a guaranteed-empty answer.
      const spy = vi.spyOn(prisma!, '$queryRaw');
      try {
        const stats = await history(0);
        expect(spy).not.toHaveBeenCalled();
        expect(stats?.months).toEqual([]);
        expect(stats?.years).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe.skipIf(!SCRATCH_IS_PUBLIC)('the month rollup (L142)', () => {
    it('returns the month, the play count and the real listening time', async () => {
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 20), msPlayed: 60_000 });

      const stats = await history();

      // 120 000 ms of music. Not the fallback: the fallback is count * 210 s.
      expect(stats?.months).toEqual([{ monthName: 'March', playCount: 2, timeString: '2 minutes' }]);
    });

    it('falls back to 210 seconds per play when ms_played is NULL', async () => {
      // `COALESCE(SUM(ms_played), 0)` is what makes a month of scrobbles with
      // no duration information readable at all rather than "0 minutes". Two
      // plays: 2 * 210 = 420 s, which is 7 minutes.
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: null });
      await seedPlay({ timePlayed: inMonth(2023, 2, 20), msPlayed: null });

      const stats = await history();

      expect(stats?.months).toEqual([{ monthName: 'March', playCount: 2, timeString: '7 minutes' }]);
    });

    it('reads a sub-minute total as 0 minutes, because the formatter floors', async () => {
      // 3 000 ms of music is a real 3 seconds. `formatLongListeningTime` takes
      // Math.floor(seconds / 60), so the card says "0 minutes". That is the
      // formatter's doing, not the query's, and it is pinned here so a change to
      // either is a deliberate act rather than a surprise.
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 1_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 20), msPlayed: 1_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 21), msPlayed: 1_000 });

      const stats = await history();

      expect(stats?.months).toEqual([{ monthName: 'March', playCount: 3, timeString: '0 minutes' }]);
    });

    it('groups a month together instead of listing one row per play', async () => {
      await seedPlay({ timePlayed: inMonth(2023, 2, 1), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 15), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 28), msPlayed: 60_000 });

      const stats = await history();

      expect(stats?.months).toHaveLength(1);
      expect(stats?.months[0]?.playCount).toBe(3);
    });

    it('returns the six most recent months, newest first', async () => {
      // Eight months seeded, LIMIT 6. January and February 2021 must be the two
      // that are missing, which is only true if both the LIMIT and the DESC
      // ordering are real.
      for (let m = 0; m < 8; m++) {
        await seedPlay({ timePlayed: inMonth(2021, m), msPlayed: 60_000 });
      }

      const stats = await history();

      expect(stats?.months.map((m) => m.monthName)).toEqual([
        'August', 'July', 'June', 'May', 'April', 'March',
      ]);
      expect(stats?.months.map((m) => m.playCount)).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it('never includes another user plays', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 11), msPlayed: 60_000, forUser: other });

      const stats = await history();

      expect(stats?.months).toEqual([{ monthName: 'March', playCount: 1, timeString: '1 minute' }]);
    });

    it('returns an empty month list for a user who has never scrobbled', async () => {
      // The shape a broken query also produces. The test above is what tells
      // the two apart; this one only pins the empty case.
      const stats = await history();
      expect(stats?.months).toEqual([]);
    });
  });

  describe.skipIf(!SCRATCH_IS_PUBLIC)('the year rollup (L171)', () => {
    it('leads with an all-time row and then lists the years newest first', async () => {
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2024, 6, 10), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2024, 6, 11), msPlayed: 60_000 });

      const stats = await history();

      // The leading space in ' All' is deliberate - it is a Discord list bullet
      // in the card. Asserted literally so a trim() "cleanup" is caught.
      expect(stats?.years).toEqual([
        { year: ' All', playCount: 3, timeString: '3 minutes' },
        { year: '2024', playCount: 2, timeString: '2 minutes' },
        { year: '2023', playCount: 1, timeString: '1 minute' },
      ]);
    });

    it('keeps every year, because unlike the month query this one has no LIMIT', async () => {
      for (const year of [2015, 2017, 2019, 2021, 2023]) {
        await seedPlay({ timePlayed: inMonth(year, 5), msPlayed: 60_000 });
      }

      const stats = await history();

      expect(stats?.years.map((y) => y.year)).toEqual([' All', '2023', '2021', '2019', '2017', '2015']);
      expect(stats?.years).toHaveLength(6);
    });

    it('applies the same 210-second fallback at both levels', async () => {
      // 2024 has no ms_played, 2023 does. The ' All' row sums PER ROW, applying
      // the fallback per row, so it is not simply 3 * 210: it is 210 000 ms for
      // 2024 plus 60 000 ms for 2023 = 270 s, which is 4 minutes. A sum taken
      // after the fallback instead of before it would read 7 minutes here.
      await seedPlay({ timePlayed: inMonth(2024, 0), msPlayed: null });
      await seedPlay({ timePlayed: inMonth(2023, 0), msPlayed: 60_000 });

      const stats = await history();

      expect(stats?.years).toEqual([
        { year: ' All', playCount: 2, timeString: '4 minutes' },
        { year: '2024', playCount: 1, timeString: '3 minutes' },
        { year: '2023', playCount: 1, timeString: '1 minute' },
      ]);
    });

    it('a play older than the six-month window is still in the year total', async () => {
      // The asymmetry the two queries are allowed to have: the month list is a
      // six-row card, the year list is the whole history. Six months seeded for
      // the card plus one from 2014, which only the year query can see - and
      // which must not push one of the six off the end, because LIMIT 6 keeps
      // the six NEWEST months and all of these are in 2021.
      for (let m = 0; m < 6; m++) {
        await seedPlay({ timePlayed: inMonth(2021, m), msPlayed: 60_000 });
      }
      await seedPlay({ timePlayed: inMonth(2014, 2), msPlayed: 60_000 });

      const stats = await history();

      expect(stats?.months.map((m) => m.monthName)).toEqual([
        'June', 'May', 'April', 'March', 'February', 'January',
      ]);
      expect(stats?.years).toEqual([
        { year: ' All', playCount: 7, timeString: '7 minutes' },
        { year: '2021', playCount: 6, timeString: '6 minutes' },
        { year: '2014', playCount: 1, timeString: '1 minute' },
      ]);
    });

    it('never includes another user plays', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 60_000 });
      await seedPlay({ timePlayed: inMonth(2023, 2, 11), msPlayed: 60_000, forUser: other });

      const stats = await history();

      expect(stats?.years).toEqual([
        { year: ' All', playCount: 1, timeString: '1 minute' },
        { year: '2023', playCount: 1, timeString: '1 minute' },
      ]);
    });

    it('returns an empty year list for a user who has never scrobbled', async () => {
      const stats = await history();
      expect(stats?.years).toEqual([]);
    });

    it('handles a play with a NULL track name, which is a real scrobble shape', async () => {
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), trackName: null, msPlayed: 60_000 });

      const stats = await history();

      expect(stats?.months[0]?.playCount).toBe(1);
      expect(stats?.years[0]?.playCount).toBe(1);
    });
  });

  describe.skipIf(!SCRATCH_IS_PUBLIC)('the schema these two queries are pinned to', () => {
    it('reads public explicitly, so search_path cannot redirect it away from the seeded rows', async () => {
      await seedPlay({ timePlayed: inMonth(2023, 2, 10), msPlayed: 60_000 });

      // Point the connection's search_path somewhere useless. A
      // schema-qualified query is unaffected; an unqualified one would fail
      // outright. That is the whole difference, and it is why a scratch schema
      // other than public would make this suite read the wrong tables.
      //
      // One honest caveat, inherited from librarySearchService.db.test.ts: `SET`
      // lands on whichever pooled connection Prisma picks, so this cannot PROVE
      // the qualification - it can only fail if the query turns out to depend on
      // search_path, which is the failure worth catching. The property itself is
      // the `public.` prefix in the source.
      await prisma!.$executeRawUnsafe('SET search_path TO pg_catalog');
      try {
        const stats = await history();
        expect(stats?.months).toHaveLength(1);
      } finally {
        await prisma!.$executeRawUnsafe('SET search_path TO public');
      }
    });
  });
});
