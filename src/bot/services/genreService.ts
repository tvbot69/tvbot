import { injectable, inject, container } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { CacheService } from './system/cacheService';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';

/**
 * A failed read is not a zero.
 *
 * Seven methods in this file are `$queryRaw` aggregates over `user_artists` and
 * `artist_genres`, and every one of them ended in `catch { return [] }`. That
 * made a dropped connection and a user with no scrobbles the same value, which
 * is the worst failure shape available: `.topgenres` answered "you have no
 * genres" and `.whoknowsgenre` answered "nobody in this server listens to
 * anything" during an outage, with no error anywhere. The genre db suite
 * (`genreService.db.test.ts`) found a real production bug of exactly this shape
 * in four of these seven queries, and it was invisible from the outside.
 *
 * Same rule as `orUnavailable` in lastFmRepository and
 * `orDatabaseUnavailable` in playHistoryService and guildAdminService: a
 * missing ROW is a real answer and stays an empty result, but a query that could
 * not run raises. None of these seven has a "not found" case to separate out -
 * every one is a `GROUP BY` aggregate, and an aggregate with no matching rows
 * succeeds with a shorter result rather than erroring. So empty IS the answer,
 * and an error is always an error.
 */
const orDatabaseUnavailable = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: label, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${label}; refusing to render it as an empty result`,
    );
    throw new SourceUnavailableError(`genreService.${label}`, err, 'Database unavailable');
  }
};

/**
 * `guild_id` is BigInt and every guild id arrives as a string, so `BigInt()`
 * throws a SyntaxError on anything non-numeric.
 *
 * A malformed argument is not a source that failed to answer, and it must not be
 * laundered into the same "database unavailable" as a real outage - that would
 * tell a caller to retry a request which can never succeed. The guard returns
 * the empty answer WITHOUT opening a query, which is the honest answer: no such
 * guild exists, so it has no genre rows. Same shape as `safeBigInt` in
 * crownRepository.
 */
const parseGuildId = (guildId: string): bigint | null => {
  if (!guildId || !/^\d+$/.test(guildId)) return null;
  try {
    return BigInt(guildId);
  } catch {
    // CORRECT AS IS, and the reasoning is the doc comment above plus the regex
    // on the first line: the guard already rejects everything `BigInt` refuses,
    // so this branch is unreachable in practice. What matters is that IF it were
    // reached it would still be right - a malformed guild id is a CALLER bug, and
    // turning it into `SourceUnavailableError` would tell the operator to go
    // look at Postgres when the fault is upstream of it. The honest answer is
    // "no such guild, so it has no genre rows", returned without opening a query.
    return null;
  }
};

export interface TopGenreItem {
  genreName: string;
  userPlaycount: number;
  topArtists?: string[];
}

export interface GuildGenreItem {
  genreName: string;
  totalPlaycount: number;
  listenerCount: number;
}

export interface WhoKnowsGenreItem {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  playcount: number;
}

@injectable()
export class GenreService {
  constructor(
    @inject(CacheService) private readonly cache: CacheService,
    @inject(ArtistGenreRepository) private readonly artistGenreRepo: ArtistGenreRepository,
    @inject(ArtistRepository) private readonly artistRepo: ArtistRepository,
    @inject(LastFmRepository) private readonly lastfmRepo: ILastfmRepository,
    @inject(PrismaClient) private readonly prisma: PrismaClient,
  ) {}

  public static genresToString(genres: string[]): string {
    return genres.join(' · ');
  }

  public async getGenresForArtist(artistName: string, sampleTrack?: string): Promise<string[]> {
    if (!artistName) return [];

    // Track-anchored resolution (same rationale as ArtworkService.getArtistImageUrl):
    // pin the exact Spotify entity via one of the user's own scrobbles. Anchored
    // results use a track-scoped cache key and never touch the global name-keyed
    // genre table, so same-name artists can't pollute each other.
    if (sampleTrack?.trim()) {
      const anchoredKey = `genres:${artistName.toLowerCase().trim()}:via:${sampleTrack.toLowerCase().trim()}`;
      const anchoredCached = await this.cache.get<string[]>(anchoredKey);
      if (anchoredCached) return anchoredCached;

      try {
        const api = container.resolve(SpotifySearchApi);
        const anchoredId = await api.getArtistIdViaTrackSample(artistName, sampleTrack);
        if (anchoredId) {
          const artist = await api.getArtistById(anchoredId);
          const spotifyGenres = (artist?.genres ?? []).map((g) => String(g).toLowerCase().trim()).filter(Boolean).slice(0, 4);
          if (spotifyGenres.length > 0) {
            await this.cache.set(anchoredKey, spotifyGenres, 3600);
            return spotifyGenres;
          }
          // Spotify knows the entity but lists no genres: prove a name collision
          // before suppressing Last.fm tags (which would belong to the other entity).
          const naive = await api.searchArtists(artistName, 5);
          const target = artistName.toLowerCase().trim();
          const naiveId = naive.find((a) => a.name.toLowerCase().trim() === target)?.id ?? naive[0]?.id;
          if (naiveId && naiveId !== anchoredId) {
            await this.cache.set(anchoredKey, [], 3600);
            return [];
          }
        }
      } catch {
        // CORRECT AS IS. The anchored Spotify lookup is an optional PRECISION
        // improvement, not the answer: a failure here falls through to the
        // name-based flow below, which still consults our own `artist_genres`
        // table and then Last.fm. So the worst case is a genre list resolved by
        // name rather than pinned to the entity - the same answer the service
        // already returns whenever no sample track is supplied, and the same
        // answer it returns when Spotify genuinely cannot find the entity. No
        // number is invented and no row is dropped, so there is nothing here for
        // the user to be misled about. Raising would break the entire artist
        // card over a decoration.
        // fall through to the name-based flow
      }
      // No anchor (or anchor matches naive winner): fall through to name-based flow.
    }

    const key = `genres:${artistName.toLowerCase().trim()}`;
    const cached = await this.cache.get<string[]>(key);
    if (cached) return cached;

    // 1) DB hit
    const db = await this.artistGenreRepo.getForArtistName(artistName);
    if (db.length) {
      await this.cache.set(key, db, 3600);
      return db;
    }

    // 2) Last.fm fallback — top tags via artist.getInfo
    try {
      let info = await this.lastfmRepo.getArtistInfo(artistName);
      let tags = info?.tags ?? [];

      // If tags empty and artist name has '$' or 's', try spelling variant (e.g. Travis Scott vs Travi$ Scott)
      if (tags.length === 0) {
        if (artistName.includes('$')) {
          const alt = artistName.replace(/\$/g, 's');
          info = await this.lastfmRepo.getArtistInfo(alt);
          tags = info?.tags ?? [];
        } else if (/s/i.test(artistName)) {
          const alt = artistName.replace(/s/gi, '$');
          info = await this.lastfmRepo.getArtistInfo(alt);
          tags = info?.tags ?? [];
        }
      }

      // If still empty, query artist.gettoptags directly
      if (tags.length === 0 && container.isRegistered(LastfmApi)) {
        try {
          const api = container.resolve(LastfmApi);
          const res = await api.call<{ toptags?: { tag?: Array<{ name: string }> } }>('artist.gettoptags', {
            artist: artistName,
            autocorrect: '1',
          });
          const rawTags = res?.toptags?.tag ?? [];
          tags = rawTags.map((t) => t.name).filter(Boolean);
        } catch {
          // CORRECT AS IS. `artist.gettoptags` is the THIRD and last rung of a
          // ladder: `artist.getInfo` already ran and returned this artist with
          // no tags, and the s/$ spelling variant was already tried. A failure
          // here therefore costs one redundant probe of an artist Last.fm has
          // already described as untagged - it does not convert a real tag list
          // into an empty one, because a real tag list would have been returned
          // two rungs earlier and never reached this call. `top` below stays
          // empty and the caller gets the honest "Last.fm has no tags for this
          // artist" answer, which the outer catch classifies the same way.
          // ignore
        }
      }

      const lowerName = artistName.toLowerCase().replace(/\$/g, 's').replace(/[^a-z0-9]/g, '');
      const top = tags
        .map((t) => String(t).toLowerCase().trim())
        .filter((t) => Boolean(t) && t.toLowerCase().replace(/\$/g, 's').replace(/[^a-z0-9]/g, '') !== lowerName)
        .slice(0, 4);

      if (top.length) {
        const artist = await this.artistRepo.getOrCreateArtist(artistName);
        await this.artistGenreRepo.setForArtistId(artist.artistId, top);
        await this.cache.set(key, top, 3600);
        return top;
      }
    } catch (err) {
      // `lastfmRepo.getArtistInfo` already draws this line for us: a real "no
      // such artist" comes back as null, and anything else - a 5xx, a dropped
      // connection - is RAISED as LastFmUnavailableError precisely so no caller
      // can mistake it for an artist with no tags. This catch used to swallow
      // that and cache `[]` for ten minutes, so a Last.fm outage told the world
      // the artist has no genres, and `.genre <artist>` then charted an artist
      // as a genre because it branches on `genres.length === 0`. Overruling a
      // deliberately raised signal is the bug; anything genuinely unexpected
      // still falls through to the empty answer below.
      if (isSourceUnavailable(err)) {
        Logger.error(
          { artist: artistName, err: (err as Error)?.message ?? String(err) },
          'Last.fm unavailable while resolving artist genres; not caching the failure as "no genres"',
        );
        throw err;
      }
    }

    await this.cache.set(key, [], 600);
    return [];
  }

  public async getGenresForArtistNames(artistNames: string[]): Promise<Map<string, string[]>> {
    return this.artistGenreRepo.getForArtistNames(artistNames);
  }

  public async getTopGenresForUserAllTime(userId: number, limit = 100): Promise<TopGenreItem[]> {
    const rows = await orDatabaseUnavailable<Array<{ genreName: string; userPlaycount: bigint }>>(
      'getTopGenresForUserAllTime',
      () => this.prisma.$queryRaw<Array<{ genreName: string; userPlaycount: bigint }>>`
        SELECT ag.name AS "genreName", SUM(ua.playcount)::bigint AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId} AND ua.artist_id IS NOT NULL
        GROUP BY ag.name
        ORDER BY "userPlaycount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      genreName: r.genreName,
      userPlaycount: Number(r.userPlaycount),
    }));
  }

  public async getTopGenresForTopArtists(
    topArtists: { name: string; playcount: number }[],
    limit = 100,
  ): Promise<TopGenreItem[]> {
    if (!topArtists || topArtists.length === 0) return [];

    const artistNames = [...new Set(topArtists.map(a => a.name.toLowerCase().trim()))];
    if (artistNames.length === 0) return [];

    const rows = await orDatabaseUnavailable<Array<{ genre: string; artistName: string }>>(
      'getTopGenresForTopArtists',
      () => this.prisma.$queryRaw<Array<{ genre: string; artistName: string }>>`
        SELECT ag.name AS "genre", a.name AS "artistName"
        FROM artists a
        INNER JOIN artist_genres ag ON ag.artist_id = a.artist_id
        WHERE LOWER(a.name) = ANY(${artistNames})
      `,
    );

    const artistGenreMap = new Map<string, string[]>();
    for (const r of rows) {
      const k = r.artistName.toLowerCase().trim();
      if (!artistGenreMap.has(k)) artistGenreMap.set(k, []);
      artistGenreMap.get(k)!.push(r.genre);
    }

    const genreTotals = new Map<string, number>();
    const genreArtists = new Map<string, string[]>();

    for (const a of topArtists) {
      const genres = artistGenreMap.get(a.name.toLowerCase().trim()) || [];
      for (const g of genres) {
        genreTotals.set(g, (genreTotals.get(g) || 0) + a.playcount);
        if (!genreArtists.has(g)) genreArtists.set(g, []);
        const list = genreArtists.get(g)!;
        if (list.length < 3 && !list.includes(a.name)) {
          list.push(a.name);
        }
      }
    }

    return Array.from(genreTotals.entries())
      .map(([genreName, userPlaycount]) => ({
        genreName,
        userPlaycount,
        topArtists: genreArtists.get(genreName) || [],
      }))
      .sort((a, b) => b.userPlaycount - a.userPlaycount)
      .slice(0, limit);
  }

  public async getUserArtistsForGenre(
    userId: number,
    genreName: string,
    limit = 50,
  ): Promise<{ artistName: string; userPlaycount: number }[]> {
    const rows = await orDatabaseUnavailable<Array<{ artistName: string; userPlaycount: number }>>(
      'getUserArtistsForGenre',
      () => this.prisma.$queryRaw<Array<{ artistName: string; userPlaycount: number }>>`
        SELECT ua.name AS "artistName", ua.playcount AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND LOWER(ag.name) = LOWER(${genreName.trim()})
        ORDER BY ua.playcount DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      artistName: r.artistName,
      userPlaycount: Number(r.userPlaycount),
    }));
  }

  public async getGuildTopGenresAllTime(
    guildId: string,
    limit = 100,
  ): Promise<GuildGenreItem[]> {
    const gIdBigInt = parseGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable<Array<{ genreName: string; totalPlaycount: bigint; listenerCount: bigint }>>(
      'getGuildTopGenresAllTime',
      () => this.prisma.$queryRaw<Array<{ genreName: string; totalPlaycount: bigint; listenerCount: bigint }>>`
        SELECT ag.name AS "genreName",
               SUM(ua.playcount)::bigint AS "totalPlaycount",
               COUNT(DISTINCT ua.user_id)::bigint AS "listenerCount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide' AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ag.name
        ORDER BY "listenerCount" DESC, "totalPlaycount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      genreName: r.genreName,
      totalPlaycount: Number(r.totalPlaycount),
      listenerCount: Number(r.listenerCount),
    }));
  }

  public async getGuildArtistsForGenre(
    guildId: string,
    genreName: string,
    limit = 50,
  ): Promise<{ artistName: string; userPlaycount: number }[]> {
    const gIdBigInt = parseGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable<Array<{ artistName: string; userPlaycount: bigint }>>(
      'getGuildArtistsForGenre',
      () => this.prisma.$queryRaw<Array<{ artistName: string; userPlaycount: bigint }>>`
        SELECT ua.name AS "artistName", SUM(ua.playcount)::bigint AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide' AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(ag.name) = LOWER(${genreName.trim()})
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ua.name
        ORDER BY "userPlaycount" DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(r => ({
      artistName: r.artistName,
      userPlaycount: Number(r.userPlaycount),
    }));
  }

  public async getGuildUsersForGenre(
    guildId: string,
    genreName: string,
  ): Promise<WhoKnowsGenreItem[]> {
    const gIdBigInt = parseGuildId(guildId);
    if (gIdBigInt === null) return [];

    const rows = await orDatabaseUnavailable<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>(
      'getGuildUsersForGenre',
      () => this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
        SELECT ua.user_id AS "userId",
               u.discord_user_id AS "discordUserId",
               u.user_name_last_fm AS "userNameLastFm",
               SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN users u ON u.user_id = ua.user_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND u.privacy_level <> 'Hide'
          AND NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE af.user_id = ua.user_id AND (af.expires_at IS NULL OR af.expires_at > NOW()))
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
          AND ua.artist_id IN (
            SELECT ag.artist_id FROM artist_genres ag
            WHERE LOWER(ag.name) = LOWER(${genreName.trim()})
          )
        GROUP BY ua.user_id, u.discord_user_id, u.user_name_last_fm
        ORDER BY "playcount" DESC
      `,
    );

    return rows.map(r => ({
      userId: r.userId,
      discordUserId: r.discordUserId.toString(),
      userNameLastFm: r.userNameLastFm,
      playcount: Number(r.playcount),
    }));
  }

  public async getFriendUsersForGenre(
    userId: number,
    friendUserIds: number[],
    genreName: string,
  ): Promise<WhoKnowsGenreItem[]> {
    const allUserIds = [...new Set([userId, ...friendUserIds])];
    if (allUserIds.length === 0) return [];

    const rows = await orDatabaseUnavailable<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>(
      'getFriendUsersForGenre',
      () => this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
        SELECT ua.user_id AS "userId",
               u.discord_user_id AS "discordUserId",
               u.user_name_last_fm AS "userNameLastFm",
               SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN users u ON u.user_id = ua.user_id
        WHERE ua.user_id = ANY(${allUserIds})
          AND ua.artist_id IN (
            SELECT ag.artist_id FROM artist_genres ag
            WHERE LOWER(ag.name) = LOWER(${genreName.trim()})
          )
        GROUP BY ua.user_id, u.discord_user_id, u.user_name_last_fm
        ORDER BY "playcount" DESC
      `,
    );

    return rows.map(r => ({
      userId: r.userId,
      discordUserId: r.discordUserId.toString(),
      userNameLastFm: r.userNameLastFm,
      playcount: Number(r.playcount),
    }));
  }
}
