import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { CountryService } from './countryService';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';

/**
 * A query that could not run is not a query that found nothing.
 *
 * Every read in this file carried a `.catch(() => [])` — nine of them — and every
 * one of them turned a dropped connection into an answer the user reads as a
 * fact about themselves or about the people in their server:
 *
 *  - `.listeninggaps` said "no hiatuses found"
 *  - `.discoveries` said "you discovered nothing new"
 *  - `.iceberg` was the worst of them: `artist.findMany` failing emptied the
 *    popularity map, `hasDbPopularity` went false, and the RANK-RATIO FALLBACK
 *    then invented a popularity score per artist from playcount position — so an
 *    outage rendered a complete, confident, entirely fabricated iceberg.
 *  - `.affinity` was the `guildAdminService` class again, one layer out: an empty
 *    `guildUser` list renders "*Could not find indexed users with a similar music
 *    taste in this server*", and an empty TARGET `userArtist` list does not
 *    render empty at all — it renders a full table of real people, every one at
 *    `0%`, sorted by those zeros.
 *
 * Same rule as `orUnavailable` in `lastFmRepository` and `orDatabaseUnavailable`
 * in `playHistoryService`, `guildAdminService`, `genreService`, `countryService`,
 * `albumService` and `overviewService`: a query that returns NO ROWS is a real
 * answer and stays empty; a query that THROWS raises `SourceUnavailableError`
 * after a `Logger.error`.
 *
 * There is no "not found" case to split out the way Last.fm has one. Every read
 * below is a `GROUP BY` aggregate or a `findMany` with no existence claim in it —
 * an artist with no genre rows, a user with no plays, a server with no other
 * indexed members — and each of those succeeds with a shorter result rather than
 * erroring. So empty IS the answer, and an error is always an error.
 *
 * Every caller sits behind a boundary that replies on a throw: `commandHandler`
 * at the message boundary, `interactionHandler.ts:353` for buttons (which
 * replies "something went wrong" only when the interaction has not already been
 * acknowledged, so the previous card survives untouched rather than being
 * replaced by an empty one) and `:482` for slash commands.
 */
const orDatabaseUnavailable = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: `musicIntelligenceService:${label}`, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in musicIntelligenceService (${label}); refusing to render the failure as a real answer`,
    );
    throw new SourceUnavailableError(`musicIntelligenceService:${label}`, err, 'Database unavailable');
  }
};

/**
 * `guild_id` is BigInt and every guild id arrives as a string, so `BigInt()`
 * throws a SyntaxError on anything non-numeric.
 *
 * A malformed argument is a CALLER bug, not a source that failed to answer, and
 * it must not be laundered into the same "Database unavailable" as a real outage
 * — that would tell whoever reads the log to go and look at Postgres when the
 * fault is upstream of it. The guard returns the empty answer WITHOUT opening a
 * query, which is honest: no such guild exists, so it has no neighbours. Same
 * shape and same reasoning as `parseGuildId` in `genreService`.
 */
const parseGuildId = (guildId: string): bigint | null => {
  if (!guildId || !/^\d+$/.test(guildId)) return null;
  try {
    return BigInt(guildId);
  } catch {
    // CORRECT AS IS, and identical to `parseGuildId` in genreService including
    // the reason: the regex already rejects what `BigInt` refuses, so this branch
    // is a backstop. Were it reached it would still be right - a malformed guild
    // id is a CALLER bug, and laundering it into "Database unavailable" would
    // send an operator to Postgres when the fault is upstream of it. The honest
    // answer is "no such guild, so it has no neighbours", without opening a query.
    return null;
  }
};

export type GapEntityType = 'artist' | 'album' | 'track';

/**
 * Row shapes for the raw gap queries.
 *
 * Named rather than inline because an inline multi-line generic argument
 * (`$queryRawUnsafe<Array<{\n ... \n}>>(...)`) parses under `tsc` and FAILS under
 * esbuild, which is what vitest transforms with — so the type went at module
 * scope and the call sites carry a single-line generic. Found by running the
 * suite, not by reading: `tsc --noEmit` was clean while every test in the file
 * failed to collect.
 */
interface GapRow {
  name: string;
  resume_date: Date;
  prev_played: Date;
  gap_days: number;
  total_plays: bigint;
}

interface GapRowWithArtist extends GapRow {
  artist_name: string;
}

interface DiscoveryRow {
  artist_name: string;
  first_play: Date;
  playcount: bigint;
}

export interface ListeningGapItem {
  name: string;
  artistName?: string;
  resumeDate: Date;
  prevPlayed: Date;
  gapDays: number;
  totalPlays: number;
}

export interface DiscoveryItem {
  artistName: string;
  firstPlay: Date;
  playcount: number;
}

export interface IcebergTier {
  tierNumber: number;
  name: string;
  emoji: string;
  description: string;
  artists: Array<{ name: string; playcount: number; popularity?: number }>;
}

export interface IcebergData {
  displayName: string;
  userNameLastFm: string;
  timePeriodDescription: string;
  tiers: IcebergTier[];
  totalArtists: number;
}

export interface AffinityNeighbor {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  displayName?: string;
  totalPercentage: number;
  artistPercentage: number;
  genrePercentage: number;
  countryPercentage: number;
  sharedArtists: string[];
}

export interface AffinityData {
  userDisplayName: string;
  userNameLastFm: string;
  guildName: string;
  neighbors: AffinityNeighbor[];
  totalGuildUsers: number;
}

@injectable()
export class MusicIntelligenceService {
  constructor(
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
    @inject(CountryService) private readonly countryService?: CountryService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getListeningGaps(
    userId: number,
    entityType: GapEntityType,
    minGapDays: number = 90,
  ): Promise<ListeningGapItem[]> {
    if (entityType === 'artist') {
      const rows = await orDatabaseUnavailable('getListeningGaps:artist', () =>
        this.db.$queryRawUnsafe<GapRow[]>(`
        WITH ordered_plays AS (
          SELECT artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1
        ),
        gaps AS (
          SELECT artist_name AS name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays));

      return rows.map((r) => ({
        name: r.name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    } else if (entityType === 'album') {
      const rows = await orDatabaseUnavailable('getListeningGaps:album', () =>
        this.db.$queryRawUnsafe<GapRowWithArtist[]>(`
        WITH ordered_plays AS (
          SELECT album_name, artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name), LOWER(album_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name), LOWER(album_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
        ),
        gaps AS (
          SELECT album_name AS name,
                 artist_name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name), LOWER(album_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, artist_name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays));

      return rows.map((r) => ({
        name: r.name,
        artistName: r.artist_name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    } else {
      const rows = await orDatabaseUnavailable('getListeningGaps:track', () =>
        this.db.$queryRawUnsafe<GapRowWithArtist[]>(`
        WITH ordered_plays AS (
          SELECT track_name, artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name), LOWER(track_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name), LOWER(track_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1 AND track_name IS NOT NULL AND track_name != ''
        ),
        gaps AS (
          SELECT track_name AS name,
                 artist_name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name), LOWER(track_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, artist_name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays));

      return rows.map((r) => ({
        name: r.name,
        artistName: r.artist_name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    }
  }

  public async getDiscoveries(
    userId: number,
    startDateTime: Date,
    endDateTime: Date,
  ): Promise<DiscoveryItem[]> {
    const rows = await orDatabaseUnavailable('getDiscoveries', () =>
      this.db.$queryRawUnsafe<DiscoveryRow[]>(`
      WITH artist_first_plays AS (
        SELECT artist_name, MIN(time_played) AS first_play
        FROM user_plays
        WHERE user_id = $1
        GROUP BY artist_name
      ),
      period_plays AS (
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND time_played <= $3
        GROUP BY artist_name
      )
      SELECT a.artist_name, a.first_play, p.playcount
      FROM artist_first_plays a
      JOIN period_plays p ON LOWER(a.artist_name) = LOWER(p.artist_name)
      WHERE a.first_play >= $2 AND a.first_play <= $3
      ORDER BY p.playcount DESC
      LIMIT 100;
    `, userId, startDateTime, endDateTime));

    return rows.map((r) => ({
      artistName: r.artist_name,
      firstPlay: new Date(r.first_play),
      playcount: Number(r.playcount),
    }));
  }

  public async getIceberg(
    _userId: number,
    topArtists: Array<{ name: string; playcount: number }>,
    displayName: string,
    userNameLastFm: string,
    timePeriodDescription: string,
  ): Promise<IcebergData> {
    const artistNames = topArtists.map((a) => a.name);

    const dbArtists = await orDatabaseUnavailable('getIceberg:artistPopularity', () =>
      this.db.artist.findMany({
        where: {
          name: { in: artistNames, mode: 'insensitive' },
        },
        select: {
          name: true,
          popularity: true,
        },
      }),
    );

    const popMap = new Map<string, number>();
    for (const a of dbArtists) {
      if (a.popularity !== null && a.popularity !== undefined) {
        popMap.set(a.name.toLowerCase(), a.popularity);
      }
    }

    const tierDefinitions = [
      { tierNumber: 1, name: 'The Tip', emoji: '🏔️', description: 'Mainstream Giants (Pop 80-100)', minPop: 80, maxPop: 100 },
      { tierNumber: 2, name: 'Waterline', emoji: '🌊', description: 'Popular & Well-Known (Pop 60-79)', minPop: 60, maxPop: 79 },
      { tierNumber: 3, name: 'The Depths', emoji: '⚓', description: 'Indie & Sub-mainstream (Pop 40-59)', minPop: 40, maxPop: 59 },
      { tierNumber: 4, name: 'Twilight Zone', emoji: '🪨', description: 'Underground & Niche (Pop 20-39)', minPop: 20, maxPop: 39 },
      { tierNumber: 5, name: 'The Abyss', emoji: '🐙', description: 'Ultra-Obscure & Rare (Pop 0-19)', minPop: 0, maxPop: 19 },
    ];

    const tiers: IcebergTier[] = tierDefinitions.map((def) => ({
      tierNumber: def.tierNumber,
      name: def.name,
      emoji: def.emoji,
      description: def.description,
      artists: [],
    }));

    let hasDbPopularity = false;
    for (const [_, pop] of popMap) {
      if (pop > 0) {
        hasDbPopularity = true;
        break;
      }
    }

    // THE RANK-RATIO FALLBACK BELOW IS STAYS, AND THE DIFFERENCE IS THE POINT.
    // It is the honest answer when the query RAN and came back with no recorded
    // popularity for these artists — we asked, and the answer was "we have not
    // scored them". It is a fabrication when the query THREW, because then we do
    // not know which of the two happened, and the old `.catch(() => [])` made
    // those identical: an outage rendered a complete five-tier iceberg with a
    // confident invented popularity on every artist, all of it derived from
    // playcount rank. Raising above is what separates them. An empty result and
    // a fabricated result now render identically, and only one of them is true.
    topArtists.forEach((artist, index) => {
      let pop = popMap.get(artist.name.toLowerCase());
      if (pop === undefined) {
        if (hasDbPopularity) {
          pop = 15;
        } else {
          const rankRatio = topArtists.length > 1 ? index / topArtists.length : 0;
          pop = Math.max(0, Math.round(95 - rankRatio * 90));
        }
      }

      let tierIndex = 4;
      if (pop >= 80) tierIndex = 0;
      else if (pop >= 60) tierIndex = 1;
      else if (pop >= 40) tierIndex = 2;
      else if (pop >= 20) tierIndex = 3;
      else tierIndex = 4;

      tiers[tierIndex]!.artists.push({
        name: artist.name,
        playcount: artist.playcount,
        popularity: pop,
      });
    });

    return {
      displayName,
      userNameLastFm,
      timePeriodDescription,
      tiers,
      totalArtists: topArtists.length,
    };
  }

  public async getGuildAffinity(
    guildId: string,
    targetUserId: number,
    targetDisplayName: string,
    targetUserNameLastFm: string,
    guildName: string,
  ): Promise<AffinityData> {
    const guildIdBigInt = parseGuildId(guildId);
    if (guildIdBigInt === null) {
      Logger.warn(
        { guildId },
        'musicIntelligenceService received a guild id that is not a snowflake; no query was issued',
      );
      return {
        userDisplayName: targetDisplayName,
        userNameLastFm: targetUserNameLastFm,
        guildName,
        neighbors: [],
        totalGuildUsers: 0,
      };
    }

    // The candidate list itself. Empty here renders "*Could not find indexed
    // users with a similar music taste in this server*", which during an outage
    // is a confident falsehood about real people in a real server.
    const guildUsers = await orDatabaseUnavailable('getGuildAffinity:guildUsers', () =>
      this.db.guildUser.findMany({
        where: {
          guildId: guildIdBigInt,
          userId: { not: targetUserId },
          whoKnowsBanned: false,
        },
        include: {
          user: {
            select: {
              userId: true,
              discordUserId: true,
              userNameLastFm: true,
            },
          },
        },
      }),
    );

    if (guildUsers.length === 0) {
      // Genuinely nobody else in the server is indexed. That IS the answer, and
      // it is the one case the builder above renders correctly.
      return {
        userDisplayName: targetDisplayName,
        userNameLastFm: targetUserNameLastFm,
        guildName,
        neighbors: [],
        totalGuildUsers: 0,
      };
    }

    // THE TARGET'S OWN TOP ARTISTS. This is the most insidious read in the
    // file, and it is why a per-site judgement was not enough to triage this one.
    // Failing here does NOT render an empty table. It empties `targetArtistMap`,
    // which zeroes `artistScore` for every neighbour, which zeroes `totalPercentage`
    // for every neighbour — so the user gets a FULL affinity table of real people,
    // every number in it wrong, sorted by those wrong numbers. Identical in shape
    // to `guildAdminService.getMembersOverview`, which sank the heaviest listener
    // in a server to the bottom of the members table.
    const targetArtistsRaw = await orDatabaseUnavailable('getGuildAffinity:targetArtists', () =>
      this.db.userArtist.findMany({
        where: { userId: targetUserId },
        orderBy: { playcount: 'desc' },
        take: 100,
        select: { name: true, playcount: true },
      }),
    );

    const targetArtistMap = new Map<string, number>();
    for (const a of targetArtistsRaw) {
      targetArtistMap.set(a.name.toLowerCase(), a.playcount);
    }

    const otherUserIds = guildUsers.map((gu) => gu.userId);
    // Same shape as the target read: empty here means every neighbour is skipped
    // by the `uArtists.length === 0` guard below, so the table collapses to the
    // same "could not find indexed users" line an empty candidate list produces.
    const otherArtistsRaw = await orDatabaseUnavailable('getGuildAffinity:guildArtists', () =>
      this.db.userArtist.findMany({
        where: {
          userId: { in: otherUserIds },
        },
        orderBy: { playcount: 'desc' },
        select: { userId: true, name: true, playcount: true },
      }),
    );

    const allArtistNames = [...new Set([
      ...targetArtistsRaw.map((a) => a.name.toLowerCase().trim()),
      ...otherArtistsRaw.map((a) => a.name.toLowerCase().trim()),
    ])];

    let dbArtists: Array<{ name: string; countryCode?: string | null; genres?: Array<{ name: string }> }> = [];
    if (allArtistNames.length > 0 && this.db.artist?.findMany) {
      // THE PARTIAL-SUCCESS CASE, which is the insidious one. `artistPercentage`
      // above is real; only the genre and country columns depend on this read. So a
      // failure here does not empty the table — it renders a table whose middle
      // two columns are `0%` for everybody, with no hint that they were never
      // measured. That is why `guildAdminService.getMembersOverview` has a
      // separate test for a crowns-only failure: the playcounts are real, so the
      // table looks trustworthy right up to the column that is not.
      const res = await orDatabaseUnavailable('getGuildAffinity:artistEnrichment', () =>
        this.db.artist.findMany({
          where: {
            name: { in: allArtistNames, mode: 'insensitive' },
          },
          select: {
            name: true,
            countryCode: true,
            genres: {
              select: { name: true },
            },
          },
        }),
      );
      if (Array.isArray(res)) dbArtists = res;
    }

    const artistGenreMap = new Map<string, string[]>();
    const artistCountryMap = new Map<string, string>();

    for (const a of dbArtists) {
      const k = a.name.toLowerCase().trim();
      if (a.genres && a.genres.length > 0) {
        artistGenreMap.set(k, a.genres.map((g: { name: string }) => g.name.toLowerCase()));
      }
      if (a.countryCode) {
        artistCountryMap.set(k, a.countryCode.toLowerCase());
      }
    }

    if (this.countryService?.getSeedCountry) {
      for (const name of allArtistNames) {
        if (!artistCountryMap.has(name)) {
          const seed = this.countryService.getSeedCountry(name);
          if (seed) {
            artistCountryMap.set(name, seed.toLowerCase());
          }
        }
      }
    }

    const getTopGenres = (artists: Array<{ name: string; playcount: number }>): string[] => {
      const genreTotals = new Map<string, number>();
      for (const a of artists) {
        const genres = artistGenreMap.get(a.name.toLowerCase().trim());
        if (genres) {
          for (const g of genres) {
            genreTotals.set(g, (genreTotals.get(g) ?? 0) + a.playcount);
          }
        }
      }
      return Array.from(genreTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([g]) => g);
    };

    const getTopCountries = (artists: Array<{ name: string; playcount: number }>): string[] => {
      const countryTotals = new Map<string, number>();
      for (const a of artists) {
        const c = artistCountryMap.get(a.name.toLowerCase().trim());
        if (c) {
          countryTotals.set(c, (countryTotals.get(c) ?? 0) + a.playcount);
        }
      }
      return Array.from(countryTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([c]) => c);
    };

    const targetGenres = getTopGenres(targetArtistsRaw);
    const targetCountries = getTopCountries(targetArtistsRaw);

    const userArtistsByUser = new Map<number, Array<{ name: string; playcount: number }>>();
    for (const a of otherArtistsRaw) {
      let list = userArtistsByUser.get(a.userId);
      if (!list) {
        list = [];
        userArtistsByUser.set(a.userId, list);
      }
      if (list.length < 100) {
        list.push({ name: a.name, playcount: a.playcount });
      }
    }

    const neighbors: AffinityNeighbor[] = [];

    for (const gu of guildUsers) {
      const uArtists = userArtistsByUser.get(gu.userId) ?? [];
      if (uArtists.length === 0) continue;

      const sharedArtists: string[] = [];
      for (const a of uArtists) {
        const lower = a.name.toLowerCase();
        if (targetArtistMap.has(lower)) {
          sharedArtists.push(a.name);
        }
      }

      const denominator = Math.max(1, Math.min(targetArtistMap.size, uArtists.length));
      const artistScore = targetArtistMap.size > 0
        ? Math.min(100, Math.round((sharedArtists.length / denominator) * 100))
        : 0;

      const uGenres = getTopGenres(uArtists);
      let genreScore = 0;
      if (targetGenres.length > 0 && uGenres.length > 0) {
        const commonGenres = uGenres.filter((g) => targetGenres.includes(g));
        genreScore = Math.min(
          100,
          Math.round((commonGenres.length / Math.max(1, Math.min(targetGenres.length, uGenres.length))) * 100),
        );
      }

      const uCountries = getTopCountries(uArtists);
      let countryScore = 0;
      if (targetCountries.length > 0 && uCountries.length > 0) {
        const commonCountries = uCountries.filter((c) => targetCountries.includes(c));
        countryScore = Math.min(
          100,
          Math.round((commonCountries.length / Math.max(1, Math.min(targetCountries.length, uCountries.length))) * 100),
        );
      }

      const totalPercentage = Math.round(artistScore * 0.5 + genreScore * 0.3 + countryScore * 0.2);

      neighbors.push({
        userId: gu.userId,
        discordUserId: gu.user.discordUserId.toString(),
        userNameLastFm: gu.user.userNameLastFm,
        totalPercentage,
        artistPercentage: artistScore,
        genrePercentage: genreScore,
        countryPercentage: countryScore,
        sharedArtists: sharedArtists.slice(0, 5),
      });
    }

    neighbors.sort((a, b) => b.totalPercentage - a.totalPercentage);

    return {
      userDisplayName: targetDisplayName,
      userNameLastFm: targetUserNameLastFm,
      guildName,
      neighbors,
      totalGuildUsers: guildUsers.length,
    };
  }
}
