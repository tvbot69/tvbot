import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifySearchApi } from './spotifySearchApi';
import type { SpotifyTokenManager } from './spotifyTokenManager';
import { Logger } from '@domain/logger';

/**
 * `getFullAlbum` and `searchAndGetFullAlbum` — the album-metadata path.
 *
 * These two are the ones whose failure modes are DELIBERATELY different from
 * the rest of the module, and the difference is worth pinning because it looks
 * like an inconsistency if you only read the raise-based methods:
 *
 *   - `getFullAlbum` answers `null` for everything, including a 401 and a 5xx.
 *     Its only caller is `albumService`, which logs a WARN and then builds the
 *     card from Last.fm's own tracklist — a real answer, just a smaller one, so
 *     nothing rendered can be wrong. A raise here would buy a log line one layer
 *     up for a value nothing renders as a fact.
 *   - `searchAndGetFullAlbum` has TWO rungs and must not let the first one
 *     flatten into a miss: a quoted search that 400s says nothing about the
 *     unquoted one that follows it.
 *
 * VENDOR ASSUMPTION encoded here: Spotify's search accepts the quoted field
 * syntax `album:"x" artist:"y"` on `/v1/search`, and a search for an album
 * returns album objects whose `id` is directly fetchable from `/v1/albums/{id}`.
 * That is ordinary Web API behaviour, but nothing in this file checks it against
 * the live API, so it carries the flag.
 */

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  }) as unknown as Response;

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  SpotifySearchApi.clearRateLimit();
});

describe('getFullAlbum', () => {
  it('returns the album on a 200 and asks for it by id', async () => {
    const { api } = build();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'alb1', name: 'Geogaddi', total_tracks: 23 }));

    await expect(api.getFullAlbum('alb1')).resolves.toMatchObject({ name: 'Geogaddi' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/albums/alb1',
      expect.anything(),
    );
  });

  it('answers null without asking Spotify while the cooldown is live', async () => {
    const { api, getToken } = build();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '30' }));
    await expect(api.getTrack('t1')).rejects.toThrow();
    fetchMock.mockClear();
    getToken.mockClear();

    await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers null when there is no token, rather than issuing an unauthenticated request', async () => {
    const { api } = build(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates the token on a 401 and answers null', async () => {
    // A 401 here means the CREDENTIAL needs refreshing. Unlike the raise-based
    // methods this one does not raise, so the invalidation is the only recovery
    // signal the caller gets.
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));

    await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('opens the cooldown on a 429 and answers null, without invalidating the token', async () => {
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '20' }));

    await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('answers null for a 4xx that is not 401/429, and does not arm the breaker', async () => {
    const { api, invalidate } = build();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 404));

    for (let i = 0; i < 6; i++) {
      await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    }
    expect(invalidate).not.toHaveBeenCalled();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('answers null on a network failure, because the caller has a real fallback', async () => {
    const { api } = build();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
  });

  it('a 200 counts as a success, so it clears a transport-failure run', async () => {
    // The reset is invisible until something depends on it, and this is the only
    // album-path call that reports success, so it is the only place a stale
    // failure run can be cleared.
    const { api } = build();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    for (let i = 0; i < 3; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
      await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'alb1' }));
    await expect(api.getFullAlbum('alb1')).resolves.toMatchObject({ id: 'alb1' });

    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    for (let i = 0; i < 3; i++) {
      await expect(api.getFullAlbum('alb1')).resolves.toBeNull();
    }
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });
});

describe('searchAndGetFullAlbum — the two rungs are genuinely independent', () => {
  /**
   * Routes by URL so a test pins the request it means, not the call order.
   *
   * The `/v1/albums/{id}` response ECHOES the id that was asked for, so an
   * assertion on the returned album's id measures which candidate the scorer
   * picked. A fixed body here would make every selection test pass for the
   * wrong reason.
   */
  const router = (
    quotedBody: unknown | 'throw',
    plainBody: unknown | 'throw',
    albumBody: unknown = { name: 'Geogaddi' },
  ) => {
    const fetchMock = vi.fn(async (..._args: unknown[]): Promise<Response> => {
      const url = String(_args[0]);
      if (url.includes('/v1/albums/')) {
        const requestedId = url.slice(url.indexOf('/v1/albums/') + '/v1/albums/'.length);
        return jsonResponse(albumBody === null ? null : { ...(albumBody as object), id: requestedId });
      }
      const q = new URL(url).searchParams.get('q') ?? '';
      const body = q.includes('album:') ? quotedBody : plainBody;
      if (body === 'throw') return jsonResponse({}, 500);
      return jsonResponse(body);
    });
    return fetchMock;
  };

  const searchUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/v1/search'));

  it('tries the quoted search first, and only asks Spotify once when it answers', async () => {
    const { api } = build();
    const fetchMock = router({ albums: { items: [{ id: 'alb1', name: 'Geogaddi' }] } }, { albums: { items: [] } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'alb1',
    });

    const searches = searchUrls(fetchMock);
    expect(searches).toHaveLength(1);
    expect(new URL(searches[0]!).searchParams.get('q')).toBe('album:"Geogaddi" artist:"Boards of Canada"');
    expect(searches[0]).toContain('type=album');
  });

  it('falls through to the unquoted search when the quoted one matched nothing', async () => {
    const { api } = build();
    const fetchMock = router(
      { albums: { items: [] } },
      { albums: { items: [{ id: 'alb9', name: 'Geogaddi' }] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'alb9',
    });

    const searches = searchUrls(fetchMock);
    expect(searches).toHaveLength(2);
    expect(new URL(searches[1]!).searchParams.get('q')).toBe('Geogaddi Boards of Canada');
  });

  it('falls through to the unquoted search when the quoted one FAILS, not just when it is empty', async () => {
    // The whole reason the inner catch exists. A rejected quoted request says
    // nothing about the plain one on the next line, and flattening it into "no
    // album found" is the exact lie the raise-based methods avoid.
    const { api } = build();
    const fetchMock = router('throw', { albums: { items: [{ id: 'alb9', name: 'Geogaddi' }] } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'alb9',
    });
    expect(searchUrls(fetchMock)).toHaveLength(2);
  });

  it('answers null when both rungs ran and neither matched anything', async () => {
    const { api } = build();
    const fetchMock = router({ albums: { items: [] } }, { albums: { items: [] } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Nothing', 'Nobody')).resolves.toBeNull();
    expect(searchUrls(fetchMock)).toHaveLength(2);
    // The album fetch is never reached, so it must never be made.
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/v1/albums/'))).toBe(false);
  });

  it('answers null when both rungs FAIL — the outer catch, not a fabricated match', async () => {
    const { api } = build();
    const fetchMock = router('throw', 'throw');
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toBeNull();
  });

  it('picks the candidate whose credited artist matches, not merely the first result', async () => {
    const { api } = build();
    const fetchMock = router(
      {
        albums: {
          items: [
            { id: 'wrong', name: 'Geogaddi', artists: [{ name: 'Someone Else' }] },
            { id: 'right', name: 'Geogaddi', artists: [{ name: 'Boards Of Canada' }] },
          ],
        },
      },
      { albums: { items: [] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'right',
    });
  });

  it('matches an artist name through punctuation and spacing differences', async () => {
    // `clean()` strips punctuation and case, so "Boards of Canada" and
    // "boards of canada!" are the same entity. A strict string compare here would
    // send a correct album to the wrong rung.
    const { api } = build();
    const fetchMock = router(
      {
        albums: {
          items: [{ id: 'right', name: 'Geogaddi', artists: [{ name: 'boards of canada!' }] }],
        },
      },
      { albums: { items: [] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'right',
    });
  });

  it('still returns a candidate when NO artist matched, ranked by album-name similarity', async () => {
    // A live-reissue / compilation rip frequently carries a different credited
    // artist. Answering null there would drop a correct cover, so the pool falls
    // back to every candidate and the album name decides.
    const { api } = build();
    const fetchMock = router(
      {
        albums: {
          items: [
            { id: 'weak', name: 'Music Has the Right to Children', artists: [{ name: 'Aphex Twin' }] },
            { id: 'strong', name: 'Geogaddi', artists: [{ name: 'Aphex Twin' }] },
          ],
        },
      },
      { albums: { items: [] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toMatchObject({
      id: 'strong',
    });
  });

  it('returns null when the album fetch itself comes back null', async () => {
    const { api } = build();
    const fetchMock = router(
      { albums: { items: [{ id: 'alb1', name: 'Geogaddi', artists: [{ name: 'Boards of Canada' }] }] } },
      { albums: { items: [] } },
      null,
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada')).resolves.toBeNull();
  });
});

/**
 * The tracklist limit, which is the one place a measured ceiling is MISSING.
 *
 * `spotifyApiLimits.ts` carries a live probe log for `/v1/search`,
 * `/v1/artists/{id}/albums` and the `q` length, and all three say the server
 * rejects limit>10 while the documentation says 50. `/v1/albums/{id}/tracks` is
 * NOT in that log, and this method sends it `Math.min(limit, 50)` with no clamp —
 * and `albumService` calls it with 50.
 *
 * So the 400-is-a-lie shape that the `/v1/artists/{id}/albums` fix removed is
 * still reachable here: a 4xx is treated as an ANSWER, so a rejected request
 * comes back as "this album has no tracks" with nothing logged. That is exactly
 * the claim `getAlbumTrackNames` was rewritten to stop making for 5xx. Whether
 * the server actually rejects 50 here is UNVERIFIED — I have no network access
 * and did not probe it. What is verified is that the code sends 50 and that a
 * rejection would be silent.
 */
describe('getAlbumTrackNames — the tracklist limit is the one UNMEASURED ceiling', () => {
  const tracklistRouter = (tracksStatus: number, tracksBody: unknown = {}) => {
    const fetchMock = vi.fn(async (..._args: unknown[]): Promise<Response> => {
      const url = String(_args[0]);
      if (url.includes('/tracks')) return jsonResponse(tracksBody, tracksStatus);
      if (url.includes('/v1/albums/')) return jsonResponse({ id: 'alb1', name: 'Geogaddi' });
      return jsonResponse({ albums: { items: [{ id: 'alb1', name: 'Geogaddi' }] } });
    });
    return fetchMock;
  };

  const tracklistUrl = (fetchMock: ReturnType<typeof vi.fn>): string =>
    fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/tracks')) ?? '';

  it('sends limit=50 to the tracklist endpoint — the documented value, NOT the measured 10', async () => {
    // Recorded as the number in the code, so a future change to it is visible.
    // If someone probes this endpoint and finds the same 10 ceiling the other
    // two have, this test and `spotifyApiLimits.ts` are where the change goes.
    const { api } = build();
    const fetchMock = tracklistRouter(200, { items: [{ name: 'Xtal' }] });
    vi.stubGlobal('fetch', fetchMock);

    await api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 50);

    const url = tracklistUrl(fetchMock);
    expect(url).toContain('limit=50');
    expect(url).not.toContain('limit=10');
  });

  it('caps a wildly over-large caller limit at 50, the value the docs suggest', async () => {
    const { api } = build();
    const fetchMock = tracklistRouter(200, { items: [{ name: 'Xtal' }] });
    vi.stubGlobal('fetch', fetchMock);

    await api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 500);

    expect(tracklistUrl(fetchMock)).toContain('limit=50');
  });

  it('SILENT ANSWER — a 400 from the tracklist endpoint returns an empty tracklist with no log', async () => {
    // The dangerous shape, pinned as observed. Every other inconclusive failure
    // in this method raises; a 4xx does not. So if the server rejects this
    // request the caller is told the album has no tracks, `albumService` builds a
    // Last.fm-sourced card, and nothing above DEBUG records that a request this
    // module built was invalid.
    const { api } = build();
    const fetchMock = tracklistRouter(400, { error: { status: 400, message: 'Invalid limit' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 50),
    ).resolves.toEqual([]);

    expect(Logger.warn).not.toHaveBeenCalled();
    expect(Logger.debug).not.toHaveBeenCalled();
  });

  it('BUG — a 200 with a real tracklist is ALSO discarded, so this method never returns a tracklist', async () => {
    // `spotifySearchApi.ts:718` is `if (res.status < 500) return []`, which a 200
    // satisfies. The status checks above it throw for 401, 429 and >=500, so the
    // only statuses that can reach the body parse are... none. Lines 719-721
    // (`noteTransportSuccess` and the `items` mapping) are dead code.
    //
    // This is the same defect as the 400 case above, and worse: it is not
    // confined to a request the server might reject, it is EVERY successful
    // answer. So the 4xx silent answer was the visible half — the real one is
    // that `getAlbumTrackNames` reports "this album has no tracks" for every
    // album, and `albumService` builds the card from Last.fm's tracklist every
    // time, with nothing logged.
    //
    // Pinned as observed, not as desired. The fix is one character class
    // (`=== 404` instead of `< 500`) in production, which this file must not do.
    const { api } = build();
    const fetchMock = tracklistRouter(200, {
      items: [{ name: 'Xtal' }, { name: 'Music Is Math' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 5),
    ).resolves.toEqual([]);

    // The request really was made and really was a 200 — this is not a routing
    // or a double problem, the body is simply never read.
    expect(tracklistUrl(fetchMock)).toContain('/v1/albums/alb1/tracks');
  });

  it('BUG — a 404 is the one status the empty answer was written for, and it is indistinguishable from the 200', async () => {
    // The comment on line 716 says a 404 "IS an answer". It is, and so is a 200,
    // and the code cannot tell them apart.
    const { api } = build();
    vi.stubGlobal('fetch', tracklistRouter(404));

    await expect(
      api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 5),
    ).resolves.toEqual([]);
  });
});
