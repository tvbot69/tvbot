import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';
import { DeezerApi } from '@deezer/apis/deezerApi';
import type { DeezerTrack } from '@deezer/models/deezerModels';
import type { MirrorProvider, MirrorResolution, MirrorTrack } from '@domain/models/music/musicTrack';

const PROVIDER: MirrorProvider = 'deezer';
// album.cover_xl is sometimes absent while md5_image survives — same template LavaSrc uses.
const COVER_FALLBACK = (md5: string): string =>
  `https://cdn-images.dzcdn.net/images/cover/${md5}/1000x1000-000000-80-0-0.jpg`;

const DEEZER_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist|artist)\/([0-9]+)/i;
const SHARE_HOSTS = new Set(['deezer.page.link', 'link.deezer.com']);

/**
 * Resolves Deezer links (canonical + share short-links) to mirror metadata.
 * The public Deezer API needs no auth; the returned tracks mirror onto
 * Lavalink audio through the same ISRC-first ladder as Spotify links.
 */
export class DeezerResolver {
  constructor(private readonly deezerApi: DeezerApi) {}

  public isDeezerUrl(url: string): boolean {
    const trimmed = url.trim();
    if (DEEZER_URL_REGEX.test(trimmed)) return true;
    try {
      const host = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
      return SHARE_HOSTS.has(host.replace(/^www\./, ''));
    } catch {
      return false;
    }
  }

  public parseDeezerUrl(url: string): { type: 'track' | 'album' | 'playlist' | 'artist'; id: string } | null {
    const match = url.trim().match(DEEZER_URL_REGEX);
    if (!match || !match[1] || !match[2]) return null;
    return { type: match[1].toLowerCase() as 'track' | 'album' | 'playlist' | 'artist', id: match[2] };
  }

  /**
   * Resolves a share short-link to the canonical deezer.com URL by following
   * redirects manually and reading the `?dest=` parameter (LavaSrc-style).
   * Bounded hops, never throws.
   */
  public async resolveShareUrl(url: string): Promise<string | null> {
    let current = url.trim();
    if (!current.startsWith('http')) current = `https://${current}`;
    for (let hop = 0; hop < 5; hop++) {
      try {
        const res = await fetchWithTimeout(current, { redirect: 'manual' }, 8000);
        const location = res.headers.get('location');
        if (!location) {
          return DEEZER_URL_REGEX.test(current) ? current : null;
        }
        const next = new URL(location, current);
        if (next.pathname.endsWith('/404')) return null;
        const dest = next.searchParams.get('dest');
        const candidate = dest ?? `${next.origin}${next.pathname}`;
        if (DEEZER_URL_REGEX.test(candidate)) return candidate;
        current = candidate;
      } catch {
        return null;
      }
    }
    return null;
  }

  public async resolve(url: string): Promise<MirrorResolution | null> {
    let canonical = url.trim();
    if (!this.parseDeezerUrl(canonical)) {
      const shared = await this.resolveShareUrl(canonical);
      if (!shared) {
        Logger.warn({ url }, '[Deezer] Unresolvable link (not a Deezer URL or share target)');
        return null;
      }
      canonical = shared;
    }
    const parsed = this.parseDeezerUrl(canonical);
    if (!parsed) return null;
    try {
      switch (parsed.type) {
        case 'track':
          return await this.resolveTrack(parsed.id);
        case 'album':
          return await this.resolveAlbum(parsed.id);
        case 'playlist':
          return await this.resolvePlaylist(parsed.id);
        case 'artist':
          return await this.resolveArtist(parsed.id);
        default:
          return null;
      }
    } catch (err) {
      Logger.warn({ err, url }, '[Deezer] Failed to resolve link');
      return null;
    }
  }

  private static coverOf(json: DeezerTrack, fallbackArt?: string): string | undefined {
    return (
      json.album?.cover_xl ||
      json.album?.cover_big ||
      (json.md5_image ? COVER_FALLBACK(json.md5_image) : undefined) ||
      fallbackArt
    );
  }

  private static mapTrack(json: DeezerTrack, fallbackArt?: string): MirrorTrack | null {
    const title = json.title?.trim();
    const artist = json.artist?.name?.trim();
    if (!title || !artist) return null;
    return {
      name: title,
      artist,
      durationMs: (json.duration || 0) * 1000,
      searchQuery: `${artist} - ${title}`,
      artworkUrl: DeezerResolver.coverOf(json, fallbackArt),
      sourceUrl: json.link,
      isrc: json.isrc?.trim() || undefined,
      provider: PROVIDER,
    };
  }

  private async resolveTrack(id: string): Promise<MirrorResolution | null> {
    const data = await this.deezerApi.getTrack(id);
    if (!data) return null;
    const track = DeezerResolver.mapTrack(data);
    if (!track) return null;
    return {
      type: 'track',
      title: track.name,
      author: track.artist,
      artworkUrl: track.artworkUrl,
      tracks: [track],
      totalTracks: 1,
      provider: PROVIDER,
    };
  }

  private async resolveAlbum(id: string): Promise<MirrorResolution | null> {
    const [album, items] = await Promise.all([
      this.deezerApi.getAlbumById(id),
      this.deezerApi.getAlbumTracks(id),
    ]);
    if (!album && items.length === 0) return null;
    const albumArt = album?.cover_xl;
    const tracks: MirrorTrack[] = [];
    for (const item of items) {
      const mapped = DeezerResolver.mapTrack(item, albumArt);
      if (mapped) tracks.push(mapped);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'album',
      title: album?.title || tracks[0]?.name || 'Deezer Album',
      author: album?.artist?.name || tracks[0]?.artist,
      artworkUrl: albumArt,
      tracks,
      totalTracks: tracks.length,
      provider: PROVIDER,
    };
  }

  private async resolvePlaylist(id: string): Promise<MirrorResolution | null> {
    const [playlist, items] = await Promise.all([
      this.deezerApi.getPlaylistById(id),
      this.deezerApi.getPlaylistTracks(id),
    ]);
    if (!playlist && items.length === 0) return null;
    const tracks: MirrorTrack[] = [];
    for (const item of items) {
      const mapped = DeezerResolver.mapTrack(item, playlist?.picture_xl);
      if (mapped) tracks.push(mapped);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'playlist',
      title: playlist?.title || 'Deezer Playlist',
      author: playlist?.creator?.name,
      artworkUrl: playlist?.picture_xl,
      tracks,
      totalTracks: items.length > tracks.length ? items.length : tracks.length,
      provider: PROVIDER,
    };
  }

  private async resolveArtist(id: string): Promise<MirrorResolution | null> {
    const artistId = Number(id);
    const [artist, items] = await Promise.all([
      Number.isFinite(artistId) ? this.deezerApi.getArtist(artistId).catch(() => null) : Promise.resolve(null),
      this.deezerApi.getArtistTop(id),
    ]);
    if (!artist && items.length === 0) return null;
    const tracks: MirrorTrack[] = [];
    for (const item of items) {
      const mapped = DeezerResolver.mapTrack(item, artist?.picture_xl);
      if (mapped) tracks.push(mapped);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'artist',
      title: `${artist?.name ?? tracks[0]?.artist}'s Top Tracks`,
      author: artist?.name ?? tracks[0]?.artist,
      artworkUrl: artist?.picture_xl,
      tracks,
      totalTracks: tracks.length,
      provider: PROVIDER,
    };
  }
}
