import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifySearchApi, SpotifyUnavailableError } from '../spotifySearchApi';
import type { SpotifyTokenManager } from '../spotifyTokenManager';
import { Logger } from '@domain/logger';

/**
 * `getArtistDiscographyCovers` and `getArtistIdViaTrackSample` — the two rungs
 * that feed a collage's cover cells.
 *
 * This method is the one whose whole failure surface used to be a single silent
 * `[]` (see `spotifySearchApi.limits.test.ts` for the 400-the-limit bug that
 * lived there). What is left to pin is the rest of it: the two lookup rungs, and
 * the fact that an album the endpoint returns WITHOUT artwork is dropped rather
 * than handed on as a URL the browser will fail to load. A mosaic cell with a
 * broken image is worse than a mosaic cell with nothing in it.
 *
 * VENDOR ASSUMPTIONS encoded here, and what the live probe made of each one
 * (`scripts/liveVerify.ts`, 2026-09-30 — full table in `spotifyApiLimits.ts`):
 *   - `GET /v1/artists/{id}/albums` returns album objects whose ARTWORK IS AT
 *     `images[0].url` on the item itself. CONFIRMED: item keys are album_type,
 *     total_tracks, available_markets, external_urls, href, id, images, name,
 *     release_date, release_date_precision, type, uri, artists, album_group —
 *     and `item.album` is ABSENT, where a search result for a track carries its
 *     artwork at `album.images` instead. The two look alike; reading the wrong one
 *     is the easy mistake here.
 *   - A discography item with no `images` key means Spotify has no artwork for
 *     that release, not that the request failed. CONFIRMED.
 *   - The response has no `total` and no `total_pages`, "so the caller cannot
 *     learn how many covers exist beyond the page it asked for". That was the
 *     old claim, and its `total` half was WRONG: the top-level keys are href,
 *     limit, next, offset, previous, TOTAL, items, and `total` was 60 for
 *     Radiohead. Only the `total_pages` half was right, and it is still absent.
 *
 * So the product decision below — a bare list, no denominator — is unchanged, and
 * its stated REASON is now corrected. `total` is not a denominator for this
 * method even though it is readable:
 *   1. With `include_groups=album,single,appears_on` it counts RELEASES THE
 *      ARTIST APPEARS ON, which is mostly other people's compilations and
 *      soundtracks. It is not "how many covers this artist has".
 *   2. It is not the size of the list either. Items with no artwork are dropped
 *      and repeated cover URLs are de-duplicated, so covers.length can be far
 *      below it for reasons that have nothing to do with the count.
 *   3. Nothing renders a number here. Both callers
 *      (`whoKnowsImageBuilder.ts:317`, `topBuilders.ts:86`) use the result as
 *      collage cover cells, so there is no field to attach it to and no
 *      `totalKnown`-style flag needed — `musicTrack.ts`'s `totalKnown` exists
 *      for a size the bot RENDERS, which this is not.
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

type SearchBodies = { track?: unknown; artist?: unknown };
type AlbumsReply = { status?: number; body?: unknown };

/** Routes by URL and query type, so a test pins the request it means. */
const router = (searches: SearchBodies, albums: AlbumsReply = {}) => {
  const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
    const url = String(args[0]);
    if (url.includes('/v1/search')) {
      const type = new URL(url).searchParams.get('type');
      if (type === 'track') {
        const body = searches.track;
        if (body === 'fail') return jsonResponse({}, 500);
        return jsonResponse({ tracks: { items: body ?? [] } });
      }
      const body = searches.artist;
      if (body === 'fail') return jsonResponse({}, 500);
      return jsonResponse({ artists: { items: body ?? [] } });
    }
    const status = albums.status ?? 200;
    return jsonResponse(albums.body ?? { items: [] }, status, status === 429 ? { 'Retry-After': '9' } : {});
  });
  return fetchMock;
};

const urlsOf = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map((c) => String(c[0]));

let debug: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  SpotifySearchApi.clearRateLimit();
  debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  SpotifySearchApi.clearRateLimit();
});

describe('getArtistDiscographyCovers — nothing in, nothing out, and nothing asked', () => {
  it('answers [] without a token request while the cooldown is live', async () => {
    const { api, getToken } = build();
    const fetchMock = router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { status: 429 });
    vi.stubGlobal('fetch', fetchMock);
    await api.getArtistDiscographyCovers('Radiohead', undefined, 5);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    fetchMock.mockClear();
    getToken.mockClear();
    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers [] when there are no credentials, and never asks Spotify', async () => {
    const { api } = build(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers [] when Spotify says the artist has no discography, without warning', async () => {
    // The genuine empty. Silence is reserved for Spotify having answered, so
    // this asserts the absence of a log line as well as the empty list.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { body: { items: [] } }),
    );

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('getArtistDiscographyCovers — the two lookup rungs', () => {
  it('resolves the artist from a track sample and asks for THAT artist id', async () => {
    const { api } = build();
    const fetchMock = router(
      { track: [{ name: 'Airbag', artists: [{ name: 'Radiohead', id: 'ARTIST-FROM-TRACK' }] }] },
      { body: { items: [{ images: [{ url: 'https://cdn.example/cover1.png' }] }] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    const covers = await api.getArtistDiscographyCovers('Radiohead', 'Airbag', 5);

    expect(covers).toEqual(['https://cdn.example/cover1.png']);
    const urls = urlsOf(fetchMock);
    // A track search first, then the albums endpoint for the id it produced.
    expect(urls[0]).toContain('type=track');
    expect(urls.some((u) => u.includes('/artists/ARTIST-FROM-TRACK/albums'))).toBe(true);
    // The artist-search rung must NOT have run: the sample already answered.
    expect(urls.some((u) => u.includes('type=artist'))).toBe(false);
  });

  it('falls back to the artist search when the track sample matches nobody', async () => {
    const { api } = build();
    const fetchMock = router(
      {
        track: [{ name: 'Airbag', artists: [{ name: 'Someone Else', id: 'other' }] }],
        artist: [{ name: 'Radiohead', id: 'ARTIST' }],
      },
      { body: { items: [{ images: [{ url: 'https://cdn.example/cover1.png' }] }] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    const covers = await api.getArtistDiscographyCovers('Radiohead', 'Airbag', 5);

    expect(covers).toEqual(['https://cdn.example/cover1.png']);
    const urls = urlsOf(fetchMock);
    expect(urls.some((u) => u.includes('type=track'))).toBe(true);
    expect(urls.some((u) => u.includes('type=artist'))).toBe(true);
    expect(urls.some((u) => u.includes('/artists/other/albums'))).toBe(false);
  });

  it('falls back to the artist search when the track rung FAILS, and says so at DEBUG', async () => {
    // A failed rung says nothing about the next one. Returning [] here would
    // cost the whole Spotify column of every collage, silently.
    const { api } = build();
    const fetchMock = router(
      { track: 'fail', artist: [{ name: 'Radiohead', id: 'ARTIST' }] },
      { body: { items: [{ images: [{ url: 'https://cdn.example/cover1.png' }] }] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    const covers = await api.getArtistDiscographyCovers('Radiohead', 'Airbag', 5);

    expect(covers).toEqual(['https://cdn.example/cover1.png']);
    expect(debug).toHaveBeenCalledTimes(1);
    const logged = String(debug.mock.calls[0]?.[1] ?? '');
    expect(logged).toMatch(/track-sample rung failed/i);
  });

  it('answers [] when the artist rung also fails, and says so rather than pretending empty', async () => {
    const { api } = build();
    vi.stubGlobal('fetch', router({ track: 'fail', artist: 'fail' }));

    await expect(api.getArtistDiscographyCovers('Radiohead', 'Airbag', 5)).resolves.toEqual([]);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(String(debug.mock.calls[1]?.[1] ?? '')).toMatch(/artist rung failed/i);
    expect(warn).not.toHaveBeenCalled();
  });

  it('matches the artist name through punctuation, so "Boards of Canada!" still resolves', async () => {
    const { api } = build();
    const fetchMock = router(
      { artist: [{ name: 'boards of canada!', id: 'ARTIST' }] },
      { body: { items: [{ images: [{ url: 'https://cdn.example/cover1.png' }] }] } },
    );
    vi.stubGlobal('fetch', fetchMock);

    const covers = await api.getArtistDiscographyCovers('Boards of Canada', undefined, 5);
    expect(covers).toHaveLength(1);
  });
});

describe('getArtistDiscographyCovers — a cover that cannot be read is omitted, not faked', () => {
  it('drops an item with no artwork instead of emitting a URL the browser will fail on', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router(
        { artist: [{ name: 'Radiohead', id: 'ARTIST' }] },
        {
          body: {
            items: [
              { id: 'no-art', name: 'Untitled rip' },
              { id: 'with-art', name: 'OK Computer', images: [{ url: 'https://cdn.example/ok.png' }] },
            ],
          },
        },
      ),
    );

    const covers = await api.getArtistDiscographyCovers('Radiohead', undefined, 5);

    // The caller receives a shorter list, not a list with an undefined in it —
    // an `undefined` pushed here becomes `<img src="undefined">` in the mosaic.
    expect(covers).toEqual(['https://cdn.example/ok.png']);
  });

  it('de-duplicates repeated cover URLs, so one album does not fill the grid twice', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router(
        { artist: [{ name: 'Radiohead', id: 'ARTIST' }] },
        {
          body: {
            items: [
              { images: [{ url: 'https://cdn.example/same.png' }] },
              { images: [{ url: 'https://cdn.example/same.png' }] },
              { images: [{ url: 'https://cdn.example/other.png' }] },
            ],
          },
        },
      ),
    );

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([
      'https://cdn.example/same.png',
      'https://cdn.example/other.png',
    ]);
  });

  it('tolerates a response with no `items` key at all', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { body: {} }),
    );

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
  });
});

describe('getArtistDiscographyCovers — the `total` in the payload is read and not used', () => {
  // MEASURED 2026-09-30: `GET /v1/artists/{id}/albums` returns top-level keys
  // href, limit, next, offset, previous, total, items — and `total` was 60 for
  // Radiohead. The test comment here used to claim the opposite ("no total, so
  // there is nothing truthful to attach"), which is why the wrong claim went
  // unchallenged. The decision to return a bare list is still right, for the
  // reason the source comment gives: `total` counts releases matching
  // `include_groups=...,appears_on`, so it is not this artist's artwork count,
  // and the cover list is smaller than it again for two independent reasons.
  it('returns exactly the covers on the page when the payload carries a much larger total', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router(
        { artist: [{ name: 'Radiohead', id: 'ARTIST' }] },
        {
          body: {
            href: 'https://api.spotify.com/v1/artists/ARTIST/albums?offset=0&limit=5',
            limit: 5,
            offset: 0,
            total: 60,
            next: 'https://api.spotify.com/v1/artists/ARTIST/albums?offset=5&limit=5',
            previous: null,
            items: [
              { images: [{ url: 'https://cdn.example/a.png' }] },
              { images: [{ url: 'https://cdn.example/b.png' }] },
              { images: [{ url: 'https://cdn.example/c.png' }] },
            ],
          },
        },
      ),
    );

    const covers = await api.getArtistDiscographyCovers('Radiohead', undefined, 5);

    // Five covers were asked for, three came back, and the answer is the three.
    // Not 60, not 5, and not a "3 of 60" the caller could render as a discography
    // size — the two other numbers are both fabrications.
    expect(covers).toEqual([
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
      'https://cdn.example/c.png',
    ]);
  });

  it('does not chase the `total` with more requests, because a collage wants a page, not a census', async () => {
    // The `next` cursor is right there in the same payload, so the temptation is
    // real: paging would fill a 15-cell grid from 60 releases and cost 12 extra
    // requests per mosaic. This pins that reading a total is not a licence to
    // fetch it, and that the answer is exactly the page that was asked for.
    const { api } = build();
    const fetchMock = router(
      { artist: [{ name: 'Radiohead', id: 'ARTIST' }] },
      {
        body: {
          total: 60,
          next: 'https://api.spotify.com/v1/artists/ARTIST/albums?offset=3&limit=3',
          items: [
            { images: [{ url: 'https://cdn.example/a.png' }] },
            { images: [{ url: 'https://cdn.example/b.png' }] },
            { images: [{ url: 'https://cdn.example/c.png' }] },
          ],
        },
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 3)).resolves.toHaveLength(3);

    // One search rung, one albums request. Nothing followed `next`.
    expect(urlsOf(fetchMock).filter((u) => u.includes('/albums'))).toHaveLength(1);
  });
});

describe('getArtistDiscographyCovers — the albums endpoint failing', () => {
  it('invalidates the token on a 401 and answers [], without arming the breaker', async () => {
    const { api, invalidate } = build();
    vi.stubGlobal(
      'fetch',
      router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { status: 401 }),
    );
    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('opens the cooldown on a 429 and answers [], without invalidating the token', async () => {
    const { api, invalidate } = build();
    vi.stubGlobal(
      'fetch',
      router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { status: 429 }),
    );

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('a transport failure answers [] and is reported once at DEBUG, not swallowed', async () => {
    const { api } = build();
    const failing = vi.fn(async (..._args: unknown[]): Promise<Response> => {
      if (String(_args[0]).includes('/v1/search')) {
        return jsonResponse({ artists: { items: [{ name: 'Radiohead', id: 'ARTIST' }] } });
      }
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', failing);

    await expect(api.getArtistDiscographyCovers('Radiohead', undefined, 5)).resolves.toEqual([]);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[1] ?? '')).toMatch(/discography covers unavailable/i);
  });
});

describe('getArtistIdViaTrackSample — null for no match, a raise for no answer', () => {
  it('answers null for a blank artist name without asking Spotify', async () => {
    const { api, getToken } = build();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getArtistIdViaTrackSample('   ', 'Airbag')).resolves.toBeNull();
    await expect(api.getArtistIdViaTrackSample('Radiohead', '   ')).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RAISES while the cooldown is live, because the search would otherwise have run', async () => {
    // A null here is what `artworkService` writes into its cache as `'none'`.
    // A live cooldown is not a verdict on the artist, so it must raise and stay
    // uncached.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router({ artist: [{ name: 'Radiohead', id: 'ARTIST' }] }, { status: 429 }),
    );
    await api.getArtistDiscographyCovers('Radiohead', undefined, 5);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    await expect(api.getArtistIdViaTrackSample('Radiohead', 'Airbag')).rejects.toThrow(
      SpotifyUnavailableError,
    );
  });

  it('treats an unreadable payload shape as "no exact match", not as an outage', async () => {
    // `items` is not iterable, so the loop throws. That is a shape surprise, not
    // a failed request, and the contract says a shape surprise answers null.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (..._args: unknown[]) => jsonResponse({ tracks: { items: { nope: true } } })),
    );

    await expect(api.getArtistIdViaTrackSample('Radiohead', 'Airbag')).resolves.toBeNull();
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });

  it('answers null when the search ran and the credited artist does not match', async () => {
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router({ track: [{ name: 'Airbag', artists: [{ name: 'Someone Else', id: 'other' }] }] }),
    );

    await expect(api.getArtistIdViaTrackSample('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('picks the matching artist out of a multi-artist credit, not the first one', async () => {
    // The disambiguation this method exists for: a same-name artist where the
    // recording's credits identify the right entity.
    const { api } = build();
    vi.stubGlobal(
      'fetch',
      router({
        track: [
          {
            name: 'Esme',
            artists: [
              { name: 'EVO', id: 'evo-id' },
              { name: 'Mond', id: 'mond-id' },
            ],
          },
        ],
      }),
    );

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).resolves.toBe('mond-id');
  });
});
