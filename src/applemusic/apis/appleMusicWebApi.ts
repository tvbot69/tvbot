import { AppleMusicTokenScraper } from './appleMusicTokenScraper';
import type {
  AmAlbumAttributes,
  AmArtistAttributes,
  AmSongAttributes,
  AmSearchResponse,
} from '@applemusic/models/amModels';

const AMP_API_BASE = 'https://amp-api.music.apple.com/v1/catalog/us/search';

export interface AmResolvedArtwork {
  url: string;
  width: number;
  height: number;
}

export const renderAmArtwork = (
  template: string,
  width: number,
  height: number,
): string => template.replaceAll('{w}', String(width)).replaceAll('{h}', String(height));

export class AppleMusicWebApi {
  private readonly tokenScraper: AppleMusicTokenScraper;

  constructor(tokenScraper: AppleMusicTokenScraper) {
    this.tokenScraper = tokenScraper;
  }

  public async searchAlbums(
    albumQuery: string,
    artistName?: string,
    limit: number = 3,
    artworkSize: number = 3000,
  ): Promise<Array<{ name: string; artistName: string; url?: string; artwork?: AmResolvedArtwork }>> {
    const term = artistName ? `${albumQuery} ${artistName}` : albumQuery;
    const response = await this.search(term, 'albums', limit);
    return (response.results?.albums?.data ?? []).map((d) => {
      const attrs = d.attributes as AmAlbumAttributes | undefined;
      return {
        name: attrs?.name ?? '',
        artistName: attrs?.artistName ?? '',
        url: attrs?.url,
        artwork: this.resolveArtwork(attrs?.artwork, artworkSize),
      };
    });
  }

  public async searchArtists(
    query: string,
    limit: number = 3,
    artworkSize: number = 3000,
  ): Promise<Array<{ name: string; url?: string; artwork?: AmResolvedArtwork }>> {
    const response = await this.search(query, 'artists', limit);
    return (response.results?.artists?.data ?? []).map((d) => {
      const attrs = d.attributes as AmArtistAttributes | undefined;
      return {
        name: attrs?.name ?? '',
        url: attrs?.url,
        artwork: this.resolveArtwork(attrs?.artwork, artworkSize),
      };
    });
  }

  public async searchSongs(
    songQuery: string,
    artistName?: string,
    limit: number = 3,
    artworkSize: number = 3000,
  ): Promise<Array<{ name: string; artistName: string; artwork?: AmResolvedArtwork }>> {
    const term = artistName ? `${songQuery} ${artistName}` : songQuery;
    const response = await this.search(term, 'songs', limit);
    return (response.results?.songs?.data ?? []).map((d) => {
      const attrs = d.attributes as AmSongAttributes | undefined;
      return {
        name: attrs?.name ?? '',
        artistName: attrs?.artistName ?? '',
        artwork: this.resolveArtwork(attrs?.artwork, artworkSize),
      };
    });
  }

  private resolveArtwork(
    artwork: { url: string; width?: number; height?: number } | undefined,
    requestedSize: number,
  ): AmResolvedArtwork | undefined {
    if (!artwork?.url) {
      return undefined;
    }
    const width = Math.min(artwork.width ?? requestedSize, requestedSize);
    const height = Math.min(artwork.height ?? requestedSize, requestedSize);
    return { url: renderAmArtwork(artwork.url, width, height), width: width, height: height };
  }

  private async search(term: string, types: string, limit: number): Promise<AmSearchResponse> {
    const token = await this.tokenScraper.getToken();
    if (!token) {
      throw new Error('Apple Music web token unavailable');
    }

    const url = new URL(AMP_API_BASE);
    url.searchParams.set('term', term);
    url.searchParams.set('types', types);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('l', 'en-us');

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://music.apple.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.tokenScraper.invalidate();
      }
      throw new Error(`Apple Music web API HTTP ${response.status}`);
    }

    return (await response.json()) as AmSearchResponse;
  }
}
