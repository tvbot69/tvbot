import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackInfo } from '@domain/models/musicInfo';
import type { TopTrack } from '@domain/models/topLists';
import { ArtworkService, isPlaceholderImageUrl } from './artworkService';
import { CacheService } from './cacheService';
import type { PrismaClient } from '@prisma/client';

const CACHE_TTL_SECONDS = 1800;

export interface TrackSearchResult {
  trackName: string;
  artistName: string;
  albumName?: string;
  trackUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  coverUrl?: string;
  trackId?: number;
  durationSeconds?: number;
  userPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  summary?: string;
  tags?: string[];
  serverPlaycount?: number;
  serverListeners?: number;
  isLoved?: boolean;
  lastMonthPlays?: number;
}

export class TrackService {
  constructor(
    private readonly lastfmRepository: ILastfmRepository,
    private readonly artistRepository: IArtistRepository,
    private readonly trackRepository: ITrackRepository,
    private readonly whoKnowsRepository: IWhoKnowsRepository,
    private readonly artworkService: ArtworkService,
    private readonly cache: CacheService,
    private readonly prisma?: PrismaClient,
  ) {}

  public async getTrackInfo(
    trackName: string,
    artistName: string,
    username?: string,
  ): Promise<TrackInfo | null> {
    const key = `track-info:${artistName.toLowerCase()}:${trackName.toLowerCase()}${
      username ? `:${username.toLowerCase()}` : ':global'
    }`;
    const cached = await this.cache.get<TrackInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getTrackInfo(trackName, artistName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchTracks(query: string): Promise<TopTrack[]> {
    return this.lastfmRepository.searchTracks(query);
  }

  public async searchTrack(
    searchValue: string | null | undefined,
    user: User,
    guildId?: string | null,
  ): Promise<TrackSearchResult | null> {
    let searchArtist = '';
    let searchTrack = '';

    const trimmed = (searchValue ?? '').trim();

    if (!trimmed) {
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
      searchTrack = latest.name;
    } else if (trimmed.toLowerCase() === 'random') {
      const topTracks = await this.lastfmRepository.getTopTracks(
        user.userNameLastFm,
        undefined as never,
        100,
      );
      if (topTracks.length === 0) {
        return null;
      }
      const picked = topTracks[Math.floor(Math.random() * topTracks.length)]!;
      searchArtist = picked.artistName;
      searchTrack = picked.name;
    } else if (trimmed.includes(' | ')) {
      const parts = trimmed.split(' | ');
      searchArtist = parts[0]!.trim();
      searchTrack = parts[1]!.trim();
    } else if (trimmed.toLowerCase().includes(' by ')) {
      const parts = trimmed.split(/ by /i);
      searchTrack = parts[0]!.trim();
      searchArtist = parts[1]!.trim();
    } else {
      const results = await this.lastfmRepository.searchTracks(trimmed);
      if (results.length > 0) {
        searchArtist = results[0]!.artistName;
        searchTrack = results[0]!.name;
      } else {
        searchArtist = 'Unknown Artist';
        searchTrack = trimmed;
      }
    }

    const info = await this.getTrackInfo(searchTrack, searchArtist, user.userNameLastFm);

    let coverUrl: string | undefined;
    const resolvedCover = await this.artworkService.getTrackCoverUrl(searchTrack, searchArtist);
    if (resolvedCover && !isPlaceholderImageUrl(resolvedCover)) {
      coverUrl = resolvedCover;
    } else if (info?.albumCoverUrl && !isPlaceholderImageUrl(info.albumCoverUrl)) {
      coverUrl = info.albumCoverUrl;
    } else if (info?.imageUrl && !isPlaceholderImageUrl(info.imageUrl)) {
      coverUrl = info.imageUrl;
    }

    let serverPlaycount: number | undefined;
    let serverListeners: number | undefined;
    let trackId: number | undefined;

    if (guildId) {
      try {
        const artist = await this.artistRepository.getArtistByName(searchArtist);
        if (artist) {
          const track = await this.trackRepository.getTrackByNameAndArtist(
            searchTrack,
            artist.artistId,
          );
          if (track) {
            trackId = track.trackId;
            const rows = await this.whoKnowsRepository.getIndexedUsersForTrack(
              guildId,
              track.trackId,
            );
            if (rows && rows.length > 0) {
              serverPlaycount = rows.reduce((acc, r) => acc + r.playcount, 0);
              serverListeners = rows.length;
            }
          }
        }
      } catch {
        // ignore server stats lookup errors
      }
    }

    const finalArtist = info?.artistName ?? searchArtist;
    const finalTrack = info?.name ?? searchTrack;

    const lastMonthPlays = await this.getLastMonthPlays(user.userId, finalTrack, finalArtist);

    return {
      trackName: finalTrack,
      artistName: finalArtist,
      albumName: info?.albumName,
      trackUrl:
        info?.url ??
        `https://www.last.fm/music/${encodeURIComponent(finalArtist)}/_/${encodeURIComponent(
          finalTrack,
        )}`,
      artistUrl: `https://www.last.fm/music/${encodeURIComponent(finalArtist)}`,
      albumUrl: info?.albumName
        ? `https://www.last.fm/music/${encodeURIComponent(finalArtist)}/${encodeURIComponent(
            info.albumName,
          )}`
        : undefined,
      coverUrl,
      trackId,
      durationSeconds: info?.durationSeconds,
      userPlaycount: info?.userPlayCount ?? 0,
      globalPlaycount: info?.playCount,
      globalListeners: info?.listeners,
      summary: info?.summary,
      tags: info?.tags,
      serverPlaycount,
      serverListeners,
      isLoved: info?.userLoved,
      lastMonthPlays,
    };
  }

  public async getLastMonthPlays(userId: number, trackName: string, artistName: string): Promise<number> {
    if (!this.prisma) return 0;
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
      const count = await this.prisma.userPlay.count({
        where: {
          userId,
          artistName: { equals: artistName, mode: 'insensitive' },
          trackName: { equals: trackName, mode: 'insensitive' },
          timePlayed: { gte: thirtyDaysAgo },
        },
      });
      return count;
    } catch {
      return 0;
    }
  }
}
