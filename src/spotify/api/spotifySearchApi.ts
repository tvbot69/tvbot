import { container } from 'tsyringe';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';
import { SpotifyTokenManager } from './spotifyTokenManager';
import { TelemetryService } from '@bot/services/telemetryService';
import { Logger } from '@domain/logger';
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
  private static rateLimitedUntil: number = 0;
  private readonly tokenManager: SpotifyTokenManager;

  constructor(tokenManager: SpotifyTokenManager) {
    this.tokenManager = tokenManager;
  }

  public static isRateLimited(): boolean {
    return Date.now() < SpotifySearchApi.rateLimitedUntil;
  }

  public static getRateLimitedUntil(): number {
    return SpotifySearchApi.rateLimitedUntil;
  }

  public static clearRateLimit(): void {
    SpotifySearchApi.rateLimitedUntil = 0;
  }

  private static checkRateLimit(): void {
    if (Date.now() < SpotifySearchApi.rateLimitedUntil) {
      const waitSec = Math.ceil((SpotifySearchApi.rateLimitedUntil - Date.now()) / 1000);
      throw new SpotifyUnavailableError(`Spotify rate limit cooldown active (${waitSec}s remaining)`);
    }
  }

  private static handleRateLimit(response: Response): void {
    const retryHeader = response.headers.get('Retry-After');
    const retrySeconds = retryHeader ? Math.max(1, parseInt(retryHeader, 10) || 10) : 10;
    SpotifySearchApi.rateLimitedUntil = Date.now() + (retrySeconds * 1000);
    Logger.warn(
      `[Spotify] API hit 429 (Too Many Requests). Entering rate-limit cooldown for ${retrySeconds}s until ${new Date(SpotifySearchApi.rateLimitedUntil).toLocaleTimeString()}.`,
    );
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

  /**
   * Resolves the exact Spotify artist ID by anchoring on one of the user's own
   * scrobbles (`Artist + Track`). Name-only artist search silently picks the
   * globally-most-popular same-name entity (e.g. metal band "Mond" instead of the
   * Egyptian rapper "Mond"); a track search disambiguates via the recording's
   * credited artists. Returns null when nothing matches exactly.
   */
  public async getArtistIdViaTrackSample(
    artistName: string,
    sampleTrack: string,
  ): Promise<string | null> {
    try {
      if (SpotifySearchApi.isRateLimited()) return null;
      const target = artistName.toLowerCase().trim();
      if (!target || !sampleTrack?.trim()) return null;
      const tracks = await this.searchTracks(`${artistName} ${sampleTrack}`, 5);
      for (const t of tracks) {
        const matching = t.artists?.find(
          (a) =>
            a.name.toLowerCase().trim() === target ||
            SpotifySearchApi.clean(a.name) === SpotifySearchApi.clean(artistName),
        );
        if (matching?.id) return matching.id;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches the canonical Spotify artist entity (images, genres, followers).
   */
  public async getArtistById(artistId: string): Promise<SpotifySearchArtist | null> {
    try {
      if (SpotifySearchApi.isRateLimited()) return null;
      const token = await this.tokenManager.getToken();
      if (!token) return null;
      const res = await fetchWithTimeout(`https://api.spotify.com/v1/artists/${artistId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.tokenManager.invalidate();
        return null;
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        return null;
      }
      if (!res.ok) return null;
      return (await res.json()) as SpotifySearchArtist;
    } catch {
      return null;
    }
  }

  /**
   * Exact track fetch by Spotify ID: one GET, no search, no matching risk.
   * Throws SpotifyUnavailableError on 429/5xx/network/timeout so callers can
   * treat throws as inconclusive (retry later), never as misses.
   */
  public async getTrack(trackId: string, isRetry = false): Promise<SpotifySearchTrack | null> {
    const token = await this.tokenManager.getToken();
    if (!token) {
      throw new SpotifyUnavailableError('Spotify credentials not configured');
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyUnavailableError(`Spotify network error: ${String(err)}`);
    }
    if (response.status === 401) {
      this.tokenManager.invalidate();
      if (!isRetry) {
        return this.getTrack(trackId, true);
      }
      throw new SpotifyUnavailableError('Spotify token rejected');
    }
    if (response.status === 429) {
      if (this.tokenManager.rotateCredential()) {
        return this.getTrack(trackId, isRetry);
      }
      SpotifySearchApi.handleRateLimit(response);
      throw new SpotifyUnavailableError('Spotify rate limited');
    }
    if (!response.ok) {
      throw new SpotifyUnavailableError(`Spotify HTTP ${response.status}`);
    }
    return (await response.json()) as SpotifySearchTrack;
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
    if (SpotifySearchApi.isRateLimited()) return null;
    const token = await this.tokenManager.getToken();
    if (!token) return null;

    try {
      const response = await fetchWithTimeout(`https://api.spotify.com/v1/albums/${spotifyId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        this.tokenManager.invalidate();
        return null;
      }
      if (response.status === 429) {
        SpotifySearchApi.handleRateLimit(response);
        return null;
      }
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
    isRetry = false,
  ): Promise<SpotifySearchResponse> {
    SpotifySearchApi.checkRateLimit();

    const token = await this.tokenManager.getToken();
    if (!token) {
      throw new SpotifyUnavailableError('Spotify credentials not configured');
    }

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('type', type);
    url.searchParams.set('limit', String(limit));

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const durationMs = Date.now() - startTime;
      try {
        if (container.isRegistered(TelemetryService)) {
          container.resolve(TelemetryService).recordApiCall('spotify', `/v1/search?type=${type}`, durationMs, response.status);
        }
      } catch {
        // Ignore telemetry errors
      }
    } catch (err) {
      throw new SpotifyUnavailableError(`Spotify network error: ${String(err)}`);
    }

    if (response.status === 401) {
      this.tokenManager.invalidate();
      if (!isRetry) {
        Logger.info('[Spotify] Access token expired (401). Retrying with freshly requested token...');
        return this.search(query, type, limit, true);
      }
      throw new SpotifyUnavailableError('Spotify token rejected');
    }
    if (response.status === 429) {
      if (this.tokenManager.rotateCredential()) {
        Logger.warn('[Spotify] Credential rate-limited (429). Retrying immediately with next credential in pool...');
        return this.search(query, type, limit, isRetry);
      }
      SpotifySearchApi.handleRateLimit(response);
      throw new SpotifyUnavailableError('Spotify rate limited');
    }
    if (!response.ok) {
      throw new SpotifyUnavailableError(`Spotify HTTP ${response.status}`);
    }

    return (await response.json()) as SpotifySearchResponse;
  }

  public async getArtistDiscographyCovers(
    artistName: string,
    sampleTrackOrAlbum?: string,
    limit: number = 20,
  ): Promise<string[]> {
    try {
      if (SpotifySearchApi.isRateLimited()) return [];
      const token = await this.tokenManager.getToken();
      if (!token) return [];

      let artistId: string | null = null;

      // 1. If sample track/album provided, find exact artist ID through track search
      if (sampleTrackOrAlbum) {
        try {
          const tracks = await this.searchTracks(`${artistName} ${sampleTrackOrAlbum}`, 5);
          for (const t of tracks) {
            const matchingArtist = t.artists?.find((a) => {
              const an = a.name.toLowerCase().trim();
              const target = artistName.toLowerCase().trim();
              return an === target || SpotifySearchApi.clean(an) === SpotifySearchApi.clean(target);
            });
            if (matchingArtist?.id) {
              artistId = matchingArtist.id;
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      // 2. Fall back to direct artist search
      if (!artistId) {
        try {
          const artists = await this.searchArtists(artistName, 5);
          const matched = artists.find((a) => {
            const an = a.name.toLowerCase().trim();
            const target = artistName.toLowerCase().trim();
            return an === target || SpotifySearchApi.clean(an) === SpotifySearchApi.clean(target);
          });
          if (matched?.id) {
            artistId = matched.id;
          }
        } catch {
          // ignore
        }
      }

      if (!artistId) return [];

      // 3. Query official albums, singles, and features (appears_on)
      const url = `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single,appears_on&limit=${Math.min(limit, 50)}`;
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.tokenManager.invalidate();
        return [];
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        return [];
      }
      if (!res.ok) return [];
      const data: any = await res.json();
      const items: any[] = data.items ?? [];

      const covers: string[] = [];
      const seenUrls = new Set<string>();

      for (const item of items) {
        const coverUrl = item.images?.[0]?.url;
        if (coverUrl && !seenUrls.has(coverUrl)) {
          seenUrls.add(coverUrl);
          covers.push(coverUrl);
        }
      }

      return covers;
    } catch {
      return [];
    }
  }

  public async getAlbumTrackNames(albumName: string, artistName?: string, limit: number = 5): Promise<string[]> {
    try {
      if (SpotifySearchApi.isRateLimited()) return [];
      const token = await this.tokenManager.getToken();
      if (!token) return [];

      let albums: SpotifySearchAlbum[] = [];
      try {
        const query = artistName ? `album:"${albumName}" artist:"${artistName}"` : `album:"${albumName}"`;
        albums = await this.searchAlbums(query, 3);
      } catch {
        // ignore
      }

      if (albums.length === 0) {
        try {
          const simpleQuery = artistName ? `${artistName} ${albumName}` : albumName;
          albums = await this.searchAlbums(simpleQuery, 3);
        } catch {
          // ignore
        }
      }

      const albumId = albums[0]?.id;
      if (!albumId) return [];

      const res = await fetchWithTimeout(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${Math.min(limit, 50)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.tokenManager.invalidate();
        return [];
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        return [];
      }
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.items ?? []).map((t: any) => t.name).filter(Boolean);
    } catch {
      return [];
    }
  }
}

