import { container } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import type { TopArtist } from '@domain/models/topLists';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ReferencedMusic } from '@domain/models/referencedMusic';
import { ArtworkService } from './artworkService';
import { ColorService } from './colorService';
import { MusicBrainzService } from './musicBrainzService';
import { TasteService, type TasteItem, type TasteComparisonItem } from './tasteService';
import { CacheService } from './cacheService';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { PrismaClient } from '@prisma/client';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { Logger } from '@domain/logger';

const CACHE_TTL_SECONDS = 3600;

export interface ArtistSearchResult {
  artistName: string;
  artistUrl?: string;
  imageUrl?: string;
  userPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  bio?: string;
  tags?: string[];
  rndPosition?: number;
  rndPlaycount?: number;
}

export enum EmbedSize {
  Default = 'default',
  Small = 'small',
  Large = 'large',
}

export interface UserTrackEntry {
  userTrackId?: number;
  userId: number;
  name: string;
  artistName: string;
  playcount: number;
}

export interface UserAlbumEntry {
  id?: number;
  userId: number;
  name: string;
  artistName: string;
  playcount: number;
}

export class ArtistsService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly cache: CacheService;
  private readonly artworkService?: ArtworkService;
  private readonly colorService?: ColorService;
  private readonly musicBrainzService?: MusicBrainzService;
  private readonly prisma?: PrismaClient;

  constructor(
    lastfmRepository: ILastfmRepository,
    cache: CacheService,
    artworkService?: ArtworkService,
    colorService?: ColorService,
    musicBrainzService?: MusicBrainzService,
    prisma?: PrismaClient,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.cache = cache;
    this.artworkService = artworkService;
    this.colorService = colorService;
    this.musicBrainzService = musicBrainzService;
    this.prisma = prisma;
  }

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getArtistInfo(
    artistName: string,
    username?: string,
  ): Promise<ArtistInfo | null> {
    const key = `artist-info:${artistName.toLowerCase()}${username ? `:${username.toLowerCase()}` : ':global'}`;
    const cached = await this.cache.get<ArtistInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getArtistInfo(artistName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchArtists(query: string): Promise<TopArtist[]> {
    return this.lastfmRepository.searchArtists(query);
  }

  /**
   * Resolves artist name from Spotify, Apple Music, or Last.fm URLs
   */
  public async resolveArtistFromLink(input: string): Promise<string | null> {
    if (!input || !input.includes('http')) return null;

    try {
      // Spotify artist link: https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb
      const spotifyMatch = input.match(/spotify\.com\/(?:intl-[a-zA-Z-]+\/)?artist\/([a-zA-Z0-9]+)/i);
      if (spotifyMatch && spotifyMatch[1]) {
        const spotifyId = spotifyMatch[1];
        const dbArtist = await this.getArtistForSpotifyId(spotifyId);
        if (dbArtist?.name) {
          return dbArtist.name;
        }
      }

      // Last.fm artist URL: https://www.last.fm/music/Radiohead
      const lastfmMatch = input.match(/last\.fm\/music\/([^/?#]+)/i);
      if (lastfmMatch && lastfmMatch[1]) {
        try {
          return decodeURIComponent(lastfmMatch[1].replace(/\+/g, ' '));
        } catch {
          return lastfmMatch[1];
        }
      }

      // Apple Music artist URL: https://music.apple.com/us/artist/radiohead/657515
      const appleMatch = input.match(/music\.apple\.com\/[a-z]{2}\/artist\/([^/]+)\/([0-9]+)/i);
      if (appleMatch && appleMatch[1]) {
        try {
          return decodeURIComponent(appleMatch[1].replace(/-/g, ' '));
        } catch {
          return appleMatch[1];
        }
      }
    } catch (e) {
      Logger.warn({ err: e }, `Failed to resolve artist from link: ${input}`);
    }

    return null;
  }

  /**
   * Calculates popularity relative to top artist
   */
  public async getArtistsPopularity(
    topArtists: Array<{ name: string; playcount: number }>,
  ): Promise<Array<{ name: string; playcount: number; popularityScore: number }>> {
    if (!topArtists || topArtists.length === 0) return [];
    const maxPlaycount = Math.max(...topArtists.map((a) => a.playcount), 1);
    return topArtists.map((artist) => ({
      name: artist.name,
      playcount: artist.playcount,
      popularityScore: Math.round((artist.playcount / maxPlaycount) * 100),
    }));
  }

  /**
   * Filters out singles and EPs from album lists
   */
  public filterSinglesFromUserAlbums<T extends { name: string; artistName?: string }>(albums: T[]): T[] {
    if (!albums || albums.length === 0) return [];
    return albums.filter((album) => {
      const lower = album.name.toLowerCase();
      return !lower.endsWith(' - single') && !lower.endsWith(' - ep') && lower !== 'single';
    });
  }

  /**
   * Batch hydrates artist images using ArtworkService or database cache
   */
  public async fillArtistImages(topArtists: TopArtist[]): Promise<TopArtist[]> {
    const missing = topArtists.filter((a) => !a.imageUrl);
    if (missing.length === 0) return topArtists;

    if (this.artworkService) {
      await Promise.all(
        missing.map(async (artist) => {
          try {
            const url = await this.artworkService!.getArtistImageUrl(artist.name);
            if (url) {
              artist.imageUrl = url;
            }
          } catch {
            // ignore
          }
        }),
      );
      return topArtists;
    }

    try {
      const names = missing.map((m) => m.name);
      const rows = await this.db.artist.findMany({
        where: {
          name: { in: names, mode: 'insensitive' },
        },
        select: {
          name: true,
          spotifyImageUrl: true,
        },
      });

      const map = new Map<string, string>();
      for (const r of rows) {
        if (r.spotifyImageUrl) {
          map.set(r.name.toLowerCase(), r.spotifyImageUrl);
        }
      }

      for (const a of topArtists) {
        if (!a.imageUrl) {
          const found = map.get(a.name.toLowerCase());
          if (found) a.imageUrl = found;
        }
      }
    } catch {
      // ignore
    }

    return topArtists;
  }

  /**
   * Fetches user's all-time top artists with optional 10-minute caching
   */
  public async getUserAllTimeTopArtists(userId: number, useCache: boolean = false): Promise<TopArtist[]> {
    const cacheKey = `user-${userId}-topartists-alltime`;
    if (useCache) {
      const cached = await this.cache.get<TopArtist[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1
        GROUP BY artist_name
        ORDER BY playcount DESC
        LIMIT 1000
      `, userId);

      const result: TopArtist[] = rows.map((r) => ({
        name: r.artist_name,
        playcount: Number(r.playcount),
      }));

      if (result.length > 100) {
        await this.cache.set(cacheKey, result, 600);
      }

      return result;
    } catch {
      return [];
    }
  }

  /**
   * Visual comparison indicator matching fmbot: ' • ', ' > ', ' < '
   */
  public static getCompareChar(ownPlaycount: number, otherPlaycount: number): string {
    return ownPlaycount === otherPlaycount ? ' • ' : ownPlaycount > otherPlaycount ? ' > ' : ' < ';
  }

  /**
   * Filters and sorts matched taste items for side-by-side comparison
   */
  public static artistsToShow(
    leftUserArtists: TasteItem[],
    rightUserArtists: TasteItem[],
  ): TasteItem[] {
    const rightSet = new Map(rightUserArtists.map((a) => [a.name.toLowerCase(), a.playcount]));
    return leftUserArtists
      .filter((w) => rightSet.has(w.name.toLowerCase()))
      .sort((a, b) => b.playcount - a.playcount);
  }

  /**
   * Formats taste comparison description header
   */
  public static description(
    mainUserArtists: TasteItem[],
    matchedArtists: TasteItem[],
    timeDescription: string = 'overall',
  ): string {
    const total = mainUserArtists.length;
    const matched = matchedArtists.length;
    const percentage = total > 0 ? ((matched / total) * 100).toFixed(1) : '0.0';
    return `Matched **${matched}** of **${total.toLocaleString('en-US')}** artists (${percentage}%) for ${timeDescription}.`;
  }

  /**
   * Translates extra options like 'xl', 'xs' to standard EmbedSize
   */
  public setTasteEmbedSize(extraOptions?: string | null): EmbedSize {
    if (!extraOptions) return EmbedSize.Default;
    const lower = extraOptions.toLowerCase();
    if (lower.includes('xl') || lower.includes('xxl') || lower.includes('extralarge')) {
      return EmbedSize.Large;
    }
    if (lower.includes('xs') || lower.includes('xxs') || lower.includes('extrasmall')) {
      return EmbedSize.Small;
    }
    return EmbedSize.Default;
  }

  public async getArtistForId(artistId: number): Promise<{ id: number; name: string } | null> {
    try {
      const a = await this.db.artist.findUnique({
        where: { artistId },
        select: { artistId: true, name: true },
      });
      return a ? { id: a.artistId, name: a.name } : null;
    } catch {
      return null;
    }
  }

  public async getArtistForSpotifyId(_spotifyId: string): Promise<{ id: number; name: string } | null> {
    return null;
  }

  public async getArtistFromDatabase(artistName: string, _redirectsEnabled: boolean = true): Promise<{ id: number; name: string } | null> {
    if (!artistName) return null;
    try {
      const a = await this.db.artist.findFirst({
        where: { name: { equals: artistName, mode: 'insensitive' } },
        select: { artistId: true, name: true },
      });
      return a ? { id: a.artistId, name: a.name } : null;
    } catch {
      return null;
    }
  }

  public async getTopTracksForArtist(userId: number, artistName: string): Promise<UserTrackEntry[]> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND track_name IS NOT NULL
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, userId, artistName);

      return rows.map((r) => ({
        userId,
        name: r.track_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getTopAlbumsForArtist(userId: number, artistName: string): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, userId, artistName);

      return rows.map((r) => ({
        name: r.album_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getTopAlbumsForArtistGlobal(artistName: string, limit: number = 10): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE LOWER(artist_name) = LOWER($1) AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT $2
      `, artistName, limit);

      return rows.map((r) => ({
        name: r.album_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getTopTracksForArtistGlobal(artistName: string, limit: number = 10): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE LOWER(artist_name) = LOWER($1) AND track_name IS NOT NULL AND track_name != ''
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT $2
      `, artistName, limit);

      return rows.map((r) => ({
        name: r.track_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getUserAlbumsForArtist(userId: number, artistName: string): Promise<UserAlbumEntry[]> {
    try {
      const albums = await this.getTopAlbumsForArtist(userId, artistName);
      return albums.map((a) => ({
        userId,
        name: a.name,
        artistName: a.artistName,
        playcount: a.playcount,
      }));
    } catch {
      return [];
    }
  }

  public async getUserAlbumCount(userId: number): Promise<number> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ count: bigint }>>(`
        SELECT COUNT(DISTINCT LOWER(album_name))::bigint AS count
        FROM user_plays
        WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
      `, userId);
      return rows[0] ? Number(rows[0].count) : 0;
    } catch {
      return 0;
    }
  }

  public async getUserTrackCount(userId: number): Promise<number> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ count: bigint }>>(`
        SELECT COUNT(DISTINCT (LOWER(artist_name) || '|' || LOWER(track_name)))::bigint AS count
        FROM user_plays
        WHERE user_id = $1 AND track_name IS NOT NULL AND track_name != ''
      `, userId);
      return rows[0] ? Number(rows[0].count) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Autocomplete: Recently scrobbled artists in last 2 days
   */
  public async getLatestArtists(discordUserId: string, cacheEnabled: boolean = true): Promise<string[]> {
    const cacheKey = `user-recent-artists-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<string[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.db.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const plays = await this.db.userPlay.findMany({
        where: {
          userId: user.userId,
          timePlayed: { gte: cutoff },
        },
        orderBy: { timePlayed: 'desc' },
        select: { artistName: true },
        take: 200,
      });

      const artists = Array.from(new Set(plays.map((p) => p.artistName)));
      await this.cache.set(cacheKey, artists, 30);
      return artists;
    } catch {
      return [];
    }
  }

  /**
   * Autocomplete: Top artists in last 20 days
   */
  public async getRecentTopArtists(
    discordUserId: string,
    cacheEnabled: boolean = true,
    daysToGoBack: number = 20,
  ): Promise<TopArtist[]> {
    const cacheKey = `user-recent-top-artists-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<TopArtist[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.db.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - daysToGoBack * 24 * 3600 * 1000);
      const rows = await this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2
        GROUP BY artist_name
        ORDER BY playcount DESC
        LIMIT 25
      `, user.userId, cutoff);

      const artists = rows.map((r) => ({
        name: r.artist_name,
        playcount: Number(r.playcount),
      }));

      await this.cache.set(cacheKey, artists, 120);
      return artists;
    } catch {
      return [];
    }
  }

  /**
   * Autocomplete: Fuzzy search through artist catalog
   */
  public async searchThroughArtists(searchValue: string): Promise<Array<{ name: string; popularity?: number }>> {
    if (!searchValue || searchValue.trim().length === 0) return [];
    try {
      const rows = await this.db.artist.findMany({
        where: {
          name: { contains: searchValue.trim(), mode: 'insensitive' },
        },
        take: 25,
        select: { name: true },
      });
      return rows.map((r) => ({ name: r.name }));
    } catch {
      return [];
    }
  }

  /**
   * Resolves prominent accent color for artist
   */
  public async getArtistAccentColorAsync(
    artistImageUrl?: string | null,
    _artistId?: number | null,
    _artistName?: string | null,
  ): Promise<number> {
    if (artistImageUrl) {
      try {
        const cs = this.colorService ?? container.resolve(ColorService);
        return cs.getColorFromImageUrl(artistImageUrl);
      } catch {
        return DiscordConstants.LastFmColorRed;
      }
    }

    return DiscordConstants.LastFmColorRed;
  }

  /**
   * Checks if today is the artist's birthday
   */
  public static isArtistBirthday(startDateTime?: Date | null): string | null {
    if (!startDateTime) return null;
    const now = new Date();
    // Ignore Jan 1 placeholder dates
    if (startDateTime.getUTCDate() === 1 && startDateTime.getUTCMonth() === 0) {
      return null;
    }
    if (
      startDateTime.getUTCDate() === now.getUTCDate() &&
      startDateTime.getUTCMonth() === now.getUTCMonth()
    ) {
      return ' 🎂';
    }
    return null;
  }

  /**
   * Master artist search pipeline matching fmbot SearchArtist cascade
   */
  public async searchArtist(
    searchValue: string | null | undefined,
    user: User,
    _guildId?: string | null,
    referencedMusic?: ReferencedMusic | null,
  ): Promise<ArtistSearchResult | null> {
    let searchArtist = '';
    const trimmed = (searchValue ?? '').trim();

    // 1) Referenced music fallback if reply context
    if (!trimmed && referencedMusic?.artist) {
      searchArtist = referencedMusic.artist;
    } else if (trimmed) {
      // 2) Check if input is a URL
      const fromLink = await this.resolveArtistFromLink(trimmed);
      if (fromLink) {
        searchArtist = fromLink;
      } else if (trimmed.toLowerCase() === 'random' || trimmed.toLowerCase() === 'rnd') {
        const topArtists = await this.getUserAllTimeTopArtists(user.userId, true);
        if (topArtists.length > 0) {
          const rnd = Math.floor(Math.random() * topArtists.length);
          const picked = topArtists[rnd]!;
          return {
            artistName: picked.name,
            userPlaycount: picked.playcount,
            rndPosition: rnd + 1,
            rndPlaycount: picked.playcount,
          };
        }
        const topArtistsLfm = await this.lastfmRepository.getTopArtists(user.userNameLastFm, undefined as never, 100);
        if (topArtistsLfm.length > 0) {
          const rnd = Math.floor(Math.random() * topArtistsLfm.length);
          const picked = topArtistsLfm[rnd]!;
          searchArtist = picked.name;
        }
      } else {
        searchArtist = trimmed;
      }
    } else {
      // 3) Fallback to user's currently playing or last played track
      const recent = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        user.userNameLastFm,
        1,
        1,
        undefined,
        user.sessionKey,
      );
      const latest = recent.tracks[0];
      if (!latest) {
        return null;
      }
      searchArtist = latest.artistName;
    }

    const info = await this.getArtistInfo(searchArtist, user.userNameLastFm);
    if (info) {
      return {
        artistName: info.name,
        artistUrl: info.url,
        imageUrl: info.imageUrl,
        userPlaycount: info.userPlayCount,
        globalPlaycount: info.playCount,
        globalListeners: info.listeners,
        bio: info.summary,
        tags: info.tags,
      };
    }

    // Try search fallback if exact artist info failed
    const searchResults = await this.searchArtists(searchArtist);
    if (searchResults.length > 0) {
      const fallbackName = searchResults[0]!.name;
      const fallbackInfo = await this.getArtistInfo(fallbackName, user.userNameLastFm);
      if (fallbackInfo) {
        return {
          artistName: fallbackInfo.name,
          artistUrl: fallbackInfo.url,
          imageUrl: fallbackInfo.imageUrl,
          userPlaycount: fallbackInfo.userPlayCount,
          globalPlaycount: fallbackInfo.playCount,
          globalListeners: fallbackInfo.listeners,
          bio: fallbackInfo.summary,
          tags: fallbackInfo.tags,
        };
      }
      return {
        artistName: fallbackName,
      };
    }

    return {
      artistName: searchArtist,
    };
  }
}
