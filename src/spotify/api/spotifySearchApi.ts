import { SpotifyTokenManager } from './spotifyTokenManager';
import type {
  SpotifySearchAlbum,
  SpotifySearchArtist,
  SpotifySearchResponse,
  SpotifySearchTrack,
} from '@spotify/models/spotifyModels';

const SEARCH_ENDPOINT = 'https://api.spotify.com/v1/search';
const DEFAULT_LIMIT = 5;

export class SpotifyUnavailableError extends Error {}

export class SpotifySearchApi {
  private readonly tokenManager: SpotifyTokenManager;

  constructor(tokenManager: SpotifyTokenManager) {
    this.tokenManager = tokenManager;
  }

  public async searchArtists(query: string, limit: number = DEFAULT_LIMIT): Promise<SpotifySearchArtist[]> {
    const response = await this.search(query, 'artist', limit);
    return response.artists?.items ?? [];
  }

  public async searchAlbums(query: string, limit: number = DEFAULT_LIMIT): Promise<SpotifySearchAlbum[]> {
    const response = await this.search(query, 'album', limit);
    return response.albums?.items ?? [];
  }

  public async searchTracks(query: string, limit: number = DEFAULT_LIMIT): Promise<SpotifySearchTrack[]> {
    const response = await this.search(query, 'track', limit);
    return response.tracks?.items ?? [];
  }

  private static clean(s: string): string {
    return s.toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');
  }

  public async getSpotifyTrackUrl(artistName: string, trackName: string): Promise<string | null> {
    try {
      // Use limit 5 — limit 15 triggers HTTP 400 for some Arabic queries (e.g. Lege-Cy)
      let results: SpotifySearchTrack[] = [];
      try {
        results = await this.searchTracks(`${artistName} ${trackName}`, 5);
      } catch (err) {
        if (String(err).includes('400')) {
          // Retry with quoted query on 400
          results = await this.searchTracks(`artist:"${artistName}" track:"${trackName}"`, 5);
        } else throw err;
      }
      if (results.length === 0) return null;
      const cleanArtist = SpotifySearchApi.clean(artistName);
      const cleanTrack = SpotifySearchApi.clean(trackName);
      const cleanQuery = SpotifySearchApi.clean(`${artistName} ${trackName}`);
      const scored = results.map((item: any, idx: number) => {
        const resTrack = (item.name ?? '').toLowerCase();
        const resArt = (item.artists?.[0]?.name ?? '').toLowerCase();
        const combined = `${resArt} ${resTrack}`;
        const cResArt = SpotifySearchApi.clean(resArt);
        const cResTrack = SpotifySearchApi.clean(resTrack);
        const cCombined = SpotifySearchApi.clean(combined);
        let score = 0;
        if (cCombined === cleanQuery) score += 5000;
        if (cResTrack === cleanTrack && cResArt === cleanArtist) score += 4000;
        if (cResArt === cleanArtist) score += 2000;
        if (resArt.includes(artistName.toLowerCase())) score += 1000;
        let trackMatchScore = 0;
        if (cResTrack === cleanTrack) trackMatchScore += 1000;
        if (resTrack.includes(trackName.toLowerCase()) || trackName.toLowerCase().includes(resTrack)) trackMatchScore += 500;
        if (cResTrack.includes(cleanTrack) || cleanTrack.includes(cResTrack)) trackMatchScore += 500;
        score += trackMatchScore;
        if (artistName.toLowerCase().includes('baba') && !resArt.includes('baba')) score -= 5000;
        if (cleanArtist && cResArt !== cleanArtist && !resArt.includes(artistName.toLowerCase()) && !artistName.toLowerCase().includes(resArt)) {
          if (cResTrack !== cleanTrack) return { item, score: -1 };
          score -= 2000;
        }
        if (cleanTrack && trackMatchScore === 0) {
          if (cResArt === cleanArtist) score -= 1000;
          else return { item, score: -1 };
        }
        const querySymbols = (artistName + trackName).replace(/[a-z0-9\s]/g, '');
        const resSymbols = (resArt + resTrack).replace(/[a-z0-9\s]/g, '');
        if (querySymbols && resSymbols.includes(querySymbols)) score += 800;
        score += (15 - idx) * 10;
        return { item, score };
      });
      const valid = scored.filter((r: any) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a: any, b: any) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      if (chosen.id) return `https://open.spotify.com/track/${chosen.id}`;
      if (chosen.external_urls?.spotify) return chosen.external_urls.spotify;
      return null;
    } catch {
      return null;
    }
  }

  public async getFullAlbum(spotifyId: string): Promise<SpotifySearchAlbum | null> {
    const token = await this.tokenManager.getToken();
    if (!token) return null;

    try {
      const response = await fetch(`https://api.spotify.com/v1/albums/${spotifyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as SpotifySearchAlbum;
    } catch {
      return null;
    }
  }

  public async searchAndGetFullAlbum(albumName: string, artistName: string): Promise<SpotifySearchAlbum | null> {
    try {
      let results: SpotifySearchAlbum[] = [];
      try {
        results = await this.searchAlbums(`album:"${albumName}" artist:"${artistName}"`, 5);
      } catch {
        results = [];
      }
      if (results.length === 0) {
        results = await this.searchAlbums(`${albumName} ${artistName}`, 5);
      }
      if (results.length === 0) return null;

      const cleanArtist = SpotifySearchApi.clean(artistName);
      const cleanAlbum = SpotifySearchApi.clean(albumName);

      const scored = results.map((r, idx) => {
        const rAlbum = SpotifySearchApi.clean(r.name);
        const hasMatchingArtist = r.artists?.some((a) => {
          const aName = SpotifySearchApi.clean(a.name);
          return aName === cleanArtist || aName.includes(cleanArtist) || cleanArtist.includes(aName);
        });

        let score = 0;
        if (hasMatchingArtist) score += 3000;
        if (rAlbum === cleanAlbum) score += 2000;
        else if (rAlbum.includes(cleanAlbum) || cleanAlbum.includes(rAlbum)) score += 800;
        score += (10 - idx) * 10;
        return { album: r, score, hasMatchingArtist };
      });

      const matching = scored.filter((s) => s.hasMatchingArtist);
      const pool = matching.length > 0 ? matching : scored;
      pool.sort((a, b) => b.score - a.score);

      const match = pool[0]?.album;
      if (!match) return null;
      return this.getFullAlbum(match.id);
    } catch {
      return null;
    }
  }

  private async search(
    query: string,
    type: 'artist' | 'album' | 'track',
    limit: number,
  ): Promise<SpotifySearchResponse> {
    const token = await this.tokenManager.getToken();
    if (!token) {
      throw new SpotifyUnavailableError('Spotify credentials not configured');
    }

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('type', type);
    url.searchParams.set('limit', String(limit));

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyUnavailableError(`Spotify network error: ${String(err)}`);
    }

    if (response.status === 401) {
      this.tokenManager.invalidate();
      throw new SpotifyUnavailableError('Spotify token rejected');
    }
    if (response.status === 429) {
      throw new SpotifyUnavailableError('Spotify rate limited');
    }
    if (!response.ok) {
      throw new SpotifyUnavailableError(`Spotify HTTP ${response.status}`);
    }

    return (await response.json()) as SpotifySearchResponse;
  }
}
