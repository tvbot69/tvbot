import type {
  DeezerAlbum,
  DeezerArtist,
  DeezerTrack,
} from '@deezer/models/deezerModels';
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

  private async get<T>(path: string): Promise<T> {
    const response = await fetchWithTimeout(`${API_BASE}${path}`, {}, DEEZER_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Deezer HTTP ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }
}
