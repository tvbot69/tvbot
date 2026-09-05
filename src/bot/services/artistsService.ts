import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import type { TopArtist } from '@domain/models/topLists';
import type { User } from '@domain/interfaces/iuserRepository';
import { CacheService } from './cacheService';

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
}

export class ArtistsService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly cache: CacheService;

  constructor(
    lastfmRepository: ILastfmRepository,
    cache: CacheService,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.cache = cache;
  }

  public async getArtistInfo(
    artistName: string,
    username?: string,
  ): Promise<ArtistInfo | null> {
    const key = `artist-info:${artistName.toLowerCase()}`;
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

  public async searchArtist(
    searchValue: string | null | undefined,
    user: User,
    _guildId?: string | null,
  ): Promise<ArtistSearchResult | null> {
    let searchArtist = '';
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
    } else if (trimmed.toLowerCase() === 'random' || trimmed.toLowerCase() === 'rnd') {
      const topArtists = await this.lastfmRepository.getTopArtists(
        user.userNameLastFm,
        undefined as never,
        100,
      );
      if (topArtists.length === 0) {
        return null;
      }
      const picked = topArtists[Math.floor(Math.random() * topArtists.length)]!;
      searchArtist = picked.name;
    } else {
      searchArtist = trimmed;
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

