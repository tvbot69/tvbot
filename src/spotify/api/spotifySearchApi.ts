import { container } from 'tsyringe';
import { fetchWithTimeout } from '@domain/http/fetchWithTimeout';
import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { TelemetryService } from '@bot/services/system/telemetryService';
import { Logger } from '@domain/logging/logger';
import {
  SPOTIFY_SEARCH_QUERY_MAX,
  clampSpotifyAlbumTracksLimit,
  clampSpotifyArtistAlbumsLimit,
  clampSpotifySearchLimit,
} from '@spotify/api/spotifyApiLimits';
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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

  /**
   * The raised answer for "no token", which has TWO causes and must not report
   * them with one message.
   *
   * `getToken()` answers `null` for both, so this method is what tells them
   * apart — using `credentialCount`, which already exists on the token manager,
   * rather than changing its public shape. The distinction is not cosmetic:
   *
   *   - `credentialCount === 0` means SPOTIFY_CLIENT_ID / _SECRET are absent.
   *     Nothing was ever asked of accounts.spotify.com, and the operator's fix
   *     is to configure the deploy.
   *   - `credentialCount > 0` with a `null` means the credentials WERE
   *     submitted and REFUSED — measured as HTTP 400 `invalid_client` from the
   *     token endpoint, which `SpotifyTokenManager` already reports at ERROR
   *     with the status and the vendor's own code. Calling that "not
   *     configured" sends the operator to configure credentials that are
   *     already configured, while the actual refusal sits in a different log
   *     line. The transient case (a 5xx, or a request that never arrived) also
   *     lands here, so the wording says "configured but no token was issued"
   *     and points at the ERROR line rather than asserting the refusal.
   *
   * The vendor's status and code are deliberately NOT re-read here: they are on
   * the token manager's own ERROR line, and re-deriving that state would be a
   * second classification of the same failure. What is attached is the `cause`
   * that says which of the two situations this was, which is what makes the two
   * distinguishable at the call site.
   */
  private noTokenError(): SpotifyUnavailableError {
    const configured = this.tokenManager.credentialCount;
    if (configured === 0) {
      return new SpotifyUnavailableError(
        'Spotify credentials not configured: no SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET in the pool, so nothing was ever asked of accounts.spotify.com',
      );
    }
    return new SpotifyUnavailableError(
      `Spotify credentials are configured (${String(configured)} in the pool) but no access token was issued — the credential was refused, or the token endpoint was unreachable. The status and the vendor code are on the "[Spotify] Token request failed" ERROR line.`,
      { cause: { kind: 'credentials-refused', credentialCount: configured } },
    );
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
   *
   * 404 is the ONE 4xx that is a miss. Measured 2026-09-30 on
   * `/v1/artists/{id}`: an unknown-but-well-formed id is 404 "Resource not found",
   * while a malformed id is 400 "Invalid base62 id" — a verdict on a request this
   * module built, not on the artist, and the one that must not become a cached
   * `'none'`. There is no 403 to handle on this deploy: a scope failure is a 401
   * (`/v1/me` on a client-credentials token returns 401 "Valid user
   * authentication required"), and 401 is already inconclusive below.
   *
   * A 200 whose body cannot be read raises too, for the same reason the 400
   * does: `artworkService` caches this method's `null` as `'none'`, so a null is
   * a published statement about the artist, and an unreadable body is not one.
   * A 200 that parses and carries no artist IS a miss and stays a null.
   */
  public async getArtistById(artistId: string): Promise<SpotifySearchArtist | null> {
    try {
      if (SpotifySearchApi.isRateLimited()) {
        throw new SpotifyUnavailableError('Spotify cooldown active');
      }
      const token = await this.tokenManager.getToken();
      // Unconfigured credentials never asked Spotify anything, so the null this
      // used to return was indistinguishable from "no such artist" — and that is
      // the value `artworkService` caches as `'none'`. The message also has to
      // keep the two null-token causes apart; see `noTokenError`.
      if (!token) throw this.noTokenError();
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
        // On a client-credentials deploy this is also where a SCOPE problem
        // lands: measured, `/v1/me` answers 401 "Valid user authentication
        // required", never 403.
        throw new SpotifyUnavailableError('Spotify token rejected');
      }
      if (res.status === 429) {
        SpotifySearchApi.handleRateLimit(res);
        throw new SpotifyUnavailableError('Spotify rate limited');
      }
      // 404 is the only status that is an ANSWER about the artist: no such
      // entity, which IS a miss and stays a null. Every other 4xx is a request
      // this module built badly (400 "Invalid base62 id" is the measured shape)
      // and is raised, because `artworkService` caches a null as `'none'` — so a
      // client bug would be published as "this artist has no cover" and, unlike a
      // 5xx, must NOT arm the transport breaker, since re-asking cannot fix it.
      if (res.status === 404) return null;
      if (!res.ok) {
        if (res.status >= 500) SpotifySearchApi.noteTransportFailure();
        throw new SpotifyUnavailableError(`Spotify HTTP ${res.status}`);
      }
      // A 200 that will not PARSE is the same lie as a 400, in a quieter dress.
      // The status says the request succeeded, which is true — but the answer was
      // not delivered in a form anyone can read: a truncated body, a captive
      // portal serving HTML with a 200, a proxy injecting its own page. Answering
      // `null` here said "this artist does not exist", and `artworkService` writes
      // that null into its cache as `'none'`, so ONE unreadable body published
      // "this artist has no cover" for the whole negative-cache TTL and the
      // correct art was never fetched again.
      //
      // A shape surprise is still not an OUTAGE — the request got an answer — so
      // this deliberately does NOT arm the transport breaker, exactly as the 400
      // case above does not. It raises, so the value cannot reach the negative
      // cache, and `artworkService`'s anchored path leaves `anchoredSettled`
      // false (artworkService.ts:537) and falls through to the name-based rungs.
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        throw new SpotifyUnavailableError(
          `Spotify artist response was 200 but the body could not be read: ${String(err)}`,
          { cause: err },
        );
      }
      // A well-formed body that carries no artist is a real answer — a miss — and
      // stays a null. That is the other direction of the same rule: "we could not
      // read it" is inconclusive, "we read it and it holds no such artist" is a
      // verdict. Refusing both would make this method useless to its only caller.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SpotifyUnavailableError(
          'Spotify artist response was 200 but the body was not an artist object',
        );
      }
      const artist = parsed as SpotifySearchArtist;
      if (!artist.id) return null;
      return artist;
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
      // Two causes, two messages: see `noTokenError`. A refused credential must
      // never be reported to the operator as an unconfigured one.
      throw this.noTokenError();
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
      // limit 5 is deliberate and sits well inside the measured ceiling of 50 —
      // see `spotifyApiLimits`. This line used to claim that "limit 15 triggers
      // HTTP 400 for some Arabic queries (e.g. Lege-Cy)" and to retry with a
      // quoted query on any 400. Both were false, and the retry was a no-op for a
      // reason that has nothing to do with the limit:
      //   - The 400 was NEVER the limit. Measured 2026-09-30: limit=15 on
      //     `/v1/search` returns 200 with 15 items, for `test`, `Lege-Cy`,
      //     `Radiohead` and an Arabic query alike. There is no charset bug.
      //   - The one 400 a limit-5 request CAN produce is `q` over 250 raw
      //     characters ("Query exceeds maximum length of 250 characters"), and
      //     unlike `SpotifyResolver.searchTracks` this method never truncated.
      //     The quoted retry made the query LONGER (`artist:"x" track:"y"` is
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
      // Two causes, two messages: see `noTokenError`.
      throw this.noTokenError();
    }

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('type', type);
    // Clamped, because every public entry point above forwards a caller-supplied
    // `limit` straight through. Measured 2026-09-30: the server accepts 50 and
    // returns 50 items, and rejects 51 with 400 "Invalid limit" — the same
    // ceiling, and the same total clamp, as the two limits in
    // `spotifyApiLimits`. Without it a caller asking for more gets a 400, which
    // `search()` raises as inconclusive — the same "never got an answer" signal
    // as a rate limit, for a bug of ours.
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
      // The limit is clamped because a caller can ask for more than the server
      // takes: measured 2026-09-30, `limit=50` returns 50 items and `limit=51`
      // is 400 "Invalid limit". Both collage builders ask for 15, which is inside
      // the range and therefore goes out as 15. They used to be clamped DOWN to
      // 10 — an earlier probe of this file measured a ceiling of 10 that the
      // server does not have, so every Spotify column of every mosaic the bot has
      // ever rendered was a third short, silently, with nothing logged above
      // DEBUG. `include_groups=album,single,appears_on` was probed at every limit
      // from 5 to 50 and is valid. See `spotifyApiLimits` for the probe.
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
        //  - 4xx (401/429 already handled above, so in practice 400 or 404: a
        //    scope failure is a 401 on this deploy, measured, never a 403): a
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

      // The payload carries a `total` (measured 2026-09-30: 60 for Radiohead, and
      // the top-level keys are href, limit, next, offset, previous, total,
      // items). It is deliberately NOT attached to the answer, and it is not a
      // denominator even if someone wanted one: with
      // `include_groups=...,appears_on` that total counts RELEASES THE ARTIST
      // APPEARS ON — other people's compilations and soundtracks — not this
      // artist's artwork, and the list below is smaller again because items with
      // no `images` are dropped and repeated cover URLs are de-duplicated. So
      // `covers.length`, `items.length` and `total` are three different numbers,
      // and reporting any of them as "how many covers this artist has" would be a
      // fresh fabrication rather than a correction of one. The callers render
      // these as collage cells and read no count at all, so a bare list is the
      // whole honest answer.
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
      // any deploy that lost its secrets. Two causes, two messages: see
      // `noTokenError`.
      if (!token) throw this.noTokenError();

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
        // Clamped, TOTAL, through the same measured ceiling as the other two
        // limits: 50 is accepted AND honoured on a 199-track album, 51+ is a 400.
        // This was `Math.min(limit, 50)` — a partial clamp with the ceiling right
        // and no floor, so a caller passing 0 or NaN built a request the server
        // refuses. `albumService` passes 50 and `whoKnowsImageBuilder` passes 5,
        // so nothing in production exercises the floor; that is a reason to clamp,
        // not a reason to leave it open.
        res = await fetchWithTimeout(
          `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=${String(clampSpotifyAlbumTracksLimit(limit))}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
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

