import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { CountryService } from '@bot/services/library/countryService';
import {
  connect,
  resetTables,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../../testSupport/dbHarness';

/**
 * The five raw queries behind the country rankings, executed by a real Postgres.
 * All five are `$queryRaw` tagged templates and until this file none of them had
 * ever been parsed by a database:
 *
 *   getUserTopCountriesAllTime  L349
 *   getUserArtistsForCountry    L380
 *   getGuildTopCountriesAllTime L403
 *   getGuildArtistsForCountry   L440
 *   getGuildUsersForCountry     L468
 *
 * Every one of them ends in `catch { return [] }`, and that is the whole danger: a
 * statement Postgres refuses and a user with no scrobbles are the same value. The
 * four bugs the real-Postgres suite found elsewhere in this repo all had that shape.
 * So these tests seed rows and call the real method rather than reading the SQL.
 *
 * TWO THINGS THIS FILE PROVES THAT A MOCK CANNOT.
 *
 * 1. THE SAME BUG AS genreService, in the same shape, twice more. `getGuildTopCountriesAllTime`
 *    and `getGuildUsersForCountry` carry
 *
 *        AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
 *
 *    In fmbot `guild_users.who_knows_whitelisted` is a NULLABLE column, NULL for an
 *    ordinary member, so that clause admits everyone but an explicitly un-whitelisted
 *    member. Here it is `BOOLEAN NOT NULL DEFAULT false` (migrations
 *    20260825191327 and 20260825193358), so it is never NULL, the clause is false for
 *    every row that can exist, and nothing in this repo ever sets it true for a
 *    guild_user - the only write to a `who_knows_whitelisted` column is
 *    channelRepository.ts L38, and that is the `channels` table.
 *
 *    Measured against the real schema: a default member returns 0 rows from both, and
 *    the same member with the flag set true returns the correct rows. So both methods
 *    return an empty list in production for every ordinary guild member, with no error
 *    and no log line. `getGuildUsersForCountry` is wired to `.whoknowscountry` in both
 *    text and slash form, and `getGuildTopCountriesAllTime` to the country select menu
 *    in `countryInteractions.ts` L90. The two tests named `BUG` assert the CORRECT
 *    behaviour and therefore FAIL until the predicate is fixed; they are left failing
 *    on purpose, because a test that pinned the current answer would ratify a dead
 *    feature. The fix is a product decision - make the column nullable like fmbot's, or
 *    drop the clause as `GuildRankingService` does in all four of its charts - so it is
 *    not made here. The passing tests seed a whitelisted member, which is the only
 *    state in which these statements can return anything today, and they show the
 *    arithmetic and the ordering are otherwise correct.
 *
 * 2. `getUserTopCountriesAllTime`'s raw query is a FALLBACK, and that fact is only
 *    visible by running it. The method first aggregates in JS from
 *    `getUserArtistsTop` plus the seed map and the preloaded `artists.country_code`
 *    map, and only falls through to the SQL when that produces nothing. The map is
 *    snapshotted once, in the constructor, and never refreshed - so every artist the
 *    indexer catalogues after boot is missing from it, the JS aggregation returns
 *    nothing, and the SQL answers. That is a routine production route, not a
 *    contrived one, and it is the only one. Worth pinning: a query that can only be
 *    reached to return nothing is a query nobody should keep.
 *
 * Fixture names are deliberately invented. `src/bot/resources/artist_countries.json`
 * maps several hundred real artists to countries and the constructor loads it, so a
 * real artist name would be answered by the seed map before the database was ever
 * asked. None of the names below is in that file.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: CountryService | null = null;
let userId = 1;

/** A guild id that is neither the default nor a plausible production snowflake. */
const GUILD = 987654321012345678n;
const GUILD_ID = GUILD.toString();

/**
 * A MusicBrainz double.
 *
 * Every path that would otherwise reach the network returns nothing, which keeps the
 * background `setImmediate` lookup in `getTopCountriesForTopArtists` from writing to
 * the database after the test has finished. It records its calls so a test can prove
 * a name was handed to it rather than to Postgres.
 */
const mbLookups: string[] = [];
const musicBrainz = {
  getArtistData: async (name: string): Promise<null> => {
    mbLookups.push(name);
    return null;
  },
};

/** A cache double; the five queries never consult it. */
const cache = { get: async (): Promise<null> => null, set: async (): Promise<void> => undefined };

/** The `discord_user_id` that `seedUser` wrote for a given `user_id`. */
const discordIdFor = (id: number): string => String(BigInt(id) * 1000n);

suite('CountryService raw queries against a real database', () => {
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
    // resetTables truncates abuse_flags as of 2026-09-29; it used to be the one
    // table it missed, and this line was the per-file workaround. Kept because a
    // flag written by one test suppressing a user in the next is the exact
    // failure it prevents, and a free DELETE is cheaper than a re-run.
    await prisma.abuseFlag.deleteMany({});
    await prisma.guild.create({ data: { guildId: GUILD, guildName: 'country db test' } });
    userId += 1;
    await seedUser(prisma, userId);
    mbLookups.length = 0;
  });

  /**
   * The service is built, and its country preload is awaited, together.
   *
   * The constructor kicks off `ensureDbPreloaded()` against the `artists` table as it
   * stands at construction time, and caches the resolved promise forever -
   * `if (this.dbArtistCountryMap.size > 0) return;` and `if (this.dbPreloadPromise)
   * return this.dbPreloadPromise` both refuse to re-run it. Awaiting it here makes
   * the map's contents a function of WHEN this was called rather than of how the
   * query scheduler happened to interleave, which is the difference between a test
   * that proves something and a test that passes.
   *
   * That makes two kinds of test possible, and both are real production states:
   *
   *   - built AFTER the artists exist: the preload sees them and the in-JS
   *     aggregation answers. This is boot against a populated `artists` table.
   *   - built BEFORE they exist: the map is empty and `getUserTopCountriesAllTime`
   *     falls through to its SQL. This is every artist the indexer catalogues after
   *     boot, because nothing else repopulates the map for
   *     `getTopCountriesForTopArtists` - only `getArtistCountry` writes to it, and
   *     that is a different method on a different code path.
   *
   * prisma is the FIRST parameter here, unlike genreService and albumService.
   */
  const build = async (): Promise<CountryService> => {
    const svc = new CountryService(prisma!, musicBrainz as never, cache as never);
    await svc.ensureDbPreloaded();
    return svc;
  };

  /** An artist row, reusing one that already exists (`artists.name` is UNIQUE). */
  const artist = async (name: string, countryCode: string | null): Promise<number> => {
    const existing = await prisma!.artist.findUnique({ where: { name } });
    if (existing) return existing.artistId;
    return (await prisma!.artist.create({ data: { name, countryCode } })).artistId;
  };

  /** The `user_artists` rollup all five queries aggregate. */
  const topArtist = async (id: number, artistId: number, name: string, playcount: number): Promise<void> => {
    await prisma!.userArtist.create({ data: { userId: id, artistId, name, playcount } });
  };

  /**
   * A guild member, with the who-knows flags left at their column defaults.
   *
   * `offset` 0 is the primary user, already seeded by beforeEach. The `false` default
   * is the column default rather than an explicit write, so these rows are exactly
   * what production writes when somebody joins a server - the state the BUG tests
   * are about.
   */
  const member = async (offset: number, whitelisted = false): Promise<number> => {
    const id = userId + offset;
    if (offset !== 0) await seedUser(prisma!, id);
    await prisma!.guildUser.create({
      data: { guildId: GUILD, userId: id, ...(whitelisted ? { whoKnowsWhitelisted: true } : {}) },
    });
    return id;
  };

  describe('the country map the service preloads, which decides which path a call takes', () => {
    it('resolves a country code to its full name from countries.json', async () => {
      // Both guild charts and the SQL fallback resolve the name in JS after the
      // query returns, so a wrong code would render as "ZZ" in an embed rather than
      // as a country. The resource file is the only source for it.
      await member(0, true);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      const rows = await service.getGuildTopCountriesAllTime(GUILD_ID);
      expect(rows).toEqual([{ countryName: 'United Kingdom', countryCode: 'GB', totalPlaycount: 30, listenerCount: 1 }]);
    });

    it('falls back to the bare code when countries.json does not know it', async () => {
      // A code can reach `artists.country_code` from MusicBrainz without ever being
      // in the resource file, and an embed saying "XK" is better than an empty one.
      await member(0, true);
      await topArtist(userId, await artist('Nullpoint Orchestra', 'ZZ'), 'Nullpoint Orchestra', 30);
      service = await build();
      const rows = await service.getGuildTopCountriesAllTime(GUILD_ID);
      expect(rows).toEqual([{ countryName: 'ZZ', countryCode: 'ZZ', totalPlaycount: 30, listenerCount: 1 }]);
    });
  });

  describe('getUserTopCountriesAllTime (L349)', () => {
    it('returns an empty list for a user with no artists', async () => {
      service = await build();
      await expect(service.getUserTopCountriesAllTime(userId)).resolves.toEqual([]);
    });

    it('returns an empty list when the user has no artist with a country', async () => {
      service = await build();
      await topArtist(userId, await artist('Cobalt Ravens', null), 'Cobalt Ravens', 30);
      await expect(service.getUserTopCountriesAllTime(userId)).resolves.toEqual([]);
    });

    it('is normally answered by the in-JS aggregation, not by the SQL', async () => {
      // Both paths must agree or the user sees the country list change shape
      // depending on state they cannot see. This is the ordinary case: the
      // constructor's preload has already seen these artists, so the JS aggregation
      // answers and the SQL at L349 is never reached. Getting here at all is the
      // assertion - the numbers are the cross-check.
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'IE'), 'Velvet Harbour', 12);
      service = await build();
      const rows = await service.getUserTopCountriesAllTime(userId);
      expect(rows.map((c) => [c.countryCode, c.playcount, c.artistCount])).toEqual([
        ['GB', 30, 1],
        ['IE', 12, 1],
      ]);
      expect(rows[0]?.countryName).toBe('United Kingdom');
      // addArtists is true on this path, so the per-country artist list is present
      // and sorted by playcount.
      expect(rows[0]?.artists).toEqual([{ name: 'Quartz Ensemble', playcount: 30 }]);
    });

    it('reaches the raw query for an artist catalogued after the country map was preloaded', async () => {
      // This is the only real route into L349, and it is a production route rather
      // than a contrived one. `CountryService` is constructed once at boot
      // (startup.ts L736) and `ensureDbPreloaded` snapshots `artists` at that moment
      // and then caches the promise forever. Every artist the indexer catalogues
      // AFTER boot is therefore missing from `dbArtistCountryMap`, the JS
      // aggregation returns nothing, and the SQL - which joins on `ua.artist_id` and
      // does not care when the artist was inserted - answers instead.
      //
      // The name is spelled identically in `artists` and in the rollup, so this is
      // not a case-matching trick: it is purely the map's age. If that route ever
      // closes, L349 becomes a query nobody can reach and should be deleted.
      service = await build();
      await topArtist(userId, await artist('Static Meridian', 'JP'), 'Static Meridian', 5);
      await topArtist(userId, await artist('Cobalt Ravens', 'US'), 'Cobalt Ravens', 3);
      const rows = await service.getUserTopCountriesAllTime(userId);
      expect(rows.map((c) => [c.countryCode, c.playcount, c.artistCount])).toEqual([
        ['JP', 5, 1],
        ['US', 3, 1],
      ]);
      expect(rows.map((c) => c.countryName)).toEqual(['Japan', 'United States']);
    });

    it('reports the bigint playcount and artistCount as JS numbers', async () => {
      service = await build();
      await topArtist(userId, await artist('Hollow Coast', 'GB'), 'HOLLOW COAST', 42);
      const [first] = await service.getUserTopCountriesAllTime(userId);
      expect(typeof first?.playcount).toBe('number');
      expect(typeof first?.artistCount).toBe('number');
    });

    it('counts distinct artists, not rows, so one country twice is artistCount 2', async () => {
      await topArtist(userId, await artist('Hollow Coast', 'GB'), 'Hollow Coast', 30);
      await topArtist(userId, await artist('Brass Meridian', 'GB'), 'Brass Meridian', 12);
      service = await build();
      expect(await service.getUserTopCountriesAllTime(userId)).toEqual([
        {
          countryName: 'United Kingdom',
          countryCode: 'GB',
          playcount: 42,
          artistCount: 2,
          artists: [
            { name: 'Hollow Coast', playcount: 30 },
            { name: 'Brass Meridian', playcount: 12 },
          ],
        },
      ]);
    });

    it('drops a NULL country in the SQL too, rather than grouping under an empty code', async () => {
      // Reached through the SQL by building the service before the artists exist, so
      // the `a.country_code IS NOT NULL` predicate is what removes the row and not
      // the JS map's absence of a code for it.
      service = await build();
      await topArtist(userId, await artist('Cobalt Ravens', null), 'Cobalt Ravens', 30);
      await topArtist(userId, await artist('Paper Lanterns Club', 'IE'), 'Paper Lanterns Club', 12);
      const rows = await service.getUserTopCountriesAllTime(userId);
      expect(rows.map((c) => c.countryCode)).toEqual(['IE']);
    });

    it('honours the limit by slicing, and a limit of zero returns nothing', async () => {
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'IE'), 'Velvet Harbour', 12);
      service = await build();
      await expect(service.getUserTopCountriesAllTime(userId, 1)).resolves.toHaveLength(1);
      await expect(service.getUserTopCountriesAllTime(userId, 0)).resolves.toEqual([]);
    });

    it('hands an unknown artist to MusicBrainz rather than to the database', async () => {
      // The background resolver is fired with `setImmediate` and cannot be awaited, so
      // only the hand-off is asserted. It is the reason the MusicBrainz double has to
      // exist at all: without it this file would make network calls. Built after the
      // seed, so 'Signal Fires' is in the preloaded map and is NOT looked up.
      await topArtist(userId, await artist('Signal Fires', 'GB'), 'Signal Fires', 30);
      await topArtist(userId, await artist('Cinnamon Static', null), 'Cinnamon Static', 5);
      service = await build();
      await service.getUserTopCountriesAllTime(userId);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mbLookups).toContain('Cinnamon Static');
      expect(mbLookups).not.toContain('Signal Fires');
    });
  });

  describe('getUserArtistsForCountry (L380)', () => {
    it('returns an empty list for a user with no artists', async () => {
      service = await build();
      await expect(service.getUserArtistsForCountry(userId, 'GB')).resolves.toEqual([]);
    });

    it('returns an empty list for a country the user has not played', async () => {
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await expect(service.getUserArtistsForCountry(userId, 'JP')).resolves.toEqual([]);
    });

    it('lists the user artists in that country by playcount descending', async () => {
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'GB'), 'Velvet Harbour', 12);
      await topArtist(userId, await artist('Cobalt Ravens', 'IE'), 'Cobalt Ravens', 7);
      await expect(service.getUserArtistsForCountry(userId, 'GB')).resolves.toEqual([
        { name: 'Quartz Ensemble', playcount: 30 },
        { name: 'Velvet Harbour', playcount: 12 },
      ]);
    });

    it('matches the country code case-insensitively and trims it', async () => {
      // The stored code is a `VARCHAR(2)` and MusicBrainz and the resource file
      // disagree about case in places, so both the comparison and the map lookup
      // have to be case-insensitive or a user sees an empty country page.
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      for (const code of ['GB', 'gb', ' Gb ']) {
        await expect(service.getUserArtistsForCountry(userId, code)).resolves.toEqual([
          { name: 'Quartz Ensemble', playcount: 30 },
        ]);
      }
    });

    it('returns the rollup name, so a case-mismatched rollup still lists its artist', async () => {
      // The join is on `artist_id` and the displayed name is `ua.name`, not
      // `artists.name`. Pinned because the sibling query above resolves names the
      // other way round, and the two are easy to confuse.
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'quartz ensemble', 30);
      await expect(service.getUserArtistsForCountry(userId, 'GB')).resolves.toEqual([
        { name: 'quartz ensemble', playcount: 30 },
      ]);
    });

    it('drops an artist with no country code', async () => {
      service = await build();
      await topArtist(userId, await artist('Cobalt Ravens', null), 'Cobalt Ravens', 30);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 12);
      expect((await service.getUserArtistsForCountry(userId, 'GB')).map((a) => a.name)).toEqual(['Quartz Ensemble']);
    });

    it('honours the LIMIT parameter', async () => {
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'GB'), 'Velvet Harbour', 12);
      await topArtist(userId, await artist('Brass Meridian', 'GB'), 'Brass Meridian', 7);
      await expect(service.getUserArtistsForCountry(userId, 'GB', 2)).resolves.toHaveLength(2);
      await expect(service.getUserArtistsForCountry(userId, 'GB', 1)).resolves.toEqual([
        { name: 'Quartz Ensemble', playcount: 30 },
      ]);
    });

    it('scopes the list to one user and applies no guild or privacy filter', async () => {
      const other = userId + 1;
      await seedUser(prisma!, other);
      await prisma!.user.update({ where: { userId }, data: { privacyLevel: 'Hide' } });
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(other, gb, 'Quartz Ensemble', 900);
      await expect(service!.getUserArtistsForCountry(userId, 'GB')).resolves.toEqual([
        { name: 'Quartz Ensemble', playcount: 30 },
      ]);
    });
  });

  describe('getGuildTopCountriesAllTime (L403)', () => {
    it('returns an empty list for a guild with no members', async () => {
      service = await build();
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID)).resolves.toEqual([]);
    });

    it('returns an empty list when no member has an artist with a country', async () => {
      await member(0, true);
      await topArtist(userId, await artist('Cobalt Ravens', null), 'Cobalt Ravens', 30);
      service = await build();
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID)).resolves.toEqual([]);
    });

    it('totals the country across the guild and counts the listeners in it', async () => {
      await member(0, true);
      const second = await member(1, true);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      service = await build();
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID)).resolves.toEqual([
        { countryName: 'United Kingdom', countryCode: 'GB', totalPlaycount: 42, listenerCount: 2 },
      ]);
    });

    it('reports both counters as JS numbers, which the ::bigint casts make necessary', async () => {
      await member(0, true);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      const [first] = await service.getGuildTopCountriesAllTime(GUILD_ID);
      expect(typeof first?.totalPlaycount).toBe('number');
      expect(typeof first?.listenerCount).toBe('number');
    });

    it('orders by listeners first, then by playcount, rather than by playcount alone', async () => {
      await member(0, true);
      const second = await member(1, true);
      const ie = await artist('Velvet Harbour', 'IE');
      await topArtist(userId, ie, 'Velvet Harbour', 2);
      await topArtist(second, ie, 'Velvet Harbour', 2);
      const jp = await artist('Static Meridian', 'JP');
      await topArtist(userId, jp, 'Static Meridian', 9);
      service = await build();
      expect((await service.getGuildTopCountriesAllTime(GUILD_ID)).map((c) => c.countryCode)).toEqual(['IE', 'JP']);
    });

    it('honours the LIMIT parameter', async () => {
      await member(0, true);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'IE'), 'Velvet Harbour', 12);
      await topArtist(userId, await artist('Static Meridian', 'JP'), 'Static Meridian', 7);
      service = await build();
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID, 2)).resolves.toHaveLength(2);
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID, 1)).resolves.toEqual([
        { countryName: 'United Kingdom', countryCode: 'GB', totalPlaycount: 30, listenerCount: 1 },
      ]);
    });

    it('scopes the chart to one guild', async () => {
      await member(0, true);
      const OTHER_GUILD = 555555555555555n;
      await prisma!.guild.create({ data: { guildId: OTHER_GUILD, guildName: 'elsewhere' } });
      const elsewhere = userId + 5;
      await seedUser(prisma!, elsewhere);
      await prisma!.guildUser.create({
        data: { guildId: OTHER_GUILD, userId: elsewhere, whoKnowsWhitelisted: true },
      });
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(elsewhere, await artist('Static Meridian', 'JP'), 'Static Meridian', 900);
      service = await build();
      expect((await service.getGuildTopCountriesAllTime(GUILD_ID)).map((c) => c.countryCode)).toEqual(['GB']);
      expect((await service.getGuildTopCountriesAllTime(OTHER_GUILD.toString())).map((c) => c.countryCode)).toEqual([
        'JP',
      ]);
    });

    it('excludes a banned member, a self-blocked one, a hidden one and a flagged one', async () => {
      await member(0, true);
      const banned = await member(1, true);
      const blocked = await member(2, true);
      const hidden = await member(3, true);
      const flagged = await member(4, true);
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
      const gb = await artist('Quartz Ensemble', 'GB');
      for (const id of [banned, blocked, hidden, flagged]) await topArtist(id, gb, 'Quartz Ensemble', 900);
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      service = await build();
      await expect(service.getGuildTopCountriesAllTime(GUILD_ID)).resolves.toEqual([
        { countryName: 'United Kingdom', countryCode: 'GB', totalPlaycount: 30, listenerCount: 1 },
      ]);
    });

    it('REGRESSION: an ordinary member is included, since 20260928220000 made who_knows_whitelisted nullable', async () => {
      // FAILS today, and that is the point. See the header.
      //
      // `guild_users.who_knows_whitelisted` is `BOOLEAN NOT NULL DEFAULT false`, so
      // `(gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)` is
      // false for every row that can exist, and nothing in this repo ever sets it
      // true for a guild_user. The statement therefore SUCCEEDS and returns nothing,
      // which is why there is no log line and no error to grep for: this is the
      // silent-failure shape the plan calls out, except the catch is not even
      // involved. Wired to the country select menu in `countryInteractions.ts` L90.
      //
      // Asserted with a real default row rather than a synthetic predicate, so it
      // fails for the reason production fails.
      await member(0);
      const second = await member(1);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      service = await build();
      expect(await service.getGuildTopCountriesAllTime(GUILD_ID)).toEqual([
        { countryName: 'United Kingdom', countryCode: 'GB', totalPlaycount: 42, listenerCount: 2 },
      ]);
    });
  });

  describe('getGuildArtistsForCountry (L440)', () => {
    it('returns an empty list for a guild with no members', async () => {
      service = await build();
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'GB')).resolves.toEqual([]);
    });

    it('returns an empty list for a country nobody in the guild has', async () => {
      await member(0);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'JP')).resolves.toEqual([]);
    });

    it('sums one row per artist name across the whole guild', async () => {
      // No `who_knows_whitelisted` clause here, which is why this one works and the
      // two around it do not. The inconsistency between sibling statements in one
      // service is what made the bug worth reporting rather than shrugging at.
      await member(0);
      const second = await member(1);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      await topArtist(userId, await artist('Velvet Harbour', 'GB'), 'Velvet Harbour', 7);
      service = await build();
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'GB')).resolves.toEqual([
        { name: 'Quartz Ensemble', playcount: 42 },
        { name: 'Velvet Harbour', playcount: 7 },
      ]);
    });

    it('matches the country code case-insensitively and trims it', async () => {
      await member(0);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      for (const code of ['GB', 'gb', ' Gb ']) {
        await expect(service.getGuildArtistsForCountry(GUILD_ID, code)).resolves.toEqual([
          { name: 'Quartz Ensemble', playcount: 30 },
        ]);
      }
    });

    it('honours the LIMIT parameter', async () => {
      await member(0);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'GB'), 'Velvet Harbour', 12);
      await topArtist(userId, await artist('Brass Meridian', 'GB'), 'Brass Meridian', 7);
      service = await build();
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'GB', 2)).resolves.toHaveLength(2);
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'GB', 1)).resolves.toEqual([
        { name: 'Quartz Ensemble', playcount: 30 },
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
      const gb = await artist('Quartz Ensemble', 'GB');
      for (const id of [banned, blocked, hidden, flagged]) await topArtist(id, gb, 'Quartz Ensemble', 900);
      await topArtist(userId, await artist('Velvet Harbour', 'IE'), 'Velvet Harbour', 30);
      service = await build();
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'GB')).resolves.toEqual([]);
      await expect(service.getGuildArtistsForCountry(GUILD_ID, 'IE')).resolves.toEqual([
        { name: 'Velvet Harbour', playcount: 30 },
      ]);
    });
  });

  describe('getGuildUsersForCountry (L468)', () => {
    it('returns an empty list for a guild with no members', async () => {
      service = await build();
      await expect(service.getGuildUsersForCountry(GUILD_ID, 'GB')).resolves.toEqual([]);
    });

    it('returns an empty list for a country nobody in the guild has', async () => {
      await member(0, true);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      await expect(service.getGuildUsersForCountry(GUILD_ID, 'JP')).resolves.toEqual([]);
    });

    it('lists the members who listen there, most plays first, with their discord ids', async () => {
      // `discord_user_id` is int8, so it arrives as a BigInt and the `.toString()` on
      // the way out is load-bearing: a BigInt in an embed renders "1001000n".
      await member(0, true);
      const second = await member(1, true);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      service = await build();
      const rows = await service.getGuildUsersForCountry(GUILD_ID, 'GB');
      expect(rows).toEqual([
        { userId, discordUserId: discordIdFor(userId), userNameLastFm: `db_user_${userId}`, playcount: 30 },
        {
          userId: second,
          discordUserId: discordIdFor(second),
          userNameLastFm: `db_user_${second}`,
          playcount: 12,
        },
      ]);
      expect(typeof rows[0]?.discordUserId).toBe('string');
      expect(typeof rows[0]?.playcount).toBe('number');
    });

    it('sums a member across every artist they play in the country', async () => {
      await member(0, true);
      const second = await member(1, true);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(userId, await artist('Velvet Harbour', 'GB'), 'Velvet Harbour', 5);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      service = await build();
      const rows = await service.getGuildUsersForCountry(GUILD_ID, 'GB');
      expect(rows.map((r) => [r.userId, r.playcount])).toEqual([
        [userId, 35],
        [second, 12],
      ]);
    });

    it('matches the country code case-insensitively, through a join on artist_id', async () => {
      await member(0, true);
      await topArtist(userId, await artist('Quartz Ensemble', 'GB'), 'Quartz Ensemble', 30);
      service = await build();
      for (const code of ['GB', 'gb', ' Gb ']) {
        await expect(service.getGuildUsersForCountry(GUILD_ID, code)).resolves.toHaveLength(1);
      }
    });

    it('stops at 50 members, so the LIMIT is a literal rather than a parameter', async () => {
      // The one statement in this file with a hard-coded LIMIT. A guild with 51
      // listeners in one country shows 50 and there is no argument to change that,
      // which is worth pinning: a builder that paginates on it will find there is
      // nothing to paginate, and a reader cannot tell 50 from 1000 by inspection.
      await member(0, true);
      for (let i = 1; i <= 50; i++) await member(i, true);
      const gb = await artist('Quartz Ensemble', 'GB');
      for (let i = 0; i <= 50; i++) await topArtist(userId + i, gb, 'Quartz Ensemble', 51 - i);
      service = await build();
      const rows = await service.getGuildUsersForCountry(GUILD_ID, 'GB');
      expect(rows).toHaveLength(50);
      // The cut is at the bottom: the 51st member is the one with 1 play.
      expect(rows[0]?.playcount).toBe(51);
      expect(rows[49]?.playcount).toBe(2);
      expect(rows.map((r) => r.playcount)).not.toContain(1);
    });

    it('excludes a banned member, a self-blocked one, a hidden one and a flagged one', async () => {
      await member(0, true);
      const banned = await member(1, true);
      const blocked = await member(2, true);
      const hidden = await member(3, true);
      const flagged = await member(4, true);
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
      const gb = await artist('Quartz Ensemble', 'GB');
      for (const id of [banned, blocked, hidden, flagged]) await topArtist(id, gb, 'Quartz Ensemble', 900);
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      service = await build();
      expect((await service.getGuildUsersForCountry(GUILD_ID, 'GB')).map((r) => r.userId)).toEqual([userId]);
    });

    it('REGRESSION: an ordinary member is included, since 20260928220000 made who_knows_whitelisted nullable', async () => {
      // FAILS today, and that is the point. See the header and the sibling BUG tests.
      //
      // This one is wired to live commands: `countryCommands.ts` L283
      // (`.whoknowscountry`) and `countrySlashCommands.ts` L397. Both hand the result
      // straight to a builder, so the user sees a confident "nobody in this server
      // listens to anything from the United Kingdom" for a server full of listeners,
      // with no error anywhere in the log.
      await member(0);
      const second = await member(1);
      const gb = await artist('Quartz Ensemble', 'GB');
      await topArtist(userId, gb, 'Quartz Ensemble', 30);
      await topArtist(second, gb, 'Quartz Ensemble', 12);
      service = await build();
      expect(await service.getGuildUsersForCountry(GUILD_ID, 'GB')).toHaveLength(2);
    });
  });
});
