import type { TopAlbum } from '@domain/models/topLists';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { CacheService } from './cacheService';

const ENRICH_CONCURRENCY = 6;

interface EnrichmentData {
  releaseDate?: Date;
  releaseDatePrecision?: string;
  albumType?: string;
}

export const parseSpotifyReleaseDate = (
  value?: string,
  precision?: string,
): Date | undefined => {
  if (!value) {
    return undefined;
  }
  const parts = value.split('-').map((p) => Number(p));
  const year = parts[0];
  if (!year || Number.isNaN(year)) {
    return undefined;
  }
  const month = precision === 'month' || precision === 'day' ? (parts[1] ?? 1) : 1;
  const day = precision === 'day' ? (parts[2] ?? 1) : 1;
  return new Date(Date.UTC(year, month - 1, day));
};

export class AlbumEnrichmentService {
  private readonly spotifyApi: SpotifySearchApi;
  private readonly artistRepository: ArtistRepository;
  private readonly albumRepository: AlbumRepository;
  private readonly cache: CacheService;

  constructor(
    spotifyApi: SpotifySearchApi,
    artistRepository: ArtistRepository,
    albumRepository: AlbumRepository,
    cache: CacheService,
  ) {
    this.spotifyApi = spotifyApi;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.cache = cache;
  }

  public async enrichTopAlbums(albums: TopAlbum[]): Promise<void> {
    const toEnrich = albums.filter((a) => !a.releaseDate || !a.albumType);
    if (toEnrich.length === 0) {
      return;
    }

    let index = 0;
    const workers = Array.from(
      { length: Math.min(ENRICH_CONCURRENCY, toEnrich.length) },
      async () => {
        while (index < toEnrich.length) {
          const album = toEnrich[index++]!;
          try {
            const data = await this.enrichSingle(album.name, album.artistName);
            if (data) {
              album.releaseDate = data.releaseDate;
              album.releaseDatePrecision = data.releaseDatePrecision;
              album.albumType = data.albumType;
            }
          } catch {
            continue;
          }
        }
      },
    );

    await Promise.all(workers);
  }

  private async enrichSingle(albumName: string, artistName: string): Promise<EnrichmentData | null> {
    const key = `album-enrich:${artistName.toLowerCase()}|${albumName.toLowerCase()}`;
    const cached = await this.cache.get<EnrichmentData>(key);
    if (cached) {
      return cached.releaseDate || cached.albumType ? cached : null;
    }

    const results = await this.spotifyApi.searchAlbums(`${albumName} ${artistName}`);
    const match =
      results.find(
        (r) => r.name.toLowerCase() === albumName.toLowerCase(),
      ) ?? results[0];

    if (!match) {
      await this.cache.set(key, {}, 86400);
      return null;
    }

    const data: EnrichmentData = {
      releaseDate: parseSpotifyReleaseDate(match.release_date, match.release_date_precision),
      releaseDatePrecision: match.release_date_precision,
      albumType: match.album_type,
    };

    await this.cache.set(key, data, 7 * 86400);

    try {
      const artist = await this.artistRepository.getArtistByName(artistName);
      if (artist) {
        const albumRow = await this.albumRepository.getAlbumByNameAndArtist(albumName, artist.artistId);
        if (albumRow && !albumRow.releaseDate) {
          await this.albumRepository.setReleaseData(albumRow.albumId, data);
        }
      }
    } catch {
      return data;
    }

    return data;
  }
}
