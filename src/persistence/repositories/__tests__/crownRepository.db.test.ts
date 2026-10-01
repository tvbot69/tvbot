import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import {
  connect,
  resetTables,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The six raw queries in crownRepository.ts, executed by a real Postgres:
 *
 *   L22  getCurrentCrown            - the active-crown lookup, case-insensitive
 *   L186 getUserCrowns             - the per-user list, three ORDER BY shapes
 *   L219 getTopCrownHoldersInGuild - the crown leaderboard
 *   L252 getCrownHistoryForArtist  - the stolen-crown history, LIMIT-bound
 *   L292 seedCrownsForGuild        - DISTINCT ON over a two-table join
 *   L397 getBlockedCrownUsers      - the crown-block list
 *
 * All six are `$queryRaw` tagged templates, and the original audit that claimed
 * "28 of 28 raw queries covered" matched `$queryRawUnsafe` only - so none of
 * these had ever been parsed by a database. A renamed column or a bind Postgres
 * cannot type is a RUNTIME failure with a perfectly green build and a perfectly
 * green unit suite, because every other test of this repository mocks prisma!.
 *
 * Two things here are more fragile than they look and are covered explicitly:
 *
 *  1. THE BOOLEAN BINDS in getUserCrowns. `c.active = $3` and the three
 *     `CASE WHEN $4 THEN c.created END` terms bind JS booleans into SQL. If the
 *     engine cannot resolve one of them, the statement fails for EVERY call, and
 *     the failure is a "no crowns" list rather than an error.
 *  2. THE ::int ON getTopCrownHoldersInGuild. `COUNT(*)::int` is what stops a
 *     BigInt leaking into a leaderboard entry typed `crownCount: number`.
 *
 * `guild_id` is BigInt and every guild id arrives as a string, which is why the
 * repository has a `safeBigInt` guard. That guard is covered per method: a
 * non-numeric id must return the empty answer WITHOUT opening a query, since
 * `BigInt('abc')` throws.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: CrownRepository | null = null;
let userId = 1;

/** A guild id well outside Last.fm's range, so nothing here collides with real data. */
const GUILD_ID = 8_800_001n;
const OTHER_GUILD_ID = 8_800_002n;
const guildId = String(GUILD_ID);
const otherGuildId = String(OTHER_GUILD_ID);

/**
 * Fixed instants for the two ORDER BY columns that the queries sort on.
 *
 * `created` and `modified` both default to now(), and the whole row arrives
 * inside one transaction, so an ORDER BY test that relied on insertion order
 * would be asserting nothing at all. These are absolute dates precisely so the
 * expected order is the one written down below.
 */
const T = (day: number): Date => new Date(Date.UTC(2024, 0, day, 12, 0, 0));

/**
 * Makes every seeded artist name globally unique.
 *
 * `artists.name` is UNIQUE while `user_artists.name` is not, and a test that
 * reused a catalogue name across tests would be relying on truncation rather
 * than on the schema. Monotonic, so two rows in one fixture never collide.
 */
let artistSerial = 0;

const seedNamedUser = async (id: number, name: string): Promise<void> => {
  await prisma!.user.create({
    data: { userId: id, userNameLastFm: name, discordUserId: BigInt(id) * 1000n },
  });
};

interface CrownSeed {
  guild?: bigint;
  user?: number;
  artistName?: string;
  startPlaycount?: number;
  currentPlaycount?: number;
  active?: boolean;
  seededCrown?: boolean;
  created?: Date;
  modified?: Date;
}

const seedCrown = async (over: CrownSeed = {}): Promise<number> => {
  const created = over.created ?? T(1);
  const modified = over.modified ?? T(1);
  const row = await prisma!.userCrown.create({
    data: {
      guildId: over.guild ?? GUILD_ID,
      userId: over.user ?? userId,
      artistName: over.artistName ?? 'Radiohead',
      startPlaycount: over.startPlaycount ?? 10,
      currentPlaycount: over.currentPlaycount ?? 10,
      active: over.active ?? true,
      seededCrown: over.seededCrown ?? false,
    },
  });
  // `created` is @default(now()) and `modified` is @updatedAt, so both land on
  // the wall clock at insert time and there is no way to place a crown in the
  // past through the ORM. Three of the six queries under test ORDER BY one or
  // both of these columns - getUserCrowns' three views, getCrownHistoryForArtist
  // and killCrown's aftermath - so an ORDER BY test built on "now" for every row
  // would be asserting an accident. One explicit UPDATE is what makes the
  // expected order the one written down. The casts are load-bearing: Prisma
  // sends $1 untyped and Postgres cannot resolve an untyped parameter (42804).
  await prisma!.$executeRawUnsafe(
    `UPDATE user_crowns SET created = $1::timestamptz, modified = $2::timestamptz WHERE crown_id = $3::int4`,
    created,
    modified,
    row.crownId,
  );
  return row.crownId;
};

/** A guild member row, which user_crowns and the seed query both join through. */
const seedGuildMember = async (
  id: number,
  over: { guild?: bigint; blockedFromCrowns?: boolean; whoKnowsBanned?: boolean } = {},
): Promise<void> => {
  await prisma!.guildUser.create({
    data: {
      guildId: over.guild ?? GUILD_ID,
      userId: id,
      blockedFromCrowns: over.blockedFromCrowns ?? false,
      whoKnowsBanned: over.whoKnowsBanned ?? false,
    },
  });
};

/** A real artist -> user_artists row, because user_artists.artist_id is an FK. */
const seedUserArtist = async (
  id: number,
  name: string,
  playcount: number,
): Promise<number> => {
  const artist = await prisma!.artist.create({ data: { name: `${name} #${artistSerial++}` } });
  await prisma!.userArtist.create({
    data: { userId: id, artistId: artist.artistId, name, playcount },
  });
  return artist.artistId;
};

suite('CrownRepository raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    repo = new CrownRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    // Both guilds, because every query is guild-scoped and a scoping test that
    // only had one guild could not tell "filtered" from "no other data".
    await prisma!.guild.create({ data: { guildId: GUILD_ID, guildName: 'Crown Guild' } });
    await prisma!.guild.create({ data: { guildId: OTHER_GUILD_ID, guildName: 'Other Crown Guild' } });
    await seedUser(prisma!, userId);
  });

  describe('getCurrentCrown (L22)', () => {
    it('returns null when the artist has no crown', async () => {
      await seedCrown({ artistName: 'Portishead' });
      await expect(repo!.getCurrentCrown(guildId, 'Radiohead')).resolves.toBeNull();
    });

    it('returns null for a guild nobody has crowned anything in', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getCurrentCrown(otherGuildId, 'Radiohead')).resolves.toBeNull();
    });

    it('returns null for a non-numeric guild id without opening a query', async () => {
      // `BigInt('abc')` throws a SyntaxError. The safeBigInt guard exists so
      // this returns the empty answer instead of propagating.
      await expect(repo!.getCurrentCrown('not-a-guild', 'Radiohead')).resolves.toBeNull();
      await expect(repo!.getCurrentCrown('', 'Radiohead')).resolves.toBeNull();
    });

    it('returns the active crown with the joined user fields', async () => {
      const crownId = await seedCrown({ artistName: 'Radiohead', currentPlaycount: 42 });
      const crown = await repo!.getCurrentCrown(guildId, 'Radiohead');
      expect(crown?.crownId).toBe(crownId);
      expect(crown?.artistName).toBe('Radiohead');
      expect(crown?.userId).toBe(userId);
      expect(crown?.currentPlaycount).toBe(42);
      expect(crown?.active).toBe(true);
      expect(crown?.userNameLastFm).toBe(`db_user_${userId}`);
    });

    it('matches the artist name case-insensitively', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getCurrentCrown(guildId, 'radiohead')).resolves.not.toBeNull();
      await expect(repo!.getCurrentCrown(guildId, 'RADIOHEAD')).resolves.not.toBeNull();
    });

    it('ignores an inactive crown, because a stolen crown is not the current holder', async () => {
      await seedCrown({ artistName: 'Radiohead', active: false });
      await expect(repo!.getCurrentCrown(guildId, 'Radiohead')).resolves.toBeNull();
    });

    it('returns exactly one row when two active crowns exist for the same artist', async () => {
      // LIMIT 1 with no ORDER BY, so WHICH row comes back is unspecified - the
      // assertion is the count, and the shape of the answer. Two active crowns
      // for one artist is itself a data-integrity bug that this method hides
      // rather than surfaces.
      await seedCrown({ artistName: 'Radiohead', currentPlaycount: 10 });
      await seedCrown({ artistName: 'radiohead', currentPlaycount: 99 });
      const crown = await repo!.getCurrentCrown(guildId, 'Radiohead');
      expect(crown).not.toBeNull();
      expect([10, 99]).toContain(crown?.currentPlaycount);
    });

    it('is scoped to one guild when the same artist is crowned in two', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedCrown({ artistName: 'Radiohead', currentPlaycount: 10 });
      await seedCrown({ artistName: 'Radiohead', currentPlaycount: 77, guild: OTHER_GUILD_ID, user: other });
      expect((await repo!.getCurrentCrown(guildId, 'Radiohead'))?.currentPlaycount).toBe(10);
      expect((await repo!.getCurrentCrown(otherGuildId, 'Radiohead'))?.currentPlaycount).toBe(77);
    });

    it('returns the BigInt columns as strings and the rest as numbers and Dates', async () => {
      // `guild_id::text` and `discord_user_id::text` are load-bearing: without
      // them Prisma hands back a BigInt, and every consumer of guildId - a
      // Discord route parameter, a template string - would serialise it as
      // "8800001n".
      await seedCrown({ artistName: 'Radiohead' });
      const crown = await repo!.getCurrentCrown(guildId, 'Radiohead');
      expect(crown).not.toBeNull();
      expect(typeof crown?.guildId).toBe('string');
      expect(crown?.guildId).toBe(guildId);
      expect(typeof crown?.discordUserId).toBe('string');
      expect(crown?.discordUserId).toBe(String(BigInt(userId) * 1000n));
      expect(typeof crown?.crownId).toBe('number');
      expect(typeof crown?.userId).toBe('number');
      expect(typeof crown?.currentPlaycount).toBe('number');
      expect(typeof crown?.startPlaycount).toBe('number');
      expect(crown?.created).toBeInstanceOf(Date);
      expect(crown?.modified).toBeInstanceOf(Date);
      expect(crown?.created).toEqual(T(1));
    });

    it('cannot return a crown whose user row is gone, because the FK forbids the orphan', async () => {
      // INNER JOIN users. The FK is ON DELETE CASCADE, so the orphan this join
      // would have to tolerate cannot exist - which is the reason a LEFT JOIN
      // here would be both wrong and untestable. Asserted as a fact about the
      // database rather than about a hypothetical row.
      await seedCrown({ artistName: 'Radiohead' });
      await expect(
        prisma!.userCrown.updateMany({ where: { artistName: 'Radiohead' }, data: { userId: userId + 9000 } }),
      ).rejects.toThrow();
      expect(await repo!.getCurrentCrown(guildId, 'Radiohead')).not.toBeNull();
    });
  });

  describe('getUserCrowns (L186)', () => {
    it('returns an empty list for a user with no crowns', async () => {
      // The crown has to belong to somebody ELSE, and until 2026-09-29 it did
      // not: `seedCrown` defaults `user` to the primary `userId`, so this seeded
      // the very user it then asked about and asserted an empty list for. The
      // query is right - `WHERE c.guild_id = $1 AND c.user_id = $2 AND
      // c.active = $3` is scoped per user, which is what the method is FOR - and
      // the fixture was asserting the opposite of the row it had just written.
      // The "no crowns" case is a crown that exists in the guild under a
      // different holder, so that is what gets seeded. The second assertion is
      // there so the fixture cannot silently rot back into seeding userId.
      const other = userId + 7000;
      await seedUser(prisma!, other);
      await seedCrown({ artistName: 'Radiohead', user: other });

      await expect(repo!.getUserCrowns(guildId, userId)).resolves.toEqual([]);
      await expect(repo!.getUserCrowns(guildId, other)).resolves.toHaveLength(1);
    });

    it('returns an empty list for a non-numeric guild id', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getUserCrowns('not-a-guild', userId)).resolves.toEqual([]);
    });

    it('orders by current playcount descending for the Playcount view', async () => {
      await seedCrown({ artistName: 'Low', currentPlaycount: 5, created: T(1) });
      await seedCrown({ artistName: 'High', currentPlaycount: 50, created: T(2) });
      await seedCrown({ artistName: 'Mid', currentPlaycount: 20, created: T(3) });
      const crowns = await repo!.getUserCrowns(guildId, userId, 'Playcount');
      expect(crowns.map((c) => c.artistName)).toEqual(['High', 'Mid', 'Low']);
    });

    it('orders by creation descending for the Recent view', async () => {
      await seedCrown({ artistName: 'Oldest', created: T(1), currentPlaycount: 50 });
      await seedCrown({ artistName: 'Newest', created: T(3), currentPlaycount: 5 });
      await seedCrown({ artistName: 'Middle', created: T(2), currentPlaycount: 20 });
      const crowns = await repo!.getUserCrowns(guildId, userId, 'Recent');
      expect(crowns.map((c) => c.artistName)).toEqual(['Newest', 'Middle', 'Oldest']);
    });

    it('lists the INACTIVE crowns, newest steal first, for the Stolen view', async () => {
      // The one genuinely surprising thing about this query: `Stolen` flips the
      // active filter off. A stolen crown is precisely the deactivated row, so
      // asking for your stolen crowns and getting only active ones would be
      // empty by construction.
      await seedCrown({ artistName: 'Live', created: T(1), modified: T(1) });
      await seedCrown({ artistName: 'StolenFirst', active: false, created: T(1), modified: T(5) });
      await seedCrown({ artistName: 'StolenSecond', active: false, created: T(1), modified: T(2) });
      const stolen = await repo!.getUserCrowns(guildId, userId, 'Stolen');
      expect(stolen.map((c) => c.artistName)).toEqual(['StolenFirst', 'StolenSecond']);
      const playcount = await repo!.getUserCrowns(guildId, userId, 'Playcount');
      expect(playcount.map((c) => c.artistName)).toEqual(['Live']);
    });

    it('defaults to the Playcount view', async () => {
      await seedCrown({ artistName: 'Low', currentPlaycount: 5 });
      await seedCrown({ artistName: 'High', currentPlaycount: 50 });
      const crowns = await repo!.getUserCrowns(guildId, userId);
      expect(crowns.map((c) => c.artistName)).toEqual(['High', 'Low']);
    });

    it('never leaks another user crowns, and never another guild', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedCrown({ artistName: 'Mine' });
      await seedCrown({ artistName: 'Theirs', user: other });
      await seedCrown({ artistName: 'OtherGuild', guild: OTHER_GUILD_ID });
      expect((await repo!.getUserCrowns(guildId, userId)).map((c) => c.artistName)).toEqual(['Mine']);
      expect((await repo!.getUserCrowns(guildId, other)).map((c) => c.artistName)).toEqual(['Theirs']);
      expect((await repo!.getUserCrowns(otherGuildId, userId)).map((c) => c.artistName)).toEqual(['OtherGuild']);
    });

    it('binds the three view booleans as booleans, so the statement can be typed at all', async () => {
      // `c.active = $3` plus three `CASE WHEN $4/$5/$6` terms. If any of these
      // binds as an untyped parameter Postgres cannot resolve it, the statement
      // fails on EVERY call - and the caller sees an empty crown list, which is
      // indistinguishable from having no crowns. Three view types, three
      // different boolean combinations, so no combination is left unexecuted.
      await seedCrown({ artistName: 'Active' });
      await seedCrown({ artistName: 'Inactive', active: false });
      for (const view of ['Playcount', 'Recent', 'Stolen'] as const) {
        const crowns = await repo!.getUserCrowns(guildId, userId, view);
        expect(crowns).toHaveLength(1);
        expect(crowns[0]?.artistName).toBe(view === 'Stolen' ? 'Inactive' : 'Active');
      }
    });

    it('returns the same row shape as getCurrentCrown, casts included', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      const [crown] = await repo!.getUserCrowns(guildId, userId, 'Playcount');
      expect(typeof crown?.guildId).toBe('string');
      expect(typeof crown?.discordUserId).toBe('string');
      expect(crown?.userNameLastFm).toBe(`db_user_${userId}`);
      expect(crown?.created).toBeInstanceOf(Date);
    });
  });

  describe('getTopCrownHoldersInGuild (L219)', () => {
    it('returns an empty list for a guild with no crowns', async () => {
      await expect(repo!.getTopCrownHoldersInGuild(guildId)).resolves.toEqual([]);
    });

    it('returns an empty list for a non-numeric guild id', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getTopCrownHoldersInGuild('not-a-guild')).resolves.toEqual([]);
    });

    it('counts one holder per user, most crowns first', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedCrown({ artistName: 'A' });
      await seedCrown({ artistName: 'B' });
      await seedCrown({ artistName: 'C' });
      await seedCrown({ artistName: 'D', user: second });
      await seedCrown({ artistName: 'E', user: second });
      const holders = await repo!.getTopCrownHoldersInGuild(guildId);
      expect(holders).toHaveLength(2);
      expect(holders[0]?.userId).toBe(userId);
      expect(holders[0]?.crownCount).toBe(3);
      expect(holders[1]?.userId).toBe(second);
      expect(holders[1]?.crownCount).toBe(2);
    });

    it('returns crownCount as a JS number, which is what the ::int cast is for', async () => {
      // `COUNT(*)` is int8, so an uncast count would arrive as a BigInt and
      // CrownLeaderboardEntry.crownCount is typed `number`. A BigInt there is
      // fine until something does arithmetic or string-concatenates it.
      await seedCrown({ artistName: 'A' });
      const [holder] = await repo!.getTopCrownHoldersInGuild(guildId);
      expect(typeof holder?.crownCount).toBe('number');
      expect(holder?.crownCount).toBe(1);
      expect(typeof holder?.userId).toBe('number');
      expect(typeof holder?.discordUserId).toBe('string');
      expect(typeof holder?.userNameLastFm).toBe('string');
    });

    it('counts only active crowns, so a user who lost everything drops off', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedCrown({ artistName: 'Kept' });
      await seedCrown({ artistName: 'Lost', active: false });
      await seedCrown({ artistName: 'Theirs', user: second, active: false });
      const holders = await repo!.getTopCrownHoldersInGuild(guildId);
      expect(holders).toHaveLength(1);
      expect(holders[0]?.userId).toBe(userId);
      expect(holders[0]?.crownCount).toBe(1);
    });

    it('keeps two users with equal counts as two rows rather than merging them', async () => {
      // GROUP BY includes the user's display columns, so the grouping key is not
      // user_id alone. A tie in crownCount must not collapse the leaderboard.
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedCrown({ artistName: 'A' });
      await seedCrown({ artistName: 'B', user: second });
      const holders = await repo!.getTopCrownHoldersInGuild(guildId);
      expect(holders).toHaveLength(2);
      expect(holders.map((h) => h.userId).sort((a, b) => a - b)).toEqual([userId, second].sort((a, b) => a - b));
      expect(holders.every((h) => h.crownCount === 1)).toBe(true);
    });

    it('is scoped to one guild', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedCrown({ artistName: 'Mine' });
      await seedCrown({ artistName: 'Theirs', guild: OTHER_GUILD_ID, user: other });
      const holders = await repo!.getTopCrownHoldersInGuild(guildId);
      expect(holders).toHaveLength(1);
      expect(holders[0]?.userId).toBe(userId);
    });
  });

  describe('getCrownHistoryForArtist (L252)', () => {
    it('returns an empty list for an artist with no history', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getCrownHistoryForArtist(guildId, 'Portishead')).resolves.toEqual([]);
    });

    it('returns an empty list for a non-numeric guild id', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await expect(repo!.getCrownHistoryForArtist('not-a-guild', 'Radiohead')).resolves.toEqual([]);
    });

    it('returns stolen and live crowns together, newest first', async () => {
      // No `active` predicate on this query, which is the whole point of a
      // history: a reader asking "who held this before" needs the rows that
      // getCurrentCrown deliberately hides.
      await seedCrown({ artistName: 'Radiohead', created: T(1), currentPlaycount: 10 });
      await seedCrown({ artistName: 'Radiohead', created: T(3), currentPlaycount: 30, active: false });
      await seedCrown({ artistName: 'Radiohead', created: T(2), currentPlaycount: 20, active: false });
      const history = await repo!.getCrownHistoryForArtist(guildId, 'Radiohead');
      expect(history.map((c) => c.currentPlaycount)).toEqual([30, 20, 10]);
      expect(history.every((c) => c.artistName === 'Radiohead')).toBe(true);
    });

    it('honours the LIMIT, including a limit of zero', async () => {
      // LIMIT is bound as a parameter, so both a nonsense value and a boundary
      // value are runtime concerns. `LIMIT 0` returning one row would mean the
      // bound is being ignored.
      await seedCrown({ artistName: 'Radiohead', created: T(1) });
      await seedCrown({ artistName: 'Radiohead', created: T(2) });
      await seedCrown({ artistName: 'Radiohead', created: T(3) });
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead', 0)).toEqual([]);
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead', 1)).toHaveLength(1);
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead', 2)).toHaveLength(2);
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead', 99)).toHaveLength(3);
    });

    it('defaults to 10 rows when no limit is given', async () => {
      for (let i = 0; i < 12; i += 1) {
        await seedCrown({ artistName: 'Radiohead', created: T(1), currentPlaycount: i });
      }
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead')).toHaveLength(10);
    });

    it('matches the artist case-insensitively and stays in one guild', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedCrown({ artistName: 'Radiohead' });
      await seedCrown({ artistName: 'Radiohead', guild: OTHER_GUILD_ID, user: other });
      expect(await repo!.getCrownHistoryForArtist(guildId, 'RADIOHEAD')).toHaveLength(1);
      expect(await repo!.getCrownHistoryForArtist(guildId, 'radiohead')).toHaveLength(1);
      expect(await repo!.getCrownHistoryForArtist(otherGuildId, 'Radiohead')).toHaveLength(1);
    });
  });

  describe('seedCrownsForGuild (L292)', () => {
    it('seeds nothing when the guild has no indexed artists', async () => {
      await expect(repo!.seedCrownsForGuild(guildId)).resolves.toBe(0);
      // The await is load-bearing. Without it `expect` is handed a PrismaPromise,
      // `.toBe(0)` inspects the promise OBJECT, and the failure reads
      // "expected { catch, finally, requestTransaction, ... } to be 0" - a dump
      // of the ORM, not a statement about crowns.
      expect(await prisma!.userCrown.count()).toBe(0);
    });

    it('seeds nothing for a non-numeric guild id', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      await expect(repo!.seedCrownsForGuild('not-a-guild')).resolves.toBe(0);
    });

    it('seeds one active crown for the guild top listener', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      const crown = await prisma!.userCrown.findFirstOrThrow();
      expect(crown.userId).toBe(userId);
      expect(crown.artistName).toBe('Radiohead');
      expect(crown.seededCrown).toBe(true);
      expect(crown.active).toBe(true);
      expect(crown.startPlaycount).toBe(100);
      expect(crown.currentPlaycount).toBe(100);
    });

    it('applies the playcount threshold inclusively', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Exactly', 30);
      await seedUserArtist(userId, 'Below', 29);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      expect((await prisma!.userCrown.findMany()).map((c) => c.artistName)).toEqual(['Exactly']);
    });

    it('skips a member who is not in the guild at all', async () => {
      // The JOIN, not a WHERE clause: an indexed user who has left the guild has
      // no guild_users row and must not be seeded.
      await seedUserArtist(userId, 'Radiohead', 100);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(0);
    });

    it('skips a crown-blocked member and a who-knows-banned member', async () => {
      const blocked = userId + 5000;
      const banned = userId + 6000;
      const allowed = userId + 7000;
      await seedUser(prisma!, blocked);
      await seedUser(prisma!, banned);
      await seedUser(prisma!, allowed);
      await seedGuildMember(blocked, { blockedFromCrowns: true });
      await seedGuildMember(banned, { whoKnowsBanned: true });
      await seedGuildMember(allowed);
      await seedUserArtist(blocked, 'BlockedArtist', 100);
      await seedUserArtist(banned, 'BannedArtist', 100);
      await seedUserArtist(allowed, 'AllowedArtist', 100);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      expect((await prisma!.userCrown.findMany()).map((c) => c.artistName)).toEqual(['AllowedArtist']);
    });

    it('gives one artist to one user: the highest playcount wins, whichever name it is stored under', async () => {
      // DISTINCT ON (LOWER(name)) with ORDER BY LOWER(name), playcount DESC. Two
      // guild members both listening to the same artist must produce ONE crown,
      // not two competing active crowns for the same title.
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedGuildMember(userId);
      await seedGuildMember(second);
      await seedUserArtist(userId, 'Mac DeMarco', 100);
      await seedUserArtist(second, 'MAC DEMARCO', 250);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      const crowns = await prisma!.userCrown.findMany();
      expect(crowns).toHaveLength(1);
      expect(crowns[0]?.userId).toBe(second);
      expect(crowns[0]?.artistName).toBe('MAC DEMARCO');
      expect(crowns[0]?.currentPlaycount).toBe(250);
    });

    it('does not overwrite a live crown that a user already holds', async () => {
      // The fmbot rule: a seeded crown must never take a crown away from
      // somebody who earned it. Matched case-insensitively, so a different
      // capitalisation is still the same artist.
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      await seedCrown({ artistName: 'radiohead', currentPlaycount: 7, seededCrown: false });
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(0);
      const crowns = await prisma!.userCrown.findMany();
      expect(crowns).toHaveLength(1);
      expect(crowns[0]?.currentPlaycount).toBe(7);
      expect(crowns[0]?.seededCrown).toBe(false);
    });

    it('does replace a DEACTIVATED crown, because nobody holds it any more', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      await seedCrown({ artistName: 'Radiohead', currentPlaycount: 7, active: false });
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      const crowns = await prisma!.userCrown.findMany();
      expect(crowns).toHaveLength(2);
      expect(crowns.filter((c) => c.active)).toHaveLength(1);
    });

    it('is re-runnable: a second run replaces the seeded crown rather than adding one', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      const active = await prisma!.userCrown.findMany({ where: { active: true } });
      expect(active).toHaveLength(1);
      expect(active[0]?.seededCrown).toBe(true);
    });

    it('only deletes SEEDED crowns from the previous run, so a real crown survives', async () => {
      await seedGuildMember(userId);
      await seedUserArtist(userId, 'Radiohead', 100);
      await seedCrown({ artistName: 'Portishead', seededCrown: false });
      await seedCrown({ artistName: 'Boards Of Canada', seededCrown: true });
      await repo!.seedCrownsForGuild(guildId, 30);
      const names = (await prisma!.userCrown.findMany()).map((c) => c.artistName).sort();
      expect(names).toEqual(['Portishead', 'Radiohead']);
    });

    it('is scoped to one guild', async () => {
      const other = userId + 5000;
      await seedUser(prisma!, other);
      await seedGuildMember(userId);
      await seedGuildMember(other, { guild: OTHER_GUILD_ID });
      await seedUserArtist(userId, 'Mine', 100);
      await seedUserArtist(other, 'Theirs', 100);
      expect(await repo!.seedCrownsForGuild(guildId, 30)).toBe(1);
      expect((await prisma!.userCrown.findMany()).map((c) => c.artistName)).toEqual(['Mine']);
    });
  });

  describe('getBlockedCrownUsers (L397)', () => {
    it('returns an empty list when nobody is blocked', async () => {
      await seedGuildMember(userId);
      await expect(repo!.getBlockedCrownUsers(guildId)).resolves.toEqual([]);
    });

    it('returns an empty list for a guild that does not exist', async () => {
      await expect(repo!.getBlockedCrownUsers(otherGuildId)).resolves.toEqual([]);
    });

    it('returns an empty list for a non-numeric guild id', async () => {
      await seedGuildMember(userId, { blockedFromCrowns: true });
      await expect(repo!.getBlockedCrownUsers('not-a-guild')).resolves.toEqual([]);
    });

    it('returns only the blocked members, in last.fm name order', async () => {
      const zeta = userId + 5000;
      const alpha = userId + 6000;
      const unblocked = userId + 7000;
      await seedNamedUser(zeta, 'zeta');
      await seedNamedUser(alpha, 'alpha');
      await seedNamedUser(unblocked, 'middle');
      await seedGuildMember(zeta, { blockedFromCrowns: true });
      await seedGuildMember(alpha, { blockedFromCrowns: true });
      await seedGuildMember(unblocked);
      const blocked = await repo!.getBlockedCrownUsers(guildId);
      expect(blocked.map((b) => b.userNameLastFm)).toEqual(['alpha', 'zeta']);
      expect(blocked.map((b) => b.userId)).toEqual([alpha, zeta]);
      expect(typeof blocked[0]?.discordUserId).toBe('string');
      expect(blocked[0]?.discordUserId).toBe(String(BigInt(alpha) * 1000n));
    });

    it('is scoped to one guild', async () => {
      const other = userId + 5000;
      await seedNamedUser(other, 'elsewhere');
      await seedGuildMember(userId, { blockedFromCrowns: true });
      await seedGuildMember(other, { blockedFromCrowns: true, guild: OTHER_GUILD_ID });
      expect((await repo!.getBlockedCrownUsers(guildId)).map((b) => b.userNameLastFm)).toEqual([`db_user_${userId}`]);
      expect((await repo!.getBlockedCrownUsers(otherGuildId)).map((b) => b.userNameLastFm)).toEqual(['elsewhere']);
    });

    it('setCrownBlock writes the row this query reads, and blocking also drops the crowns', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await seedCrown({ artistName: 'Portishead' });
      await repo!.setCrownBlock(guildId, userId, true);
      expect((await repo!.getBlockedCrownUsers(guildId)).map((b) => b.userId)).toEqual([userId]);
      expect(await prisma!.userCrown.count({ where: { active: true } })).toBe(0);

      await repo!.setCrownBlock(guildId, userId, false);
      expect(await repo!.getBlockedCrownUsers(guildId)).toEqual([]);
    });
  });

  describe('the reads the crown pages depend on', () => {
    it('createCrown returns the same row shape the raw queries return', async () => {
      // Same DTO, one path through the ORM and one through raw SQL. If the raw
      // query ever drifts - a renamed column, a lost cast - this is where the
      // two answers are compared rather than assumed equal.
      const created = await repo!.createCrown({
        guildId,
        userId,
        artistName: 'Radiohead',
        startPlaycount: 5,
        currentPlaycount: 9,
      });
      const fetched = await repo!.getCurrentCrown(guildId, 'Radiohead');
      expect(typeof created.guildId).toBe('string');
      expect(fetched).not.toBeNull();
      expect(fetched?.crownId).toBe(created.crownId);
      expect(fetched?.userId).toBe(created.userId);
      expect(fetched?.artistName).toBe(created.artistName);
      expect(fetched?.currentPlaycount).toBe(created.currentPlaycount);
      expect(fetched?.startPlaycount).toBe(created.startPlaycount);
      expect(fetched?.guildId).toBe(created.guildId);
      expect(fetched?.discordUserId).toBe(created.discordUserId);
      expect(fetched?.userNameLastFm).toBe(created.userNameLastFm);
      expect(fetched?.active).toBe(created.active);
      expect(fetched?.seededCrown).toBe(created.seededCrown);
    });

    it('replaceCrown steals atomically and refuses when the crown is already gone', async () => {
      const first = await repo!.createCrown({
        guildId,
        userId,
        artistName: 'Radiohead',
        startPlaycount: 10,
        currentPlaycount: 10,
      });
      const thief = userId + 5000;
      await seedUser(prisma!, thief);
      const stolen = await repo!.replaceCrown(first.crownId, {
        guildId,
        userId: thief,
        artistName: 'Radiohead',
        startPlaycount: 0,
        currentPlaycount: 0,
      });
      expect(stolen?.userId).toBe(thief);
      expect((await repo!.getCurrentCrown(guildId, 'Radiohead'))?.userId).toBe(thief);
      expect(await prisma!.userCrown.count({ where: { active: true } })).toBe(1);
      // Second steal of the same crown: the row is inactive, so the
      // compare-and-set inside the transaction must refuse rather than create a
      // second active crown for the same artist.
      expect(await repo!.replaceCrown(first.crownId, {
        guildId,
        userId,
        artistName: 'Radiohead',
        startPlaycount: 0,
        currentPlaycount: 0,
      })).toBeNull();
      expect(await prisma!.userCrown.count({ where: { active: true } })).toBe(1);
    });

    it('killCrown and killAllCrowns move rows out of the active filter the queries apply', async () => {
      await seedCrown({ artistName: 'Radiohead' });
      await seedCrown({ artistName: 'Portishead' });
      expect(await repo!.getTotalActiveCrownsInGuild(guildId)).toBe(2);
      expect(await repo!.killCrown(guildId, 'radiohead')).toBe(true);
      expect(await repo!.killCrown(guildId, 'Nothing Here')).toBe(false);
      expect((await repo!.getUserCrowns(guildId, userId, 'Playcount')).map((c) => c.artistName)).toEqual(['Portishead']);
      expect(await repo!.killAllCrowns(guildId)).toBe(1);
      expect(await repo!.getTotalActiveCrownsInGuild(guildId)).toBe(0);
      expect(await repo!.getCrownHistoryForArtist(guildId, 'Radiohead')).toHaveLength(1);
    });

    it('deactivateCrownsForUser only touches active rows', async () => {
      const crownId = await seedCrown({ artistName: 'Radiohead' });
      await seedCrown({ artistName: 'Portishead', active: false });
      expect(await repo!.deactivateCrownsForUser(userId)).toBe(1);
      // deactivateCrown is an unconditional update by primary key, so it resolves
      // on an already-inactive row rather than refusing - which is why the steal
      // path uses replaceCrown's compare-and-set instead.
      await expect(repo!.deactivateCrown(crownId)).resolves.toBeUndefined();
      expect((await prisma!.userCrown.findUniqueOrThrow({ where: { crownId } })).active).toBe(false);
      await repo!.updateCrownPlaycount(crownId, 500);
      expect((await prisma!.userCrown.findUniqueOrThrow({ where: { crownId } })).currentPlaycount).toBe(500);
    });
  });
});
