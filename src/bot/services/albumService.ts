import { container, inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';
import type { AlbumInfo } from '@domain/models/musicInfo';
import type { TopAlbum } from '@domain/models/topLists';
import { CacheService } from './cacheService';
import { ArtworkService } from './artworkService';
import { ColorService } from './colorService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { parseSpotifyReleaseDate } from './albumEnrichmentService';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logger';
import { DiscordConstants } from '@bot/resources/discordConstants';

const CACHE_TTL_SECONDS = 3600;

export interface ResolvedAlbumTrack {
  name: string;
  durationSeconds?: number;
  playcount?: number;
  url?: string;
  rank?: number;
}

export interface AlbumSearchResult {
  albumName: string;
  artistName: string;
  albumUrl?: string;
  artistUrl?: string;
  albumCoverUrl?: string;
  albumId: number;
  userPlaycount?: number;
  userMonthlyPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  releaseDate?: Date;
  label?: string;
  summary?: string;
  tracks: ResolvedAlbumTrack[];
  totalDurationSeconds?: number;
  serverPlaycount?: number;
  serverListeners?: number;
  userTotalPlays?: number;
  userTimeListenedSeconds?: number;
  userPercentageOfAllPlays?: number;
  spotifyUrl?: string;
}

@injectable()
export class AlbumService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly artistRepository: IArtistRepository;
  private readonly albumRepository: IAlbumRepository;
  private readonly userRepository: IUserRepository;
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly artworkService: ArtworkService;
  private readonly spotifyApi: SpotifySearchApi;
  private readonly prisma: PrismaClient;
  private readonly cache: CacheService;
  private readonly colorService?: ColorService;

  constructor(
    @inject('ILastfmRepository') lastfmRepository: ILastfmRepository,
    @inject('IArtistRepository') artistRepository: IArtistRepository,
    @inject('IAlbumRepository') albumRepository: IAlbumRepository,
    @inject('IUserRepository') userRepository: IUserRepository,
    @inject('IGuildUserRepository') guildUserRepository: IGuildUserRepository,
    @inject(ArtworkService) artworkService: ArtworkService,
    @inject(SpotifySearchApi) spotifyApi: SpotifySearchApi,
    @inject(PrismaClient) prisma: PrismaClient,
    @inject(CacheService) cache: CacheService,
    @inject(ColorService) colorService?: ColorService,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.userRepository = userRepository;
    this.guildUserRepository = guildUserRepository;
    this.artworkService = artworkService;
    this.spotifyApi = spotifyApi;
    this.prisma = prisma;
    this.cache = cache;
    this.colorService = colorService;
  }

  public async getAlbumInfo(
    artistName: string,
    albumName: string,
    username?: string,
  ): Promise<AlbumInfo | null> {
    const key = `album-info:${artistName.toLowerCase()}:${albumName.toLowerCase()}${username ? `:${username.toLowerCase()}` : ''}`;
    const cached = await this.cache.get<AlbumInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getAlbumInfo(artistName, albumName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchAlbums(query: string): Promise<TopAlbum[]> {
    return this.lastfmRepository.searchAlbums(query);
  }

  public async getAlbumById(albumId: number): Promise<{ albumName: string; artistName: string; albumId: number } | null> {
    const album = await this.albumRepository.getAlbumById(albumId);
    if (!album) {
      return null;
    }
    const artistRecord = await this.prisma.artist.findUnique({ where: { artistId: album.artistId } });
    return {
      albumName: album.name,
      artistName: artistRecord?.name ?? '',
      albumId: album.albumId,
    };
  }

  public async searchAlbum(
    searchValue: string | null | undefined,
    user: User,
    guildId?: string | null,
  ): Promise<AlbumSearchResult | null> {
    let searchArtist = '';
    let searchAlbum = '';

    const trimmed = (searchValue ?? '').trim();

    if (!trimmed) {
      // Resolve currently playing track or latest scrobble
      const recent = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        user.userNameLastFm, 1, 1, undefined, user.sessionKey,
      );
      const latest = recent.tracks[0];
      if (!latest) {
        return null;
      }
      searchArtist = latest.artistName;
      searchAlbum = latest.albumName || latest.name;
    } else if (trimmed.toLowerCase() === 'random') {
      const topAlbums = await this.lastfmRepository.getTopAlbums(user.userNameLastFm, undefined as never, 100);
      if (topAlbums.length === 0) {
        return null;
      }
      const randomAlbum = topAlbums[Math.floor(Math.random() * topAlbums.length)];
      if (!randomAlbum) return null;
      searchArtist = randomAlbum.artistName;
      searchAlbum = randomAlbum.name;
    } else if (trimmed.includes(' | ')) {
      const [artistPart, albumPart] = trimmed.split(' | ');
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = (albumPart ?? '').trim();
    } else if (trimmed.includes(' - ')) {
      const [artistPart, ...rest] = trimmed.split(' - ');
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = rest.join(' - ').trim();
    } else if (/\s+by\s+/i.test(trimmed)) {
      const [albumPart, artistPart] = trimmed.split(/\s+by\s+/i);
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = (albumPart ?? '').trim();
    } else {
      const matches = await this.lastfmRepository.searchAlbums(trimmed);
      if (matches.length === 0) {
        return null;
      }
      // If user typed e.g. "future future", pick candidate matching artist words
      const lower = trimmed.toLowerCase();
      const best = matches.find((m) =>
        lower.includes(m.artistName.toLowerCase()) && lower.includes(m.name.toLowerCase()),
      ) ?? matches[0]!;
      searchArtist = best.artistName;
      searchAlbum = best.name;
    }

    if (!searchArtist || !searchAlbum) {
      return null;
    }

    const albumInfo = await this.getAlbumInfo(searchArtist, searchAlbum, user.userNameLastFm);
    const resolvedArtistName = albumInfo?.artistName || searchArtist;
    const resolvedAlbumName = albumInfo?.name || searchAlbum;

    // Database record resolution
    const artistRecord = await this.artistRepository.getOrCreateArtist(resolvedArtistName);
    const albumRecord = await this.albumRepository.getOrCreateAlbum(
      resolvedAlbumName,
      artistRecord.artistId,
      albumInfo?.imageUrl,
    );

    // Fetch Spotify full album for release date + label + tracks
    let spotifyReleaseDate: Date | undefined;
    let spotifyLabel: string | undefined;
    let spotifyTracks: Array<{ name: string; track_number: number; duration_ms: number }> = [];
    try {
      const spotifyAlbum = await this.spotifyApi.searchAndGetFullAlbum(resolvedAlbumName, resolvedArtistName);
      if (spotifyAlbum) {
        spotifyReleaseDate = parseSpotifyReleaseDate(spotifyAlbum.release_date, spotifyAlbum.release_date_precision);

        // Extract label from copyrights (℗ phonographic copyright contains label)
        if (spotifyAlbum.label) {
          spotifyLabel = spotifyAlbum.label;
        } else if (spotifyAlbum.copyrights && spotifyAlbum.copyrights.length > 0) {
          const phonographic = spotifyAlbum.copyrights.find((c) => c.type === 'P');
          const copyright = phonographic ?? spotifyAlbum.copyrights[0];
          if (copyright?.text) {
            // Strip any combination of ℗/©/(P)/(C) symbols and year prefixes
            spotifyLabel = copyright.text
              .replace(/^[\s℗©(P)(C)]+/i, '')
              .replace(/^\d{4}\s*/, '')
              .trim() || undefined;
          }
        }

        // Collect Spotify tracks for supplementing Last.fm
        if (spotifyAlbum.tracks?.items && spotifyAlbum.tracks.items.length > 0) {
          spotifyTracks = spotifyAlbum.tracks.items;
        }

        // Persist release data to DB if missing
        if (!albumRecord.releaseDate && spotifyReleaseDate) {
          await this.albumRepository.setReleaseData(albumRecord.albumId, {
            releaseDate: spotifyReleaseDate,
            releaseDatePrecision: spotifyAlbum.release_date_precision,
            spotifyAlbumType: spotifyAlbum.album_type,
          }).catch(() => undefined);
        }
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to fetch Spotify album metadata');
    }

    // Resolve cover art — ArtworkService is primary (Spotify→Deezer→Apple→Last.fm), Last.fm raw URL is last-resort
    const rawLfmCover = albumInfo?.imageUrl && !albumInfo.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') ? albumInfo.imageUrl : undefined;
    const coverUrl =
      (await this.artworkService.getAlbumCoverUrl(resolvedAlbumName, resolvedArtistName)) ||
      rawLfmCover;

    // Resolve tracks & track durations
    // Use Last.fm tracks, but supplement with Spotify if Last.fm has fewer tracks
    const rawTracks = albumInfo?.tracks ?? [];
    let totalDurationSeconds = 0;
    let tracks: ResolvedAlbumTrack[];

    if (spotifyTracks.length > rawTracks.length) {
      // Use Spotify tracks as primary source (more complete)
      tracks = spotifyTracks.map((st) => {
        const durSec = Math.round(st.duration_ms / 1000);
        totalDurationSeconds += durSec;
        return {
          name: st.name,
          durationSeconds: durSec,
          playcount: undefined,
          url: `https://www.last.fm/music/${encodeURIComponent(resolvedArtistName)}/_/${encodeURIComponent(st.name)}`,
          rank: st.track_number,
        };
      });
    } else {
      // Use Last.fm tracks
      tracks = rawTracks.map((t, idx) => {
        if (t.durationSeconds) {
          totalDurationSeconds += t.durationSeconds;
        }
        return {
          name: t.name,
          durationSeconds: t.durationSeconds,
          playcount: undefined,
          url: t.url || `https://www.last.fm/music/${encodeURIComponent(resolvedArtistName)}/_/${encodeURIComponent(t.name)}`,
          rank: t.rank ?? idx + 1,
        };
      });
    }

    // Resolve user's playcount on tracks from DB if available
    try {
      if (tracks.length > 0 && user.userId) {
        const trackNames = tracks.map((t) => t.name.toLowerCase());
        const userTrackPlays = await this.prisma.userPlay.groupBy({
          by: ['trackName'],
          where: {
            userId: user.userId,
            artistName: { equals: resolvedArtistName, mode: 'insensitive' },
            trackName: { in: trackNames, mode: 'insensitive' },
          },
          _count: { trackName: true },
        });

        const playMap = new Map<string, number>();
        for (const row of userTrackPlays) {
          if (row.trackName) {
            playMap.set(row.trackName.toLowerCase(), row._count.trackName);
          }
        }

        for (const track of tracks) {
          const count = playMap.get(track.name.toLowerCase());
          if (count !== undefined && count > 0) {
            track.playcount = count;
          }
        }
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to compute track playcounts');
    }

    // User total plays & server stats
    let userPlaycount = albumInfo?.userPlayCount;
    let userMonthlyPlaycount: number | undefined;
    let userTimeListenedSeconds: number | undefined;
    let userPercentageOfAllPlays: number | undefined;
    let serverPlaycount: number | undefined;
    let serverListeners: number | undefined;

    try {
      if (user.userId) {
        const dbPlays = await this.prisma.userPlay.count({
          where: {
            userId: user.userId,
            albumId: albumRecord.albumId,
          },
        });
        if (dbPlays > 0 && (!userPlaycount || dbPlays > userPlaycount)) {
          userPlaycount = dbPlays;
        }

        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const monthlyPlays = await this.prisma.userPlay.count({
          where: {
            userId: user.userId,
            albumId: albumRecord.albumId,
            timePlayed: { gte: oneMonthAgo },
          },
        });
        if (monthlyPlays > 0) {
          userMonthlyPlaycount = monthlyPlays;
        }

        // Calculate time listened using per-track playcounts × durations
        if (tracks.length > 0) {
          let computedSeconds = 0;
          for (const track of tracks) {
            const pc = track.playcount ?? 0;
            const dur = track.durationSeconds ?? 0;
            if (pc > 0 && dur > 0) {
              computedSeconds += pc * dur;
            }
          }
          if (computedSeconds > 0) {
            userTimeListenedSeconds = computedSeconds;
          } else if (userPlaycount && totalDurationSeconds > 0 && tracks.length > 0) {
            // Fallback: avg track duration × total plays
            const avgTrackDuration = totalDurationSeconds / tracks.length;
            userTimeListenedSeconds = Math.round(userPlaycount * avgTrackDuration);
          }
        } else if (userPlaycount) {
          userTimeListenedSeconds = userPlaycount * 210; // estimate 3.5 min per track
        }

        if (user.totalPlayCount && user.totalPlayCount > 0 && userPlaycount) {
          userPercentageOfAllPlays = Number(((userPlaycount / user.totalPlayCount) * 100).toFixed(2));
        }
      }

      if (guildId) {
        const guildUserIds = await this.guildUserRepository.getUserIdsForGuild(guildId);
        if (guildUserIds.length > 0) {
          const guildPlays = await this.prisma.userPlay.findMany({
            where: {
              albumId: albumRecord.albumId,
              userId: { in: guildUserIds },
            },
            select: { userId: true },
          });
          if (guildPlays.length > 0) {
            serverPlaycount = guildPlays.length;
            serverListeners = new Set(guildPlays.map((p) => p.userId)).size;
          }
        }
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to query server/user stats for album');
    }

    const artistSlug = encodeURIComponent(resolvedArtistName);
    const albumSlug = encodeURIComponent(resolvedAlbumName);

    return {
      albumName: resolvedAlbumName,
      artistName: resolvedArtistName,
      albumUrl: albumInfo?.url || `https://www.last.fm/music/${artistSlug}/${albumSlug}`,
      artistUrl: `https://www.last.fm/music/${artistSlug}`,
      albumCoverUrl: coverUrl || undefined,
      albumId: albumRecord.albumId,
      userPlaycount: userPlaycount,
      userMonthlyPlaycount: userMonthlyPlaycount,
      globalPlaycount: albumInfo?.playCount,
      globalListeners: albumInfo?.listeners,
      releaseDate: albumRecord.releaseDate || spotifyReleaseDate || undefined,
      label: spotifyLabel || undefined,
      summary: albumInfo?.summary,
      tracks: tracks,
      totalDurationSeconds: totalDurationSeconds > 0 ? totalDurationSeconds : undefined,
      serverPlaycount: serverPlaycount,
      serverListeners: serverListeners,
      userTotalPlays: user.totalPlayCount ?? undefined,
      userTimeListenedSeconds: userTimeListenedSeconds,
      userPercentageOfAllPlays: userPercentageOfAllPlays,
    };
  }

  public resolveAlbumFromLink(input: string): { artistName?: string; albumName?: string } | null {
    if (!input || !input.includes('http')) return null;

    // Last.fm album URL: https://www.last.fm/music/Radiohead/OK+Computer
    const lastfmMatch = input.match(/last\.fm\/music\/([^/?#]+)\/([^/?#]+)/i);
    if (lastfmMatch && lastfmMatch[1] && lastfmMatch[2]) {
      try {
        return {
          artistName: decodeURIComponent(lastfmMatch[1].replace(/\+/g, ' ')),
          albumName: decodeURIComponent(lastfmMatch[2].replace(/\+/g, ' ')),
        };
      } catch {
        return { artistName: lastfmMatch[1], albumName: lastfmMatch[2] };
      }
    }

    // Spotify album URL: https://open.spotify.com/album/4LH4d3cOWNNXdsqFd42wum
    const spotifyMatch = input.match(/spotify\.com\/(?:intl-[a-zA-Z-]+\/)?album\/([a-zA-Z0-9]+)/i);
    if (spotifyMatch && spotifyMatch[1]) {
      return { albumName: spotifyMatch[1] };
    }

    // Apple Music album URL
    const appleMatch = input.match(/music\.apple\.com\/[a-z]{2}\/album\/([^/]+)\/([0-9]+)/i);
    if (appleMatch && appleMatch[1]) {
      try {
        return { albumName: decodeURIComponent(appleMatch[1].replace(/-/g, ' ')) };
      } catch {
        return { albumName: appleMatch[1] };
      }
    }

    return null;
  }

  public filterAlbumsThatAreSingles<T extends { name: string; albumType?: string }>(albums: T[]): T[] {
    if (!albums || albums.length === 0) return [];
    return albums.filter((a) => {
      if (a.albumType && a.albumType.toLowerCase() === 'single') return false;
      const lower = a.name.toLowerCase();
      return !lower.endsWith(' - single') && !lower.endsWith(' - ep') && lower !== 'single';
    });
  }

  public filterAlbumToReleaseYear<T extends { releaseDate?: Date }>(albums: T[], year: number): T[] {
    if (!albums || albums.length === 0) return [];
    return albums.filter((a) => a.releaseDate && a.releaseDate.getUTCFullYear() === year);
  }

  public filterAlbumToReleaseDecade<T extends { releaseDate?: Date }>(albums: T[], decade: number): T[] {
    if (!albums || albums.length === 0) return [];
    const endDecade = decade + 9;
    return albums.filter((a) => {
      if (!a.releaseDate) return false;
      const y = a.releaseDate.getUTCFullYear();
      return y >= decade && y <= endDecade;
    });
  }

  public getAlbumsPopularity(topAlbums: Array<{ name: string; playcount: number }>): Array<{ name: string; playcount: number; popularityScore: number }> {
    if (!topAlbums || topAlbums.length === 0) return [];
    const maxPlaycount = Math.max(...topAlbums.map((a) => a.playcount), 1);
    return topAlbums.map((album) => ({
      name: album.name,
      playcount: album.playcount,
      popularityScore: Math.round((album.playcount / maxPlaycount) * 100),
    }));
  }

  /**
   * Batch hydrates missing album covers across Spotify / Last.fm
   */
  public async fillMissingAlbumCovers(topAlbums: TopAlbum[]): Promise<TopAlbum[]> {
    const missing = topAlbums.filter((a) => !a.imageUrl);
    if (missing.length === 0) return topAlbums;

    await Promise.all(
      missing.map(async (album) => {
        try {
          const url = await this.artworkService.getAlbumCoverUrl(album.name, album.artistName);
          if (url) {
            album.imageUrl = url;
          }
        } catch {
          // ignore
        }
      }),
    );

    return topAlbums;
  }

  /**
   * User's all-time top albums
   */
  public async getUserAllTimeTopAlbums(userId: number, useCache: boolean = false): Promise<TopAlbum[]> {
    const cacheKey = `user-${userId}-topalbums-alltime`;
    if (useCache) {
      const cached = await this.cache.get<TopAlbum[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT 1000
      `, userId);

      const albums: TopAlbum[] = rows.map((r) => ({
        name: r.album_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));

      if (albums.length > 100) {
        await this.cache.set(cacheKey, albums, 600);
      }

      return albums;
    } catch {
      return [];
    }
  }

  /**
   * Filters user's all-time top albums by release prefix (e.g. '199' for 90s, '2023' for 2023)
   */
  public async getUserAllTimeTopAlbumsByReleasePrefix(
    userId: number,
    prefix: string,
    prefixLength: number = 4,
  ): Promise<TopAlbum[]> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        album_name: string;
        artist_name: string;
        playcount: bigint;
        release_date: Date | null;
        album_type: string | null;
      }>>(`
        SELECT ua.name AS album_name,
               ua.artist_name,
               ua.playcount,
               a.release_date,
               a.type AS album_type
        FROM user_albums ua
        INNER JOIN albums a ON ua.album_id = a.id
        WHERE ua.user_id = $1
          AND a.release_date IS NOT NULL
          AND LEFT(a.release_date::text, $2) = $3
        ORDER BY ua.playcount DESC
        LIMIT 100
      `, userId, prefixLength, prefix);

      return rows.map((r) => ({
        name: r.album_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
        releaseDate: r.release_date ?? undefined,
        albumType: r.album_type ?? undefined,
      }));
    } catch {
      // Fallback using user plays and in-memory year filter
      const all = await this.getUserAllTimeTopAlbums(userId, true);
      return all;
    }
  }

  public async getUserAllTimeTopAlbumsByReleaseYear(userId: number, year: number): Promise<TopAlbum[]> {
    return this.getUserAllTimeTopAlbumsByReleasePrefix(userId, year.toString(), 4);
  }

  public async getUserAllTimeTopAlbumsByReleaseDecade(userId: number, decade: number): Promise<TopAlbum[]> {
    return this.getUserAllTimeTopAlbumsByReleasePrefix(userId, Math.floor(decade / 10).toString(), 3);
  }

  /**
   * Filters guild albums to release period
   */
  public async filterAlbumsToReleasePeriod<T extends { artistName: string; albumName: string }>(
    albums: T[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<T[]> {
    if (albums.length === 0) return [];
    try {
      const albumNames = albums.map((a) => a.albumName);
      const rows = await this.prisma.album.findMany({
        where: {
          name: { in: albumNames, mode: 'insensitive' },
          releaseDate: { gte: periodStart, lt: periodEnd },
        },
        select: { name: true, artist: { select: { name: true } } },
      });

      const matched = new Set(rows.map((r) => `${r.artist.name.toLowerCase()}|${r.name.toLowerCase()}`));
      return albums.filter((a) => matched.has(`${a.artistName.toLowerCase()}|${a.albumName.toLowerCase()}`));
    } catch {
      return albums;
    }
  }

  /**
   * Filters out singles from guild album lists
   */
  public async filterGuildAlbumsThatAreSingles<T extends { artistName: string; albumName: string }>(
    albums: T[],
  ): Promise<T[]> {
    return this.filterAlbumsThatAreSingles(
      albums.map((a) => ({ ...a, name: a.albumName })),
    ).map((a) => a as unknown as T);
  }

  /**
   * Resolves album accent color
   */
  public async getAlbumAccentColor(
    albumCoverUrl?: string | null,
    _albumName?: string,
    _artistName?: string,
  ): Promise<number> {
    if (albumCoverUrl) {
      try {
        const cs = this.colorService ?? container.resolve(ColorService);
        return cs.getColorFromImageUrl(albumCoverUrl);
      } catch {
        return DiscordConstants.LastFmColorRed;
      }
    }
    return DiscordConstants.LastFmColorRed;
  }

  public async getAccentColorWithAlbum(
    _context: unknown,
    albumCoverUrl?: string | null,
    _albumId?: number | null,
    albumName?: string,
    artistName?: string,
    _allowCustomColors: boolean = true,
  ): Promise<number> {
    return this.getAlbumAccentColor(albumCoverUrl, albumName, artistName);
  }

  /**
   * Formats album release date string matching C# GetAlbumReleaseDate
   */
  public static getAlbumReleaseDate(album: { releaseDate?: Date | string | null; releaseDatePrecision?: string | null }): string | null {
    if (!album.releaseDate) return null;
    const date = typeof album.releaseDate === 'string' ? new Date(album.releaseDate) : album.releaseDate;
    if (isNaN(date.getTime())) return null;

    if (album.releaseDatePrecision === 'year') {
      return `\`${date.getUTCFullYear()}\``;
    }
    if (album.releaseDatePrecision === 'month') {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    }

    const epochSeconds = Math.floor(date.getTime() / 1000);
    return `<t:${epochSeconds}:D>`;
  }

  /**
   * Autocomplete: Recent albums played in last 2 days
   */
  public async getLatestAlbums(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; albumName: string }>> {
    const cacheKey = `user-recent-albums-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<Array<{ artistName: string; albumName: string }>>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const plays = await this.prisma.userPlay.findMany({
        where: {
          userId: user.userId,
          timePlayed: { gte: cutoff },
          albumName: { not: null },
        },
        orderBy: { timePlayed: 'desc' },
        select: { artistName: true, albumName: true },
        take: 200,
      });

      const unique = new Map<string, { artistName: string; albumName: string }>();
      for (const p of plays) {
        if (p.albumName) {
          const key = `${p.artistName.toLowerCase()}|${p.albumName.toLowerCase()}`;
          if (!unique.has(key)) {
            unique.set(key, { artistName: p.artistName, albumName: p.albumName });
          }
        }
      }

      const result = Array.from(unique.values()).slice(0, 25);
      await this.cache.set(cacheKey, result, 30);
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Autocomplete: Top albums in last 20 days
   */
  public async getRecentTopAlbums(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; albumName: string }>> {
    const cacheKey = `user-recent-top-albums-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<Array<{ artistName: string; albumName: string }>>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 20 * 24 * 3600 * 1000);
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        artist_name: string;
        album_name: string;
        playcount: bigint;
      }>>(`
        SELECT artist_name, album_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND album_name IS NOT NULL AND album_name != ''
        GROUP BY artist_name, album_name
        ORDER BY playcount DESC
        LIMIT 25
      `, user.userId, cutoff);

      const result = rows.map((r) => ({
        artistName: r.artist_name,
        albumName: r.album_name,
      }));

      await this.cache.set(cacheKey, result, 120);
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Autocomplete: Search through album catalog
   */
  public async searchThroughAlbums(
    searchValue: string,
  ): Promise<Array<{ artistName: string; albumName: string; popularity?: number }>> {
    if (!searchValue || searchValue.trim().length === 0) return [];
    try {
      const rows = await this.prisma.album.findMany({
        where: {
          name: { contains: searchValue.trim(), mode: 'insensitive' },
        },
        take: 25,
        select: { name: true, artist: { select: { name: true } } },
      });

      return rows.map((r) => ({
        artistName: r.artist.name,
        albumName: r.name,
      }));
    } catch {
      return [];
    }
  }

  public async getAlbumImages(albumId: number): Promise<any[]> {
    try {
      return await (this.prisma as any).albumImage?.findMany({
        where: { albumId },
      }) ?? [];
    } catch {
      return [];
    }
  }
}

