import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import type { TopArtist } from '@domain/models/topLists';
import { CacheService } from './cacheService';

const CACHE_TTL_SECONDS = 3600;

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
}
