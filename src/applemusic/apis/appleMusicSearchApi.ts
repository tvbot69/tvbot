import type { ITunesSearchResult } from '@applemusic/models/itunesModels';

const SEARCH_ENDPOINT = 'https://itunes.apple.com/search';

export class AppleMusicSearchApi {
  public async searchAlbums(
    albumQuery: string,
    artistName?: string,
    limit: number = 5,
  ): Promise<ITunesSearchResult[]> {
    const term = artistName ? `${albumQuery} ${artistName}` : albumQuery;
    return this.search(term, 'album', limit);
  }

  public async searchArtists(query: string, limit: number = 5): Promise<ITunesSearchResult[]> {
    return this.search(query, 'musicArtist', limit);
  }

  public async searchSongs(
    songQuery: string,
    artistName?: string,
    limit: number = 5,
  ): Promise<ITunesSearchResult[]> {
    const term = artistName ? `${songQuery} ${artistName}` : songQuery;
    return this.search(term, 'song', limit);
  }

  private async search(
    term: string,
    entity: string,
    limit: number,
  ): Promise<ITunesSearchResult[]> {
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('term', term);
    url.searchParams.set('entity', entity);
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url, {
      headers: { 'User-Agent': 'tvbot' },
    });
    if (!response.ok) {
      throw new Error(`iTunes HTTP ${response.status}`);
    }
    const json = (await response.json()) as { results?: ITunesSearchResult[] };
    return json.results ?? [];
  }
}

export const upscaleArtwork = (artworkUrl100: string, size: number = 1200): string =>
  artworkUrl100.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
