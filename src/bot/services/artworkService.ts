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
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';

const MEMORY_CACHE_TTL_SECONDS = 3600;
/** Negative cache for DEFINITIVE misses (every provider answered no).
 * Inconclusive runs (throws, rate-limits) are never cached — the next
 * lookup retries. Kept short anyway: new releases appear, providers change. */
const NONE_TTL_SECONDS = 600;
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

/**
 * Strips auto-generated YouTube channel suffixes ("Drake - Topic", "X
 * VEVO") down to the real artist. Without this, strict artist matching
 * rejects every provider hit for topic-channel uploads (candidate "Drake"
 * vs target "Drake - Topic") and the cascade wrongly falls through to the
 * artist picture. Real artist names never end this way, so this is safe
 * to apply to every track-cover lookup.
 */
export const stripChannelSuffix = (value?: string | null): string => {
  if (!value) return '';
  return value
    .trim()
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
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

const normalizeTitleKey = (s: string): string =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');

const stripBracketed = (s: string): string =>
  s.replace(/\s*[([{\u3010].*?[)\]}\u3011]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * Strict recording-title match: normalized equality, tolerating edition tags
 * ("Song (Remastered)" vs "Song"). Never use substring matching here — "Song"
 * must not match "Song 2" or a same-title recording by another artist.
 */
export const matchesTrackTitle = (candidate: string, target: string): boolean => {
  if (!candidate || !target) return false;
  const c = normalizeTitleKey(candidate);
  const t = normalizeTitleKey(target);
  if (!c || !t) return false;
  if (c === t) return true;
  const cs = normalizeTitleKey(stripBracketed(candidate));
  const ts = normalizeTitleKey(stripBracketed(target));
  return cs.length > 0 && ts.length > 0 && (cs === ts || cs === t || c === ts);
};

export const matchesArtistName = (candidate: string, target: string): boolean => {
  const cLow = candidate.toLowerCase().trim();
  const tLow = target.toLowerCase().trim();
  if (cLow === tLow) return true;

  const nc = normalizeArtistKey(candidate);
  const nt = normalizeArtistKey(target);
  if (nc.length > 0 && nc === nt) return true;

  // Split collaboration/feature formats: "A & B", "A feat. B", "A x B", "A / B", "A with B"
  const collabs = cLow
    .split(/\s*(?:feat\.?|ft\.?|featuring|\bx\b|&|\/|,|\bwith\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (collabs.length > 1) {
    for (const part of collabs) {
      if (part === tLow || normalizeArtistKey(part) === nt) {
        return true;
      }
    }
  }

  return false;
};

export interface ProviderAttempt {
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
  /** Shared outage signal — gates negative caching of ambiguous Last.fm nulls. */
  private readonly lastFmErrorTracker?: LastfmErrorRateTracker;
  /**
   * In-flight cascade dedupe: the now-playing card, chapter art, JIT top-ups
   * and commands can ask for the same cover within milliseconds — they share
   * one provider sweep instead of stampeding the APIs N times.
   */
  private readonly inFlight = new Map<string, Promise<string | null>>();

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
    lastFmErrorTracker?: LastfmErrorRateTracker,
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
    this.lastFmErrorTracker = lastFmErrorTracker;
  }

  /**
   * The Last.fm repo swallows transport failures into null — indistinguishable
   * from "provider has no such entity". While Last.fm is erroring hard (shared
   * rate tracker), that null is an outage symptom and must not count as a
   * definitive miss; otherwise one blip poisons the 10-min negative cache.
   */
  private isLastFmUnhealthy(): boolean {
    try {
      return this.lastFmErrorTracker?.isElevated() ?? false;
    } catch {
      return false;
    }
  }

  private joinFlight(flightKey: string, run: () => Promise<string | null>): Promise<string | null> {
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    const flight = run().finally(() => {
      this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, flight);
    return flight;
  }

  public async getAlbumCoverUrl(
    albumName?: string,
    artistName?: string,
    outerAttempts?: ProviderAttempt[],
  ): Promise<string | null> {
    if (!albumName || !artistName) return null;
    const cleanAlbum = sanitizeMusicName(albumName);
    const flightKey = `flight:album:${artistName.toLowerCase()}|${cleanAlbum.toLowerCase()}`;
    const existingFlight = this.inFlight.get(flightKey);
    if (existingFlight) {
      // Joining another caller's cascade — its outcome is opaque here, so the
      // outer gate must treat a null as inconclusive, never a definitive miss.
      outerAttempts?.push({ source: 'album-inner:shared' });
      return existingFlight;
    }
    return this.joinFlight(flightKey, () => this.resolveAlbumCover(cleanAlbum, artistName, outerAttempts));
  }

  private async resolveAlbumCover(
    cleanAlbum: string,
    artistName: string,
    outerAttempts?: ProviderAttempt[],
  ): Promise<string | null> {
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

    if (!result && SpotifySearchApi.isRateLimited()) {
      attempts.push({ source: 'spotify:rate-limited' });
    }
    if (!result && !SpotifySearchApi.isRateLimited()) {
      try {
        let albums: any[] = [];
        try {
          albums = await this.spotifyApi.searchAlbums(`album:"${cleanAlbum}" artist:"${artistName}"`, 10);
        } catch {
          albums = [];
        }
        if (albums.length === 0) {
          albums = await this.spotifyApi.searchAlbums(`${cleanAlbum} ${artistName}`, 10);
        }

        let match = albums.find((a) =>
          a.artists?.some((art: any) => matchesArtistName(art.name, artistName)),
        );
        if (!match && albums[0] && matchesArtistName(albums[0].artists?.[0]?.name ?? '', artistName)) {
          match = albums[0];
        }

        let url = pickLargest(match?.images);
        if (!url && cleanAlbum !== `${cleanAlbum} ${artistName}`) {
          // Retry with album-only query for Arabic / transliteration mismatches.
          // Only a verified artist match is accepted — never the first result.
          const retryAlbums = await this.spotifyApi.searchAlbums(cleanAlbum, 10);
          const retryMatch = retryAlbums.find((a) =>
            a.artists?.some((art: any) => matchesArtistName(art.name, artistName)),
          );
          url = pickLargest(retryMatch?.images);
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
          // Retry album-only — Deezer is strongest for Arabic catalog.
          // Only a verified artist match is accepted AND persisted — never the
          // first result (persistence of a wrong cover poisons the DB for 90d).
          const retryAlbums = await this.deezerApi.searchAlbums(cleanAlbum);
          const retryMatch = retryAlbums.find((a) =>
            a.artist?.name ? matchesArtistName(a.artist.name, artistName) : false,
          );
          url = retryMatch?.cover_xl ?? retryMatch?.cover_big;
          match = retryMatch;
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
        const match = albums.find((a) => matchesArtistName(a.artistName ?? '', artistName));
        const art = match?.artwork;
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
        const match = albums.find(
          (a) => a.artworkUrl100 && matchesArtistName(a.artistName ?? '', artistName),
        );
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
      let answered = false;
      try {
        const info = await this.lastfmRepository.getAlbumInfo(artistName, cleanAlbum);
        const lfmUrl = info?.imageUrl ?? null;
        if (isValidImageUrl(lfmUrl)) {
          result = lfmUrl;
          answered = true;
        }
      } catch {
        attempts.push({ source: 'lastfm' });
        answered = true;
      }
      if (!answered && this.isLastFmUnhealthy()) {
        // Ambiguous null during a hard outage — inconclusive, not definitive.
        attempts.push({ source: 'lastfm:outage' });
      }
    }

    if (attempts.length > 0) {
      Logger.debug({ attempts }, 'Artwork resolution fell through providers');
    }

    // Never cache Last.fm star as valid
    if (result && isPlaceholderImageUrl(result)) result = null;
    if (result) {
      await this.cache.set(key, result, MEMORY_CACHE_TTL_SECONDS);
    } else if (attempts.length === 0) {
      // Definitive miss only: every provider answered no. Anything else
      // (throws, rate-limits) retries on the next lookup.
      await this.cache.set(key, 'none', NONE_TTL_SECONDS);
    } else if (outerAttempts) {
      // Inner lookup was inconclusive — the outer gate must not read this
      // null as a definitive miss.
      outerAttempts.push({ source: 'album-inner' });
    }
    return result;
  }

  public async getArtistImageUrl(artistName?: string, sampleTrack?: string): Promise<string | null> {
    if (!artistName) return null;
    const flightKey = `flight:artist:${artistName.toLowerCase()}:${sampleTrack?.toLowerCase().trim() ?? ''}`;
    return this.joinFlight(flightKey, () => this.resolveArtistImage(artistName, sampleTrack));
  }

  private async resolveArtistImage(artistName: string, sampleTrack?: string): Promise<string | null> {
    // Track-anchored resolution: when the caller's own scrobble (Artist + Track) is
    // known, pin the exact Spotify artist entity instead of trusting a bare
    // name search (which returns the globally-most-popular same-name artist).
    // Anchored results are cached under a track-scoped key and NEVER persisted to
    // the global name-keyed artist row, so colliding artists can't pollute each other.
    if (sampleTrack?.trim()) {
      const anchoredKey = `art:artist:${artistName.toLowerCase()}:via:${sampleTrack.toLowerCase().trim()}`;
      const anchoredCached = await this.cache.get<string>(anchoredKey);
      if (anchoredCached) {
        if (anchoredCached === 'none') return null;
        if (!isPlaceholderImageUrl(anchoredCached)) return anchoredCached;
      }
      // Only a clean run with no hit earns a negative cache — rate limits
      // and throws stay uncached so the next lookup retries.
      let anchoredSettled = false;
      if (!SpotifySearchApi.isRateLimited()) {
        try {
          const artistId = await this.spotifyApi.getArtistIdViaTrackSample(artistName, sampleTrack);
          if (artistId) {
            const artist = await this.spotifyApi.getArtistById(artistId);
            const url = pickLargest(artist?.images);
            if (url && isValidImageUrl(url)) {
              await this.cache.set(anchoredKey, url, MEMORY_CACHE_TTL_SECONDS);
              return url;
            }
          }
          anchoredSettled = true;
        } catch (err) {
          Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: anchored miss');
        }
      }
      if (anchoredSettled) await this.cache.set(anchoredKey, 'none', NONE_TTL_SECONDS);
      // Fall through to the name-based flow as a last resort.
    }

    const key = `art:artist:${artistName.toLowerCase()}`;
    // Hotfix for Jordana — Deezer/Spotify search conflates with Jordana Bryant; force correct Spotify image
    if (artistName.toLowerCase().trim() === 'jordana') {
      const correct = 'https://i.scdn.co/image/ab6761610000e5eb856b7f7308eff9c24c17cb88';
      try {
        const existing = await this.artistRepository.getArtistByName(artistName);
        if (existing && existing.spotifyImageUrl !== correct) {
          await this.artistRepository.setSpotifyImage(existing.artistId, correct, new Date()).catch(() => undefined);
        }
      } catch (err) {
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: DB probe failed (jordana hotfix)');
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
    const attempts: ProviderAttempt[] = [];

    let existing: Awaited<ReturnType<IArtistRepository['getArtistByName']>> | null = null;
    try {
      existing = await this.artistRepository.getArtistByName(artistName);
    } catch (err) {
      Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: DB probe failed — treating as cache miss');
    }
    if (existing?.spotifyImageUrl && this.isFresh(existing.spotifyImageDate) && isValidImageUrl(existing.spotifyImageUrl)) {
      await this.cache.set(key, existing.spotifyImageUrl, MEMORY_CACHE_TTL_SECONDS);
      return existing.spotifyImageUrl;
    }

    // 1. PRIMARY: Query Spotify API first for highest-quality artist profile picture
    if (!result && SpotifySearchApi.isRateLimited()) {
      attempts.push({ source: 'spotify:rate-limited' });
    }
    if (!SpotifySearchApi.isRateLimited()) {
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
        if (url && isValidImageUrl(url) && match) {
          result = url;
          try {
            const target = existing ?? (await this.artistRepository.getOrCreateArtist(artistName));
            await this.artistRepository.setSpotifyImage(target.artistId, url, new Date());
          } catch {
            // ignore persistence failure
          }
        }
      } catch (err) {
        attempts.push({ source: 'spotify' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: spotify miss');
      }
    }

    // 2. FALLBACK 1: If Spotify API missed/rate-limited, check DB for older Spotify, Deezer, or Last.fm image
    if (!result) {
      if (existing?.spotifyImageUrl && isValidImageUrl(existing.spotifyImageUrl)) {
        result = existing.spotifyImageUrl;
      } else if (existing?.deezerImageUrl && isValidImageUrl(existing.deezerImageUrl)) {
        result = existing.deezerImageUrl;
      } else if (existing?.imageUrl && isValidImageUrl(existing.imageUrl)) {
        result = existing.imageUrl;
      }
    }

    // 3. FALLBACK 2: Query Deezer API
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
          if (url && isValidImageUrl(url)) {
            result = url;
            try {
              const target = existing ?? (await this.artistRepository.getOrCreateArtist(artistName));
              await this.artistRepository.setDeezerImage(target.artistId, match.id, url);
            } catch {
              // ignore persistence failure
            }
          }
        }
      } catch (err) {
        attempts.push({ source: 'deezer' });
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
        attempts.push({ source: 'am-web' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Artist art: am-web miss');
      }
    }

    if (!result) {
      let answered = false;
      try {
        const info = await this.lastfmRepository.getArtistInfo(artistName);
        answered = info !== null;
        if (info?.name && info.name.toLowerCase() !== artistName.toLowerCase()) {
          // Last.fm redirected to canonical name (e.g. "Travi$ Scott" -> "Travis Scott")
          const resolvedCanonical = await this.getArtistImageUrl(info.name);
          if (resolvedCanonical) {
            result = resolvedCanonical;
          } else {
            // Inner outcome is opaque (own cache/gate) — treat as
            // inconclusive rather than a definitive miss.
            attempts.push({ source: 'lastfm-redirect:unknown' });
          }
        }
        if (!result) {
          const lfmUrl = info?.imageUrl ?? null;
          if (isValidImageUrl(lfmUrl)) result = lfmUrl;
        }
      } catch {
        attempts.push({ source: 'lastfm' });
        answered = true;
      }
      if (!answered && this.isLastFmUnhealthy()) {
        // Ambiguous null during a hard outage — inconclusive, not definitive.
        attempts.push({ source: 'lastfm:outage' });
      }
    }

    if (result && isPlaceholderImageUrl(result)) result = null;
    if (result) {
      await this.cache.set(key, result, MEMORY_CACHE_TTL_SECONDS);
    } else if (attempts.length === 0) {
      await this.cache.set(key, 'none', NONE_TTL_SECONDS);
    }
    return result;
  }

  public async getTrackCoverUrl(trackName?: string, artistName?: string): Promise<string | null> {
    if (!trackName || !artistName) return null;
    const cleanTrack = sanitizeMusicName(trackName);
    const cleanArtist = stripChannelSuffix(artistName) || artistName.trim();
    const flightKey = `flight:track:${cleanArtist.toLowerCase()}|${cleanTrack.toLowerCase()}`;
    return this.joinFlight(flightKey, () => this.resolveTrackCover(cleanTrack, cleanArtist, trackName, artistName));
  }

  private async resolveTrackCover(
    cleanTrack: string,
    cleanArtist: string,
    trackName: string,
    artistName: string,
  ): Promise<string | null> {
    const key = `art:track:${cleanArtist.toLowerCase()}|${cleanTrack.toLowerCase()}`;

    const cached = await this.cache.get<string>(key);
    if (cached) {
      if (cached === 'none') return null;
      if (isPlaceholderImageUrl(cached)) return null;
      return cached;
    }

    let result: string | null = null;
    const attempts: ProviderAttempt[] = [];

    // Every provider below must match BOTH artist and title. First-result
    // trust is what produced wrong covers (same-title recordings, covers,
    // remixes by other artists) — a miss falls through to the next provider.
    const trackMatches = (
      candidateArtist: string | undefined,
      candidateTitle: string | undefined,
    ): boolean =>
      matchesArtistName(candidateArtist ?? '', cleanArtist) &&
      matchesTrackTitle(candidateTitle ?? '', cleanTrack);

    if (SpotifySearchApi.isRateLimited()) {
      attempts.push({ source: 'spotify:rate-limited' });
    }
    if (!SpotifySearchApi.isRateLimited()) {
      try {
        let tracks = await this.spotifyApi.searchTracks(
          `track:${cleanTrack} artist:${cleanArtist}`,
          10,
        );
        if (tracks.length === 0) {
          tracks = await this.spotifyApi.searchTracks(`${cleanTrack} ${cleanArtist}`, 10);
        }
        const match = tracks.find((t) =>
          (t.artists ?? []).some((a) => matchesArtistName(a.name, cleanArtist)) &&
          matchesTrackTitle(t.name, cleanTrack),
        );
        const url = pickLargest(match?.album?.images);
        if (url) {
          result = url;
          const artistRow = await this.artistRepository.getArtistByName(cleanArtist);
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
        attempts.push({ source: 'spotify' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: spotify miss');
      }
    }

    if (!result) {
      try {
        let tracks = await this.deezerApi.searchTracks(`${cleanTrack} ${cleanArtist}`);
        if (tracks.length === 0) {
          tracks = await this.deezerApi.searchTracks(`${cleanArtist} ${cleanTrack}`);
        }
        const match = tracks.find((t) => trackMatches(t.artist?.name, t.title));
        result = match?.album?.cover_xl ?? match?.album?.cover_big ?? null;
      } catch (err) {
        attempts.push({ source: 'deezer' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: deezer miss');
      }
    }

    if (!result) {
      try {
        const songs = await this.appleMusicWebApi.searchSongs(cleanTrack, cleanArtist);
        const match = songs.find((s) => trackMatches(s.artistName, s.name));
        result = match?.artwork?.url ?? null;
      } catch (err) {
        attempts.push({ source: 'am-web' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: am-web miss');
      }
    }

    if (!result) {
      try {
        const songs = await this.appleMusicApi.searchSongs(cleanTrack, artistName);
        const match = songs.find(
          (s) => s.artworkUrl100 && trackMatches(s.artistName, s.trackName),
        );
        if (match?.artworkUrl100) {
          const upscaled = upscaleArtwork(match.artworkUrl100);
          if (isValidImageUrl(upscaled)) result = upscaled;
        }
      } catch (err) {
        attempts.push({ source: 'itunes' });
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: itunes miss');
      }
    }

    if (!result) {
      let answered = false;
      try {
        const info = await this.lastfmRepository.getTrackInfo(trackName, cleanArtist);
        if (info?.albumName) {
          answered = true;
          result = await this.getAlbumCoverUrl(info.albumName, cleanArtist, attempts);
        }
      } catch (err) {
        attempts.push({ source: 'lastfm' });
        answered = true;
        Logger.debug({ err: String(err).slice(0, 80) }, 'Track art: lastfm miss');
      }
      if (!answered && this.isLastFmUnhealthy()) {
        // Ambiguous null during a hard outage — inconclusive, not definitive.
        attempts.push({ source: 'lastfm:outage' });
      }
    }

    if (result && isPlaceholderImageUrl(result)) result = null;
    if (result) {
      await this.cache.set(key, result, MEMORY_CACHE_TTL_SECONDS);
    } else if (attempts.length === 0) {
      // Definitive miss only — see NONE_TTL_SECONDS.
      await this.cache.set(key, 'none', NONE_TTL_SECONDS);
    }
    return result;
  }

  /**
   * Exact cover fetch by Spotify track ID: one GET, no search, no matching
   * risk. Same cache semantics as the cascade: hits cached 1h, definitive
   * no-art cached 10 min, throws/rate-limits uncached (retry later).
   */
  async getTrackCoverBySpotifyId(id: string): Promise<string | null> {
    if (!/^[\w-]{22}$/.test(id)) return null;
    return this.joinFlight(`flight:spid:${id}`, () => this.resolveTrackCoverBySpotifyId(id));
  }

  private async resolveTrackCoverBySpotifyId(id: string): Promise<string | null> {
    const key = `art:spid:${id}`;
    const hit = await this.cache.get<string>(key);
    if (hit) return hit === 'none' ? null : hit;
    if (SpotifySearchApi.isRateLimited()) return null;
    try {
      const t = await this.spotifyApi.getTrack(id);
      const url = pickLargest(t?.album?.images);
      if (url && isValidImageUrl(url)) {
        await this.cache.set(key, url, MEMORY_CACHE_TTL_SECONDS);
        return url;
      }
      await this.cache.set(key, 'none', NONE_TTL_SECONDS);
      return null;
    } catch {
      return null;
    }
  }

  private isFresh(date?: Date | null): boolean {
    if (!date) {
      return false;
    }
    return Date.now() - date.getTime() < FRESHNESS_WINDOW_MS;
  }

  private async findExistingAlbumRow(albumName: string, artistName: string) {
    // A DB hiccup must degrade to a cache miss, never reject the cascade.
    try {
      const artist = await this.artistRepository.getArtistByName(artistName);
      if (!artist) {
        return null;
      }
      return await this.albumRepository.getAlbumByNameAndArtist(albumName, artist.artistId);
    } catch (err) {
      Logger.debug({ err: String(err).slice(0, 80) }, 'Artwork DB probe failed (album row) — treating as cache miss');
      return null;
    }
  }
}
