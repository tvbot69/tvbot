import type {
  IAlbumRepository,
} from '@domain/interfaces/ialbumRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { CacheService } from './cacheService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import {
  AppleMusicSearchApi,
  upscaleArtwork,
} from '@applemusic/apis/appleMusicSearchApi';
import { AppleMusicWebApi } from '@applemusic/apis/appleMusicWebApi';
import { Logger } from '@domain/logger';

const MEMORY_CACHE_TTL_SECONDS = 3600;
const FRESHNESS_WINDOW_MS = 90 * 24 * 3600 * 1000;
const LASTFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

export const isPlaceholderImageUrl = (url?: string | null): boolean => {
  if (!url) return true;
  return url.includes(LASTFM_PLACEHOLDER_HASH);
};

const isValidImageUrl = (url?: string | null): boolean => !!url && !isPlaceholderImageUrl(url);

export const sanitizeMusicName = (value?: string): string => {
  if (!value) return '';
  return value
    .replace(/-\s*(single|ep)\s*$/i, '')
    .replace(/\((?:deluxe|remastered|explicit)[^)]*\)/gi, '')
    .trim();
};

const pickLargest = (
  images: Array<{ url: string; height: number | null }> | undefined,
): string | undefined => {
  if (!images || images.length === 0) {
    return undefined;
  }
  return [...images].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]?.url;
};

export const normalizeArtistKey = (s: string): string =>
  s.toLowerCase()
    .replace(/\$/g, 's')
    .replace(/\+/g, 't')
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]/gu, '');

export const matchesArtistName = (candidate: string, target: string): boolean => {
  if (candidate.toLowerCase() === target.toLowerCase()) return true;
  const nc = normalizeArtistKey(candidate);
  const nt = normalizeArtistKey(target);
  if (nc.length > 0 && nc === nt) return true;
  if (nc.length > 3 && nt.length > 3 && (nc.includes(nt) || nt.includes(nc))) return true;
  return false;
};

interface ProviderAttempt {
  source: string;
}

export class ArtworkService {
  private readonly spotifyApi: SpotifySearchApi;
  private readonly deezerApi: DeezerApi;
  private readonly appleMusicWebApi: AppleMusicWebApi;
  private readonly appleMusicApi: AppleMusicSearchApi;
  private readonly artistRepository: IArtistRepository;
  private readonly albumRepository: IAlbumRepository;
  private readonly trackRepository: ITrackRepository;
  private readonly lastfmRepository: ILastfmRepository;
  private readonly cache: CacheService;

  constructor(
    spotifyApi: SpotifySearchApi,
    deezerApi: DeezerApi,
    appleMusicWebApi: AppleMusicWebApi,
    appleMusicApi: AppleMusicSearchApi,
    artistRepository: IArtistRepository,
    albumRepository: IAlbumRepository,
    trackRepository: ITrackRepository,
    lastfmRepository: ILastfmRepository,
    cache: CacheService,
  ) {
    this.spotifyApi = spotifyApi;
    this.deezerApi = deezerApi;
    this.appleMusicWebApi = appleMusicWebApi;
    this.appleMusicApi = appleMusicApi;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.trackRepository = trackRepository;
    this.lastfmRepository = lastfmRepository;
    this.cache = cache;
  }

  public async getAlbumCoverUrl(albumName?: string, artistName?: string): Promise<string | null> {
    if (!albumName || !artistName) return null;
    const cleanAlbum = sanitizeMusicName(albumName);
    const key = `art:album:${artistName.toLowerCase()}|${cleanAlbum.toLowerCase()}`;

    const cached = await this.cache.get<string>(key);
    if (cached) {
      if (cached === 'none') return null;
      if (isPlaceholderImageUrl(cached)) return null;
      return cached;
    }

    let result: string | null = null;
    const attempts: ProviderAttempt[] = [];

    const existing = await this.findExistingAlbumRow(cleanAlbum, artistName);
    if (existing?.spotifyImageUrl && this.isFresh(existing.spotifyImageDate) && isValidImageUrl(existing.spotifyImageUrl)) {
      await this.cache.set(key, existing.spotifyImageUrl, MEMORY_CACHE_TTL_SECONDS);
      return existing.spotifyImageUrl;
    }
    if (existing?.deezerImageUrl && isValidImageUrl(existing.deezerImageUrl)) {
      result = existing.deezerImageUrl;
    }
    if (!result && existing?.lastFmImageUrl && isValidImageUrl(existing.lastFmImageUrl)) {
      result = existing.lastFmImageUrl;
    }

    if (!result && existing?.spotifyImageUrl && isValidImageUrl(existing.spotifyImageUrl)) {
      result = existing.spotifyImageUrl;
    }

    if (!result) {
      try {
        let albums: any[] = [];
        try {
          albums = await this.spotifyApi.searchAlbums(`album:"${cleanAlbum}" artist:"${artistName}"`);
        } catch {
          albums = [];
        }
        if (albums.length === 0) {
          albums = await this.spotifyApi.searchAlbums(`${cleanAlbum} ${artistName}`);
        }

        let match = albums.find((a) =>
          a.artists?.some((art: any) => matchesArtistName(art.name, artistName)),
        );
        if (!match && albums[0] && matchesArtistName(albums[0].artists?.[0]?.name ?? '', artistName)) {
          match = albums[0];
        }

        let url = pickLargest(match?.images);
        if (!url && cleanAlbum !== `${cleanAlbum} ${artistName}`) {
          // Retry with album-only query for Arabic / transliteration mismatches
          const retryAlbums = await this.spotifyApi.searchAlbums(cleanAlbum);
          const retryMatch = retryAlbums.find((a) =>
            a.artists?.some((art: any) => matchesArtistName(art.name, artistName)),
          );
          url = pickLargest(retryMatch?.images ?? retryAlbums[0]?.images);
        }
        if (url && isValidImageUrl(url)) {
          result = url;
          if (existing) {
            await this.albumRepository.setSpotifyImage(existing.albumId, url, new Date());
          }
        }
      } catch (err) {
        attempts.push({ source: `spotify:${String(err).slice(0, 60)}` });
      }
    }

    if (!result) {
      try {
        let albums: any[] = [];
        try {
          albums = await this.deezerApi.searchAlbums(`album:"${cleanAlbum}" artist:"${artistName}"`);
        } catch {
          albums = [];
        }
        if (albums.length === 0) {
          albums = await this.deezerApi.searchAlbums(`${cleanAlbum} ${artistName}`);
        }

        let match = albums.find((a) =>
          a.artist?.name ? matchesArtistName(a.artist.name, artistName) : false,
        );
        if (!match && albums[0] && albums[0].artist?.name && matchesArtistName(albums[0].artist.name, artistName)) {
          match = albums[0];
        }

        let url = match?.cover_xl ?? match?.cover_big;
        if (!url || !isValidImageUrl(url)) {
          // Retry album-only — Deezer is strongest for Arabic catalog
          const retryAlbums = await this.deezerApi.searchAlbums(cleanAlbum);
          const retryMatch = retryAlbums.find((a) =>
            a.artist?.name ? matchesArtistName(a.artist.name, artistName) : false,
          );
          url = retryMatch?.cover_xl ?? retryMatch?.cover_big ?? retryAlbums[0]?.cover_xl;
          match = retryMatch ?? retryAlbums[0];
        }
        if (url && match && isValidImageUrl(url)) {
          result = url;
          if (existing) {
            await this.albumRepository.setDeezerImage(existing.albumId, match.id, url);
          }
        }
      } catch (err) {
        attempts.push({ source: `deezer:${String(err).slice(0, 60)}` });
      }
    }

    if (!result) {
      try {
        const albums = await this.appleMusicWebApi.searchAlbums(cleanAlbum, artistName);
        const art = albums[0]?.artwork;
        if (art?.url && isValidImageUrl(art.url)) {
          result = art.url;
          if (existing) {
            await this.albumRepository.setImageUrl(existing.albumId, result);
          }
        }
      } catch (err) {
        attempts.push({ source: `am-web:${String(err).slice(0, 60)}` });
      }
    }

    if (!result) {
      try {
        const albums = await this.appleMusicApi.searchAlbums(cleanAlbum, artistName);
        const match = albums.find((a) => a.artworkUrl100);
        if (match?.artworkUrl100) {
          const upscaled = upscaleArtwork(match.artworkUrl100);
          if (isValidImageUrl(upscaled)) {
            result = upscaled;
            if (existing) {
              await this.albumRepository.setImageUrl(existing.albumId, result);
            }
          }
        }
      } catch (err) {
        attempts.push({ source: `itunes:${String(err).slice(0, 60)}` });
      }
    }

    if (!result) {
      try {
        const info = await this.lastfmRepository.getAlbumInfo(artistName, cleanAlbum);
        const lfmUrl = info?.imageUrl ?? null;
        if (isValidImageUrl(lfmUrl)) result = lfmUrl;
      } catch {
        attempts.push({ source: 'lastfm' });
      }
    }

    if (attempts.length > 0) {
      Logger.debug({ attempts }, 'Artwork resolution fell through providers');
    }

    // Never cache Last.fm star as valid
    if (result && isPlaceholderImageUrl(result)) result = null;
    await this.cache.set(key, result ?? 'none', MEMORY_CACHE_TTL_SECONDS);
    return result;
  }

  public async getArtistImageUrl(artistName?: string): Promise<string | null> {
    if (!artistName) return null;
    const key = `art:artist:${artistName.toLowerCase()}`;
    // Hotfix for Jordana — Deezer/Spotify search conflates with Jordana Bryant; force correct Spotify image
    if (artistName.toLowerCase().trim() === 'jordana') {
      const correct = 'https://i.scdn.co/image/ab6761610000e5eb856b7f7308eff9c24c17cb88';
      const existing = await this.artistRepository.getArtistByName(artistName);
      if (existing && existing.spotifyImageUrl !== correct) {
        await this.artistRepository.setSpotifyImage(existing.artistId, correct, new Date()).catch(() => undefined);
      }
      await this.cache.set(key, correct, MEMORY_CACHE_TTL_SECONDS);
      return correct;
    }

    const cached = await this.cache.get<string>(key);
    if (cached) {
      if (cached === 'none') return null;
      if (isPlaceholderImageUrl(cached)) return null;
      return cached;
    }

    let result: string | null = null;

    const existing = await this.artistRepository.getArtistByName(artistName);
    if (existing?.spotifyImageUrl && this.isFresh(existing.spotifyImageDate) && isValidImageUrl(existing.spotifyImageUrl)) {
      await this.cache.set(key, existing.spotifyImageUrl, MEMORY_CACHE_TTL_SECONDS);
      return existing.spotifyImageUrl;
    }
    if (existing?.deezerImageUrl && isValidImageUrl(existing.deezerImageUrl)) {
      result = existing.deezerImageUrl;
    }
    if (!result && existing?.imageUrl && isValidImageUrl(existing.imageUrl)) {
      result = existing.imageUrl;
    }

    if (!result) {
      try {
        const artists = await this.spotifyApi.searchArtists(artistName);
        let match = artists.find((a) => matchesArtistName(a.name, artistName));
        if (!match && artistName.includes('$')) {
          const clean = artistName.replace(/\$/g, 's');
          const retry = await this.spotifyApi.searchArtists(clean);
          match = retry.find((a) => matchesArtistName(a.name, clean));
        }
        if (!match && artists[0] && matchesArtistName(artists[0].name, artistName)) {
          match = artists[0];
        }
        const url = pickLargest(match?.images);
        if (url && match) {
          result = url;
          if (existing) {
            await this.artistRepository.setSpotifyImage(existing.artistId, url, new Date());
          }
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: spotify miss');
      }
    }

    if (!result) {
      try {
        const artists = await this.deezerApi.searchArtists(artistName);
        let match = artists.find((a) => matchesArtistName(a.name, artistName));
        if (!match && artistName.includes('$')) {
          const clean = artistName.replace(/\$/g, 's');
          const retry = await this.deezerApi.searchArtists(clean);
          match = retry.find((a) => matchesArtistName(a.name, clean));
        }
        if (!match && artists[0] && matchesArtistName(artists[0].name, artistName)) {
          match = artists[0];
        }
        if (!match) {
          Logger.debug(`Artist art: deezer no match for ${artistName}`);
        } else {
          const url = match.picture_xl ?? match.picture_big;
          if (url) {
            result = url;
            if (existing) {
              await this.artistRepository.setDeezerImage(existing.artistId, match.id, url);
            }
          }
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: deezer miss');
      }
    }

    if (!result) {
      try {
        const artists = await this.appleMusicWebApi.searchArtists(artistName);
        let match = artists.find((a) => matchesArtistName(a.name, artistName));
        if (!match && artistName.includes('$')) {
          const clean = artistName.replace(/\$/g, 's');
          const retry = await this.appleMusicWebApi.searchArtists(clean);
          match = retry.find((a) => matchesArtistName(a.name, clean));
        }
        if (!match && artists[0] && matchesArtistName(artists[0].name, artistName)) {
          match = artists[0];
        }
        if (!match) {
          Logger.debug(`Artist art: apple-web no match for ${artistName}`);
        } else {
          const url = match.artwork?.url;
          if (url && existing) {
            result = url;
            await this.artistRepository.setAppleMusicUrl(existing.artistId, url);
          }
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: am-web miss');
      }
    }

    if (!result) {
      try {
        const info = await this.lastfmRepository.getArtistInfo(artistName);
        if (info?.name && info.name.toLowerCase() !== artistName.toLowerCase()) {
          // Last.fm redirected to canonical name (e.g. "Travi$ Scott" -> "Travis Scott")
          const resolvedCanonical = await this.getArtistImageUrl(info.name);
          if (resolvedCanonical) result = resolvedCanonical;
        }
        if (!result) {
          const lfmUrl = info?.imageUrl ?? null;
          if (isValidImageUrl(lfmUrl)) result = lfmUrl;
        }
      } catch {
        return null;
      }
    }

    if (result && isPlaceholderImageUrl(result)) result = null;
    await this.cache.set(key, result ?? 'none', MEMORY_CACHE_TTL_SECONDS);
    return result;
  }

  public async getTrackCoverUrl(trackName?: string, artistName?: string): Promise<string | null> {
    if (!trackName || !artistName) return null;
    const cleanTrack = sanitizeMusicName(trackName);
    const key = `art:track:${artistName.toLowerCase()}|${cleanTrack.toLowerCase()}`;

    const cached = await this.cache.get<string>(key);
    if (cached) {
      if (cached === 'none') return null;
      if (isPlaceholderImageUrl(cached)) return null;
      return cached;
    }

    let result: string | null = null;

    try {
      const tracks = await this.spotifyApi.searchTracks(
        `track:${cleanTrack} artist:${artistName}`,
      );
      const url = pickLargest(tracks[0]?.album?.images);
      if (url) {
        result = url;
        const artistRow = await this.artistRepository.getArtistByName(artistName);
        if (artistRow) {
          const trackRow = await this.trackRepository.getTrackByNameAndArtist(
            cleanTrack,
            artistRow.artistId,
          );
          if (trackRow) {
            await this.trackRepository.setSpotifyImage(trackRow.trackId, url, new Date());
          }
        }
      }
    } catch (err) {
      Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: spotify miss');
    }

    if (!result) {
      try {
        const tracks = await this.deezerApi.searchTracks(`${cleanTrack} ${artistName}`);
        result = tracks[0]?.album?.cover_xl ?? tracks[0]?.album?.cover_big ?? null;
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: deezer miss');
      }
    }

    if (!result) {
      try {
        const songs = await this.appleMusicWebApi.searchSongs(cleanTrack, artistName);
        result = songs[0]?.artwork?.url ?? null;
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: am-web miss');
      }
    }

    if (!result) {
      try {
        const songs = await this.appleMusicApi.searchSongs(cleanTrack, artistName);
        const match = songs.find((s) => s.artworkUrl100);
        if (match?.artworkUrl100) {
          const upscaled = upscaleArtwork(match.artworkUrl100);
          if (isValidImageUrl(upscaled)) result = upscaled;
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: itunes miss');
      }
    }

    if (!result) {
      try {
        const info = await this.lastfmRepository.getTrackInfo(trackName, artistName);
        if (info?.albumName) {
          result = await this.getAlbumCoverUrl(info.albumName, artistName);
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: lastfm miss');
      }
    }

    if (result && isPlaceholderImageUrl(result)) result = null;
    await this.cache.set(key, result ?? 'none', MEMORY_CACHE_TTL_SECONDS);
    return result;
  }

  private isFresh(date?: Date | null): boolean {
    if (!date) {
      return false;
    }
    return Date.now() - date.getTime() < FRESHNESS_WINDOW_MS;
  }

  private async findExistingAlbumRow(albumName: string, artistName: string) {
    const artist = await this.artistRepository.getArtistByName(artistName);
    if (!artist) {
      return null;
    }
    return this.albumRepository.getAlbumByNameAndArtist(albumName, artist.artistId);
  }
}
