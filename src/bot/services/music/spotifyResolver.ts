import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { clampSpotifySearchLimit } from '@spotify/api/spotifyApiLimits';
import { Logger } from '@domain/logging/logger';
import { fetchWithTimeout } from '@domain/http/fetchWithTimeout';
import type { MirrorProvider, MirrorTrack } from '@domain/models/music/musicTrack';
import { SpotifyScraperService } from '@bot/services/music/spotifyScraperService';

export interface SpotifyResolvedTrack extends MirrorTrack {
  /** Canonical open.spotify.com page for this entry. */
  spotifyUri?: string;
}

export interface SpotifyResolutionResult {
  type: 'track' | 'album' | 'playlist' | 'artist';
  title: string;
  author?: string;
  artworkUrl?: string;
  tracks: SpotifyResolvedTrack[];
  totalTracks: number;
  /**
   * Whether `totalTracks` is a real count or merely the number of tracks this
   * shard returned.
   *
   * `false` means the vendor never told us the size, and `totalTracks` is then
   * an UNDERSTATEMENT rather than a fact. Measured: Spotify's embed page
   * carries no item count at all, so the scraper's `/(\d+)\s+items/` read
   * matches nothing on either the embed or the main page. Without this flag the
   * shard size was published as the playlist size and a 347-track playlist
   * rendered as a confident "100 tracks" with no truncation notice.
   *
   * Defaults to `true` because every caller that knows a real count should say
   * so; only the scraper's unreadable-count path sets it to `false`.
   */
  totalKnown?: boolean;
  provider: MirrorProvider;
}

const SPOTIFY_URL_REGEX =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?|spotify:)(track|album|playlist|artist)[/:]([a-zA-Z0-9]+)/i;

export class SpotifyResolver {
  private readonly tokenManager: SpotifyTokenManager;
  private readonly scraper?: SpotifyScraperService;

  constructor(tokenManager: SpotifyTokenManager, scraper?: SpotifyScraperService) {
    this.tokenManager = tokenManager;
    this.scraper = scraper;
  }

  public isSpotifyUrl(url: string): boolean {
    return SPOTIFY_URL_REGEX.test(url.trim());
  }

  public parseSpotifyUrl(
    url: string,
  ): { type: 'track' | 'album' | 'playlist' | 'artist'; id: string } | null {
    const match = url.trim().match(SPOTIFY_URL_REGEX);
    if (!match || !match[1] || !match[2]) {
      return null;
    }
    const type = match[1].toLowerCase() as 'track' | 'album' | 'playlist' | 'artist';
    const id = match[2];
    return { type, id };
  }

  public async resolve(url: string): Promise<SpotifyResolutionResult | null> {
    const parsed = this.parseSpotifyUrl(url);
    if (!parsed) {
      return null;
    }

    const token = await this.tokenManager.getToken();
    if (!token) {
      Logger.warn('Cannot resolve Spotify URL: SpotifyTokenManager has no valid token');
      return null;
    }

    try {
      switch (parsed.type) {
        case 'track':
          return await this.resolveTrack(parsed.id, token);
        case 'album':
          return await this.resolveAlbum(parsed.id, token);
        case 'playlist':
          return await this.resolvePlaylist(parsed.id, token);
        case 'artist':
          return await this.resolveArtist(parsed.id, token);
        default:
          return null;
      }
    } catch (err) {
      Logger.error({ err, url }, 'Failed to resolve Spotify URL');
      return null;
    }
  }

  public async searchTrack(query: string): Promise<SpotifyResolvedTrack | null> {
    const cleanQuery = query?.trim().slice(0, 250);
    if (!cleanQuery) return null;

    const token = await this.tokenManager.getToken();
    if (!token) return null;

    try {
      const endpoint = `https://api.spotify.com/v1/search?q=${encodeURIComponent(cleanQuery)}&type=track&limit=1`;
      const data = await this.fetchSpotify<{
        tracks?: {
          items?: Array<{
            name: string;
            artists: Array<{ name: string }>;
            duration_ms: number;
            album?: { images?: Array<{ url: string }>; name?: string };
            external_urls?: { spotify?: string };
          }>;
        };
      }>(endpoint, token);

      const first = data?.tracks?.items?.[0];
      if (!first) return null;

      const artist = first.artists.map((a) => a.name).join(', ');
      return {
        name: first.name,
        artist,
        durationMs: first.duration_ms,
        searchQuery: `${artist} - ${first.name}`,
        artworkUrl: first.album?.images?.[0]?.url,
        album: first.album?.name,
        spotifyUri: first.external_urls?.spotify,
        provider: 'spotify',
      };
    } catch {
      // CORRECT AS IS: this is ENRICHMENT, not resolution. A failed
      // searchTrack leaves the raw Lavalink title/author on the track —
      // exactly what shipped before enrichment existed — and musicService
      // still enqueues it. The one caller races this against 1.5s anyway.
      return null;
    }
  }

  public async searchTracks(query: string, limit: number = 10): Promise<SpotifyResolvedTrack[]> {
    const cleanQuery = query?.trim().slice(0, 250);
    if (!cleanQuery) return [];

    const token = await this.tokenManager.getToken();
    if (!token) return [];

    try {
      // Clamped, not trusted. The server's real `/v1/search` ceiling was measured
      // live on 2026-09-30 at 10 — limit=11, 15 and 50 each return 400 "Invalid
      // limit" — which contradicts Spotify's published 50. The old
      // `Math.min(limit, 50)` therefore clamped to a value the server rejects.
      // It never fired only because every caller passes <= 10, two of which
      // (`artworkService`) sit exactly on the boundary with no clamp of their
      // own. See `@spotify/api/spotifyApiLimits` for the probe.
      const endpoint = `https://api.spotify.com/v1/search?q=${encodeURIComponent(cleanQuery)}&type=track&limit=${clampSpotifySearchLimit(limit)}`;
      const data = await this.fetchSpotify<{
        tracks?: {
          items?: Array<{
            name: string;
            artists: Array<{ name: string }>;
            duration_ms: number;
            album?: { images?: Array<{ url: string }>; name?: string };
            external_urls?: { spotify?: string };
          }>;
        };
      }>(endpoint, token);

      const items = data?.tracks?.items;
      if (!items || items.length === 0) return [];

      return items.map((item) => {
        const artist = item.artists.map((a) => a.name).join(', ');
        return {
          name: item.name,
          artist,
          durationMs: item.duration_ms,
          searchQuery: `${artist} - ${item.name}`,
          artworkUrl: item.album?.images?.[0]?.url,
          album: item.album?.name,
          spotifyUri: item.external_urls?.spotify,
          provider: 'spotify',
        };
      });
    } catch {
      // CORRECT AS IS: `[]` means "this rung produced no rows", and both
      // callers already read it that way — musicSearchLadder.searchTracks
      // drops straight to the node-aware Lavalink search, and
      // upgradePickerResults returns leaving the picker raw. Nothing tells
      // a user "this track does not exist" from here.
      return [];
    }
  }

  private async fetchSpotify<T>(endpoint: string, token: string): Promise<T | null> {
    try {
      const response = await fetchWithTimeout(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status === 401) {
        this.tokenManager.invalidate();
        const newToken = await this.tokenManager.getToken();
        if (newToken) {
          const retryRes = await fetchWithTimeout(endpoint, {
            headers: { Authorization: `Bearer ${newToken}` },
          });
          if (retryRes.ok) {
            return (await retryRes.json()) as T;
          }
        }
        return null;
      }

      if (!response.ok) {
        Logger.warn({ status: response.status, endpoint }, 'Spotify API request failed');
        return null;
      }

      return (await response.json()) as T;
    } catch (err) {
      Logger.error({ err, endpoint }, 'Spotify fetch exception');
      return null;
    }
  }

  /** ISRC from Spotify external_ids — the exact-recording key for ISRC-first search. */
  private static readIsrc(data: { external_ids?: { isrc?: string } }): string | undefined {
    const isrc = data.external_ids?.isrc?.trim();
    return isrc || undefined;
  }

  private async resolveTrack(id: string, token: string): Promise<SpotifyResolutionResult | null> {
    interface TrackData {
      name: string;
      artists: Array<{ name: string }>;
      duration_ms: number;
      album?: { images?: Array<{ url: string }>; name?: string };
      external_urls?: { spotify?: string };
      external_ids?: { isrc?: string };
    }

    const data = await this.fetchSpotify<TrackData>(
      `https://api.spotify.com/v1/tracks/${id}`,
      token,
    );
    if (!data) return null;

    const artist = data.artists.map((a) => a.name).join(', ');
    const artworkUrl = data.album?.images?.[0]?.url;
    const track: SpotifyResolvedTrack = {
      name: data.name,
      artist,
      durationMs: data.duration_ms,
      searchQuery: `${artist} - ${data.name}`,
      artworkUrl,
      album: data.album?.name,
      spotifyUri: data.external_urls?.spotify,
      isrc: SpotifyResolver.readIsrc(data),
      provider: 'spotify',
    };

    return {
      type: 'track',
      title: data.name,
      author: artist,
      artworkUrl,
      tracks: [track],
      totalTracks: 1,
      provider: 'spotify',
    };
  }

  private async resolveAlbum(id: string, token: string): Promise<SpotifyResolutionResult | null> {
    interface AlbumTrackItem {
      name: string;
      artists: Array<{ name: string }>;
      duration_ms: number;
      external_urls?: { spotify?: string };
      external_ids?: { isrc?: string };
    }
    interface AlbumData {
      name: string;
      artists: Array<{ name: string }>;
      images?: Array<{ url: string }>;
      tracks: {
        items: AlbumTrackItem[];
        next?: string | null;
        total: number;
      };
    }

    const data = await this.fetchSpotify<AlbumData>(
      `https://api.spotify.com/v1/albums/${id}?market=US`,
      token,
    );
    if (!data) return null;

    const albumAuthor = data.artists.map((a) => a.name).join(', ');
    const artworkUrl = data.images?.[0]?.url;
    const tracks: SpotifyResolvedTrack[] = [];

    for (const item of data.tracks.items) {
      const artist = item.artists.map((a) => a.name).join(', ');
      tracks.push({
        name: item.name,
        artist,
        durationMs: item.duration_ms,
        searchQuery: `${artist} - ${item.name}`,
        artworkUrl,
        album: data.name,
        spotifyUri: item.external_urls?.spotify,
        isrc: SpotifyResolver.readIsrc(item),
        provider: 'spotify',
      });
    }

    // Paginate if album has more than 50 tracks
    let nextUrl = data.tracks.next;
    while (nextUrl && tracks.length < 500) {
      const page = await this.fetchSpotify<{
        items: AlbumTrackItem[];
        next?: string | null;
      }>(nextUrl, token);

      if (!page || !page.items) break;
      for (const item of page.items) {
        const artist = item.artists.map((a) => a.name).join(', ');
        tracks.push({
          name: item.name,
          artist,
          durationMs: item.duration_ms,
          searchQuery: `${artist} - ${item.name}`,
          artworkUrl,
          spotifyUri: item.external_urls?.spotify,
          isrc: SpotifyResolver.readIsrc(item),
          provider: 'spotify',
        });
      }
      nextUrl = page.next;
    }

    return {
      type: 'album',
      title: data.name,
      author: albumAuthor,
      artworkUrl,
      tracks,
      totalTracks: data.tracks.total || tracks.length,
      provider: 'spotify',
    };
  }

  private async resolvePlaylist(
    id: string,
    token: string,
  ): Promise<SpotifyResolutionResult | null> {
    // PERFECT: Playlists now use scraper only — no Spotify API, no token scope issues, no items undefined.
    // Scraper uses anon web-player token and supports 100-chunk lazy loading.
    if (this.scraper) {
      const page = await this.scraper.fetchPlaylistPage(id, 0, 100);
      if (page && page.tracks.length > 0) {
        const tracks: SpotifyResolvedTrack[] = page.tracks.map(t => ({
          name: t.name,
          artist: t.artist,
          durationMs: t.durationMs,
          searchQuery: `${t.artist} - ${t.name}`,
          artworkUrl: t.artworkUrl,
          spotifyUri: t.spotifyUri,
          provider: 'spotify',
        }));
        return {
          type: 'playlist',
          title: page.name,
          author: page.owner,
          artworkUrl: page.artworkUrl,
          tracks,
          totalTracks: page.total,
          totalKnown: page.totalKnown !== false,
          provider: 'spotify',
        };
      }
      Logger.warn({ playlistId: id }, 'Scraper returned no tracks, falling back to API');
    }

    // Fallback to API only if scraper unavailable or empty (kept for private playlists where scraper 403)
    interface PlaylistTrackItem {
      track?: {
        name: string;
        artists: Array<{ name: string }>;
        duration_ms: number;
        album?: { images?: Array<{ url: string }>; name?: string };
        external_urls?: { spotify?: string };
        external_ids?: { isrc?: string };
      } | null;
    }
    interface PlaylistData {
      name: string;
      owner?: { display_name?: string };
      images?: Array<{ url: string }>;
      tracks: {
        items: PlaylistTrackItem[];
        next?: string | null;
        total: number;
      };
    }

    const data = await this.fetchSpotify<PlaylistData>(
      `https://api.spotify.com/v1/playlists/${id}?market=US`,
      token,
    );
    if (!data?.tracks?.items) {
      Logger.warn({ playlistId: id, hasData: !!data, hasTracks: !!data?.tracks, hasItems: !!data?.tracks?.items }, 'Spotify playlist API returned no items');
      return null;
    }

    const author = data.owner?.display_name || 'Spotify Playlist';
    const artworkUrl = data.images?.[0]?.url;
    const tracks: SpotifyResolvedTrack[] = [];

    for (const item of data.tracks.items) {
      if (!item.track) continue;
      const artist = item.track.artists.map((a) => a.name).join(', ');
      tracks.push({
        name: item.track.name,
        artist,
        durationMs: item.track.duration_ms,
        searchQuery: `${artist} - ${item.track.name}`,
        artworkUrl: item.track.album?.images?.[0]?.url || artworkUrl,
        album: item.track.album?.name,
        spotifyUri: item.track.external_urls?.spotify,
        isrc: SpotifyResolver.readIsrc(item.track),
        provider: 'spotify',
      });
    }

    let nextUrl = data.tracks.next;
    while (nextUrl && tracks.length < 500) {
      const page = await this.fetchSpotify<{
        items: PlaylistTrackItem[];
        next?: string | null;
      }>(nextUrl, token);

      if (!page?.items) break;
      for (const item of page.items) {
        if (!item.track) continue;
        const artist = item.track.artists.map((a) => a.name).join(', ');
        tracks.push({
          name: item.track.name,
          artist,
          durationMs: item.track.duration_ms,
          searchQuery: `${artist} - ${item.track.name}`,
          artworkUrl: item.track.album?.images?.[0]?.url || artworkUrl,
          spotifyUri: item.track.external_urls?.spotify,
          isrc: SpotifyResolver.readIsrc(item.track),
          provider: 'spotify',
        });
      }
      nextUrl = page.next;
    }

    return {
      type: 'playlist',
      title: data.name,
      author,
      artworkUrl,
      tracks,
      totalTracks: data.tracks.total || tracks.length,
      provider: 'spotify',
    };
  }

  private async resolveArtist(id: string, token: string): Promise<SpotifyResolutionResult | null> {
    interface ArtistData {
      name: string;
      images?: Array<{ url: string }>;
    }
    interface TopTracksData {
      tracks: Array<{
        name: string;
        artists: Array<{ name: string }>;
        duration_ms: number;
        album?: { images?: Array<{ url: string }>; name?: string };
        external_urls?: { spotify?: string };
        external_ids?: { isrc?: string };
      }>;
    }

    const [artistData, tracksData] = await Promise.all([
      this.fetchSpotify<ArtistData>(`https://api.spotify.com/v1/artists/${id}`, token),
      this.fetchSpotify<TopTracksData>(
        `https://api.spotify.com/v1/artists/${id}/top-tracks?market=US`,
        token,
      ),
    ]);

    if (!artistData || !tracksData?.tracks) return null;

    const artworkUrl = artistData.images?.[0]?.url;
    const tracks: SpotifyResolvedTrack[] = tracksData.tracks.slice(0, 10).map((t) => {
      const artist = t.artists.map((a) => a.name).join(', ');
      return {
        name: t.name,
        artist,
        durationMs: t.duration_ms,
        searchQuery: `${artist} - ${t.name}`,
        artworkUrl: t.album?.images?.[0]?.url || artworkUrl,
        album: t.album?.name,
        spotifyUri: t.external_urls?.spotify,
        isrc: SpotifyResolver.readIsrc(t),
        provider: 'spotify',
      };
    });

    return {
      type: 'artist',
      title: `${artistData.name}'s Top Tracks`,
      author: artistData.name,
      artworkUrl,
      tracks,
      totalTracks: tracks.length,
      provider: 'spotify',
    };
  }
}
