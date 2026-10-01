import type {
  DeezerAlbum,
  DeezerArtist,
  DeezerPlaylist,
  DeezerTrack,
} from '@deezer/models/deezerModels';
import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';

const API_BASE = 'https://api.deezer.com';
const DEEZER_TIMEOUT_MS = 8000;

export class DeezerApi {
  public async searchArtists(query: string, limit: number = 5): Promise<DeezerArtist[]> {
    const json = await this.get<{ data?: DeezerArtist[] }>(
      `/search/artist?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return json.data ?? [];
  }

  public async searchAlbums(query: string, limit: number = 5): Promise<DeezerAlbum[]> {
    const json = await this.get<{ data?: DeezerAlbum[] }>(
      `/search/album?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return json.data ?? [];
  }

  public async searchTracks(query: string, limit: number = 5): Promise<DeezerTrack[]> {
    const json = await this.get<{ data?: DeezerTrack[] }>(
      `/search/track?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return json.data ?? [];
  }

  public async getArtist(artistId: number): Promise<DeezerArtist | null> {
    return this.get<DeezerArtist>(`/artist/${artistId}`);
  }

  /**
   * Link-resolution endpoints (nullable — a bad/missing ID is an expected
   * miss, not an exception). Search endpoints above keep their throwing
   * contract; these are used by the music link resolver.
   */
  public async getTrack(trackId: string): Promise<DeezerTrack | null> {
    return this.getNullable<DeezerTrack>(`/track/${encodeURIComponent(trackId)}`);
  }

  public async getTrackByIsrc(isrc: string): Promise<DeezerTrack | null> {
    return this.getNullable<DeezerTrack>(`/track/isrc:${encodeURIComponent(isrc)}`);
  }

  public async getAlbumById(albumId: string): Promise<DeezerAlbum | null> {
    return this.getNullable<DeezerAlbum>(`/album/${encodeURIComponent(albumId)}`);
  }

  /**
   * Follows Deezer's `next` cursor. Deezer caps `limit` at 100 and ignores
   * anything larger, so asking for 10000 returned exactly 100 and a 2000-track
   * playlist was silently truncated to its first page — with a "25 tracks
   * added" style reply and no partial flag. Bounded so a pathological cursor
   * chain cannot loop forever.
   */
  private async collectPages(
    firstPath: string,
    maxItems: number,
    maxPages: number,
  ): Promise<DeezerTrack[]> {
    const out: DeezerTrack[] = [];
    let path: string | null = firstPath;
    for (let page = 0; page < maxPages && path && out.length < maxItems; page++) {
      const body: { data?: DeezerTrack[]; next?: string | null } | null = await this.getNullable(path);
      const data = body?.data ?? [];
      out.push(...data);
      path = body?.next ?? null;
    }
    return out.slice(0, maxItems);
  }

  public async getAlbumTracks(albumId: string): Promise<DeezerTrack[]> {
    return this.collectPages(`/album/${encodeURIComponent(albumId)}/tracks?limit=100`, 5000, 60);
  }

  public async getPlaylistById(playlistId: string): Promise<DeezerPlaylist | null> {
    return this.getNullable<DeezerPlaylist>(`/playlist/${encodeURIComponent(playlistId)}`);
  }

  public async getPlaylistTracks(playlistId: string): Promise<DeezerTrack[]> {
    return this.collectPages(`/playlist/${encodeURIComponent(playlistId)}/tracks?limit=100`, 5000, 60);
  }

  public async getArtistTop(artistId: string): Promise<DeezerTrack[]> {
    const page = await this.getNullable<{ data?: DeezerTrack[] }>(
      `/artist/${encodeURIComponent(artistId)}/top?limit=50`,
    );
    return page?.data ?? [];
  }

  private async getNullable<T>(pathOrUrl: string): Promise<T | null> {
    try {
      const response = await fetchWithTimeout(DeezerApi.toRequestUrl(pathOrUrl), {}, DEEZER_TIMEOUT_MS);
      if (!response.ok) {
        // Deezer answers 800s for unknown IDs — an expected miss.
        Logger.debug({ status: response.status, path: pathOrUrl }, '[Deezer] Lookup miss');
        return null;
      }
      const json = (await response.json()) as (T & { error?: unknown }) | null;
      if (!json || (json as { error?: unknown }).error) return null;
      return json;
    } catch (err) {
      Logger.debug({ err, path: pathOrUrl }, '[Deezer] Lookup exception');
      return null;
    }
  }

  /**
   * Accept either a path (`/album/1/tracks`) or an absolute URL, and return the
   * URL to actually fetch.
   *
   * Deezer's `next` cursor is an ABSOLUTE url — measured live:
   * `https://api.deezer.com/playlist/914651125/tracks?limit=100&index=100`. The
   * old `getNullable` blindly prefixed `API_BASE`, producing
   * `https://api.deezer.comhttps://api.deezer.com/...`, which is an unresolvable
   * host. The request failed, the catch returned null, and pagination stopped
   * after page one: a 347-track playlist came back as 100 tracks with no
   * partial flag, which is a confident wrong answer rather than an absence.
   *
   * The liveShape fixture already asserted `next` matches
   * `^https://api\.deezer\.com/` — the test documented the bug and the bug
   * shipped anyway, because the fixture tested the *shape* of the cursor and
   * nothing tested following it.
   *
   * Absolute URLs from the vendor are honoured rather than re-based, because
   * Deezer is entitled to move the API host and the cursor is authoritative.
   */
  private static toRequestUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${API_BASE}${pathOrUrl}`;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetchWithTimeout(DeezerApi.toRequestUrl(path), {}, DEEZER_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Deezer HTTP ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }
}
