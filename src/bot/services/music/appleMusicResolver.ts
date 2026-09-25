import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';
import { AppleMusicTokenScraper } from '@applemusic/apis/appleMusicTokenScraper';
import type { MirrorProvider, MirrorResolution, MirrorTrack } from '@domain/models/music/musicTrack';

const PROVIDER: MirrorProvider = 'apple';
// Same web front the in-repo AppleMusicWebApi already proves scraped tokens against.
const AMP_API_BASE = 'https://amp-api.music.apple.com/v1';
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const APPLE_URL_REGEX =
  /(?:https?:\/\/)?music\.apple\.com\/(?:([a-z]{2})\/)?(song|album|playlist|artist)\/(?:[^?#]+\/)?([a-zA-Z0-9]+)(?:\?i=(\d+))?/i;

interface CatalogArtwork {
  url?: string;
  width?: number;
  height?: number;
}
interface CatalogTrackAttrs {
  name?: string;
  artistName?: string;
  albumName?: string;
  durationInMillis?: number;
  isrc?: string;
  url?: string;
  artwork?: CatalogArtwork;
}
interface CatalogTrackData {
  id?: string;
  attributes?: CatalogTrackAttrs;
}

/**
 * Resolves Apple Music links to mirror metadata. Catalog lookups ride the
 * shared scraped web-player token (ISRC + hi-res art); songs and albums fall
 * back to the no-auth iTunes Lookup API when the token is unavailable, so a
 * scrape breakage degrades to fewer types — never to a dead command.
 */
export class AppleMusicResolver {
  constructor(private readonly tokenScraper: AppleMusicTokenScraper = new AppleMusicTokenScraper()) {}

  public isAppleMusicUrl(url: string): boolean {
    return APPLE_URL_REGEX.test(url.trim());
  }

  public parseAppleMusicUrl(
    url: string,
  ): { type: 'song' | 'album' | 'playlist' | 'artist'; id: string; cc: string; trackId?: string } | null {
    const match = url.trim().match(APPLE_URL_REGEX);
    if (!match || !match[2] || !match[3]) return null;
    return {
      type: match[2].toLowerCase() as 'song' | 'album' | 'playlist' | 'artist',
      id: match[3],
      cc: (match[1] ?? 'us').toLowerCase(),
      trackId: match[4],
    };
  }

  public async resolve(url: string): Promise<MirrorResolution | null> {
    const parsed = this.parseAppleMusicUrl(url);
    if (!parsed) return null;
    try {
      switch (parsed.type) {
        case 'song':
          return await this.resolveSong(parsed);
        case 'album':
          return await this.resolveAlbum(parsed);
        case 'playlist':
          return await this.resolvePlaylist(parsed);
        case 'artist':
          return await this.resolveArtist(parsed);
        default:
          return null;
      }
    } catch (err) {
      Logger.warn({ err, url }, '[Apple] Failed to resolve link');
      return null;
    }
  }

  private async catalogGet<T>(cc: string, path: string): Promise<T | null> {
    const token = await this.tokenScraper.getToken();
    if (!token) return null;
    try {
      const res = await fetchWithTimeout(`${AMP_API_BASE}/catalog/${cc}/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://music.apple.com',
          'User-Agent': WEB_UA,
          Accept: 'application/json',
        },
      }, 10000);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) this.tokenScraper.invalidate();
        Logger.warn({ status: res.status, path }, '[Apple] Catalog request failed');
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      Logger.warn({ err, path }, '[Apple] Catalog fetch exception');
      return null;
    }
  }

  private static catalogArt(attrs?: CatalogTrackAttrs, size = 1000): string | undefined {
    const template = attrs?.artwork?.url;
    if (!template) return undefined;
    return template.replaceAll('{w}', String(size)).replaceAll('{h}', String(size));
  }

  private static mapCatalogTrack(data: CatalogTrackData, fallbackArt?: string): MirrorTrack | null {
    const attrs = data.attributes;
    const title = attrs?.name?.trim();
    const artist = attrs?.artistName?.trim();
    if (!title || !artist) return null;
    return {
      name: title,
      artist,
      durationMs: attrs?.durationInMillis ?? 0,
      searchQuery: `${artist} - ${title}`,
      artworkUrl: AppleMusicResolver.catalogArt(attrs) ?? fallbackArt,
      sourceUrl: attrs?.url ? decodeURIComponent(attrs.url) : undefined,
      isrc: attrs?.isrc?.trim() || undefined,
      provider: PROVIDER,
    };
  }

  private async itunesLookup(id: string): Promise<Array<Record<string, unknown>>> {
    try {
      const endpoint = `${ITUNES_LOOKUP}?id=${encodeURIComponent(id)}&entity=song&limit=300&country=US`;
      const res = await fetchWithTimeout(endpoint, undefined, 10000);
      if (!res.ok) return [];
      const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
      return json.results ?? [];
    } catch {
      return [];
    }
  }

  private static mapItunesTrack(item: Record<string, unknown>, fallbackArt?: string): MirrorTrack | null {
    const title = item.trackName as string | undefined;
    const artist = item.artistName as string | undefined;
    if (!title?.trim() || !artist?.trim()) return null;
    const rawArt = item.artworkUrl100 as string | undefined;
    const art = rawArt?.replace('100x100bb', '600x600bb') ?? fallbackArt;
    return {
      name: title.trim(),
      artist: artist.trim(),
      durationMs: (item.trackTimeMillis as number | undefined) ?? 0,
      searchQuery: `${artist.trim()} - ${title.trim()}`,
      artworkUrl: art,
      sourceUrl: item.trackViewUrl as string | undefined,
      provider: PROVIDER,
    };
  }

  private async resolveSong(parsed: { id: string; cc: string; trackId?: string }): Promise<MirrorResolution | null> {
    // Catalog first (ISRC + hi-res art), iTunes lookup as the no-auth fallback.
    const songId = parsed.trackId ?? parsed.id;
    const catalog = await this.catalogGet<{ data?: CatalogTrackData[] }>(
      parsed.cc,
      `songs/${encodeURIComponent(songId)}?extend=artistUrl`,
    );
    const mapped = catalog?.data?.[0] ? AppleMusicResolver.mapCatalogTrack(catalog.data[0]) : null;
    if (mapped) {
      return {
        type: 'track',
        title: mapped.name,
        author: mapped.artist,
        artworkUrl: mapped.artworkUrl,
        tracks: [mapped],
        totalTracks: 1,
        provider: PROVIDER,
      };
    }
    const results = await this.itunesLookup(songId);
    const item = results.find((r) => r.wrapperType === 'track');
    const fallback = item ? AppleMusicResolver.mapItunesTrack(item) : null;
    if (!fallback) return null;
    return {
      type: 'track',
      title: fallback.name,
      author: fallback.artist,
      artworkUrl: fallback.artworkUrl,
      tracks: [fallback],
      totalTracks: 1,
      provider: PROVIDER,
    };
  }

  private async resolveAlbum(parsed: { id: string; cc: string }): Promise<MirrorResolution | null> {
    const catalog = await this.catalogGet<{
      data?: Array<{ attributes?: { name?: string; artistName?: string; artwork?: CatalogArtwork } }>;
    }>(parsed.cc, `albums/${encodeURIComponent(parsed.id)}?extend=artistUrl`);
    const albumAttrs = catalog?.data?.[0]?.attributes;
    if (albumAttrs) {
      const tracksPage = await this.catalogGet<{ data?: CatalogTrackData[] }>(
        parsed.cc,
        `albums/${encodeURIComponent(parsed.id)}/tracks?limit=300&extend=artistUrl`,
      );
      const albumArt = AppleMusicResolver.catalogArt({ artwork: albumAttrs.artwork } as CatalogTrackAttrs);
      const tracks: MirrorTrack[] = [];
      for (const item of tracksPage?.data ?? []) {
        const track = AppleMusicResolver.mapCatalogTrack(item, albumArt);
        if (track) tracks.push(track);
      }
      if (tracks.length > 0) {
        return {
          type: 'album',
          title: albumAttrs.name || 'Apple Music Album',
          author: albumAttrs.artistName,
          artworkUrl: albumArt,
          tracks,
          totalTracks: tracks.length,
          provider: PROVIDER,
        };
      }
    }
    // No-auth fallback: one iTunes lookup returns the album's songs.
    const results = await this.itunesLookup(parsed.id);
    const collection = results.find((r) => r.wrapperType === 'collection');
    const albumArt = (collection?.artworkUrl100 as string | undefined)?.replace('100x100bb', '600x600bb');
    const tracks: MirrorTrack[] = [];
    for (const song of results.filter((r) => r.wrapperType === 'track')) {
      const track = AppleMusicResolver.mapItunesTrack(song, albumArt);
      if (track) tracks.push(track);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'album',
      title: (collection?.collectionName as string | undefined) || 'Apple Music Album',
      author: (collection?.artistName as string | undefined) ?? tracks[0]?.artist,
      artworkUrl: albumArt,
      tracks,
      totalTracks: tracks.length,
      provider: PROVIDER,
    };
  }

  private async resolvePlaylist(parsed: { id: string; cc: string }): Promise<MirrorResolution | null> {
    // Playlists exist only in the catalog API (iTunes lookup has no playlists).
    const playlist = await this.catalogGet<{
      data?: Array<{
        attributes?: { name?: string; curatorName?: string; artwork?: CatalogArtwork };
        relationships?: { tracks?: { data?: CatalogTrackData[] } };
      }>;
    }>(parsed.cc, `playlists/${encodeURIComponent(parsed.id)}`);
    const entry = playlist?.data?.[0];
    const tracksPage = await this.catalogGet<{ data?: CatalogTrackData[] }>(
      parsed.cc,
      `playlists/${encodeURIComponent(parsed.id)}/tracks?limit=300&extend=artistUrl`,
    );
    const items = tracksPage?.data ?? entry?.relationships?.tracks?.data ?? [];
    const playlistArt = AppleMusicResolver.catalogArt({ artwork: entry?.attributes?.artwork } as CatalogTrackAttrs);
    const tracks: MirrorTrack[] = [];
    for (const item of items) {
      const track = AppleMusicResolver.mapCatalogTrack(item, playlistArt);
      if (track) tracks.push(track);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'playlist',
      title: entry?.attributes?.name || 'Apple Music Playlist',
      author: entry?.attributes?.curatorName,
      artworkUrl: playlistArt,
      tracks,
      totalTracks: tracks.length,
      provider: PROVIDER,
    };
  }

  private async resolveArtist(parsed: { id: string; cc: string }): Promise<MirrorResolution | null> {
    const [artist, topSongs] = await Promise.all([
      this.catalogGet<{ data?: Array<{ attributes?: { name?: string; artwork?: CatalogArtwork } }> }>(
        parsed.cc,
        `artists/${encodeURIComponent(parsed.id)}`,
      ),
      this.catalogGet<{ results?: { songs?: { data?: CatalogTrackData[] } } }>(
        parsed.cc,
        `artists/${encodeURIComponent(parsed.id)}/view/top-songs`,
      ),
    ]);
    const attrs = artist?.data?.[0]?.attributes;
    const tracks: MirrorTrack[] = [];
    for (const item of topSongs?.results?.songs?.data ?? []) {
      const track = AppleMusicResolver.mapCatalogTrack(item);
      if (track) tracks.push(track);
    }
    if (tracks.length === 0) return null;
    return {
      type: 'artist',
      title: `${attrs?.name ?? tracks[0]?.artist}'s Top Tracks`,
      author: attrs?.name ?? tracks[0]?.artist,
      artworkUrl: AppleMusicResolver.catalogArt({ artwork: attrs?.artwork } as CatalogTrackAttrs),
      tracks,
      totalTracks: tracks.length,
      provider: PROVIDER,
    };
  }
}
