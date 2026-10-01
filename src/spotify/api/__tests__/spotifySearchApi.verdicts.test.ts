import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { SpotifySearchApi, SpotifyUnavailableError } from '@spotify/api/spotifySearchApi';
import type { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { TelemetryService } from '@bot/services/system/telemetryService';
import { ArtworkService } from '@bot/services/media/artworkService';
import type { CacheService } from '@bot/services/system/cacheService';
import type { DeezerApi } from '@deezer/api/deezerApi';
import type { AppleMusicWebApi } from '@applemusic/api/appleMusicWebApi';
import type { AppleMusicSearchApi } from '@applemusic/api/appleMusicSearchApi';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { Logger } from '@domain/logger';

/**
 * Which failures are MISSES and which are INCONCLUSIVE.
 *
 * The distinction is the whole point of `SpotifyUnavailableError`. A method that
 * answers `null` is claiming "not on Spotify", and callers cache and render
 * that. A method that raises is claiming "this run never got an answer", and
 * callers retry. `getArtistById`, `getTrack` and `getFullAlbum` disagree with
 * each other about which of their failures are which, and the disagreement is
 * what this file measures — including one place where the current behaviour
 * contradicts the method's own documentation (see the marked test).
 *
 * VENDOR ASSUMPTIONS encoded here, and what the live probe made of each one
 * (`scripts/liveVerify.ts`, 2026-09-30):
 *   - a 404 from `/v1/artists/{id}` means "no such artist" (a miss). CONFIRMED:
 *     an unknown-but-well-formed id is 404 "Resource not found".
 *   - a MALFORMED id is 400 "Invalid base62 id" — a verdict on a request this
 *     module built, not on the artist, so it raises instead of answering null.
 *     CONFIRMED, and it is the status that replaced the phantom 403 below.
 *   - a 401 means "the bearer token was rejected" (inconclusive, and the only
 *     status that invalidates the cached token). CONFIRMED for a missing or
 *     garbage bearer on `/v1/artists/{id}`.
 *   - a SCOPE problem is a 401 on this deploy, never a 403: `/v1/me` on a
 *     client-credentials token returns 401 "Valid user authentication required".
 *     CONFIRMED. An earlier version of this file carried a 403 test justified as
 *     "a scope problem"; on a client-credentials deploy that status cannot occur,
 *     so the test described a failure mode the bot can never reach, and the 401
 *     branch that actually catches it was the untested one.
 *   - a 429 carries `Retry-After` in seconds, and means the CREDENTIAL is
 *     rate-limited rather than the app. NOT VERIFIED: a 429 cannot be induced
 *     without provoking the vendor.
 *   - only a 5xx counts toward the transport-outage breaker: a 4xx is a bad
 *     request of ours and asking again cannot fix it. Same caveat — a 5xx cannot
 *     be induced either, so the breaker thresholds are pinned with doubles and
 *     the "only 5xx" half rests on the 400 case below, which was observed shape.
 */

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  }) as unknown as Response;

const fetchFails = (): never => {
  throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
};

const build = (token: string | null = 'test-token', credentialCount = token === null ? 0 : 1) => {
  const getToken = vi.fn(async (): Promise<string | null> => token);
  const invalidate = vi.fn();
  const rotateCredential = vi.fn((): boolean => false);
  const tokenManager = {
    getToken,
    invalidate,
    rotateCredential,
    // Read by `noTokenError()` to tell "unconfigured" from "refused". Real value:
    // `SpotifyTokenManager.credentialCount` counts the credentials in the pool.
    credentialCount,
  } as unknown as SpotifyTokenManager;
  return { api: new SpotifySearchApi(tokenManager), getToken, invalidate, rotateCredential };
};

beforeEach(() => {
  SpotifySearchApi.clearRateLimit();
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  container.clearInstances();
  SpotifySearchApi.clearRateLimit();
});

// ---------------------------------------------------------------------------
// getArtistById
// ---------------------------------------------------------------------------

describe('getArtistById — only a 404 is a miss, everything else is inconclusive', () => {
  it('answers null for a 404, which is Spotify saying there is no such artist', async () => {
    // VENDOR ASSUMPTION: 404 on /v1/artists/{id} == unknown artist. If that ever
    // stops being true this becomes a wrong "no art for this artist" rather than
    // an empty answer.
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));

    await expect(api.getArtistById('no-such-artist')).resolves.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('RAISES on a 400 from a malformed id, because a request we built is not a verdict on the artist', async () => {
    // The status the 403 test used to stand for. MEASURED 2026-09-30:
    // `/v1/artists/%20`, `/v1/artists/!!` and `/v1/artists/a` each return 400
    // `{"error":{"status":400,"message":"Invalid base62 id"}}`, while a
    // well-formed but unknown id returns 404. Those are opposites: one is a fact
    // about the ARTIST and one is a fact about our URL.
    //
    // This used to be answered `null`, because the branch read
    // `if (res.status < 500) return null`. That is the A1 failure in miniature:
    // `artworkService` writes a null into its cache as `'none'`, so a malformed
    // or hand-edited cached id published "this artist has no cover" for the whole
    // negative-cache TTL, and nothing above DEBUG said why. The 404 test above
    // must keep answering null — fixing one by inverting the other would swap one
    // lie for another.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 400));

    await expect(api.getArtistById('a')).rejects.toThrow(/HTTP 400/);
  });

  it('does not arm the transport breaker for a 400, because a bug of ours does not get better by asking again', async () => {
    // Six rejected requests, none of which counts as an outage. The breaker exists
    // to stop us re-running a leg that is known to be down; a mis-formed request
    // is not down, and the next attempt is identically mis-formed. Arming it would
    // also report a client bug as an outage, which is the other half of the lie.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 400));

    for (let i = 0; i < 6; i++) {
      await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('treats a SCOPE problem as inconclusive, because on this deploy it arrives as a 401', async () => {
    // MEASURED 2026-09-30: `/v1/me` on a client-credentials token is 401 "Valid
    // user authentication required" — there is no 403 on this deploy. So the
    // question "is a scope problem a miss or inconclusive?" has one branch, the
    // 401 one, and the answer must be inconclusive: a scope problem is a fact
    // about the deployment, not about the artist, and answering null would cache
    // `'none'` in `artworkService` and suppress the correct art for the whole TTL.
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));

    await expect(api.getArtistById('4Z8W4fKeB5YxbusRsdQVPb')).rejects.toThrow(/token rejected/i);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('RAISES on a 5xx rather than reporting "this artist does not exist"', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));

    await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);
  });

  it('arms the transport breaker on the fourth consecutive 5xx', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 502));

    for (let i = 0; i < 3; i++) {
      await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);
      expect(SpotifySearchApi.isRateLimited(), `after failure ${String(i + 1)}`).toBe(false);
    }
    await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('a 401 invalidates the cached token and RAISES, because the token is not a verdict on the artist', async () => {
    // VENDOR ASSUMPTION: 401 == rejected bearer. Note the asymmetry with the 404
    // above: 401 is inconclusive (the caller has a retry on a fresh token) while
    // 404 is a miss. Both are 4xx.
    const { api, invalidate } = build();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));

    await expect(api.getArtistById('a')).rejects.toThrow(/token rejected/i);
    expect(invalidate).toHaveBeenCalledTimes(1);
    // No retry here, unlike `search()` and `getTrack`: one wasted round trip,
    // but only one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 429 opens the cooldown and RAISES, without invalidating the token', async () => {
    // A rate limit is not a credential problem. Invalidating on a 429 would
    // throw away a perfectly good token and buy an extra auth round trip.
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '7' }));

    await expect(api.getArtistById('a')).rejects.toThrow(/rate limited/i);
    expect(invalidate).not.toHaveBeenCalled();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('RAISES rather than asking Spotify at all while the cooldown is live', async () => {
    const { api, getToken } = build();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '30' }));
    await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);

    fetchMock.mockClear();
    getToken.mockClear();
    await expect(api.getArtistById('a')).rejects.toThrow(/cooldown active/i);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RAISES when there are NO credentials, because nothing was ever asked', async () => {
    // `artworkService.resolveArtistImage` writes `'none'` into its cache on a
    // null. A deploy that lost its secrets must not be recorded as "this artist
    // has no cover", so unconfigured raises exactly like an outage does.
    //
    // The message is also the operator's instruction, so it names the actual
    // fault: no credential in the pool, nothing was asked of Spotify.
    const { api } = build(null, 0);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.getArtistById('a')).rejects.toThrow(/credentials not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT call a REFUSED credential unconfigured, because that sends the operator to fix the wrong thing', async () => {
    // The classified outcome: credentials ARE configured, they were submitted,
    // and accounts.spotify.com refused them with 400 `invalid_client` — which
    // `SpotifyTokenManager` already reports at ERROR with the status and the
    // vendor's code. `getToken()` answers `null` for that, exactly as it does
    // for an absent credential, so this message used to read "Spotify
    // credentials not configured" for a deploy whose credentials are configured.
    // The operator is then sent to configure credentials that exist, while the
    // real refusal sits on a different log line.
    //
    // Pinned separately from the test above on purpose: one message covering both
    // cases is what let a refused credential be reported as unconfigured.
    const { api } = build(null, 1);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const raised = await api.getArtistById('a').then(
      () => null,
      (err: unknown) => err,
    );

    expect(raised).toBeInstanceOf(SpotifyUnavailableError);
    const message = (raised as Error).message;
    expect(message).toMatch(/configured/i);
    expect(message).not.toMatch(/not configured/i);
    // Names the pool size and points at the line that carries the status/code,
    // so the two log lines join up instead of contradicting each other.
    expect(message).toContain('1 in the pool');
    expect(message).toMatch(/Token request failed/);
    // The underlying cause rides along, so a call site can branch on it rather
    // than regexing a message.
    expect((raised as Error).cause).toMatchObject({ kind: 'credentials-refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused credential is reported the same way on every method that raises for a null token', async () => {
    // The wording is centralised in `noTokenError()` precisely so it cannot
    // drift per method. All four `!token` sites share one message pair, and this
    // pins the two that have their own tests below plus `search()` — a method
    // that used to carry the same wrong sentence.
    const { api } = build(null, 2);
    vi.spyOn(globalThis, 'fetch');

    for (const run of [
      () => api.getArtistById('a'),
      () => api.getTrack('t1'),
      () => api.searchArtists('radiohead'),
      () => api.getAlbumTrackNames('Geogaddi', 'Boards of Canada'),
    ]) {
      const raised = await run().then(
        () => null,
        (err: unknown) => err as Error,
      );
      expect(raised, 'must raise rather than answer a miss').toBeInstanceOf(SpotifyUnavailableError);
      expect(raised?.message, 'must not blame an absent credential').not.toMatch(/not configured/i);
      expect(raised?.message).toContain('2 in the pool');
    }
  });

  it('RAISES on a network failure, because nothing asked Spotify anything', async () => {
    // The gap this test used to document, inverted. `getTrack` wraps its fetch in
    // a try and raises `Spotify network error`; `getArtistIdViaTrackSample`
    // reaches that code through `search()`. `getArtistById` did not, so a DNS
    // failure or a timeout fell to the outer catch, was not a
    // `SpotifyUnavailableError`, and was answered with `null` — the value
    // `artworkService` then caches as `'none'` (artworkService.ts:543). A
    // five-second DNS blip therefore recorded "this artist has no cover" as a
    // FACT for the whole negative-cache TTL, which is what the doc comment
    // above the method describes as the danger rather than as a justification.
    //
    // The paired half is the 404 test above, which must still answer null: a
    // transport failure and Spotify saying "no such artist" are opposites, and
    // fixing one by inverting the other would swap one lie for another.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFails);

    await expect(api.getArtistById('a')).rejects.toThrow(/network error/i);
  });

  it('counts a network failure toward the transport-outage breaker, like getTrack', async () => {
    // Not decoration: the breaker is the mechanism that stops the next artwork
    // lookup re-running the doomed leg, and it only advances if the failure is
    // recorded where it happens rather than swallowed.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFails);

    for (let i = 0; i < 3; i++) {
      await expect(api.getArtistById('a')).rejects.toThrow(/network error/i);
      expect(SpotifySearchApi.isRateLimited(), `after failure ${String(i + 1)}`).toBe(false);
    }
    await expect(api.getArtistById('a')).rejects.toThrow(/network error/i);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('RAISES on a timeout, which is the same story as a refused connection', async () => {
    // `fetchWithTimeout` converts an abort into a plain `Error`, so this is not a
    // `TypeError` and it is not a `DOMException` either — the case a
    // name-based inconclusive check has to survive.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Fetch timed out after 10000ms for https://api.spotify.com/v1/artists/a');
    });

    await expect(api.getArtistById('a')).rejects.toThrow(/network error/i);
  });

  it('RAISES on a 200 whose body cannot be parsed, because an unreadable answer is not "no such artist"', async () => {
    // THE INVERSION. This test used to assert that a 200 with an unparseable body
    // `resolves.toBeNull()`, on the reasoning that "a shape surprise is not a
    // verdict". The reasoning was right about the status and wrong about the
    // consequence: `artworkService.resolveArtistImage` treats this null as a
    // SETTLED miss and writes `'none'` into its cache (artworkService.ts:542), so
    // one malformed body — a truncated response, or a captive-portal HTML page
    // served with a 200 — published "this artist has no cover" for the whole
    // negative-cache TTL. That is the same lie as the 400 case above, reached
    // through a different door: a source that could not be READ recorded as a
    // verdict about the world.
    //
    // It is also a shape surprise rather than an outage, so it must NOT arm the
    // transport breaker — the request did get an answer. Pinned below.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    await expect(api.getArtistById('a')).rejects.toThrow(SpotifyUnavailableError);
    await expect(api.getArtistById('a')).rejects.toThrow(/could not be read/i);
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('a 200 whose body is a truncated or non-object payload RAISES too', async () => {
    // The other unreadable shapes a proxy or a captive portal produces. Each is
    // reachable with a 200 and none of them is an artist, so none may be
    // answered as "no such artist".
    const notAnObject = [null, 'a string body', 42, ['an', 'array']];
    for (const body of notAnObject) {
      const { api } = build();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));

      await expect(
        api.getArtistById('a'),
        `body ${JSON.stringify(body) ?? 'null'} must not be answered as a miss`,
      ).rejects.toThrow(/not an artist object/i);
    }
  });

  it('CONTROL: a well-formed 200 with no artist in it still answers null, which IS a miss', async () => {
    // The opposite direction, and the reason the fix above is not "refuse
    // everything". A body that PARSES and carries no `id` is the vendor saying
    // there is no such artist here — that is an answer, and it must reach the
    // caller as the null that `artworkService` legitimately caches as `'none'`.
    // A method that raised here would suppress correct art forever.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ artists: [] }));

    await expect(api.getArtistById('a')).resolves.toBeNull();
  });

  it('CONTROL: an empty artist object also answers null, for the same reason', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));

    await expect(api.getArtistById('a')).resolves.toBeNull();
  });

  it('CONTROL: a genuine 404 still answers null — the fix above must not have touched it', async () => {
    // The control the 400 and network tests each demand in turn: a transport
    // failure and a 400 are now both inconclusive, so 404 is the ONLY remaining
    // miss and it has to stay one. If raising ever swallowed this, the method
    // would answer "unknown" for every artist and no lookup would ever settle.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));

    await expect(api.getArtistById('no-such-artist')).resolves.toBeNull();
  });

  it('the real ArtworkService does NOT cache a poisoned "no cover" for an unreadable 200', async () => {
    // The half of the bug that made it matter, and the reason the null above had
    // to change. `resolveArtistImage` caches `'none'` on a settled miss
    // (artworkService.ts:542), so the old behaviour wrote ONE unreadable body
    // into the negative cache and every later lookup for that artist read "this
    // artist has no cover" for the whole TTL — the correct art was never fetched
    // again, and nothing above DEBUG said why.
    //
    // Driven through the REAL `ArtworkService` and the REAL `SpotifySearchApi`
    // with only `fetch` faked, so the assertion covers the seam rather than a
    // restatement of it: the anchored path must leave `anchoredSettled` false.
    const cache = new Map<string, unknown>();
    const cacheService = {
      get: async (k: string) => (cache.has(k) ? cache.get(k) : null),
      set: async (k: string, v: unknown) => {
        cache.set(k, v);
      },
    } as unknown as CacheService;
    const spotify = new SpotifySearchApi(
      { getToken: async () => 'test-token', invalidate: () => undefined, rotateCredential: () => false, credentialCount: 1 } as unknown as SpotifyTokenManager,
    );
    vi.spyOn(spotify, 'getArtistIdViaTrackSample').mockResolvedValue('4Z8W4fKeB5YxbusRsdQVPb');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    const artwork = new ArtworkService(
      spotify,
      {} as unknown as DeezerApi,
      {} as unknown as AppleMusicWebApi,
      {} as unknown as AppleMusicSearchApi,
      { getArtistByName: async () => null, getOrCreateArtist: async () => ({ artistId: 1 }), setSpotifyImage: async () => undefined, setDeezerImage: async () => undefined, setAppleMusicUrl: async () => undefined } as unknown as IArtistRepository,
      { getAlbumByNameAndArtist: async () => null, setSpotifyImage: async () => undefined, setDeezerImage: async () => undefined, setImageUrl: async () => undefined } as unknown as IAlbumRepository,
      { getTrackByNameAndArtist: async () => null, setSpotifyImage: async () => undefined, setImageUrl: async () => undefined } as unknown as ITrackRepository,
      { getArtistInfo: async () => null, getAlbumInfo: async () => null, getTrackInfo: async () => null } as unknown as ILastfmRepository,
      cacheService,
    );

    await artwork.getArtistImageUrl('Radiohead', 'Airbag');

    // The assertion: nothing anywhere in the cache says this artist has no cover.
    const cached = [...cache.entries()].filter(([, v]) => v === 'none');
    expect(
      cached,
      'an unreadable 200 must not be cached as "this artist has no cover"',
    ).toEqual([]);
  });

  it('a 200 that parses is returned, so the readable path is not refused', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ id: '4Z8W4fKeB5YxbusRsdQVPb', name: 'Radiohead', images: [{ url: 'https://i/a.jpg' }] }),
    );

    await expect(api.getArtistById('4Z8W4fKeB5YxbusRsdQVPb')).resolves.toMatchObject({
      id: '4Z8W4fKeB5YxbusRsdQVPb',
      name: 'Radiohead',
    });
  });
});

// ---------------------------------------------------------------------------
// getTrack
// ---------------------------------------------------------------------------

describe('getTrack — token refresh, credential rotation, and never a null', () => {
  it('invalidates and retries exactly once on a 401, then succeeds', async () => {
    // The routine case: Spotify access tokens live about an hour and the bot
    // runs for days. A 401 that does not refresh becomes a dead music link
    // roughly once an hour, forever.
    const { api, invalidate } = build();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ id: 't1', name: 'Airbag' }));

    await expect(api.getTrack('t1')).resolves.toMatchObject({ name: 'Airbag' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a second time, so a genuinely dead token cannot hammer the API', async () => {
    const { api, invalidate } = build();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));

    await expect(api.getTrack('t1')).rejects.toThrow(/token rejected/i);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rotates to the next credential on a 429 and retries without cooling down', async () => {
    const { api, rotateCredential } = build();
    rotateCredential.mockReturnValueOnce(true);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'Retry-After': '60' }))
      .mockResolvedValueOnce(jsonResponse({ id: 't1', name: 'Airbag' }));

    await expect(api.getTrack('t1')).resolves.toMatchObject({ name: 'Airbag' });
    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A backup credential absorbs the 429, so no global cooldown is armed —
    // which is the entire point of having a pool.
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('cools down when a 429 finds no backup credential to rotate to', async () => {
    const { api, rotateCredential } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '12' }));

    await expect(api.getTrack('t1')).rejects.toThrow(/rate limited/i);
    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('a network failure RAISES and counts toward the outage breaker', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    for (let i = 0; i < 3; i++) {
      await expect(api.getTrack('t1')).rejects.toThrow(/network error/i);
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
    await expect(api.getTrack('t1')).rejects.toThrow(/network error/i);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('a 4xx other than 401/429 RAISES, and does not arm the breaker', async () => {
    // A 404 on a track id IS an answer, but `getTrack` returns a track or
    // raises — it has no "no such track" answer, and inventing one would be the
    // same lie. What must not happen is a 4xx being counted as an outage.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));

    for (let i = 0; i < 6; i++) {
      await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('RAISES when no token could be obtained, rather than returning a null track', async () => {
    const { api } = build(null, 0);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.getTrack('t1')).rejects.toThrow(/credentials not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getTrack reports a REFUSED credential as refused, not as unconfigured', async () => {
    // The paired half of the `getArtistById` pair above, on the second method
    // that carries its own null-token test.
    const { api } = build(null, 1);
    vi.spyOn(globalThis, 'fetch');

    await expect(api.getTrack('t1')).rejects.toThrow(/no access token was issued/i);
    await expect(api.getTrack('t1')).rejects.not.toThrow(/not configured/i);
  });

  it('a 200 clears the transport-failure run, so a later outage needs four fresh failures', async () => {
    const { api } = build();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    for (let i = 0; i < 3; i++) {
      await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);
    }

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 't1' }));
    await expect(api.getTrack('t1')).resolves.toMatchObject({ id: 't1' });

    // A breaker that ignored successes would already be armed at 3 here, because
    // the run before the success reached 3.
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    for (let i = 0; i < 3; i++) {
      await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
    await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the static gate, on its own terms
// ---------------------------------------------------------------------------

describe('the rate-limit and outage gate', () => {
  it('reads Retry-After as seconds and exposes the deadline', async () => {
    const { api } = build();
    const before = Date.now();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '15' }));

    await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);

    const until = SpotifySearchApi.getRateLimitedUntil();
    expect(until).toBeGreaterThan(before + 14_000);
    expect(until).toBeLessThanOrEqual(before + 15_000 + 50);
  });

  it.each([
    ['a missing header', {}, 10],
    ['a zero, which cannot mean "no wait"', { 'Retry-After': '0' }, 10],
    ['a junk value', { 'Retry-After': 'soon' }, 10],
    ['a negative value, floored to one second', { 'Retry-After': '-5' }, 1],
    ['a normal value, respected exactly', { 'Retry-After': '3' }, 3],
  ])('cools down for a sensible duration given %s', async (_label, headers, expectedSec) => {
    const { api } = build();
    const before = Date.now();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, headers));

    await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);

    const wait = SpotifySearchApi.getRateLimitedUntil() - before;
    expect(wait).toBeGreaterThan(expectedSec * 1000 - 100);
    expect(wait).toBeLessThanOrEqual(expectedSec * 1000 + 100);
  });

  it('a cooldown message states how much longer the caller has to wait', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '45' }));
    await expect(api.getTrack('t1')).rejects.toThrow(SpotifyUnavailableError);

    await expect(api.searchArtists('anything')).rejects.toThrow(
      /cooldown active \(\d+s remaining\)/,
    );
  });

  it('the shared search path honours the OUTAGE window too, and only while it is live', async () => {
    // `checkRateLimit` — the gate on `search()`, which every ladder search and
    // every search-rung artwork lookup shares — read only `rateLimitedUntil`. So
    // a 429 stopped the world while the 5xx / DNS / timeout outage this breaker
    // exists for stopped only the four methods that consult `isRateLimited()`
    // for themselves. The doc comment on `outageUntil` claimed the gate covered
    // "every artwork lookup and every ladder search", and it did not. The 429
    // half of the same gate is pinned by "a cooldown message states how much
    // longer the caller has to wait" below, which must keep passing.
    const { api, getToken } = build();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ tracks: { items: [] } }));
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);

    for (let i = 0; i < 4; i++) SpotifySearchApi.noteTransportFailure();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    await expect(api.searchTracks('airbag', 5)).rejects.toThrow(/cooldown active/i);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // And the gate is a cooldown, not a latch: once the window passes the same
    // search runs again. Without this half a fix that made the gate permanent
    // would pass.
    now.mockReturnValue(realNow + 20_001);
    await expect(api.searchTracks('airbag', 5)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('noteTransportSuccess() clears the gate noteTransportFailure() armed', () => {
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    SpotifySearchApi.noteTransportSuccess();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('clearRateLimit() resets all three counters, not just the deadline', () => {
    // If it only zeroed `rateLimitedUntil`, the 20s outage window armed by a run
    // of 5xx would survive a manual clear — which is what an operator restart is
    // reaching for.
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    SpotifySearchApi.clearRateLimit();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
    expect(SpotifySearchApi.getRateLimitedUntil()).toBe(0);

    // And the failure run really was reset: three more must not arm it.
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

describe('search telemetry can never fail a search', () => {
  it('records the call when a TelemetryService is registered', async () => {
    const { api } = build();
    // Declared with rest args on purpose: a bare `vi.fn()` infers a `[]` call
    // tuple, and `mock.calls[0][1]` would then be a compile error vitest never
    // reports.
    const recordApiCall = vi.fn(async (..._args: unknown[]) => undefined);
    container.registerInstance(TelemetryService, { recordApiCall } as unknown as TelemetryService);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ tracks: { items: [{ id: 't1', name: 'Airbag' }] } }));

    await expect(api.searchTracks('airbag', 5)).resolves.toHaveLength(1);

    expect(recordApiCall).toHaveBeenCalledTimes(1);
    const call = recordApiCall.mock.calls[0] as unknown[];
    expect(call[0]).toBe('spotify');
    expect(call[1]).toBe('/v1/search?type=track');
    expect(call[3]).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records the failure status too, because a 5xx is the interesting number', async () => {
    const { api } = build();
    const recordApiCall = vi.fn(async (..._args: unknown[]) => undefined);
    container.registerInstance(TelemetryService, { recordApiCall } as unknown as TelemetryService);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 503));

    await expect(api.searchTracks('airbag', 5)).rejects.toThrow(SpotifyUnavailableError);

    const call = recordApiCall.mock.calls[0] as unknown[];
    expect(call[3]).toBe(503);
  });

  it('still returns the paid-for result when the metrics call itself throws', async () => {
    // The search already succeeded and was already paid for at this point, so a
    // throw in the telemetry hook could only discard it.
    const recordApiCall = vi.fn(async (..._args: unknown[]) => {
      throw new Error('metrics sink unavailable');
    });
    const { api } = build();
    container.registerInstance(TelemetryService, { recordApiCall } as unknown as TelemetryService);
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ tracks: { items: [{ id: 't1', name: 'Airbag' }] } }));

    await expect(api.searchTracks('airbag', 5)).resolves.toHaveLength(1);
  });

  it('works with no TelemetryService registered at all', async () => {
    const { api } = build();
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ tracks: { items: [{ id: 't1', name: 'Airbag' }] } }));

    await expect(api.searchTracks('airbag', 5)).resolves.toHaveLength(1);
  });
});
