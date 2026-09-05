import { CacheService } from './cacheService';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

export class GenreService {
  private readonly cache: CacheService;
  private readonly artistGenreRepo: ArtistGenreRepository;
  private readonly artistRepo: ArtistRepository;
  private readonly lastfmRepo: ILastfmRepository;

  constructor(cache: CacheService, artistGenreRepo: ArtistGenreRepository, artistRepo: ArtistRepository, lastfmRepo: ILastfmRepository) {
    this.cache = cache; this.artistGenreRepo = artistGenreRepo; this.artistRepo = artistRepo; this.lastfmRepo = lastfmRepo;
  }

  public static genresToString(genres: string[]): string {
    return genres.join(' · ');
  }

  async getGenresForArtist(artistName: string): Promise<string[]> {
    const key = `genres:${artistName.toLowerCase()}`;
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
      const info = await this.lastfmRepo.getArtistInfo(artistName);
      const tags = info?.tags ?? [];
      const top = tags.slice(0, 4).map(t => String(t).toLowerCase().trim()).filter(Boolean);
      if (top.length) {
        const artist = await this.artistRepo.getOrCreateArtist(artistName);
        await this.artistGenreRepo.setForArtistId(artist.artistId, top);
        await this.cache.set(key, top, 3600);
        return top;
      }
    } catch { /* ignore */ }

    await this.cache.set(key, [], 600);
    return [];
  }

  async getGenresForArtistNames(artistNames: string[]): Promise<Map<string, string[]>> {
    return this.artistGenreRepo.getForArtistNames(artistNames);
  }
}
