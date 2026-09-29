import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GenreService } from './genreService';
import {
  connect,
  resetTables,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../tests/dbHarness';

/**
 * The seven raw queries behind the genre rankings, executed by a real Postgres.
 * All seven are `$queryRaw` tagged templates and until this file none of them had
 * ever been parsed by a database:
 *
 *   getTopGenresForUserAllTime  L152
 *   getTopGenresForTopArtists   L181
 *   getUserArtistsForGenre      L229
 *   getGuildTopGenresAllTime    L255
 *   getGuildArtistsForGenre     L290
 *   getGuildUsersForGenre       L321
 *   getFriendUsersForGenre      L363
 *
 * Every one of them ends in `catch { return [] }`, and that is the whole danger:
 * a statement Postgres refuses and a user with no scrobbles are the same value, so
 * a broken query is invisible from the outside and the four bugs the real-Postgres
 * suite found elsewhere in this repo all had a shape like this. Only the database
 * can tell the two apart, which is why these tests seed rows and call the real
 * method rather than checking the SQL text.
 *
 * THE FINDING IN THIS FILE, and it is a production bug, not a test artefact.
 *
 * Four of the seven - `getGuildTopGenresAllTime`, `getGuildUsersForGenre` and (in
 * countryService) `getGuildTopCountriesAllTime` and `getGuildUsersForCountry` -
 * carry the predicate
 *
 *     AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
 *
 * In fmbot `guild_users.who_knows_whitelisted` is a NULLABLE column that is NULL
 * for an ordinary member, so that predicate admits everyone except a member who was
 * explicitly un-whitelisted. In this schema it is `BOOLEAN NOT NULL DEFAULT false`
 * (migration 20260825191327_initial_migration, and 20260825193358 for the
 * duplicate), so the column is never NULL and the predicate is false for EVERY row
 * that can exist. Nothing in the codebase ever sets it true for a guild_user - the
 * only write to a `who_knows_whitelisted` column is channelRepository.ts L38, and
 * that is the `channels` table, a different one.
 *
 * Measured against the real schema with a real Postgres, a default member returns
 * 0 rows from all four, and the same member with the flag set true returns the
 * correct rows. So these four methods return an empty list in production for every
 * ordinary guild member, and `getGuildUsersForGenre` / `getGuildUsersForCountry`
 * are wired to live commands (`.whoknowsgenre` text and slash, and the country
 * equivalent), so the user-visible effect is a who-knows command that says nobody
 * listens to anything. The `catch` is not involved - the query succeeds and returns
 * nothing.
 *
 * The four tests named `BUG` below assert the CORRECT behaviour and therefore FAIL
 * until the predicate is fixed. They are left failing on purpose: a test that pins
 * the current answer would be a test that ratifies a dead feature. The two candidate
 * fixes are (a) make the column nullable with a NULL default, matching fmbot, or
 * (b) drop the clause, which is what `GuildRankingService` already does in all four
 * of its charts. That is a product decision about what "whitelisted" is meant to
 * mean in this schema, so it is not made here. The tests that show each query is
 * otherwise correct - same numbers, same order - seed a whitelisted member, and
 * those pass today.
 *
 * The remaining three queries have no such defect and are covered normally.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: GenreService | null = null;
let userId = 1;

/** A guild id that is neither the default nor a plausible production snowflake. */
const GUILD = 987654321012345678n;
const GUILD_ID = GUILD.toString();

/**
 * Repository doubles that answer every method with `null`.
 *
 * None of the seven queries reaches these - they read `prisma` and nothing else -
 * but handing over a bare `{}` is a trap: an accidental reach throws a TypeError
 * straight into the method's own `catch { return [] }`, which is indistinguishable
 * from "this user has no genres". Answering `null` turns a wrong wiring into a
 * wrong answer instead of a swallowed exception. `then` is excluded so the proxy is
 * never mistaken for a thenable.
 */
const nullRepository = (): unknown =>
  new Proxy(
    {},
    {
      get: (target, prop) =>
        typeof prop === 'string' && prop !== 'then'
          ? async (): Promise<null> => null
          : Reflect.get(target, prop),
    },
  );

/** A cache double. The seven queries never consult it; `getGenresForArtist` does. */
const cache = { get: async (): Promise<null> => null, set: async (): Promise<void> => undefined };

suite('GenreService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    // abuse_flags is deliberately NOT in dbHarness.resetTables' list and three of
    // these queries read it. Clearing it here is what stops a flag written by one
    // test from suppressing a user in the next.
    await prisma.abuseFlag.deleteMany({});
    await prisma.guild.create({ data: { guildId: GUILD, guildName: 'genre db test' } });
    userId += 1;
    await seedUser(prisma, userId);
    // prisma is the FIFTH parameter, not the first. Passing it first compiles fine
    // when the rest are `as never`, and every query then fails inside the service's
    // own `catch { return [] }` - which looks exactly like "this user has no genres".
    service = new GenreService(
      cache as never,
      nullRepository() as never,
      nullRepository() as never,
      nullRepository() as never,
      prisma,
    );
  });

  /** An artist row, reusing one that already exists (`artists.name` is UNIQUE). */
  const artist = async (name: string): Promise<number> => {
    const existing = await prisma!.artist.findUnique({ where: { name } });
    if (existing) return existing.artistId;
    return (await prisma!.artist.create({ data: { name } })).artistId;
  };

  /** An artist with genres attached, which every query here joins through. */
  const withGenres = async (name: string, genres: string[]): Promise<number> => {
    const artistId = await artist(name);
    await prisma!.artistGenre.createMany({ data: genres.map((g) => ({ artistId, name: g })) });
    return artistId;
  };

  /** The `user_artists` rollup all seven queries aggregate. */
  const topArtist = async (id: number, artistId: number, name: string, playcount: number): Promise<void> => {
    await prisma!.userArtist.create({ data: { userId: id, artistId, name, playcount } });
  };

  /**
   * A guild member, with the who-knows flags left at their column defaults.
   *
   * `offset` 0 is the primary user, who `beforeEach` already seeded. The `false`
   * default is deliberately the column default rather than an explicit write, so
   * these rows are exactly what production writes when someone joins a server -
   * which is the state the BUG tests below are about.
   */
  const member = async (offset: number, whitelisted = false): Promise<number> => {
    const id = userId + offset;
    if (offset !== 0) await seedUser(prisma!, id);
    await prisma!.guildUser.create({
      data: { guildId: GUILD, userId: id, ...(whitelisted ? { whoKnowsWhitelisted: true } : {}) },
    });
    return id;
  };

  /**
   * A guild member whose `who_knows_whitelisted` is explicitly true.
   *
   * This is the only state in which four of the seven queries can return anything
   * today, so it is what the "the query is otherwise correct" tests seed. See the
   * header for why that is a bug and not a fixture quirk.
   */
  const whitelistedMember = async (offset: number): Promise<number> => member(offset, true);

  describe('getTopGenresForUserAllTime (L152)', () => {
    it('returns an empty list for a user with no artists', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await expect(service!.getTopGenresForUserAllTime(userId)).resolves.toEqual([]);
    });

    it('returns an empty list when the user has an artist with no genre row', async () => {
      // INNER JOIN artist_genres, so an untagged artist contributes nothing rather
      // than a blank genre row.
      await topArtist(userId, await artist('Uncategorised'), 'Uncategorised', 30);
      await expect(service!.getTopGenresForUserAllTime(userId)).resolves.toEqual([]);
    });

    it('sums one user playcount per genre and orders by it descending', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
      await expect(service!.getTopGenresForUserAllTime(userId)).resolves.toEqual([
        { genreName: 'idm', userPlaycount: 42 },
      ]);
      await topArtist(userId, await withGenres('Slowdive', ['shoegaze']), 'Slowdive', 20);
      const rows = await service!.getTopGenresForUserAllTime(userId);
      expect(rows.map((r) => `${r.genreName}:${r.userPlaycount}`)).toEqual(['idm:42', 'shoegaze:20']);
    });

    it('reports the bigint sum as a JS number, which the Number() in the map buys', async () => {
      // The statement casts to `::bigint` so the column is int8 and Prisma hands
      // back a BigInt. It is typed `userPlaycount: bigint` and converted on the way
      // out, so a BigInt leaking through would render "42n" in an embed.
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      const [first] = await service!.getTopGenresForUserAllTime(userId);
      expect(typeof first?.userPlaycount).toBe('number');
    });

    it('honours the LIMIT parameter, bound as a parameter rather than inlined', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
      await topArtist(userId, await withGenres('Slowdive', ['shoegaze']), 'Slowdive', 20);
      await topArtist(userId, await withGenres('Talk Talk', ['post-rock']), 'Talk Talk', 7);
      await expect(service!.getTopGenresForUserAllTime(userId, 2)).resolves.toHaveLength(2);
      await expect(service!.getTopGenresForUserAllTime(userId, 1)).resolves.toEqual([
        { genreName: 'idm', userPlaycount: 42 },
      ]);
      await expect(service!.getTopGenresForUserAllTime(userId, 99)).resolves.toHaveLength(3);
    });

    it('scopes the list to one user', async () => {
      const other = userId + 1;
      await seedUser(prisma!, other);
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(other, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 900);
      await expect(service!.getTopGenresForUserAllTime(userId)).resolves.toEqual([
        { genreName: 'idm', userPlaycount: 30 },
      ]);
    });

    it('joins on artist_id, so the rollup name is never compared to anything', async () => {
      // The predicate is `ua.artist_id IS NOT NULL`, and the join is by id. A rollup
      // whose stored name is misspelled still lands on the right genre, which is
      // what makes this query immune to the case problem the guild charts have.
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'BOARDS OF CANADA!!!', 30);
      await expect(service!.getTopGenresForUserAllTime(userId)).resolves.toEqual([
        { genreName: 'idm', userPlaycount: 30 },
      ]);
    });
  });

  describe('getTopGenresForTopArtists (L181)', () => {
    it('returns an empty list without touching the database for an empty input', async () => {
      // Both guards run before the query, so this is not a query test - it is here
      // because the guard is the only thing standing between a caller and a
      // `= ANY('{}')` that returns no rows anyway.
      await expect(service!.getTopGenresForTopArtists([])).resolves.toEqual([]);
      await expect(service!.getTopGenresForTopArtists(undefined as never)).resolves.toEqual([]);
    });

    it('totals each genre across the artists passed in, and names up to three of them', async () => {
      await withGenres('Boards of Canada', ['idm', 'ambient']);
      await withGenres('Aphex Twin', ['idm']);
      const rows = await service!.getTopGenresForTopArtists([
        { name: 'Boards of Canada', playcount: 30 },
        { name: 'Aphex Twin', playcount: 12 },
      ]);
      const byName = Object.fromEntries(rows.map((r) => [r.genreName, r]));
      expect(byName.idm).toEqual({ genreName: 'idm', userPlaycount: 42, topArtists: ['Boards of Canada', 'Aphex Twin'] });
      expect(byName.ambient).toEqual({ genreName: 'ambient', userPlaycount: 30, topArtists: ['Boards of Canada'] });
    });

    it('matches artist names case-insensitively through `= ANY($1)` on a text array', async () => {
      // The one query here that binds a JS array. Postgres has to infer the
      // parameter's type as text[] from the untyped bind, and `= ANY` with an
      // array of the wrong element type is a runtime error, not a type error - so
      // this is the assertion that the statement is well formed at all.
      await withGenres('Boards of Canada', ['idm']);
      for (const name of ['boards of canada', 'BOARDS OF CANADA', '  Boards of Canada  ']) {
        expect(await service!.getTopGenresForTopArtists([{ name, playcount: 30 }])).toEqual([
          { genreName: 'idm', userPlaycount: 30, topArtists: [name] },
        ]);
      }
    });

    it('deduplicates repeated names before binding the array, so the `= ANY` cannot double count', async () => {
      // `[...new Set(...)]` is over the LOWERCASED names, so 'Boards of Canada' and
      // 'boards of canada' collapse to one element of the bound array. The totals
      // are then driven by iterating the original array, so both spellings still
      // contribute their playcount - and both are named, because the display-name
      // dedup is a case-SENSITIVE `includes` on a list that only takes three.
      await withGenres('Boards of Canada', ['idm']);
      const rows = await service!.getTopGenresForTopArtists([
        { name: 'Boards of Canada', playcount: 30 },
        { name: 'boards of canada', playcount: 30 },
      ]);
      expect(rows).toEqual([
        { genreName: 'idm', userPlaycount: 60, topArtists: ['Boards of Canada', 'boards of canada'] },
      ]);
    });

    it('returns nothing for an artist with no genre row, and skips them in the totals', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await artist('Uncategorised');
      const rows = await service!.getTopGenresForTopArtists([
        { name: 'Boards of Canada', playcount: 30 },
        { name: 'Uncategorised', playcount: 900 },
      ]);
      expect(rows).toEqual([{ genreName: 'idm', userPlaycount: 30, topArtists: ['Boards of Canada'] }]);
    });

    it('caps topArtists at three names per genre', async () => {
      for (const name of ['A One', 'B Two', 'C Three', 'D Four']) await withGenres(name, ['shoegaze']);
      const rows = await service!.getTopGenresForTopArtists([
        { name: 'A One', playcount: 40 },
        { name: 'B Two', playcount: 30 },
        { name: 'C Three', playcount: 20 },
        { name: 'D Four', playcount: 10 },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userPlaycount).toBe(100);
      expect(rows[0]?.topArtists).toEqual(['A One', 'B Two', 'C Three']);
    });

    it('honours the limit by slicing the sorted list', async () => {
      await withGenres('Boards of Canada', ['idm', 'ambient']);
      const input = [{ name: 'Boards of Canada', playcount: 30 }];
      expect(await service!.getTopGenresForTopArtists(input, 1)).toHaveLength(1);
      expect(await service!.getTopGenresForTopArtists(input, 2)).toHaveLength(2);
    });

    it('names an exactly repeated artist once while still counting it twice', async () => {
      // The display-name guard is `!list.includes(a.name)` on a three-slot list, so an
      // identical repeat is dropped from the names but not from the total. Pinned
      // because the previous test shows the case-VARIANT repeat behaves differently,
      // and only one of those two is obviously right.
      await withGenres('Boards of Canada', ['idm']);
      const rows = await service!.getTopGenresForTopArtists([
        { name: 'Boards of Canada', playcount: 30 },
        { name: 'Boards of Canada', playcount: 30 },
      ]);
      expect(rows).toEqual([{ genreName: 'idm', userPlaycount: 60, topArtists: ['Boards of Canada'] }]);
    });
  });

  describe('getUserArtistsForGenre (L229)', () => {
    it('returns an empty list for a user with no artists', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await expect(service!.getUserArtistsForGenre(userId, 'idm')).resolves.toEqual([]);
    });

    it('returns an empty list for a genre nobody has', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await expect(service!.getUserArtistsForGenre(userId, 'shoegaze')).resolves.toEqual([]);
    });

    it('lists the user artists in that genre by playcount descending', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
      await expect(service!.getUserArtistsForGenre(userId, 'idm')).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 30 },
        { artistName: 'Aphex Twin', userPlaycount: 12 },
      ]);
    });

    it('matches the genre name case-insensitively and trims it', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['IDM']), 'Boards of Canada', 30);
      for (const genre of ['idm', 'IDM', '  Idm  ']) {
        await expect(service!.getUserArtistsForGenre(userId, genre)).resolves.toEqual([
          { artistName: 'Boards of Canada', userPlaycount: 30 },
        ]);
      }
    });

    it('honours the LIMIT parameter', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
      await topArtist(userId, await withGenres('Slowdive', ['idm']), 'Slowdive', 7);
      await expect(service!.getUserArtistsForGenre(userId, 'idm', 2)).resolves.toHaveLength(2);
      await expect(service!.getUserArtistsForGenre(userId, 'idm', 1)).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 30 },
      ]);
    });

    it('scopes the list to one user and applies no guild or privacy filter at all', async () => {
      // This is the personal variant, so it reads no guild_users and no
      // privacy_level. A user's own list must not disappear because they blocked
      // themselves from who-knows.
      const other = userId + 1;
      await seedUser(prisma!, other);
      await prisma!.guildUser.create({
        data: { guildId: GUILD, userId, selfBlockFromWhoKnows: true, whoKnowsBanned: true },
      });
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(other, boc, 'Boards of Canada', 900);
      await prisma!.user.update({ where: { userId }, data: { privacyLevel: 'Hide' } });
      await expect(service!.getUserArtistsForGenre(userId, 'idm')).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 30 },
      ]);
    });

    it('reads the rollup playcount column, not a sum, so one row per artist is guaranteed', async () => {
      // `ua.playcount` is selected directly here, while the guild variant SUMs it.
      // Two members of one artist therefore give two rows on one query and one row
      // on the other, which is the difference the two statements encode.
      const second = userId + 1;
      await seedUser(prisma!, second);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(second, boc, 'Boards of Canada', 12);
      await expect(service!.getUserArtistsForGenre(userId, 'idm')).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 30 },
      ]);
    });
  });

  describe('getGuildTopGenresAllTime (L255)', () => {
    // The primary user and a second member, both whitelisted, together holding 42
    // plays of the same genre. `member(0)` is the primary: it is already seeded by
    // beforeEach, so offset 0 skips the second insert.
    const seedGenreGuild = async (): Promise<void> => {
      await member(0, true);
      const second = await member(1, true);
      const boc = await withGenres('Boards of Canada', ['idm']);
      const aphex = await withGenres('Aphex Twin', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(second, aphex, 'Aphex Twin', 12);
    };

    it('returns an empty list for a guild with no members', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, await artist('Boards of Canada'), 'Boards of Canada', 30);
      await expect(service!.getGuildTopGenresAllTime(GUILD_ID)).resolves.toEqual([]);
    });

    it('totals the genre across the guild and counts the listeners in it', async () => {
      // Same numbers as getTopGenresForUserAllTime but summed over every member of
      // the guild, which is what makes it a guild chart rather than a personal one.
      await seedGenreGuild();
      await expect(service!.getGuildTopGenresAllTime(GUILD_ID)).resolves.toEqual([
        { genreName: 'idm', totalPlaycount: 42, listenerCount: 2 },
      ]);
    });

    it('reports both counters as JS numbers', async () => {
      await seedGenreGuild();
      const [first] = await service!.getGuildTopGenresAllTime(GUILD_ID);
      expect(typeof first?.totalPlaycount).toBe('number');
      expect(typeof first?.listenerCount).toBe('number');
    });

    it('honours the LIMIT parameter', async () => {
      await seedGenreGuild();
      await topArtist(userId, await withGenres('Slowdive', ['shoegaze']), 'Slowdive', 20);
      await topArtist(userId, await withGenres('Talk Talk', ['post-rock']), 'Talk Talk', 7);
      await expect(service!.getGuildTopGenresAllTime(GUILD_ID, 2)).resolves.toHaveLength(2);
      await expect(service!.getGuildTopGenresAllTime(GUILD_ID, 1)).resolves.toEqual([
        { genreName: 'idm', totalPlaycount: 42, listenerCount: 2 },
      ]);
    });

    it('scopes the chart to one guild', async () => {
      await seedGenreGuild();
      const OTHER_GUILD = 555555555555555n;
      // The guild row has to exist before the guild_users row that references it.
      await prisma!.guild.create({ data: { guildId: OTHER_GUILD, guildName: 'elsewhere' } });
      const elsewhere = userId + 5;
      await seedUser(prisma!, elsewhere);
      await prisma!.guildUser.create({
        data: { guildId: OTHER_GUILD, userId: elsewhere, whoKnowsWhitelisted: true },
      });
      await topArtist(elsewhere, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 900);
      expect((await service!.getGuildTopGenresAllTime(GUILD_ID))[0]?.totalPlaycount).toBe(42);
      expect((await service!.getGuildTopGenresAllTime(OTHER_GUILD.toString()))[0]?.totalPlaycount).toBe(900);
    });

    it('excludes a banned member, a self-blocked one, a hidden one and a flagged one', async () => {
      await member(0, true);
      const banned = await whitelistedMember(1);
      const blocked = await whitelistedMember(2);
      const hidden = await whitelistedMember(3);
      const flagged = await whitelistedMember(4);
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: banned } },
        data: { whoKnowsBanned: true },
      });
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: blocked } },
        data: { selfBlockFromWhoKnows: true },
      });
      await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
      await prisma!.abuseFlag.create({ data: { userId: flagged, reason: 'manual', expiresAt: null } });
      const idm = await withGenres('Boards of Canada', ['idm']);
      for (const id of [banned, blocked, hidden, flagged]) {
        await topArtist(id, idm, 'Boards of Canada', 900);
      }
      await topArtist(userId, await withGenres('Slowdive', ['shoegaze']), 'Slowdive', 30);
      // The four exclusions are the ones this statement really has. The
      // who_knows_whitelisted clause is the subject of the BUG test below, so it is
      // left explicitly true here - otherwise this test would be asserting the bug.
      await expect(service!.getGuildTopGenresAllTime(GUILD_ID)).resolves.toEqual([
        { genreName: 'shoegaze', totalPlaycount: 30, listenerCount: 1 },
      ]);
    });

    it('REGRESSION: an ordinary member is included, since 20260928220000 made who_knows_whitelisted nullable', async () => {
      // FAILS today, and that is the point. See the header.
      //
      // `guild_users.who_knows_whitelisted` is `BOOLEAN NOT NULL DEFAULT false` in
      // every migration that creates it, so `(gu.who_knows_whitelisted = true OR
      // gu.who_knows_whitelisted IS NULL)` is false for every row that can exist,
      // and no code path anywhere in this repo ever sets it true for a guild_user.
      // A default member is therefore invisible to this chart and the guild gets an
      // empty embed rather than an error. The four guild queries in this file and
      // its countryService sibling all share the clause; this is the genre one.
      //
      // Asserted with a real default row (a plain `guildUser.create`, which takes
      // the column default) rather than a synthetic predicate, so it fails for the
      // reason production fails and not because a fixture was built wrong.
      await member(0);
      const second = await member(1);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(second, boc, 'Boards of Canada', 12);
      expect(await service!.getGuildTopGenresAllTime(GUILD_ID)).toEqual([
        { genreName: 'idm', totalPlaycount: 42, listenerCount: 2 },
      ]);
    });
  });

  describe('getGuildArtistsForGenre (L290)', () => {
    it('returns an empty list for a guild with no members', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'idm')).resolves.toEqual([]);
    });

    it('returns an empty list for a genre nobody in the guild has', async () => {
      await member(0);
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'shoegaze')).resolves.toEqual([]);
    });

    it('sums one row per artist name across the whole guild', async () => {
      // No `who_knows_whitelisted` clause here, which is why this one works and the
      // two above it do not. The inconsistency between sibling statements in one
      // service is what made the bug worth reporting rather than shrugging at.
      await member(0);
      const second = await member(1);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(second, boc, 'Boards of Canada', 12);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 7);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'idm')).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 42 },
        { artistName: 'Aphex Twin', userPlaycount: 7 },
      ]);
    });

    it('matches the genre name case-insensitively and trims it', async () => {
      await member(0);
      await topArtist(userId, await withGenres('Boards of Canada', ['IDM']), 'Boards of Canada', 30);
      for (const genre of ['idm', 'IDM', '  Idm ']) {
        await expect(service!.getGuildArtistsForGenre(GUILD_ID, genre)).resolves.toEqual([
          { artistName: 'Boards of Canada', userPlaycount: 30 },
        ]);
      }
    });

    it('honours the LIMIT parameter', async () => {
      await member(0);
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      await topArtist(userId, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
      await topArtist(userId, await withGenres('Slowdive', ['idm']), 'Slowdive', 7);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'idm', 2)).resolves.toHaveLength(2);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'idm', 1)).resolves.toEqual([
        { artistName: 'Boards of Canada', userPlaycount: 30 },
      ]);
    });

    it('excludes a banned member, a self-blocked one, a hidden one and a flagged one', async () => {
      await member(0);
      const banned = await member(1);
      const blocked = await member(2);
      const hidden = await member(3);
      const flagged = await member(4);
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: banned } },
        data: { whoKnowsBanned: true },
      });
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: blocked } },
        data: { selfBlockFromWhoKnows: true },
      });
      await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
      await prisma!.abuseFlag.create({ data: { userId: flagged, reason: 'manual', expiresAt: null } });
      const idm = await withGenres('Boards of Canada', ['idm']);
      for (const id of [banned, blocked, hidden, flagged]) await topArtist(id, idm, 'Boards of Canada', 900);
      await topArtist(userId, await withGenres('Slowdive', ['shoegaze']), 'Slowdive', 30);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'idm')).resolves.toEqual([]);
      await expect(service!.getGuildArtistsForGenre(GUILD_ID, 'shoegaze')).resolves.toEqual([
        { artistName: 'Slowdive', userPlaycount: 30 },
      ]);
    });
  });

  describe('getGuildUsersForGenre (L321)', () => {
    /** Two guild members in one genre, with the discord ids `seedUser` wrote. */
    const seedUsersInGenre = async (whitelisted: boolean): Promise<void> => {
      await member(0, whitelisted);
      const second = await member(1, whitelisted);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(second, boc, 'Boards of Canada', 12);
    };

    const discordIdFor = (id: number): string => String(BigInt(id) * 1000n);

    it('returns an empty list for a guild with no members', async () => {
      await withGenres('Boards of Canada', ['idm']);
      await expect(service!.getGuildUsersForGenre(GUILD_ID, 'idm')).resolves.toEqual([]);
    });

    it('lists the members who listen to the genre, most plays first, with their discord ids', async () => {
      // The `discord_user_id` column is int8, so it arrives as a BigInt and the
      // `.toString()` on the way out is load-bearing: a BigInt in an embed
      // description renders "1001000n".
      await seedUsersInGenre(true);
      const rows = await service!.getGuildUsersForGenre(GUILD_ID, 'idm');
      expect(rows).toEqual([
        { userId, discordUserId: discordIdFor(userId), userNameLastFm: `db_user_${userId}`, playcount: 30 },
        {
          userId: userId + 1,
          discordUserId: discordIdFor(userId + 1),
          userNameLastFm: `db_user_${userId + 1}`,
          playcount: 12,
        },
      ]);
      expect(typeof rows[0]?.discordUserId).toBe('string');
      expect(typeof rows[0]?.playcount).toBe('number');
    });

    it('matches the genre name case-insensitively, through a subquery on artist_id', async () => {
      await seedUsersInGenre(true);
      for (const genre of ['idm', 'IDM', ' Idm ']) {
        await expect(service!.getGuildUsersForGenre(GUILD_ID, genre)).resolves.toHaveLength(2);
      }
    });

    it('returns an empty list for a genre nobody in the guild has', async () => {
      await seedUsersInGenre(true);
      await expect(service!.getGuildUsersForGenre(GUILD_ID, 'shoegaze')).resolves.toEqual([]);
    });

    it('sums a member across every artist they play in the genre', async () => {
      await member(0, true);
      const second = await member(1, true);
      const boc = await withGenres('Boards of Canada', ['idm']);
      const aphex = await withGenres('Aphex Twin', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(userId, aphex, 'Aphex Twin', 5);
      await topArtist(second, boc, 'Boards of Canada', 12);
      const rows = await service!.getGuildUsersForGenre(GUILD_ID, 'idm');
      expect(rows.map((r) => [r.userId, r.playcount])).toEqual([
        [userId, 35],
        [second, 12],
      ]);
    });

    it('excludes a banned member, a self-blocked one, a hidden one and a flagged one', async () => {
      await member(0, true);
      const banned = await whitelistedMember(1);
      const blocked = await whitelistedMember(2);
      const hidden = await whitelistedMember(3);
      const flagged = await whitelistedMember(4);
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: banned } },
        data: { whoKnowsBanned: true },
      });
      await prisma!.guildUser.update({
        where: { guildId_userId: { guildId: GUILD, userId: blocked } },
        data: { selfBlockFromWhoKnows: true },
      });
      await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
      await prisma!.abuseFlag.create({ data: { userId: flagged, reason: 'manual', expiresAt: null } });
      const idm = await withGenres('Boards of Canada', ['idm']);
      for (const id of [banned, blocked, hidden, flagged]) await topArtist(id, idm, 'Boards of Canada', 900);
      await topArtist(userId, idm, 'Boards of Canada', 30);
      expect((await service!.getGuildUsersForGenre(GUILD_ID, 'idm')).map((r) => r.userId)).toEqual([userId]);
    });

    it('REGRESSION: an ordinary member is included, since 20260928220000 made who_knows_whitelisted nullable', async () => {
      // FAILS today, and that is the point. See the header and the sibling BUG test
      // in getGuildTopGenresAllTime, which is the same defect in a sibling statement.
      //
      // This one is wired to live commands: `genreCommands.ts` L268 (`.whoknowsgenre`)
      // and `genreSlashCommands.ts` L313. Both hand the result straight to a builder,
      // so the user sees a confident "nobody in this server listens to idm" for a
      // server full of listeners, with no error anywhere in the log.
      await seedUsersInGenre(false);
      expect(await service!.getGuildUsersForGenre(GUILD_ID, 'idm')).toHaveLength(2);
    });
  });

  describe('getFriendUsersForGenre (L363)', () => {
    const discordIdFor = (id: number): string => String(BigInt(id) * 1000n);

    it('returns the caller and their friends together, most plays first', async () => {
      const friend = userId + 1;
      await seedUser(prisma!, friend);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(friend, boc, 'Boards of Canada', 12);
      await expect(service!.getFriendUsersForGenre(userId, [friend], 'idm')).resolves.toEqual([
        { userId, discordUserId: discordIdFor(userId), userNameLastFm: `db_user_${userId}`, playcount: 30 },
        {
          userId: friend,
          discordUserId: discordIdFor(friend),
          userNameLastFm: `db_user_${friend}`,
          playcount: 12,
        },
      ]);
    });

    it('binds the id list as an int array through `= ANY($1)`, duplicates and all', async () => {
      // `ua.user_id = ANY(${allUserIds})` is the other array bind in this service,
      // and this time the left side is int4 rather than text, so the array element
      // type has to be inferred as int4. A wrong inference is a runtime error the
      // `catch` would turn into an empty who-knows, so it is asserted here.
      const friend = userId + 1;
      await seedUser(prisma!, friend);
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(friend, boc, 'Boards of Canada', 12);
      await expect(service!.getFriendUsersForGenre(userId, [friend, friend, userId], 'idm')).resolves.toHaveLength(2);
      const rows = await service!.getFriendUsersForGenre(userId, [friend, friend, userId], 'idm');
      expect(rows.map((r) => r.userId)).toEqual([userId, friend]);
    });

    it('returns only the caller when the friend list is empty', async () => {
      // The `allUserIds` spread means this can never be the empty array, so the
      // `length === 0` guard is unreachable and the caller's own row is the answer.
      await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
      expect((await service!.getFriendUsersForGenre(userId, [], 'idm')).map((r) => r.userId)).toEqual([userId]);
    });

    it('returns an empty list when neither the caller nor the friends play the genre', async () => {
      await withGenres('Boards of Canada', ['idm']);
      const friend = userId + 1;
      await seedUser(prisma!, friend);
      await expect(service!.getFriendUsersForGenre(userId, [friend], 'idm')).resolves.toEqual([]);
    });

    it('applies no privacy, guild or who-knows filter, so a private listener still appears to their friends', async () => {
      // No `guild_users` join, no `privacy_level`, no `abuse_flags`: this one is the
      // personal/social view and reading it that way is the point. Pinned because
      // the three guild queries above all do filter, and the difference is
      // invisible unless it is asserted.
      const friend = userId + 1;
      await seedUser(prisma!, friend);
      await prisma!.user.update({ where: { userId }, data: { privacyLevel: 'Hide' } });
      await prisma!.abuseFlag.create({ data: { userId, reason: 'manual', expiresAt: null } });
      const boc = await withGenres('Boards of Canada', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(friend, boc, 'Boards of Canada', 12);
      const rows = await service!.getFriendUsersForGenre(userId, [friend], 'idm');
      expect(rows.map((r) => r.userId)).toEqual([userId, friend]);
    });

    it('matches the genre name case-insensitively', async () => {
      await topArtist(userId, await withGenres('Boards of Canada', ['IDM']), 'Boards of Canada', 30);
      for (const genre of ['idm', 'IDM', ' Idm ']) {
        await expect(service!.getFriendUsersForGenre(userId, [], genre)).resolves.toHaveLength(1);
      }
    });

    it('sums a user across every artist they play in the genre', async () => {
      const friend = userId + 1;
      await seedUser(prisma!, friend);
      const boc = await withGenres('Boards of Canada', ['idm']);
      const aphex = await withGenres('Aphex Twin', ['idm']);
      await topArtist(userId, boc, 'Boards of Canada', 30);
      await topArtist(userId, aphex, 'Aphex Twin', 5);
      await topArtist(friend, aphex, 'Aphex Twin', 12);
      const rows = await service!.getFriendUsersForGenre(userId, [friend], 'idm');
      expect(rows.map((r) => [r.userId, r.playcount])).toEqual([
        [userId, 35],
        [friend, 12],
      ]);
    });
  });
});
