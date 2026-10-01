import type { TopAlbum } from '@domain/models/topLists';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { CacheService } from '@bot/services/system/cacheService';

const ENRICH_CONCURRENCY = 6;

/**
 * "This run never learned whether the album has a release date", cached briefly.
 *
 * Distinct from `{}`, which is a DEFINITIVE no-match from a provider that
 * answered and found nothing. Without this marker a Spotify outage re-queried
 * the whole album list on every single chart render, and a year-filtered chart
 * then dropped every album it could not date — a full grid quietly emptying
 * because a provider was down, with no marker of why. Same three-way shape as
 * the artwork ladder: `data` (found), `{}` (answered, nothing there), this
 * (never got an answer, so do not remember it for long).
 */
const INCONCLUSIVE = 'inconclusive';
const INCONCLUSIVE_TTL_SECONDS = 90;

/**
 * One key, built one way, for the writer and both readers. The throw handler in
 * `enrichTopAlbums` has to land on exactly the key `enrichSingle` reads, and two
 * template literals differing by a space would make the marker invisible: the
 * album would be marked inconclusive and then queried anyway.
 */
const albumEnrichKey = (artistName: string, albumName: string): string =>
  `album-enrich:${artistName.toLowerCase()}|${albumName.toLowerCase()}`;

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
            // Swallowing is right for the BATCH — one bad album must not blank a
            // whole chart — but it used to leave no trace at all, so the next
            // render re-queried the entire album list through a still-broken
            // provider. The marker is what stops that. The throw itself is a
            // provider or cache failure and not a fact about the album, so it is
            // remembered as INCONCLUSIVE rather than as the `{}` no-match.
            // Cache writes must not be able to break the loop, so a cache that is
            // down just means no marker this time round.
            await this.cache
              .set(albumEnrichKey(album.artistName, album.name), INCONCLUSIVE, INCONCLUSIVE_TTL_SECONDS)
              .catch(() => undefined);
            continue;
          }
        }
      },
    );

    await Promise.all(workers);
  }

  private async enrichSingle(albumName: string, artistName: string): Promise<EnrichmentData | null> {
    const key = albumEnrichKey(artistName, albumName);
    const cached = await this.cache.get<EnrichmentData | string>(key);
    if (cached === INCONCLUSIVE) {
      // A previous run never got an answer. Serve nothing and, crucially, do not
      // ask again: the marker is the whole point.
      return null;
    }
    if (cached && typeof cached !== 'string') {
      // `{}` in here is the definitive no-match marker, not enrichment data.
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
