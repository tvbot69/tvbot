import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GuildRankingService, OrderType, parseGuildRankingSettings } from './guildRankingService';
import type { GuildRankingSettings } from './guildRankingService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../tests/dbHarness';

/**
 * The eight raw queries behind the four guild ranking charts, executed by a real
 * Postgres. All eight are `$queryRaw` tagged templates, two per chart method -
 * an all-time branch and a windowed branch - and until this file none of them had
 * ever been parsed by a database:
 *
 *   getGuildTopArtists  L269 (all-time) and L297 (windowed)
 *   getGuildTopAlbums   L351 (all-time) and L387 (windowed)
 *   getGuildTopTracks   L445 (all-time) and L481 (windowed)
 *   getGuildTopGenres   L537 (all-time) and L566 (windowed)
 *
 * Why a mock cannot cover them. Each of these eight has a shape a mock agrees with
 * by construction and a database does not: a `GROUP BY` naming columns the SELECT
 * aliases, an `ORDER BY` over an aggregate alias spliced in as a `Prisma.sql`
 * fragment, a half-open time window, and a 120-row LIMIT that nothing in the
 * type-checker can see. Unlike albumService these eight have no `catch` to hide a
 * failure, so a renamed column would at least be loud - but loud is not the same
 * as known, which is the whole point of the exercise.
 *
 * The two branches of each method are NOT interchangeable, and this file is as
 * much about the difference as about either one. The all-time charts aggregate the
 * denormalised `user_artists` / `user_albums` / `user_tracks` rollups and take
 * their display names from the `artists` / `albums` / `tracks` tables; the windowed
 * charts aggregate `user_plays` and take their display names from the scrobble
 * rows. So the same artist can appear under two spellings, the all-time album and
 * track charts carry an `id` and the windowed ones do not, and the artist filter
 * matches a different column on each side. Every one of those differences is
 * asserted here rather than assumed.
 *
 * The harness is shared on purpose: `seedPlays` owns the parameter casts, and a
 * hand-written INSERT is how this suite's failures get misdiagnosed. `guilds`,
 * `guild_users`, `artists`, `albums`, `tracks` and the rollups are seeded through
 * the Prisma models, because their column names are declared rather than spelled
 * and a raw INSERT would let a column-name mistake masquerade as a bug in the
 * query under test.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let userId = 1;

/**
 * A guild id that is neither the default nor a plausible production snowflake.
 * int8, so binding it also proves the `BigInt(guildId)` conversion works.
 */
const GUILD = 987654321012345678n;
const GUILD_ID = GUILD.toString();
const OTHER_GUILD = 111222333444555666n;

/**
 * Distinct instants derived arithmetically from a shared epoch.
 *
 * `user_plays_identity_uniq` is (user_id, time_played, lower(artist_name),
 * coalesce(lower(track_name), ''), play_source) and it EXCLUDES user_play_id, so
 * two plays sharing an instant are one play and the second insert dies with 23505.
 * Two `Date.now()` calls in one array literal return the same millisecond, which
 * is how a fixture silently loses rows; the arithmetic cannot.
 */
const EPOCH = Date.UTC(2021, 5, 1, 0, 0, 0);
const at = (offsetSeconds: number): Date => new Date(EPOCH + offsetSeconds * 1000);

/** Settings for the windowed branch, which reads `user_plays` in [start, end). */
const windowed = (
  start: Date,
  end: Date | null = null,
  orderType = OrderType.Listeners,
): GuildRankingSettings => ({
  chartTimePeriod: 'custom',
  timeDescription: 'windowed',
  orderType,
  amountOfDays: 7,
  startDateTime: start,
  endDateTime: end,
  billboardStartDateTime: null,
  billboardEndDateTime: null,
  billboardTimeDescription: null,
  newSearchValue: null,
});

/** Settings for the all-time branch, which is selected by the period name alone. */
const allTime = (orderType = OrderType.Listeners): GuildRankingSettings => ({
  chartTimePeriod: 'alltime',
  timeDescription: 'all-time',
  orderType,
  amountOfDays: 0,
  startDateTime: new Date(0),
  endDateTime: null,
  billboardStartDateTime: null,
  billboardEndDateTime: null,
  billboardTimeDescription: null,
  newSearchValue: null,
});

/**
 * The service is rebuilt for every test rather than once in `beforeAll`.
 *
 * `GuildRankingService` keeps a five-minute in-memory cache keyed on (chart, guild,
 * window, order, filter). A shared instance would serve the second test the first
 * test's rows out of memory, and a whole file of green assertions would be
 * measuring the cache instead of the SQL. The cache itself is asserted directly in
 * its own block at the bottom of this file.
 */
let service: GuildRankingService | null = null;

suite('GuildRankingService raw queries against a real database', () => {
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
    // `who_knows_banned` and `self_block_from_who_knows` are NOT NULL DEFAULT
    // false, so a plain create is already "not banned" - which is the state these
    // charts are for. The four methods that also read `who_knows_whitelisted` are
    // in genreService and countryService, and the flag behaves very differently.
    await prisma.guild.create({ data: { guildId: GUILD, guildName: 'guild ranking db test' } });
    await prisma.guild.create({ data: { guildId: OTHER_GUILD, guildName: 'other guild' } });
    userId += 1;
    await seedUser(prisma, userId);
    service = new GuildRankingService(prisma);
  });

  /** Put a user in the guild under test with default (unbanned) flags. */
  const join = async (id: number, guildId: bigint = GUILD): Promise<void> => {
    await prisma!.guildUser.create({ data: { guildId, userId: id } });
  };

  /** A second member, already in the guild. */
  const member = async (offset: number): Promise<number> => {
    const id = userId + offset;
    await seedUser(prisma!, id);
    await join(id);
    return id;
  };

  /**
   * An artist row, reusing one that already exists.
   *
   * Idempotent because `artists.name` is UNIQUE and several tests seed the same
   * artist for two members - which is the only way to make one album or track
   * count as two listeners. Creating a second 'Boards of Canada' would die on the
   * unique index and look like a broken query.
   */
  const artist = async (name: string, countryCode: string | null = null): Promise<number> => {
    const existing = await prisma!.artist.findUnique({ where: { name } });
    if (existing) return existing.artistId;
    return (await prisma!.artist.create({ data: { name, countryCode } })).artistId;
  };

  /** The all-time artist rollup the L269 and L537 branches aggregate. */
  const topArtist = async (id: number, artistId: number, name: string, playcount: number): Promise<void> => {
    await prisma!.userArtist.create({ data: { userId: id, artistId, name, playcount } });
  };

  /** The all-time album rollup the L351 branch aggregates. */
  const topAlbum = async (
    id: number,
    artistName: string,
    albumName: string,
    playcount: number,
    rollupName = albumName,
  ): Promise<{ albumId: number; artistId: number }> => {
    const artistId = await artist(artistName);
    const existing = await prisma!.album.findFirst({ where: { artistId, name: albumName } });
    const albumId =
      existing?.albumId ?? (await prisma!.album.create({ data: { artistId, name: albumName } })).albumId;
    await prisma!.userAlbum.create({ data: { userId: id, albumId, name: rollupName, playcount } });
    return { albumId, artistId };
  };

  /** The all-time track rollup the L445 branch aggregates. */
  const topTrack = async (
    id: number,
    artistName: string,
    trackName: string,
    playcount: number,
  ): Promise<{ trackId: number; artistId: number }> => {
    const artistId = await artist(artistName);
    const existing = await prisma!.track.findFirst({ where: { artistId, name: trackName } });
    const trackId =
      existing?.trackId ?? (await prisma!.track.create({ data: { artistId, name: trackName } })).trackId;
    await prisma!.userTrack.create({ data: { userId: id, trackId, name: trackName, playcount } });
    return { trackId, artistId };
  };

  /** An artist with genres attached, which both genre branches join through. */
  const withGenres = async (name: string, genres: string[]): Promise<number> => {
    const artistId = await artist(name);
    await prisma!.artistGenre.createMany({ data: genres.map((g) => ({ artistId, name: g })) });
    return artistId;
  };

  describe('getGuildTopArtists', () => {
    describe('the all-time branch (L269)', () => {
      it('returns an empty list when nobody in the guild has any artists', async () => {
        await join(userId);
        await expect(service!.getGuildTopArtists(GUILD_ID, allTime())).resolves.toEqual([]);
      });

      it('returns an empty list when the artists belong to a user who is not in the guild', async () => {
        // The chart is scoped by `guild_users`, not by the data. A member of no
        // guild is invisible here even with a full rollup.
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await expect(service!.getGuildTopArtists(GUILD_ID, allTime())).resolves.toEqual([]);
      });

      it('sums playcount and counts distinct listeners, from user_artists', async () => {
        // BOTH listeners have to be in the guild. The chart joins `guild_users`,
        // so the primary user's rollup is invisible here until `join` says so -
        // which is what the test two above pins on purpose. Seeding the rollup
        // without the membership made this assert a total of 12 with one
        // listener, for a query that was behaving exactly as designed.
        await join(userId);
        const second = await member(1);
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(second, boc, 'Boards of Canada', 12);
        const [first] = await service!.getGuildTopArtists(GUILD_ID, allTime());
        expect(first).toEqual({ name: 'Boards of Canada', totalPlaycount: 42, listenerCount: 2 });
      });

      it('reports both counters as JS numbers, which the ::int casts buy', async () => {
        // SUM() and COUNT() are int8 in Postgres and arrive as BigInt. The map
        // calls Number() on both, and a BigInt leaking into a template literal
        // renders "42n" in an embed.
        await join(userId);
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        const [first] = await service!.getGuildTopArtists(GUILD_ID, allTime());
        expect(typeof first?.totalPlaycount).toBe('number');
        expect(typeof first?.listenerCount).toBe('number');
      });

      it('splits one artist into two rows when two members spelled it differently, halving the listener count', async () => {
        // The all-time branch groups by `ua.name` and never consults `artists`, and
        // `ua.name` is whatever Last.fm sent each member. So member A's
        // 'Boards of Canada' and member B's 'boards of canada' are two groups, each
        // with one listener, instead of one group with two.
        //
        // It cannot be a single member holding both spellings - `user_artists` is
        // keyed (user_id, artist_id) and `artists.name` is UNIQUE, so that insert
        // would die with 23505. It is two members of the same guild, which is the
        // ordinary case and needs no contrived fixture.
        //
        // Worth knowing: this is why the genre branch below joins on
        // `UPPER(a.name) = UPPER(ua.name)` while the artist branch does not. The
        // artist chart genuinely can list the same artist twice.
        //
        // `member(1)` joins the SECOND listener only, so the primary user needs
        // its own `join`: the chart is scoped by `guild_users`, and without it
        // the 'Boards of Canada' half of the expected list below simply was not
        // in the result. Both spellings have to be guild members for this to be
        // the two-row chart rather than a one-row chart.
        await join(userId);
        const second = await member(1);
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(second, boc, 'boards of canada', 5);
        const rows = await service!.getGuildTopArtists(GUILD_ID, allTime());
        expect(rows.map((r) => `${r.name}:${r.totalPlaycount}:${r.listenerCount}`)).toEqual([
          'Boards of Canada:30:1',
          'boards of canada:5:1',
        ]);
      });

      it('drops an empty artist name, which the GROUP BY alone would keep as a row', async () => {
        await join(userId);
        await topArtist(userId, await artist('Blank'), '', 30);
        await topArtist(userId, await artist('Boards of Canada'), 'Boards of Canada', 5);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.name)).toEqual([
          'Boards of Canada',
        ]);
      });

      it('orders by listeners first and breaks the tie on playcount', async () => {
        // Two artists, one listener each, different playcounts. Only a query that
        // really applies the second ORDER BY term can separate them.
        await join(userId);
        await topArtist(userId, await artist('Quiet'), 'Quiet', 5);
        await topArtist(userId, await artist('Loud'), 'Loud', 40);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.name)).toEqual([
          'Loud',
          'Quiet',
        ]);
      });

      it('orders by playcount when the caller asked for it, beating the listener count', async () => {
        // The inverse of the test above, and the only one that can tell the two
        // `Prisma.sql` ORDER BY fragments apart: one broad listener and one
        // obsessive listener, and the two orderings disagree.
        await join(userId);
        const second = await member(1);
        const ojb = await artist('Orange Juice Broadcasting');
        await topArtist(userId, ojb, 'Orange Juice Broadcasting', 2);
        await topArtist(second, ojb, 'Orange Juice Broadcasting', 2);
        await topArtist(userId, await artist('xtc'), 'xtc', 9);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.name)).toEqual([
          'Orange Juice Broadcasting',
          'xtc',
        ]);
        expect(
          (await service!.getGuildTopArtists(GUILD_ID, allTime(OrderType.Playcount))).map((r) => r.name),
        ).toEqual(['xtc', 'Orange Juice Broadcasting']);
      });

      it('excludes a member who has blocked themselves from who-knows', async () => {
        await join(userId);
        const blocked = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: blocked } },
          data: { selfBlockFromWhoKnows: true },
        });
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(blocked, boc, 'Boards of Canada', 900);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.totalPlaycount)).toEqual([30]);
      });

      it('excludes a member who is banned from who-knows', async () => {
        await join(userId);
        const banned = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: banned } },
          data: { whoKnowsBanned: true },
        });
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(banned, boc, 'Boards of Canada', 900);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.totalPlaycount)).toEqual([30]);
      });

      it('excludes a user on privacy level Hide and a user with a live abuse flag', async () => {
        await join(userId);
        const hidden = await member(1);
        await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
        const flagged = await member(2);
        await prisma!.abuseFlag.create({
          data: { userId: flagged, reason: 'scrobble-velocity', expiresAt: new Date(Date.now() + 86_400_000) },
        });
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(hidden, boc, 'Boards of Canada', 400);
        await topArtist(flagged, boc, 'Boards of Canada', 500);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.totalPlaycount)).toEqual([30]);
      });

      it('counts a user whose abuse flag has already lapsed', async () => {
        // The predicate is `expires_at IS NULL OR expires_at > NOW()`, so an expired
        // flag must not suppress anyone. A swept flag that still suppressed its
        // user would be a silent, permanent moderation ban.
        await join(userId);
        const lapsed = await member(1);
        await prisma!.abuseFlag.create({
          data: { userId: lapsed, reason: 'scrobble-velocity', expiresAt: new Date(Date.now() - 86_400_000) },
        });
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(lapsed, boc, 'Boards of Canada', 4);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.listenerCount)).toEqual([2]);
      });

      it('scopes the chart to one guild', async () => {
        await join(userId);
        const elsewhere = userId + 1;
        await seedUser(prisma!, elsewhere);
        await join(elsewhere, OTHER_GUILD);
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(elsewhere, boc, 'Boards of Canada', 900);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime())).map((r) => r.totalPlaycount)).toEqual([30]);
        expect(
          (await service!.getGuildTopArtists(OTHER_GUILD.toString(), allTime())).map((r) => r.totalPlaycount),
        ).toEqual([900]);
      });

      it('caps the chart at 120 rows, cutting the lowest playcount', async () => {
        // The LIMIT is invisible to the type-checker and to a mock. 121 distinct
        // artists, and the one that would have been 121st - the lowest playcount -
        // is the row that disappears.
        await join(userId);
        await prisma!.artist.createMany({
          data: Array.from({ length: 121 }, (_, i) => ({ name: `Bulk Artist ${i}` })),
        });
        const ids = await prisma!.artist.findMany({ select: { artistId: true }, orderBy: { artistId: 'asc' } });
        await prisma!.userArtist.createMany({
          data: ids.map((a, i) => ({
            userId,
            artistId: a.artistId,
            name: `Bulk Artist ${i}`,
            playcount: 121 - i,
          })),
        });
        const rows = await service!.getGuildTopArtists(GUILD_ID, allTime());
        expect(rows).toHaveLength(120);
        expect(rows[0]?.name).toBe('Bulk Artist 0');
        expect(rows[0]?.totalPlaycount).toBe(121);
        expect(rows[119]?.name).toBe('Bulk Artist 119');
        expect(rows.map((r) => r.name)).not.toContain('Bulk Artist 120');
      });
    });

    describe('the windowed branch (L297)', () => {
      it('returns an empty list when the window contains no plays', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        await expect(
          service!.getGuildTopArtists(GUILD_ID, windowed(new Date(EPOCH + 10_000), new Date(EPOCH + 20_000))),
        ).resolves.toEqual([]);
      });

      it('counts plays, not the rollup, so one artist can read differently per branch', async () => {
        await join(userId);
        const boc = await artist('Boards of Canada');
        await topArtist(userId, boc, 'Boards of Canada', 999);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'Telephasian Workshop', timePlayed: at(1) },
        ]);
        expect((await service!.getGuildTopArtists(GUILD_ID, windowed(at(-1))))[0]?.totalPlaycount).toBe(2);
        expect((await service!.getGuildTopArtists(GUILD_ID, allTime()))[0]?.totalPlaycount).toBe(999);
      });

      it('includes a play exactly on the lower bound and excludes one exactly on the upper bound', async () => {
        // `time_played >= start` and `time_played < end`: a half-open window, so two
        // adjacent custom periods cannot both claim the boundary play.
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'In', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'Out', timePlayed: at(100) },
        ]);
        await expect(service!.getGuildTopArtists(GUILD_ID, windowed(at(0), at(100)))).resolves.toEqual([
          { name: 'Boards of Canada', totalPlaycount: 1, listenerCount: 1 },
        ]);
      });

      it('treats a null end date as open-ended rather than as the epoch', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Old', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'New', timePlayed: at(500) },
        ]);
        // `endDateTime: null` is the weekly default. A `Prisma.empty` spliced where
        // the upper bound would be must leave no upper bound at all - if it left a
        // stray comma, this query would not parse.
        expect((await service!.getGuildTopArtists(GUILD_ID, windowed(at(-1))))[0]?.totalPlaycount).toBe(2);
      });

      it('counts a play with no album and no track name, because this chart reads neither', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: null, albumName: null, timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: '', albumName: '', timePlayed: at(1) },
        ]);
        expect((await service!.getGuildTopArtists(GUILD_ID, windowed(at(-1))))[0]?.totalPlaycount).toBe(2);
      });

      it('drops a play with an empty artist name', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: '', trackName: 't', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 't', timePlayed: at(1) },
        ]);
        expect((await service!.getGuildTopArtists(GUILD_ID, windowed(at(-1)))).map((r) => r.name)).toEqual([
          'Boards of Canada',
        ]);
      });

      it('applies the same privacy, abuse and ban filters as the all-time branch', async () => {
        await join(userId);
        const blocked = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: blocked } },
          data: { selfBlockFromWhoKnows: true },
        });
        await prisma!.abuseFlag.create({ data: { userId: blocked, reason: 'manual', expiresAt: null } });
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Mine', timePlayed: at(0) },
          { userId: blocked, artistName: 'Boards of Canada', trackName: 'Theirs', timePlayed: at(1) },
        ]);
        const rows = await service!.getGuildTopArtists(GUILD_ID, windowed(at(-1)));
        expect(rows[0]?.totalPlaycount).toBe(1);
        expect(rows[0]?.listenerCount).toBe(1);
      });

      it('caps the chart at 120 rows on this branch too', async () => {
        await join(userId);
        await seedPlays(
          prisma!,
          Array.from({ length: 121 }, (_, i) => ({
            userId,
            artistName: `Bulk Artist ${i}`,
            trackName: `Bulk Track ${i}`,
            timePlayed: at(i),
          })),
        );
        await expect(service!.getGuildTopArtists(GUILD_ID, windowed(at(-1)))).resolves.toHaveLength(120);
      });
    });
  });

  describe('getGuildTopAlbums', () => {
    describe('the all-time branch (L351)', () => {
      it('returns an empty list when nobody in the guild has any albums', async () => {
        await join(userId);
        await expect(service!.getGuildTopAlbums(GUILD_ID, allTime())).resolves.toEqual([]);
      });

      it('returns the album with its artist, its playcount and its catalogue id', async () => {
        await join(userId);
        const { albumId } = await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(first).toEqual({
          name: 'Geogaddi',
          secondaryName: 'Boards of Canada',
          totalPlaycount: 30,
          listenerCount: 1,
          id: albumId,
        });
      });

      it('reports the catalogue id as a JS number', async () => {
        // The id goes into a button's custom id. `ub.album_id` is int4 so it
        // already arrives as a number and the `Number()` is belt and braces; what
        // matters is that a BigInt never reaches the button.
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(typeof first?.id).toBe('number');
      });

      it('sums one album played by two members into one row', async () => {
        await join(userId);
        const second = await member(1);
        const { albumId } = await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await topAlbum(second, 'Boards of Canada', 'Geogaddi', 12);
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(first).toMatchObject({ name: 'Geogaddi', totalPlaycount: 42, listenerCount: 2, id: albumId });
      });

      it('takes both names from the catalogue, not from the rollup', async () => {
        // The join is on id, so a rollup whose stored names differ from the
        // catalogue's still resolves - and the displayed names come from `albums`
        // and `artists`. The windowed branch below is the one that shows the
        // rollup's own spelling.
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30, 'geogaddi');
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(first?.name).toBe('Geogaddi');
        expect(first?.secondaryName).toBe('Boards of Canada');
      });

      it('separates two albums that share a title under different artists', async () => {
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Greatest Hits', 30);
        await topAlbum(userId, 'Slowdive', 'Greatest Hits', 12);
        const rows = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(rows.map((r) => `${r.secondaryName} | ${r.name}`)).toEqual([
          'Boards of Canada | Greatest Hits',
          'Slowdive | Greatest Hits',
        ]);
      });

      it('filters by artist name case-insensitively', async () => {
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await topAlbum(userId, 'Slowdive', 'Souvlaki', 12);
        for (const needle of ['boards of canada', 'BOARDS OF CANADA', 'Boards of Canada']) {
          const rows = await service!.getGuildTopAlbums(GUILD_ID, allTime(), needle);
          expect(rows.map((r) => r.name)).toEqual(['Geogaddi']);
        }
      });

      it('treats a blank or absent filter as no filter at all', async () => {
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        for (const needle of ['', '   ', null, undefined]) {
          await expect(service!.getGuildTopAlbums(GUILD_ID, allTime(), needle)).resolves.toHaveLength(1);
        }
      });

      it('returns nothing for an artist nobody in the guild has played', async () => {
        await join(userId);
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await expect(service!.getGuildTopAlbums(GUILD_ID, allTime(), 'Aphex Twin')).resolves.toEqual([]);
      });

      it('excludes a banned member but not a lapsed abuse flag', async () => {
        await join(userId);
        const banned = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: banned } },
          data: { whoKnowsBanned: true },
        });
        const lapsed = await member(2);
        await prisma!.abuseFlag.create({
          data: { userId: lapsed, reason: 'manual', expiresAt: new Date(Date.now() - 1000) },
        });
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await topAlbum(banned, 'Aphex Twin', 'Selected Ambient', 900);
        await topAlbum(lapsed, 'Slowdive', 'Souvlaki', 12);
        const rows = await service!.getGuildTopAlbums(GUILD_ID, allTime());
        expect(rows.map((r) => r.name)).toEqual(['Geogaddi', 'Souvlaki']);
      });

      it('excludes a member on privacy level Hide', async () => {
        await join(userId);
        const hidden = await member(1);
        await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await topAlbum(hidden, 'Aphex Twin', 'Selected Ambient', 900);
        expect((await service!.getGuildTopAlbums(GUILD_ID, allTime())).map((r) => r.name)).toEqual(['Geogaddi']);
      });
    });

    describe('the windowed branch (L387)', () => {
      it('returns an empty list when the window contains no plays', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', albumName: 'Geogaddi', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        await expect(
          service!.getGuildTopAlbums(GUILD_ID, windowed(new Date(EPOCH + 10_000))),
        ).resolves.toEqual([]);
      });

      it('carries no catalogue id, because this branch never joins the albums table', async () => {
        // The all-time branch returns `id` and this one cannot, so a caller that
        // builds a button from `item.id` gets undefined here. Asserted so the
        // difference is a fact rather than a surprise found in production.
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', albumName: 'Geogaddi', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1)));
        expect(first?.name).toBe('Geogaddi');
        expect(first?.id).toBeUndefined();
      });

      it('uses the scrobble spelling of the artist, not the catalogue one', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'boards of canada', albumName: 'Geogaddi', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        const [first] = await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1)));
        expect(first?.secondaryName).toBe('boards of canada');
      });

      it('drops a NULL or empty album name, which the all-time branch cannot produce', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', albumName: 'Geogaddi', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', albumName: '', trackName: 'Blank', timePlayed: at(1) },
          { userId, artistName: 'Boards of Canada', albumName: null, trackName: 'Null', timePlayed: at(2) },
        ]);
        expect((await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1)))).map((r) => r.name)).toEqual([
          'Geogaddi',
        ]);
      });

      it('keeps a play with no track name, because this branch reads only album_name', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', albumName: 'Geogaddi', trackName: null, timePlayed: at(0) },
        ]);
        expect((await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1)))).map((r) => r.name)).toEqual([
          'Geogaddi',
        ]);
      });

      it('honours the half-open window', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', albumName: 'In', trackName: 'a', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', albumName: 'Out', trackName: 'b', timePlayed: at(100) },
        ]);
        expect((await service!.getGuildTopAlbums(GUILD_ID, windowed(at(0), at(100)))).map((r) => r.name)).toEqual([
          'In',
        ]);
      });

      it('filters on the scrobble artist name, so a name that exists only in the catalogue finds nothing', async () => {
        // Both branches fold case with LOWER(), so a spelling difference alone does
        // not separate them - what separates them is WHICH column holds the name.
        // The windowed branch matches `up.artist_name`, so 'Boogaaa' (a scrobble that
        // never matched a catalogue row) is findable and 'Boards of Canada' (which
        // only exists in `artists`) is not. The all-time branch is the exact mirror.
        await join(userId);
        await artist('Boards of Canada');
        await seedPlays(prisma!, [
          { userId, artistName: 'Boogaaa', albumName: 'Geogaddi', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        const settings = windowed(at(-1));
        await expect(service!.getGuildTopAlbums(GUILD_ID, settings, 'Boogaaa')).resolves.toHaveLength(1);
        await expect(service!.getGuildTopAlbums(GUILD_ID, settings, 'Boards of Canada')).resolves.toEqual([]);

        await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
        await expect(service!.getGuildTopAlbums(GUILD_ID, allTime(), 'Boards of Canada')).resolves.toHaveLength(1);
        await expect(service!.getGuildTopAlbums(GUILD_ID, allTime(), 'Boogaaa')).resolves.toEqual([]);
      });

      it('orders by listeners first when asked, and by playcount otherwise', async () => {
        // Every row has a distinct (listenerCount, totalPlaycount) pair - (2,3),
        // (2,2), (1,4), (1,2), (1,1) - so both orderings are total. A fixture with two
        // rows tied on every ORDER BY term would assert nothing, because Postgres is
        // free to return them in either order.
        await join(userId);
        const second = await member(1);
        await seedPlays(prisma!, [
          { userId, artistName: 'Broad', albumName: 'Broad One', trackName: 'a', timePlayed: at(0) },
          { userId: second, artistName: 'Broad', albumName: 'Broad One', trackName: 'b', timePlayed: at(1) },
          { userId, artistName: 'Broad', albumName: 'Broad One', trackName: 'c', timePlayed: at(2) },
          { userId: second, artistName: 'Broad', albumName: 'Broad Two', trackName: 'd', timePlayed: at(3) },
          { userId, artistName: 'Broad', albumName: 'Broad Two', trackName: 'e', timePlayed: at(4) },
          { userId, artistName: 'Deep', albumName: 'Deep One', trackName: 'f', timePlayed: at(5) },
          { userId, artistName: 'Deep', albumName: 'Deep One', trackName: 'g', timePlayed: at(6) },
          { userId, artistName: 'Deep', albumName: 'Deep One', trackName: 'h', timePlayed: at(7) },
          { userId, artistName: 'Deep', albumName: 'Deep One', trackName: 'i', timePlayed: at(8) },
          { userId, artistName: 'Deep', albumName: 'Deep Three', trackName: 'j', timePlayed: at(9) },
          { userId, artistName: 'Deep', albumName: 'Deep Two', trackName: 'k', timePlayed: at(10) },
          { userId, artistName: 'Deep', albumName: 'Deep Two', trackName: 'l', timePlayed: at(11) },
        ]);
        expect(
          (await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1), null, OrderType.Listeners))).map((r) => r.name),
        ).toEqual(['Broad One', 'Broad Two', 'Deep One', 'Deep Two', 'Deep Three']);
        expect(
          (await service!.getGuildTopAlbums(GUILD_ID, windowed(at(-1), null, OrderType.Playcount))).map((r) => r.name),
        ).toEqual(['Deep One', 'Broad One', 'Broad Two', 'Deep Two', 'Deep Three']);
      });
    });
  });

  describe('getGuildTopTracks', () => {
    describe('the all-time branch (L445)', () => {
      it('returns an empty list when nobody in the guild has any tracks', async () => {
        await join(userId);
        await expect(service!.getGuildTopTracks(GUILD_ID, allTime())).resolves.toEqual([]);
      });

      it('returns the track with its artist, its playcount and its catalogue id', async () => {
        await join(userId);
        const { trackId } = await topTrack(userId, 'Boards of Canada', 'Roygbiv', 30);
        const [first] = await service!.getGuildTopTracks(GUILD_ID, allTime());
        expect(first).toEqual({
          name: 'Roygbiv',
          secondaryName: 'Boards of Canada',
          totalPlaycount: 30,
          listenerCount: 1,
          id: trackId,
        });
      });

      it('sums one track played by two members into one row', async () => {
        await join(userId);
        const second = await member(1);
        await topTrack(userId, 'Boards of Canada', 'Roygbiv', 30);
        await topTrack(second, 'Boards of Canada', 'Roygbiv', 12);
        expect((await service!.getGuildTopTracks(GUILD_ID, allTime()))[0]).toMatchObject({
          totalPlaycount: 42,
          listenerCount: 2,
        });
      });

      it('separates two tracks that share a title under different artists', async () => {
        await join(userId);
        await topTrack(userId, 'Boards of Canada', 'Roygbiv', 30);
        await topTrack(userId, 'Slowdive', 'Roygbiv', 12);
        const rows = await service!.getGuildTopTracks(GUILD_ID, allTime());
        expect(rows.map((r) => `${r.secondaryName} | ${r.name}`)).toEqual([
          'Boards of Canada | Roygbiv',
          'Slowdive | Roygbiv',
        ]);
      });

      it('filters by artist name case-insensitively', async () => {
        await join(userId);
        await topTrack(userId, 'Boards of Canada', 'Roygbiv', 30);
        await topTrack(userId, 'Slowdive', 'Souvlaki', 12);
        for (const needle of ['boards of canada', 'BOARDS OF CANADA']) {
          expect((await service!.getGuildTopTracks(GUILD_ID, allTime(), needle)).map((r) => r.name)).toEqual([
            'Roygbiv',
          ]);
        }
      });

      it('excludes a member who blocked themselves, a hidden member and a flagged one', async () => {
        await join(userId);
        const blocked = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: blocked } },
          data: { selfBlockFromWhoKnows: true },
        });
        const hidden = await member(2);
        await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
        const flagged = await member(3);
        await prisma!.abuseFlag.create({ data: { userId: flagged, reason: 'manual', expiresAt: null } });
        await topTrack(userId, 'Boards of Canada', 'Roygbiv', 30);
        await topTrack(blocked, 'Aphex Twin', 'Xtal', 900);
        await topTrack(hidden, 'Slowdive', 'Alison', 800);
        await topTrack(flagged, 'Talk Talk', 'After the Flood', 700);
        expect((await service!.getGuildTopTracks(GUILD_ID, allTime())).map((r) => r.name)).toEqual(['Roygbiv']);
      });
    });

    describe('the windowed branch (L481)', () => {
      it('returns an empty list when the window contains no plays', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        await expect(
          service!.getGuildTopTracks(GUILD_ID, windowed(new Date(EPOCH + 10_000))),
        ).resolves.toEqual([]);
      });

      it('carries no catalogue id, because this branch never joins the tracks table', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        const [first] = await service!.getGuildTopTracks(GUILD_ID, windowed(at(-1)));
        expect(first?.name).toBe('Roygbiv');
        expect(first?.id).toBeUndefined();
      });

      it('drops a NULL or empty track name', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: '', timePlayed: at(1) },
          { userId, artistName: 'Boards of Canada', trackName: null, timePlayed: at(2) },
        ]);
        expect((await service!.getGuildTopTracks(GUILD_ID, windowed(at(-1)))).map((r) => r.name)).toEqual(['Roygbiv']);
      });

      it('keeps a play with no album name, because this branch reads only track_name', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', albumName: null, timePlayed: at(0) },
        ]);
        expect((await service!.getGuildTopTracks(GUILD_ID, windowed(at(-1)))).map((r) => r.name)).toEqual(['Roygbiv']);
      });

      it('honours the half-open window', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'In', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'Out', timePlayed: at(100) },
        ]);
        expect((await service!.getGuildTopTracks(GUILD_ID, windowed(at(0), at(100)))).map((r) => r.name)).toEqual([
          'In',
        ]);
      });

      it('filters on the scrobble artist name', async () => {
        await join(userId);
        await seedPlays(prisma!, [
          { userId, artistName: 'boards of canada', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Slowdive', trackName: 'Alison', timePlayed: at(1) },
        ]);
        const rows = await service!.getGuildTopTracks(GUILD_ID, windowed(at(-1)), 'BOARDS OF CANADA');
        expect(rows.map((r) => r.name)).toEqual(['Roygbiv']);
      });
    });
  });

  describe('getGuildTopGenres', () => {
    describe('the all-time branch (L537)', () => {
      it('returns an empty list when no artist in the guild has a genre', async () => {
        await join(userId);
        const bare = await artist('Uncategorised');
        await topArtist(userId, bare, 'Uncategorised', 30);
        await expect(service!.getGuildTopGenres(GUILD_ID, allTime())).resolves.toEqual([]);
      });

      it('rolls playcount up from the artist to the genre', async () => {
        await join(userId);
        const second = await member(1);
        await topArtist(userId, await withGenres('Boards of Canada', ['idm']), 'Boards of Canada', 30);
        await topArtist(second, await withGenres('Aphex Twin', ['idm']), 'Aphex Twin', 12);
        await expect(service!.getGuildTopGenres(GUILD_ID, allTime())).resolves.toEqual([
          { name: 'idm', totalPlaycount: 42, listenerCount: 2 },
        ]);
      });

      it('counts a member once per genre even when they carry two genres', async () => {
        // The join is on the artist, so one member's two genres are two rows, each
        // with the same listenerCount. Compared as a map because the two rows tie
        // on every ORDER BY term and Postgres may return them in either order.
        await join(userId);
        const boc = await withGenres('Boards of Canada', ['idm', 'ambient']);
        await topArtist(userId, boc, 'Boards of Canada', 30);
        const rows = await service!.getGuildTopGenres(GUILD_ID, allTime());
        expect(Object.fromEntries(rows.map((r) => [r.name, r]))).toEqual({
          idm: { name: 'idm', totalPlaycount: 30, listenerCount: 1 },
          ambient: { name: 'ambient', totalPlaycount: 30, listenerCount: 1 },
        });
      });

      it('matches the artist name case-insensitively, which the artist chart does not', async () => {
        // The join is `UPPER(a.name) = UPPER(ua.name)`, so a rollup spelled in caps
        // still finds its genres. getGuildTopArtists would have made that two rows
        // instead; this is the one place case is folded.
        await join(userId);
        const boc = await withGenres('Boards of Canada', ['idm']);
        await topArtist(userId, boc, 'BOARDS OF CANADA', 30);
        await expect(service!.getGuildTopGenres(GUILD_ID, allTime())).resolves.toEqual([
          { name: 'idm', totalPlaycount: 30, listenerCount: 1 },
        ]);
      });

      it('orders by listeners first and by playcount on request', async () => {
        await join(userId);
        const second = await member(1);
        const broad = await withGenres('Broad', ['broad']);
        await topArtist(userId, broad, 'Broad', 2);
        await topArtist(second, broad, 'Broad', 2);
        const deep = await withGenres('Deep', ['deep']);
        await topArtist(userId, deep, 'Deep', 9);
        expect((await service!.getGuildTopGenres(GUILD_ID, allTime())).map((r) => r.name)).toEqual([
          'broad',
          'deep',
        ]);
        expect((await service!.getGuildTopGenres(GUILD_ID, allTime(OrderType.Playcount))).map((r) => r.name)).toEqual([
          'deep',
          'broad',
        ]);
      });

      it('excludes a member who blocked themselves, a hidden member and a flagged one', async () => {
        await join(userId);
        const blocked = await member(1);
        await prisma!.guildUser.update({
          where: { guildId_userId: { guildId: GUILD, userId: blocked } },
          data: { selfBlockFromWhoKnows: true },
        });
        const hidden = await member(2);
        await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
        const flagged = await member(3);
        await prisma!.abuseFlag.create({ data: { userId: flagged, reason: 'manual', expiresAt: null } });
        const boc = await withGenres('Boards of Canada', ['idm']);
        const aphex = await withGenres('Aphex Twin', ['idm']);
        const slowdive = await withGenres('Slowdive', ['idm']);
        await topArtist(userId, boc, 'Boards of Canada', 30);
        await topArtist(blocked, aphex, 'Aphex Twin', 900);
        await topArtist(hidden, slowdive, 'Slowdive', 800);
        await topArtist(flagged, slowdive, 'Slowdive', 700);
        expect((await service!.getGuildTopGenres(GUILD_ID, allTime())).map((r) => r.totalPlaycount)).toEqual([30]);
      });
    });

    describe('the windowed branch (L566)', () => {
      it('returns an empty list when the window contains no plays', async () => {
        await join(userId);
        await withGenres('Boards of Canada', ['idm']);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        await expect(
          service!.getGuildTopGenres(GUILD_ID, windowed(new Date(EPOCH + 10_000))),
        ).resolves.toEqual([]);
      });

      it('counts plays rather than the rollup', async () => {
        await join(userId);
        const boc = await withGenres('Boards of Canada', ['idm']);
        await topArtist(userId, boc, 'Boards of Canada', 999);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(1) },
        ]);
        expect((await service!.getGuildTopGenres(GUILD_ID, windowed(at(-1))))[0]?.totalPlaycount).toBe(2);
        expect((await service!.getGuildTopGenres(GUILD_ID, allTime()))[0]?.totalPlaycount).toBe(999);
      });

      it('matches the artist name case-insensitively against the scrobble', async () => {
        await join(userId);
        await withGenres('Boards of Canada', ['idm']);
        await seedPlays(prisma!, [
          { userId, artistName: 'boards of canada', trackName: 'Roygbiv', timePlayed: at(0) },
        ]);
        await expect(service!.getGuildTopGenres(GUILD_ID, windowed(at(-1)))).resolves.toEqual([
          { name: 'idm', totalPlaycount: 1, listenerCount: 1 },
        ]);
      });

      it('ignores an artist with no genre row rather than listing a blank genre', async () => {
        await join(userId);
        await withGenres('Boards of Canada', ['idm']);
        await artist('Uncategorised');
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Roygbiv', timePlayed: at(0) },
          { userId, artistName: 'Uncategorised', trackName: 'Untitled', timePlayed: at(1) },
        ]);
        await expect(service!.getGuildTopGenres(GUILD_ID, windowed(at(-1)))).resolves.toEqual([
          { name: 'idm', totalPlaycount: 1, listenerCount: 1 },
        ]);
      });

      it('honours the half-open window', async () => {
        await join(userId);
        await withGenres('Boards of Canada', ['idm']);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'In', timePlayed: at(0) },
          { userId, artistName: 'Boards of Canada', trackName: 'Out', timePlayed: at(100) },
        ]);
        const rows = await service!.getGuildTopGenres(GUILD_ID, windowed(at(0), at(100)));
        expect(rows[0]?.totalPlaycount).toBe(1);
      });

      it('excludes a hidden member, and counts one whose abuse flag has lapsed', async () => {
        await join(userId);
        const hidden = await member(1);
        await prisma!.user.update({ where: { userId: hidden }, data: { privacyLevel: 'Hide' } });
        const lapsed = await member(2);
        await prisma!.abuseFlag.create({
          data: { userId: lapsed, reason: 'scrobble-velocity', expiresAt: new Date(Date.now() - 1000) },
        });
        await withGenres('Boards of Canada', ['idm']);
        await seedPlays(prisma!, [
          { userId, artistName: 'Boards of Canada', trackName: 'Mine', timePlayed: at(0) },
          { userId: hidden, artistName: 'Boards of Canada', trackName: 'Hidden', timePlayed: at(1) },
          { userId: lapsed, artistName: 'Boards of Canada', trackName: 'Lapsed', timePlayed: at(2) },
        ]);
        const rows = await service!.getGuildTopGenres(GUILD_ID, windowed(at(-1)));
        expect(rows[0]?.totalPlaycount).toBe(2);
        expect(rows[0]?.listenerCount).toBe(2);
      });
    });
  });

  describe('the five-minute in-memory cache the eight queries sit behind', () => {
    // Not a query, but it is the reason this file rebuilds the service per test,
    // and a cache quietly serving stale chart data is indistinguishable from a
    // working one in a green suite.
    const seedForCache = async (): Promise<void> => {
      await join(userId);
      await topArtist(userId, await artist('Boards of Canada'), 'Boards of Canada', 30);
      await seedPlays(prisma!, [
        { userId, artistName: 'Late Addition', trackName: 't', timePlayed: at(0) },
      ]);
    };

    it('serves the second identical call from memory, and a new window from the database', async () => {
      await seedForCache();
      const first = await service!.getGuildTopArtists(GUILD_ID, allTime());
      const second = await service!.getGuildTopArtists(GUILD_ID, allTime());
      // Identity, not equality: the same array instance means the second call
      // never reached the database at all.
      expect(second).toBe(first);

      await topArtist(userId, await artist('Late Addition'), 'Late Addition', 5);
      // The cached array is unchanged...
      expect(await service!.getGuildTopArtists(GUILD_ID, allTime())).toHaveLength(first.length);
      // ...and the same data read through a different key shows the new row, which
      // proves the miss above was a cache hit and not an empty table.
      await expect(service!.getGuildTopArtists(GUILD_ID, windowed(at(-1)))).resolves.toEqual([
        { name: 'Late Addition', totalPlaycount: 1, listenerCount: 1 },
      ]);
    });

    it('keys the cache on the artist filter, so a filtered chart is not served unfiltered', async () => {
      await join(userId);
      const { albumId: geogaddi } = await topAlbum(userId, 'Boards of Canada', 'Geogaddi', 30);
      const { albumId: mhtrtc } = await topAlbum(
        userId,
        'Boards of Canada',
        'Music Has the Right to Children',
        12,
      );
      expect(geogaddi).not.toBe(mhtrtc);
      // An empty filtered chart first, then the matching one. If the filter were not
      // part of the cache key the second call would be served the first one's [].
      await expect(service!.getGuildTopAlbums(GUILD_ID, allTime(), 'Slowdive')).resolves.toEqual([]);
      const filtered = await service!.getGuildTopAlbums(GUILD_ID, allTime(), 'Boards of Canada');
      expect(filtered.map((a) => a.id)).toEqual([geogaddi, mhtrtc]);
    });
  });

  describe('parseGuildRankingSettings, which decides which of the eight runs', () => {
    it('defaults to the windowed branch with an open end', () => {
      const settings = parseGuildRankingSettings();
      expect(settings.chartTimePeriod).toBe('weekly');
      expect(settings.endDateTime).toBeNull();
    });

    it('reads "alltime" as the branch selector, which is the L268 / L350 / L444 / L536 switch', () => {
      // The four all-time queries are chosen by this string comparison and by
      // nothing else, so an all-time chart that quietly shows one week of plays is
      // this function's fault rather than the query's.
      expect(parseGuildRankingSettings('alltime').chartTimePeriod).toBe('alltime');
      expect(parseGuildRankingSettings('overall').chartTimePeriod).toBe('alltime');
      expect(parseGuildRankingSettings('alltime pc').orderType).toBe(OrderType.Playcount);
    });
  });
});
