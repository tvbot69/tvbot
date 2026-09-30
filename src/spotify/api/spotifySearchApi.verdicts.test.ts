import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { SpotifySearchApi, SpotifyUnavailableError } from './spotifySearchApi';
import type { SpotifyTokenManager } from './spotifyTokenManager';
import { TelemetryService } from '@bot/services/telemetryService';
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
 * VENDOR ASSUMPTIONS encoded here. None of them can be verified from a test, so
 * each one needs re-checking against the live API:
 *   - a 404 from `/v1/artists/{id}` means "no such artist" (a miss),
 *   - a 401 means "the bearer token was rejected" (inconclusive, and the only
 *     status that invalidates the cached token),
 *   - a 429 carries `Retry-After` in seconds, and means the CREDENTIAL is
 *     rate-limited rather than the app,
 *   - only a 5xx counts toward the transport-outage breaker: a 4xx is a bad
 *     request of ours and asking again cannot fix it.
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

const build = (token: string | null = 'test-token') => {
  const getToken = vi.fn(async (): Promise<string | null> => token);
  const invalidate = vi.fn();
  const rotateCredential = vi.fn((): boolean => false);
  const tokenManager = {
    getToken,
    invalidate,
    rotateCredential,
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

describe('getArtistById — a 4xx is a miss, a 5xx is inconclusive', () => {
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

  it('answers null for a 403 as well, and does not arm the transport breaker', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 403));

    for (let i = 0; i < 6; i++) {
      await expect(api.getArtistById('a')).resolves.toBeNull();
    }
    // Six rejected requests, none of which counts as an outage. A 4xx is a bug
    // of ours (or a scope problem) and re-asking cannot fix either.
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

  it('RAISES when there are no credentials, because nothing was ever asked', async () => {
    // `artworkService.resolveArtistImage` writes `'none'` into its cache on a
    // null. A deploy that lost its secrets must not be recorded as "this artist
    // has no cover", so unconfigured raises exactly like an outage does.
    const { api } = build(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.getArtistById('a')).rejects.toThrow(/credentials not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('KNOWN GAP — a network failure answers null, not a raise, unlike every sibling method', async () => {
    // The gap this test documents. `getTrack` wraps its fetch in a try and raises
    // `Spotify network error`; `getArtistIdViaTrackSample` reaches that code
    // through `search()`. `getArtistById` does not, so a DNS failure or a
    // timeout falls to the outer catch, is not a `SpotifyUnavailableError`, and
    // is answered with `null` — the value `artworkService` then caches as
    // `'none'` (artworkService.ts:543). The doc comment above the method says
    // the null "is cached as a fact about the artist", which is precisely what
    // a five-second DNS blip then produces.
    //
    // Pinned as OBSERVED behaviour so that fixing it shows up as a change to
    // this test rather than silently.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFails);

    await expect(api.getArtistById('a')).resolves.toBeNull();
  });

  it('a 200 whose body is not JSON also answers null, without arming the breaker', async () => {
    // A shape surprise is not a verdict. The request succeeded, we just could not
    // read the answer, so this must not be counted as an outage either.
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    await expect(api.getArtistById('a')).resolves.toBeNull();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
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
    const { api } = build(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.getTrack('t1')).rejects.toThrow(/credentials not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
