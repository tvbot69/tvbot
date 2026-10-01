import type { ITunesSearchResult } from '@applemusic/models/itunesModels';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';

const SEARCH_ENDPOINT = 'https://itunes.apple.com/search';
const ITUNES_TIMEOUT_MS = 8000;

/**
 * A read of the iTunes Search API that could not be completed.
 *
 * A class rather than a bare `Error` because the CALLER has to be able to tell
 * "Apple could not be asked" from "Apple has nothing" - the same distinction
 * `SpotifyUnavailableError` carries for the Spotify rung and `LastfmApiError`
 * for Last.fm. A 503 that arrives as `null` is the failure mode this bot cares
 * about most: the user is told a song is not on the service when the truth is
 * that nobody checked.
 */
export class ITunesUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`iTunes HTTP ${status}`);
    this.name = 'ITunesUnavailableError';
  }
}

export class AppleMusicSearchApi {
  public async searchAlbums(
    albumQuery: string,
    artistName?: string,
    limit: number = 5,
  ): Promise<ITunesSearchResult[]> {
    const term = artistName ? `${albumQuery} ${artistName}` : albumQuery;
    return this.search(term, 'album', limit);
  }

  public async searchSongs(
    songQuery: string,
    artistName?: string,
    limit: number = 5,
  ): Promise<ITunesSearchResult[]> {
    const term = artistName ? `${songQuery} ${artistName}` : songQuery;
    return this.search(term, 'song', limit);
  }

  /**
   * `musicArtist`, the third entity the link commands ask for.
   *
   * Lives here rather than in a second hand-rolled client so there is ONE
   * iTunes Search request in the bot and one place that knows how to tell a
   * failed read from an empty one.
   */
  public async searchArtists(
    artistQuery: string,
    limit: number = 5,
  ): Promise<ITunesSearchResult[]> {
    return this.search(artistQuery, 'musicArtist', limit);
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

    const response = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'tvbot' } },
      ITUNES_TIMEOUT_MS,
    );
    if (!response.ok) {
      // Status BEFORE body, always: an HTML error page read as JSON turns an
      // outage into "unparseable response" and destroys the status code that
      // was the only evidence of what went wrong.
      throw new ITunesUnavailableError(response.status);
    }
    const json = (await response.json()) as { results?: ITunesSearchResult[] };
    return json.results ?? [];
  }
}

export const upscaleArtwork = (artworkUrl100: string, size: number = 1200): string =>
  artworkUrl100.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
