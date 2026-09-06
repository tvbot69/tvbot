import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';
import type { AlbumInfo } from '@domain/models/musicInfo';
import type { TopAlbum } from '@domain/models/topLists';
import { CacheService } from './cacheService';
import { ArtworkService } from './artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { parseSpotifyReleaseDate } from './albumEnrichmentService';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logger';

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
}

