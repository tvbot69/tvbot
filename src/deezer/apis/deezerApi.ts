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

  public async getAlbumTracks(albumId: string): Promise<DeezerTrack[]> {
    const page = await this.getNullable<{ data?: DeezerTrack[] }>(
      `/album/${encodeURIComponent(albumId)}/tracks?limit=10000`,
    );
    return page?.data ?? [];
  }

  public async getPlaylistById(playlistId: string): Promise<DeezerPlaylist | null> {
    return this.getNullable<DeezerPlaylist>(`/playlist/${encodeURIComponent(playlistId)}`);
  }

  public async getPlaylistTracks(playlistId: string): Promise<DeezerTrack[]> {
    const page = await this.getNullable<{ data?: DeezerTrack[] }>(
      `/playlist/${encodeURIComponent(playlistId)}/tracks?limit=10000`,
    );
    return page?.data ?? [];
  }

  public async getArtistTop(artistId: string): Promise<DeezerTrack[]> {
    const page = await this.getNullable<{ data?: DeezerTrack[] }>(
      `/artist/${encodeURIComponent(artistId)}/top?limit=50`,
    );
    return page?.data ?? [];
  }

  private async getNullable<T>(path: string): Promise<T | null> {
    try {
      const response = await fetchWithTimeout(`${API_BASE}${path}`, {}, DEEZER_TIMEOUT_MS);
      if (!response.ok) {
        // Deezer answers 800s for unknown IDs — an expected miss.
        Logger.debug({ status: response.status, path }, '[Deezer] Lookup miss');
        return null;
      }
      const json = (await response.json()) as (T & { error?: unknown }) | null;
      if (!json || (json as { error?: unknown }).error) return null;
      return json;
    } catch (err) {
      Logger.debug({ err, path }, '[Deezer] Lookup exception');
      return null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetchWithTimeout(`${API_BASE}${path}`, {}, DEEZER_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Deezer HTTP ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }
}
