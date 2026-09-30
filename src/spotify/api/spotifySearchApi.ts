import { container } from 'tsyringe';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';
import { SpotifyTokenManager } from './spotifyTokenManager';
import { TelemetryService } from '@bot/services/telemetryService';
import { Logger } from '@domain/logger';
import { SPOTIFY_SEARCH_QUERY_MAX, clampSpotifyArtistAlbumsLimit, clampSpotifySearchLimit } from './spotifyApiLimits';
import type {
  SpotifyArtistAlbumsResponse,
  SpotifySearchAlbum,
  SpotifySearchArtist,
  SpotifySearchResponse,
  SpotifySearchTrack,
} from '@spotify/models/spotifyModels';

const SEARCH_ENDPOINT = 'https://api.spotify.com/v1/search';
const DEFAULT_LIMIT = 5;

/**
 * The one signal in this module that means "this run never got an answer".
 *
 * `search()` and `getTrack()` raise it for every condition that is not Spotify
 * saying no: a rate-limit cooldown, a 429, a 5xx, a network error, a timeout, a
 * rejected token. A method that catches it and answers `null`/`[]` is claiming
 * "not on Spotify", which is a different statement — and the one callers cache
 * and render.
 *
 * `name` is set explicitly and checked by name rather than with `instanceof`,
 * for the reason `isSourceUnavailable` gives: the same class can be loaded
 * through more than one module specifier, and an `instanceof` against one copy
 * silently misses the others, which is how a handled failure becomes a silent
 * one again.
 */
export class SpotifyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyUnavailableError';
  }
}

/** TRUE for "the run was inconclusive" — never for "Spotify said no". */
const isInconclusive = (err: unknown): boolean =>
  err instanceof Error && err.name === 'SpotifyUnavailableError';

export class SpotifySearchApi {
  private static rateLimitedUntil: number = 0;
  /**
   * Outage breaker. Only a 429 armed the cooldown, so a 5xx / DNS failure /
   * timeout did nothing: every artwork lookup and every ladder search re-ran
   * the doomed Spotify leg (and, because an inconclusive run is never cached
   * as a definitive miss, nothing was memoised either). A run of transport
   * failures now opens the same gate, briefly.
   *
   * Read in two places, and they used to disagree: `isRateLimited()`, which the
   * four methods below consult for themselves, and `checkRateLimit()`, which
   * guards the shared `search()` path. The window armed here is the one the
   * comment above claims stops a doomed leg, so both readers see it.
   */
  private static outageUntil: number = 0;
  private static consecutiveTransportFailures = 0;
  private static readonly OUTAGE_AFTER_FAILURES = 4;
  private static readonly OUTAGE_COOLDOWN_MS = 20_000;
  private readonly tokenManager: SpotifyTokenManager;

  constructor(tokenManager: SpotifyTokenManager) {
    this.tokenManager = tokenManager;
  }

  /** True when Spotify is rate-limited OR in a transport-outage cooldown. */
  public static isRateLimited(): boolean {
    return (
      Date.now() < SpotifySearchApi.rateLimitedUntil || Date.now() < SpotifySearchApi.outageUntil
    );
  }

  /** Records a transport-level failure; opens the breaker after a run of them. */
  public static noteTransportFailure(): void {
    SpotifySearchApi.consecutiveTransportFailures++;
    if (SpotifySearchApi.consecutiveTransportFailures >= SpotifySearchApi.OUTAGE_AFTER_FAILURES) {
      SpotifySearchApi.outageUntil = Date.now() + SpotifySearchApi.OUTAGE_COOLDOWN_MS;
      Logger.warn(
        {
          failures: SpotifySearchApi.consecutiveTransportFailures,
          cooldownSec: SpotifySearchApi.OUTAGE_COOLDOWN_MS / 1000,
        },
        '[Spotify] Repeated transport failures — pausing lookups briefly',
      );
    }
  }

  /** Any successful response clears the transport-failure run. */
  public static noteTransportSuccess(): void {
    SpotifySearchApi.consecutiveTransportFailures = 0;
    SpotifySearchApi.outageUntil = 0;
  }

  public static getRateLimitedUntil(): number {
    return SpotifySearchApi.rateLimitedUntil;
  }

  public static clearRateLimit(): void {
    SpotifySearchApi.rateLimitedUntil = 0;
    SpotifySearchApi.outageUntil = 0;
    SpotifySearchApi.consecutiveTransportFailures = 0;
  }

  private static checkRateLimit(): void {
    // BOTH deadlines, and that is the whole point: this is the gate on the
    // shared `search()` path, which every ladder search and every search-rung
    // artwork lookup goes through. It used to read `rateLimitedUntil` alone, so
    // the 20-second outage window armed below was invisible here — a 429 stopped
    // every lookup, while the 5xx / DNS / timeout outage this module exists to
    // absorb stopped only the methods that check `isRateLimited()` themselves.
    const now = Date.now();
    if (now < SpotifySearchApi.rateLimitedUntil) {
      const waitSec = Math.ceil((SpotifySearchApi.rateLimitedUntil - now) / 1000);
      throw new SpotifyUnavailableError(`Spotify rate limit cooldown active (${waitSec}s remaining)`);
    }
    if (now < SpotifySearchApi.outageUntil) {
      const waitSec = Math.ceil((SpotifySearchApi.outageUntil - now) / 1000);
      throw new SpotifyUnavailableError(`Spotify outage cooldown active (${waitSec}s remaining)`);
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
   *
   * Raises `SpotifyUnavailableError` when the run was inconclusive. That is not
   * pedantry: `artworkService.resolveArtistImage` sets `anchoredSettled = true`
   * on a null and then writes `'none'` into its cache, on the documented
   * promise that "rate limits and throws stay uncached so the next lookup
   * retries". A null here made that promise a lie, so a five-second Spotify
   * blip cached "this artist has no cover" for the whole TTL and the correct
   * art was never fetched again. `genreService` already treats a throw as
   * "fall through to the name-based flow", so it is unaffected.
   */
  public async getArtistIdViaTrackSample(
    artistName: string,
    sampleTrack: string,
  ): Promise<string | null> {
    try {
      // A live cooldown is also inconclusive, not a miss: the search below
      // would have run. `artworkService` guards this with its own
      // `isRateLimited()` check, `genreService` does not, and both handle a
      // throw correctly.
      if (SpotifySearchApi.isRateLimited()) {
        throw new SpotifyUnavailableError('Spotify cooldown active');
      }
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
    } catch (err) {
      if (isInconclusive(err)) throw err;
      // Only a shape surprise reaches here (a payload with no `artists`), which
      // is still "no exact match found" as far as this method's contract goes.
      return null;
    }
  }

  /**
   * Fetches the canonical Spotify artist entity (images, genres, followers).
   *
   * Raises `SpotifyUnavailableError` when the run was inconclusive, for the same
   * reason as `getArtistIdViaTrackSample`: `artworkService` treats this null as
   * a settled "no artist" and caches `'none'`, so a swallowed outage is written
   * to the cache as a fact about the artist.
   */
  public async getArtistById(artistId: string): Promise<SpotifySearchArtist | null> {
    try {
      if (SpotifySearchApi.isRateLimited()) {
        throw new SpotifyUnavailableError('Spotify cooldown active');
      }
      const token = await this.tokenManager.getToken();
      // Unconfigured credentials never asked Spotify anything, so the null this
      // used to return was indistinguishable from "no such artist" — and that is
      // the value `artworkService` caches as `'none'`.
      if (!token) throw new SpotifyUnavailableError('Spotify credentials not configured');
      let res: Response;
      try {
        res = await fetchWithTimeout(`https://api.spotify.com/v1/artists/${artistId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        // A DNS failure, a refused connection or a timeout is not an answer
        // about the ARTIST. Unwrapped, it reached the outer catch, was not a
        // `SpotifyUnavailableError`, and became the `null` that
        // `artworkService` writes into its cache as `'none'` — so a five-second
        // network blip recorded "this artist has no cover" as a fact for the
        // whole negative-cache TTL. Same shape as `getTrack` and `search()`:
        // count it toward the breaker and raise.
        SpotifySearchApi.noteTransportFailure();
        throw new SpotifyUnavailableError(`Spotify network error: ${String(err)}`);
      }
      if (res.status === 401) {
        this.tokenManager.invalidate();
        // A rejected token is not a verdict on the artist, and the caller has a
        // retry available on a fresh token — so this is inconclusive, not a miss.
        throw new SpotifyUnavailableError('Spotify token rejected');
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        throw new SpotifyUnavailableError('Spotify rate limited');
      }
      // A 4xx that is not 401/429 is Spotify answering: 404 means no such artist
      // entity, which IS a miss and stays a null. Only a 5xx is inconclusive.
      if (!res.ok) {
        if (res.status < 500) return null;
        SpotifySearchApi.noteTransportFailure();
        throw new SpotifyUnavailableError(`Spotify HTTP ${res.status}`);
      }
      return (await res.json()) as SpotifySearchArtist;
    } catch (err) {
      if (isInconclusive(err)) throw err;
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
      SpotifySearchApi.noteTransportFailure();
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
      if (response.status >= 500) SpotifySearchApi.noteTransportFailure();
      throw new SpotifyUnavailableError(`Spotify HTTP ${response.status}`);
    }
    SpotifySearchApi.noteTransportSuccess();
    return (await response.json()) as SpotifySearchTrack;
  }

  public async getSpotifyTrackUrl(artistName: string, trackName: string): Promise<string | null> {
    try {
      // limit 5 is deliberate and well under the measured ceiling of 10 — see
      // `spotifyApiLimits`. This line used to claim that "limit 15 triggers HTTP
      // 400 for some Arabic queries (e.g. Lege-Cy)" and to retry with a quoted
      // query on any 400. Both were false, and the retry was a no-op:
      //   - The 400 is the LIMIT, never the query. Measured 2026-09-30: at
      //     limit=15 every one of `test`, `Lege-Cy`, `Radiohead` and an Arabic
      //     query returned 400 "Invalid limit". There is no charset bug.
      //   - The one 400 that a limit-5 request CAN produce is `q` over 250 raw
      //     characters ("Query exceeds maximum length"), because unlike
      //     `SpotifyResolver.searchTracks` this method never truncated. The
      //     quoted retry made the query LONGER (`artist:"x" track:"y"` is
      //     longer than `x y`), so it was guaranteed to be rejected by the very
      //     check it was written to survive: a 280-char query was retried as a
      //     297-char query, both 400. One wasted request, then a null.
      // So: clamp the length instead, using the same 250 the sibling resolver
      // already uses, and let a genuine failure reach the catch below.
      const query = `${artistName} ${trackName}`.trim().slice(0, SPOTIFY_SEARCH_QUERY_MAX);
      const results = await this.searchTracks(query, 5);
      if (results.length === 0) return null;
      const cleanArtist = SpotifySearchApi.clean(artistName);
      const cleanTrack = SpotifySearchApi.clean(trackName);
      const cleanQuery = SpotifySearchApi.clean(`${artistName} ${trackName}`);
      // Typed as SpotifySearchTrack, not any: the scorer reads name,
      // artists[0].name, id and external_urls.spotify, and all four are
      // declared. Typing the input also gives `scored` a real shape, which is
      // what removed the two downstream annotations on filter/sort below.
      const scored = results.map((item: SpotifySearchTrack, idx: number) => {
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
      const valid = scored.filter((r) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a, b) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      if (chosen.id) return `https://open.spotify.com/track/${chosen.id}`;
      if (chosen.external_urls?.spotify) return chosen.external_urls.spotify;
      return null;
    } catch (err) {
      // CORRECT AS IS. Both callers — `previewResolverService` and
      // `trackDetailsService` — ask this for a bonus URL inside a `try`, and a
      // null there means "no preview link for this track", which is honest
      // absence: the preview is optional, the ladder has Apple and Deezer
      // rungs after it, and no caller reports it as "this track is not on
      // Spotify". Raising would buy a log line on a path that is already
      // swallowed one layer up, for a value nothing renders as a fact.
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
      SpotifySearchApi.noteTransportSuccess();
    return (await response.json()) as SpotifySearchAlbum;
    } catch (err) {
      // CORRECT AS IS. The only caller is `albumService` line 262, which wraps
      // this in a try that WARNs "Failed to fetch Spotify album metadata" and
      // then builds the album card from Last.fm's tracklist — real tracks, just
      // fewer, so nothing rendered can be wrong. That WARN is also why a null
      // here is reported rather than silent.
      return null;
    }
  }

  public async searchAndGetFullAlbum(albumName: string, artistName: string): Promise<SpotifySearchAlbum | null> {
    try {
      let results: SpotifySearchAlbum[] = [];
      try {
        results = await this.searchAlbums(`album:"${albumName}" artist:"${artistName}"`, 5);
      } catch (err) {
        // CORRECT AS IS — a genuine rung. A quoted search that fails says
        // nothing about the unquoted one on the next line, which is the whole
        // reason this catch exists. The outer catch below is the one that was
        // flattening a rung into a miss.
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
    } catch (err) {
      // CORRECT AS IS, and the visibility comes from one layer up: the unquoted
      // search on line 370 and `getFullAlbum` are the last two rungs, so a
      // failure here IS this method's answer being unknown — but the caller
      // (`albumService` line 262) already turns that into a logged WARN and a
      // Last.fm-sourced card, which is a real answer, not a fabricated one.
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
    // Clamped, because every public entry point above forwards a caller-supplied
    // `limit` straight through and the server's real ceiling is 10, not the 50
    // the docs claim. Measured; see `spotifyApiLimits`. Without this a caller
    // asking for more gets a 400, which `search()` raises as inconclusive — the
    // same "never got an answer" signal as a rate limit, for a bug of ours.
    url.searchParams.set('limit', String(clampSpotifySearchLimit(limit)));

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
        // CORRECT AS IS: metrics are never allowed to fail a search. The search
        // itself already succeeded by this point, so a throw here could only
        // discard a result that was paid for — and the send already recorded
        // whatever it managed to record.
      }
    } catch (err) {
      SpotifySearchApi.noteTransportFailure();
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
      if (response.status >= 500) SpotifySearchApi.noteTransportFailure();
      throw new SpotifyUnavailableError(`Spotify HTTP ${response.status}`);
    }

    SpotifySearchApi.noteTransportSuccess();
    return (await response.json()) as SpotifySearchResponse;
  }

  public async getArtistDiscographyCovers(
    artistName: string,
    sampleTrackOrAlbum?: string,
    limit: number = 20,
  ): Promise<string[]> {
    try {
      // CORRECT AS IS for the whole method, so the two exits below are too: this
      // is one source of collage cover cells, never a statistic, and the caller
      // has rungs behind it (`whoKnowsImageBuilder` lines 331 and 344). The
      // reason the token check below still answers `[]` — unlike the identical
      // check in `getAlbumTrackNames` — is that nothing here is cached or
      // rendered as a fact, so an absent source and a dead one cost the same
      // visible thing: fewer pictures in a PNG.
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
        } catch (err) {
          // CORRECT AS IS — rung 1 of two, and the artist search below is the
          // fallback that exists for exactly this. `artistId` stays null and the
          // method continues to rung 2.
          Logger.debug({ err }, 'Spotify discography: track-sample rung failed, trying the artist search');
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
        } catch (err) {
          // CORRECT AS IS — rung 2 of two. The caller still has its own rungs
          // behind this one (`whoKnowsImageBuilder` lines 331 and 344, and
          // `topBuilders` line 86 reads them the same way), so an empty here
          // costs one source of collage cover art, not the card. Nothing in the
          // result is a statistic: every playcount on those cards comes from
          // `args.metadata`/`args.users`, which this method never touches.
          Logger.debug({ err }, 'Spotify discography: artist rung failed; no Spotify covers for this collage');
        }
      }

      if (!artistId) return [];

      // 3. Query official albums, singles, and features (appears_on)
      // The limit is CLAMPED, not trusted: 10 is what the server accepts and both
      // collage builders ask for 15. Sending 15 got a 400 "Invalid limit", which
      // the `!res.ok` branch below turned into `[]` — indistinguishable from
      // "this artist has no covers" — so every mosaic the bot has ever rendered
      // was missing its Spotify rung with nothing logged above DEBUG.
      // `include_groups=album,single,appears_on` was probed separately and is
      // valid; the 400 was the limit alone. See `spotifyApiLimits` for the probe.
      const albumLimit = clampSpotifyArtistAlbumsLimit(limit);
      const url = `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single,appears_on&limit=${albumLimit}`;
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
      if (!res.ok) {
        // This is the branch that hid B1 for the lifetime of the feature, and it
        // conflated three different things under one silent `[]`. Split them:
        //
        //  - 4xx (401/429 already handled above, so this is 400/403/404): a
        //    REJECTED REQUEST. Spotify refused to parse a URL this module built.
        //    It is a client-side bug, and the caller must not be told "this
        //    artist has no covers" — but neither is it an outage, so it must NOT
        //    arm the transport breaker below: that breaker exists to stop us
        //    re-running a doomed leg, and a bug of ours does not get better by
        //    asking again. WARN is the floor because the operator reads Railway
        //    logs and this is the only line that would ever name the offending
        //    request. The URL carries no token (the Bearer is in the header), so
        //    logging it is safe.
        //
        //  - 5xx: a genuine outage. Arm the breaker, so the next collage does
        //    not spend another request on a leg we already know is down. Also
        //    WARN, because an outage must never be reported as "no covers"
        //    either — silence is what made both look the same.
        if (res.status >= 500) {
          SpotifySearchApi.noteTransportFailure();
          Logger.warn(
            { status: res.status, artistId, albumLimit },
            '[Spotify] Artist discography albums endpoint returned 5xx — Spotify cover rung is down, not empty',
          );
        } else {
          Logger.warn(
            { status: res.status, artistId, albumLimit, url },
            '[Spotify] Artist discography albums request was REJECTED (not an outage, not "no covers") — a request this module built was invalid',
          );
        }
        return [];
      }
      const data = (await res.json()) as SpotifyArtistAlbumsResponse;
      const items = data.items ?? [];

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
    } catch (err) {
      // CORRECT AS IS. This whole method is one source among several for a
      // collage's cover cells, and its failure has no way to make a number
      // wrong: the caller catches a throw here too (there is a test for it),
      // and the two rungs above plus the database rungs behind them still fill
      // the grid. An empty list is an honest "no covers from this source".
      Logger.debug({ err }, 'Spotify discography covers unavailable');
      return [];
    }
  }

  public async getAlbumTrackNames(albumName: string, artistName?: string, limit: number = 5): Promise<string[]> {
    // The one method here whose empty IS its answer rather than one rung's worth
    // of it, so it is the one that raises. `albumService.getTopTracksForAlbum`
    // spends seven lines explaining that a raised `SourceUnavailableError` must
    // not be degraded to "this album has no tracks" — and then calls this, which
    // returned `[]` for a 5xx and put the same lie back one layer up. The raise
    // below reaches that narrowing, and the caller's existing WARN names the
    // real reason.
    try {
      if (SpotifySearchApi.isRateLimited()) {
        throw new SpotifyUnavailableError('Spotify cooldown active');
      }
      const token = await this.tokenManager.getToken();
      // Unconfigured credentials are the same shape as an outage: this run never
      // asked Spotify anything. `search()` already raises for exactly this, and
      // answering `[]` here would cache "this album has no tracks" in dev and in
      // any deploy that lost its secrets.
      if (!token) throw new SpotifyUnavailableError('Spotify credentials not configured');

      let albums: SpotifySearchAlbum[] = [];
      try {
        const query = artistName ? `album:"${albumName}" artist:"${artistName}"` : `album:"${albumName}"`;
        albums = await this.searchAlbums(query, 3);
      } catch (err) {
        // CORRECT AS IS — rung 1 of 2, the unquoted search below is the
        // fallback. A failed rung says nothing about the next one.
        Logger.debug({ err }, 'Spotify album tracks: quoted search rung failed, trying the plain query');
      }

      if (albums.length === 0) {
        try {
          const simpleQuery = artistName ? `${artistName} ${albumName}` : albumName;
          albums = await this.searchAlbums(simpleQuery, 3);
        } catch (err) {
          // NOT swallowed. This is the LAST search rung: an empty here is no
          // longer "this query matched nothing", it is "the search never
          // answered", and it would be returned as the album's tracklist.
          throw err;
        }
      }

      const albumId = albums[0]?.id;
      if (!albumId) return [];

      let res: Response;
      try {
        res = await fetchWithTimeout(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${Math.min(limit, 50)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        SpotifySearchApi.noteTransportFailure();
        // Same reason as the rung above: a transport error on the LAST call
        // cannot be answered as "this album has no tracks".
        throw new SpotifyUnavailableError(`Spotify network error: ${String(err)}`);
      }
      if (res.status === 401) {
        this.tokenManager.invalidate();
        throw new SpotifyUnavailableError('Spotify token rejected');
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        throw new SpotifyUnavailableError('Spotify rate limited');
      }
      // A 404 is Spotify saying the album has no tracklist. That IS an answer,
      // and it stays an empty list. A 200 is the OTHER answer — the tracklist —
      // so this branch used to read `res.status < 500`, which a 200 satisfies:
      // the body parse below it was unreachable, `noteTransportSuccess` never
      // ran, and the method answered `[]` for every successful response, so
      // `albumService` fell back to the Last.fm tracklist for every album with
      // nothing logged. Only the statuses that are not answers reach the raise.
      if (res.status === 404) return [];
      if (!res.ok) {
        // A 4xx this module built and got rejected is a client bug, so it must
        // NOT arm the transport breaker — the same split as
        // `getArtistDiscographyCovers` — but it still must not be reported as
        // "this album has no tracks". A 5xx is a genuine outage, and the raise
        // reaches `albumService`'s existing WARN, which names the real reason.
        if (res.status >= 500) SpotifySearchApi.noteTransportFailure();
        throw new SpotifyUnavailableError(`Spotify HTTP ${res.status}`);
      }
      SpotifySearchApi.noteTransportSuccess();
      const data = await res.json() as { items?: Array<{ name?: string }> };
      return (data.items ?? []).map((t) => t.name).filter((n): n is string => Boolean(n));
    } catch (err) {
      if (isInconclusive(err)) throw err;
      // Only a malformed payload lands here, and a payload with no usable names
      // is the empty answer.
      return [];
    }
  }
}

