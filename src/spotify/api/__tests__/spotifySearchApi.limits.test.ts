import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifySearchApi, SpotifyUnavailableError } from '../spotifySearchApi';
import type { SpotifyTokenManager } from '../spotifyTokenManager';
import { Logger } from '@domain/logger';

/**
 * B1 — the limit ceiling on `/v1/artists/{id}/albums`, and B1b on `/v1/search`.
 *
 * Both were measured live against api.spotify.com on 2026-09-30 (see
 * `spotifyApiLimits.ts` for the probe log). The ceilings are 10, NOT the 50
 * Spotify's published reference states, and `getArtistDiscographyCovers` was
 * sending `Math.min(limit, 50)` with two callers asking for 15.
 *
 * Why the bug was invisible for the life of the feature: the rejected request
 * came back 400, `if (!res.ok) return []` turned that into an empty array, and
 * an empty array is byte-identical to "this artist has no covers". So every
 * artist mosaic the bot has ever rendered was missing its Spotify rung, with
 * nothing logged above DEBUG. These tests exist to make that specific silence
 * impossible to reintroduce.
 *
 * The `!res.ok` branch is therefore split three ways on purpose, and the
 * third test pins the split rather than the clamp:
 *   - a 4xx is a request THIS MODULE built badly  -> WARN, do NOT arm the
 *     outage breaker (asking again cannot fix a bug of ours, and the breaker
 *     exists to stop re-running a doomed leg),
 *   - a 5xx is an outage -> WARN, and DO arm the breaker,
 *   - a 200 with `items: []` is the only genuine "no covers".
 */

const ARTIST_ID = '4Z8W4fKeB5YxbusRsdQVPb';

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

const coverItems = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ images: [{ url: `https://i.scdn.co/cover${String(i)}` }] }));

/**
 * Routes by URL rather than by call order, so a test asserts on the request it
 * cares about and does not break if a rung is added or removed above it.
 */
const routerFetch = (albumsStatus: number, albumsBody: unknown) =>
  vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/v1/search')) {
      return jsonResponse({ artists: { items: [{ name: 'Radiohead', id: ARTIST_ID }] } });
    }
    if (albumsStatus === 200) return jsonResponse(albumsBody);
    return jsonResponse({ error: { status: albumsStatus, message: 'Invalid limit' } }, albumsStatus);
  });

describe('SpotifySearchApi.getArtistDiscographyCovers — the measured limit ceiling', () => {
  let tokenManager: SpotifyTokenManager;
  let api: SpotifySearchApi;
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  const build = () => {
    tokenManager = {
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager;
    api = new SpotifySearchApi(tokenManager);
  };

  /** The exact request the two collage builders produce. */
  const albumsUrl = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/albums'));

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    build();
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('CLAMPS a caller asking for 15 rather than sending 15, because the server rejects it', async () => {
    // 15 is the literal both `whoKnowsImageBuilder.ts:317` and `topBuilders.ts:86`
    // pass. Sending it returns 400 "Invalid limit" — measured, and it contradicts
    // the published docs, which is why the constant carries its probe log.
    const fetchMock = routerFetch(200, { items: coverItems(2) });
    vi.stubGlobal('fetch', fetchMock);

    await api.getArtistDiscographyCovers('Radiohead', undefined, 15);

    const url = albumsUrl(fetchMock);
    expect(url).toBeDefined();
    expect(url).toContain('limit=10');
    expect(url).not.toContain('limit=15');
    expect(Number(new URL(url!).searchParams.get('limit'))).toBe(10);
  });

  it.each([
    ['15, as both collage builders send', 15],
    ['20, the method default', 20],
    ['50, the value the docs suggest', 50],
    ['200, an uncapped caller', 200],
  ])('clamps %s to the measured ceiling', async (_label, asked) => {
    const fetchMock = routerFetch(200, { items: coverItems(1) });
    vi.stubGlobal('fetch', fetchMock);

    await api.getArtistDiscographyCovers('Radiohead', undefined, asked);

    const url = albumsUrl(fetchMock);
    const sent = Number(new URL(url!).searchParams.get('limit'));
    expect(Number.isInteger(sent) && sent >= 1 && sent <= 10, `sent limit=${String(sent)}`).toBe(true);
    expect(sent).toBe(10);
  });

  it('leaves an in-range limit untouched, so the clamp is not what makes the happy path work', async () => {
    // The companion to every clamp assertion above. A clamp that also mangled
    // valid input would pass all of them while quietly narrowing real searches.
    const fetchMock = routerFetch(200, { items: coverItems(1) });
    vi.stubGlobal('fetch', fetchMock);

    await api.getArtistDiscographyCovers('Radiohead', undefined, 7);

    expect(albumsUrl(fetchMock)).toContain('limit=7');
  });

  it('keeps include_groups intact while clamping — the group filter is valid, only the limit was not', async () => {
    // Measured separately at limit=10: `include_groups=album,single,appears_on`
    // -> 200. So the fix must not "simplify" the query by dropping the groups,
    // which would silently turn the rung into own-releases only.
    const fetchMock = routerFetch(200, { items: coverItems(1) });
    vi.stubGlobal('fetch', fetchMock);

    await api.getArtistDiscographyCovers('Radiohead', undefined, 15);

    const url = albumsUrl(fetchMock)!;
    // The URL is built by string concatenation, so the commas are literal.
    expect(url).toContain('include_groups=album,single,appears_on');
    expect(new URL(url).searchParams.get('include_groups')).toBe('album,single,appears_on');
  });

  it('returns the covers from a 200 with items — the clamp did not break the happy path', async () => {
    const fetchMock = routerFetch(200, { items: coverItems(3) });
    vi.stubGlobal('fetch', fetchMock);

    const covers = await api.getArtistDiscographyCovers('Radiohead', undefined, 15);

    expect(covers).toEqual([
      'https://i.scdn.co/cover0',
      'https://i.scdn.co/cover1',
      'https://i.scdn.co/cover2',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] for a genuine 200 with no items, and does NOT warn — that is a real answer', async () => {
    const fetchMock = routerFetch(200, { items: [] });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 15)).resolves.toEqual([]);

    // The asymmetry this pins: silence is reserved for Spotify having answered.
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('makes a REJECTED request loud — a 400 is not "this artist has no covers"', async () => {
    // The bug this whole file exists for. If Spotify ever tightens the ceiling
    // below 10, or a parameter is added badly, this must not go quiet again: an
    // empty list here is indistinguishable to the caller from a real absence.
    const fetchMock = routerFetch(400, { error: { status: 400, message: 'Invalid limit' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 15)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({ status: 400 });
    expect(String(message)).toMatch(/REJECTED/i);
    // The old code logged this at DEBUG, on the outer catch, as "discography
    // covers unavailable" — the exact line that made this bug survive.
    expect(debug).not.toHaveBeenCalled();
  });

  it('does not arm the outage breaker on a 4xx, because a bug of ours does not get better by retrying', async () => {
    // A 400 means the request was invalid. The breaker exists to stop us
    // re-running a leg that is already known to be down; ours is not down, it is
    // mis-formed, and the next attempt is identically mis-formed. Arming it would
    // also report a client bug as an outage, which is the other half of the lie.
    const fetchMock = routerFetch(400, { error: { status: 400, message: 'Invalid limit' } });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await api.getArtistDiscographyCovers('Radiohead', undefined, 15);
    }

    expect(SpotifySearchApi.isRateLimited()).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('reports a 5xx as an outage, distinctly from a rejected request', async () => {
    // Under the old `if (!res.ok) return []` a 5xx was silently identical to both
    // a 400 and a real empty discography, so the bot kept re-running a doomed leg
    // and nothing in the logs said why. NOTE: this endpoint alone cannot be made
    // to arm the breaker here, and that is not a gap in the fix — the artist
    // search that runs immediately before it succeeds and calls
    // `noteTransportSuccess()`, resetting the counter on every call. The
    // breaker behaviour is therefore pinned where it is observable, in the
    // `search` describe below.
    const fetchMock = routerFetch(503, { error: { status: 503, message: 'Service Unavailable' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 15)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({ status: 503 });
    expect(String(message)).toMatch(/not empty|down/i);
    expect(String(message)).not.toMatch(/REJECTED/i);
  });
});

describe('SpotifySearchApi.search — the measured /v1/search limit ceiling', () => {
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    api = new SpotifySearchApi({
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  const sentLimit = (fetchMock: ReturnType<typeof vi.fn>) =>
    Number(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('limit'));

  it('clamps a caller asking for more than the measured ceiling', async () => {
    // `search()` used `String(limit)` with no clamp at all, so the ceiling was
    // enforced only by every current caller happening to pass <= 10. Two of them
    // (`artworkService` lines 339/344/358/780) pass exactly 10.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ albums: { items: [{ name: 'OK Computer' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.searchAlbums('ok computer', 15);

    expect(sentLimit(fetchMock)).toBe(10);
  });

  it('leaves an in-range limit untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ albums: { items: [{ name: 'OK Computer' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.searchAlbums('ok computer', 10);

    expect(sentLimit(fetchMock)).toBe(10);
  });

  it('returns the items from a clamped 200, so the clamp is not an outage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ albums: { items: [{ name: 'OK Computer' }, { name: 'Kid A' }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchAlbums('radiohead', 50)).resolves.toHaveLength(2);
  });

  it('never arms the outage breaker for a 4xx, only for a 5xx — a client bug is not an outage', async () => {
    // The outage/client-bug split, asserted where it is actually observable.
    // `search()` is the shared path every Spotify lookup goes through, and the
    // albums endpoint above cannot be used for this: the artist search that runs
    // immediately before it succeeds and calls `noteTransportSuccess()`, which
    // resets the failure run to zero on every single call.
    const statusFailures = async (status: number): Promise<boolean> => {
      SpotifySearchApi.clearRateLimit();
      const failing = vi.fn().mockResolvedValue(jsonResponse({ error: { status } }, status));
      vi.stubGlobal('fetch', failing);
      for (let i = 0; i < 6; i++) {
        await expect(api.searchAlbums('radiohead', 5)).rejects.toThrow(SpotifyUnavailableError);
      }
      return SpotifySearchApi.isRateLimited();
    };

    expect(await statusFailures(400)).toBe(false);
    expect(await statusFailures(500)).toBe(true);
  });
});

describe('SpotifySearchApi.getSpotifyTrackUrl — the deleted quoted-query retry', () => {
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    api = new SpotifySearchApi({
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('sends ONE request on a 400, proving the quoted-query retry is gone', async () => {
    // The retry was dead weight, not a fix. Measured: at limit=15 EVERY query
    // 400s (test, Lege-Cy, Radiohead, Arabic) — the limit, never the charset, so
    // its stated reason was a phantom. And the one 400 reachable at limit=5 is
    // `q` over 250 characters, which the quoted form makes LONGER (a 280-char
    // query retried as 297, both 400). It could never rescue anything, and it
    // cost a second doomed request every time.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getSpotifyTrackUrl('Radiohead', 'Airbag')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('truncates an over-long artist+track query to the measured 250-char ceiling and gets its answer', async () => {
    // q length 250 -> 200, 251 -> 400 "Query exceeds maximum length" (measured).
    // Unlike `SpotifyResolver.searchTracks`, this method never truncated, so a
    // long title lost the Spotify bonus URL entirely, and silently: the catch
    // below is documented as an honest null.
    const longTitle = `${'Extended Edition '.repeat(14)}Airbag`.trim();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        tracks: {
          items: [
            {
              name: longTitle,
              artists: [{ name: 'Radiohead' }],
              id: '4mF0aVVHtmHQSIdem2Wh0g',
              external_urls: { spotify: 'https://open.spotify.com/track/4mF0aVVHtmHQSIdem2Wh0g' },
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const url = await api.getSpotifyTrackUrl('Radiohead', longTitle);

    const sent = String(fetchMock.mock.calls[0]?.[0]);
    const sentQuery = new URL(sent).searchParams.get('q') ?? '';
    expect(sentQuery).toHaveLength(250);
    // Sent once, at the real limit — not 15, which would 400.
    expect(sent).toContain('limit=5');
    expect(url).toBe('https://open.spotify.com/track/4mF0aVVHtmHQSIdem2Wh0g');
  });

  it('still raises 400 from the shared search path as inconclusive rather than a miss', async () => {
    // `search()` deliberately raises a 400: the request was rejected, so the run
    // never got an answer. This asserts that deleting the retry did not also
    // delete the raise underneath it.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.searchTracks('anything', 5)).rejects.toThrow(SpotifyUnavailableError);
  });
});
