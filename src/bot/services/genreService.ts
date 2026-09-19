import { injectable, inject, container } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { CacheService } from './cacheService';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

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
    } catch {
      // ignore
    }

    await this.cache.set(key, [], 600);
    return [];
  }

  public async getGenresForArtistNames(artistNames: string[]): Promise<Map<string, string[]>> {
    return this.artistGenreRepo.getForArtistNames(artistNames);
  }

  public async getTopGenresForUserAllTime(userId: number, limit = 100): Promise<TopGenreItem[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ genreName: string; userPlaycount: bigint }>>`
        SELECT ag.name AS "genreName", SUM(ua.playcount)::bigint AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId} AND ua.artist_id IS NOT NULL
        GROUP BY ag.name
        ORDER BY "userPlaycount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        genreName: r.genreName,
        userPlaycount: Number(r.userPlaycount),
      }));
    } catch {
      return [];
    }
  }

  public async getTopGenresForTopArtists(
    topArtists: { name: string; playcount: number }[],
    limit = 100,
  ): Promise<TopGenreItem[]> {
    if (!topArtists || topArtists.length === 0) return [];

    const artistNames = [...new Set(topArtists.map(a => a.name.toLowerCase().trim()))];
    if (artistNames.length === 0) return [];

    try {
      const rows = await this.prisma.$queryRaw<Array<{ genre: string; artistName: string }>>`
        SELECT ag.name AS "genre", a.name AS "artistName"
        FROM artists a
        INNER JOIN artist_genres ag ON ag.artist_id = a.artist_id
        WHERE LOWER(a.name) = ANY(${artistNames})
      `;

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
    } catch {
      return [];
    }
  }

  public async getUserArtistsForGenre(
    userId: number,
    genreName: string,
    limit = 50,
  ): Promise<{ artistName: string; userPlaycount: number }[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ artistName: string; userPlaycount: number }>>`
        SELECT ua.name AS "artistName", ua.playcount AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND LOWER(ag.name) = LOWER(${genreName.trim()})
        ORDER BY ua.playcount DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        artistName: r.artistName,
        userPlaycount: Number(r.userPlaycount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildTopGenresAllTime(
    guildId: string,
    limit = 100,
  ): Promise<GuildGenreItem[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ genreName: string; totalPlaycount: bigint; listenerCount: bigint }>>`
        SELECT ag.name AS "genreName",
               SUM(ua.playcount)::bigint AS "totalPlaycount",
               COUNT(DISTINCT ua.user_id)::bigint AS "listenerCount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide'
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ag.name
        ORDER BY "listenerCount" DESC, "totalPlaycount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        genreName: r.genreName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildArtistsForGenre(
    guildId: string,
    genreName: string,
    limit = 50,
  ): Promise<{ artistName: string; userPlaycount: number }[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ artistName: string; userPlaycount: bigint }>>`
        SELECT ua.name AS "artistName", SUM(ua.playcount)::bigint AS "userPlaycount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        INNER JOIN users u ON u.user_id = ua.user_id AND u.privacy_level <> 'Hide'
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(ag.name) = LOWER(${genreName.trim()})
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
        GROUP BY ua.name
        ORDER BY "userPlaycount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        artistName: r.artistName,
        userPlaycount: Number(r.userPlaycount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildUsersForGenre(
    guildId: string,
    genreName: string,
  ): Promise<WhoKnowsGenreItem[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
        SELECT ua.user_id AS "userId",
               u.discord_user_id AS "discordUserId",
               u.user_name_last_fm AS "userNameLastFm",
               SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN users u ON u.user_id = ua.user_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND u.privacy_level <> 'Hide'
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
          AND (gu.self_block_from_who_knows = false OR gu.self_block_from_who_knows IS NULL)
          AND ua.artist_id IN (
            SELECT ag.artist_id FROM artist_genres ag
            WHERE LOWER(ag.name) = LOWER(${genreName.trim()})
          )
        GROUP BY ua.user_id, u.discord_user_id, u.user_name_last_fm
        ORDER BY "playcount" DESC
      `;

      return rows.map(r => ({
        userId: r.userId,
        discordUserId: r.discordUserId.toString(),
        userNameLastFm: r.userNameLastFm,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getFriendUsersForGenre(
    userId: number,
    friendUserIds: number[],
    genreName: string,
  ): Promise<WhoKnowsGenreItem[]> {
    try {
      const allUserIds = [...new Set([userId, ...friendUserIds])];
      if (allUserIds.length === 0) return [];

      const rows = await this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
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
      `;

      return rows.map(r => ({
        userId: r.userId,
        discordUserId: r.discordUserId.toString(),
        userNameLastFm: r.userNameLastFm,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }
}
