import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppleMusicWebApi, renderAmArtwork } from './appleMusicWebApi';
import type { AppleMusicTokenScraper } from './appleMusicTokenScraper';

/**
 * The authenticated Apple Music catalogue search, and the artwork-size contract.
 *
 * WHY THIS CLASS MATTERS MORE THAN IT LOOKS
 * -----------------------------------------
 * It is rung two of the artwork cascade (`artworkService.ts` uses it for albums,
 * artists and tracks), behind Spotify and ahead of the no-auth iTunes rung. Every
 * consumer of it is looking for ONE thing - a cover URL - and the class can fail
 * in four ways that look identical from the outside:
 *
 *  1. no token (the scrape broke),
 *  2. the token expired (401/403),
 *  3. the search genuinely found nothing,
 *  4. the HTTP call failed (5xx, a socket error).
 *
 * Cases 1, 2 and 4 must all RAISE. Only case 3 may be an empty list. A class
 * that returned `[]` for all four would turn an outage into "this album has no
 * Apple Music artwork", which is exactly the plausible wrong answer the repo is
 * built against - and it would be invisible, because a missing cover degrades to
 * a placeholder tile.
 *
 * `ARTWORK` IS A TWO-PART CLAIM
 * ----------------------------
 * `resolveArtwork` returns `{ url, width, height }` where the numbers are
 * CLAMPED to the requested size. The clamp is not cosmetic: an Apple artwork
 * template is rendered server-side at the dimensions asked for, so requesting
 * 3000 for an asset that only exists at 600 gives a 600px image at a URL that
 * CLAIMS 3000 - and a mosaic tile that sizes itself from the number renders a
 * blurry upscale. `Math.min` keeps the declared size inside what the asset can
 * actually produce.
 */

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errorResponse = (status: number) => ({
  ok: false,
  status,
  json: async () => ({}),
});

beforeEach(() => {
  fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({ results: {} }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A token scraper double with the two methods this class calls. */
const scraperOf = (token: string | null) => {
  const invalidate = vi.fn();
  const scraper = {
    getToken: vi.fn(async () => token),
    invalidate,
  } as unknown as AppleMusicTokenScraper;
  return { scraper, invalidate };
};

/** One catalogue `data` row, shaped as the API returns it. */
const dataRow = (attributes: Record<string, unknown> = {}) => ({
  id: '1',
  attributes: {
    name: 'OK Computer',
    artistName: 'Radiohead',
    url: 'https://music.example/us/album/1',
    artwork: {
      url: 'https://img.example/thumb/abc/{w}x{h}bb.jpg',
      width: 6000,
      height: 6000,
    },
    ...attributes,
  },
});

/** Serve one catalogue shape, and hand back the api under test. */
const serving = (body: unknown, token = 'good-token') => {
  fetchMock.mockResolvedValue(jsonResponse(body));
  return new AppleMusicWebApi(scraperOf(token).scraper);
};

const queryOf = (call = 0): URL => new URL(String(fetchMock.mock.calls[call]![0]));
const headersOf = (call = 0): Record<string, string> =>
  (fetchMock.mock.calls[call]![1] as { headers?: Record<string, string> }).headers ?? {};

describe('renderAmArtwork: the template Apple sends back', () => {
  it('substitutes both dimensions', () => {
    expect(renderAmArtwork('https://x/{w}x{h}bb.jpg', 600, 600)).toBe('https://x/600x600bb.jpg');
  });

  it('substitutes a non-square size on both axes', () => {
    expect(renderAmArtwork('https://x/{w}x{h}bb.jpg', 300, 300)).toBe('https://x/300x300bb.jpg');
  });

  it('substitutes EVERY occurrence, not just the first', () => {
    // `replaceAll`, not `replace`. A template with the token twice would otherwise
    // render half-substituted and 404.
    expect(renderAmArtwork('https://x/{w}/{h}/{w}x{h}.jpg', 100, 200)).toBe(
      'https://x/100/200/100x200.jpg',
    );
  });

  it('leaves a URL with no template tokens untouched', () => {
    const plain = 'https://x/static.jpg';
    expect(renderAmArtwork(plain, 600, 600)).toBe(plain);
  });
});

describe('AppleMusicWebApi: the request it builds', () => {
  it('carries the artist into an album term, because a bare album name is ambiguous', async () => {
    await serving({ results: {} }).searchAlbums('OK Computer', 'Radiohead');

    const url = queryOf();
    expect(url.searchParams.get('term')).toBe('OK Computer Radiohead');
    expect(url.searchParams.get('types')).toBe('albums');
    expect(url.searchParams.get('l')).toBe('en-us');
  });

  it('uses a distinct entity per search, so an artist hit cannot satisfy a song query', async () => {
    const api = serving({ results: {} });

    await api.searchAlbums('OK Computer');
    expect(queryOf(0).searchParams.get('types')).toBe('albums');

    await api.searchArtists('Radiohead');
    expect(queryOf(1).searchParams.get('types')).toBe('artists');

    await api.searchSongs('Creep', 'Radiohead');
    expect(queryOf(2).searchParams.get('types')).toBe('songs');
  });

  it('carries the artist into a song term', async () => {
    await serving({ results: {} }).searchSongs('Creep', 'Radiohead');
    expect(queryOf().searchParams.get('term')).toBe('Creep Radiohead');
  });

  it('uses the bare term when no artist was given', async () => {
    await serving({ results: {} }).searchAlbums('OK Computer');
    expect(queryOf().searchParams.get('term')).toBe('OK Computer');
  });

  it('sends the scraped token as a bearer credential', async () => {
    await serving({ results: {} }, 'a-token').searchAlbums('OK Computer');
    expect(headersOf().Authorization).toBe('Bearer a-token');
  });

  it('never sends the bare token, because a malformed header reads as an expired credential', async () => {
    // Apple answers 401 to a malformed Authorization, and `search` treats 401 as
    // "your token expired" - so a missing prefix would trigger a permanent
    // invalidate-and-rescrape loop against a perfectly good token.
    await serving({ results: {} }, 'a-token').searchAlbums('OK Computer');
    expect(headersOf().Authorization).not.toBe('a-token');
  });

  it('sends the Origin header the web player sends, because the endpoint checks it', async () => {
    await serving({ results: {} }).searchAlbums('OK Computer');
    expect(headersOf().Origin).toBeDefined();
  });

  it('honours a caller-supplied limit and passes it as a string', async () => {
    await serving({ results: {} }).searchArtists('Radiohead', 7);
    expect(queryOf().searchParams.get('limit')).toBe('7');
  });

  it('asks for three rows by default, which is what the cascade needs to disambiguate', async () => {
    await serving({ results: {} }).searchAlbums('OK Computer');
    expect(queryOf().searchParams.get('limit')).toBe('3');
  });
});

describe('AppleMusicWebApi: failures that must not become an empty list', () => {
  it('raises when there is no token at all, rather than searching unauthenticated', async () => {
    // THE load-bearing assertion. `[]` would make the caller move on and read as
    // "Apple has no album by that name", so the outage would be indistinguishable
    // from an absence - and it would repeat on every single request.
    const { scraper, invalidate } = scraperOf(null);
    fetchMock.mockClear();

    await expect(new AppleMusicWebApi(scraper).searchAlbums('OK Computer')).rejects.toThrow(
      'Apple Music web token unavailable',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not invalidate a token it never sent', async () => {
    const { scraper, invalidate } = scraperOf(null);

    await expect(new AppleMusicWebApi(scraper).searchAlbums('x')).rejects.toThrow();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates the cached token on a 401, because that is what 401 means', async () => {
    const { scraper, invalidate } = scraperOf('stale-token');
    fetchMock.mockResolvedValue(errorResponse(401));

    await expect(new AppleMusicWebApi(scraper).searchAlbums('OK Computer')).rejects.toThrow(
      'Apple Music web API HTTP 401',
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached token on a 403 as well', async () => {
    // This endpoint answers 403 for an expired token as readily as 401. Both are
    // listed because both mean the credential is no longer good.
    const { scraper, invalidate } = scraperOf('stale-token');
    fetchMock.mockResolvedValue(errorResponse(403));

    await expect(new AppleMusicWebApi(scraper).searchAlbums('OK Computer')).rejects.toThrow(/403/);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate on a 404, because the token is fine and the query was not', async () => {
    // Discarding a working token over a bad query means the next card pays a full
    // re-scrape of the Apple web player. The invalidation is scoped to the two
    // statuses that actually mean "your credential is no longer good".
    const { scraper, invalidate } = scraperOf('good-token');
    fetchMock.mockResolvedValue(errorResponse(404));

    await expect(new AppleMusicWebApi(scraper).searchAlbums('Nope')).rejects.toThrow(/404/);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on a 5xx, for the same reason', async () => {
    const { scraper, invalidate } = scraperOf('good-token');
    fetchMock.mockResolvedValue(errorResponse(503));

    await expect(new AppleMusicWebApi(scraper).searchAlbums('OK Computer')).rejects.toThrow(/503/);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on a rate-limit 429, because the token is still valid', async () => {
    const { scraper, invalidate } = scraperOf('good-token');
    fetchMock.mockResolvedValue(errorResponse(429));

    await expect(new AppleMusicWebApi(scraper).searchSongs('Creep')).rejects.toThrow(/429/);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('raises the status in the message, so the log names the failure', async () => {
    const { scraper } = scraperOf('good-token');
    fetchMock.mockResolvedValue(errorResponse(500));

    await expect(new AppleMusicWebApi(scraper).searchSongs('Creep')).rejects.toThrow(
      'Apple Music web API HTTP 500',
    );
  });

  it('raises for every entity type, not only albums', async () => {
    const { scraper } = scraperOf('good-token');
    fetchMock.mockResolvedValue(errorResponse(500));
    const api = new AppleMusicWebApi(scraper);

    await expect(api.searchAlbums('a')).rejects.toThrow(/500/);
    await expect(api.searchArtists('a')).rejects.toThrow(/500/);
    await expect(api.searchSongs('a')).rejects.toThrow(/500/);
  });

  it('returns an empty list for a genuine 200 with nothing in it', async () => {
    // The honest-empty half, and the only case allowed to be `[]`.
    const api = serving({ results: {} });

    await expect(api.searchAlbums('Nobody At All')).resolves.toEqual([]);
    await expect(api.searchArtists('Nobody At All')).resolves.toEqual([]);
    await expect(api.searchSongs('Nobody At All')).resolves.toEqual([]);
  });

  it('returns an empty list when the body has no results object at all', async () => {
    await expect(serving({}).searchSongs('Nobody')).resolves.toEqual([]);
  });
});

describe('AppleMusicWebApi: mapping a catalogue row', () => {
  it('maps the album fields the cascade reads', async () => {
    const api = serving({ results: { albums: { data: [dataRow()] } } });

    const [album] = await api.searchAlbums('OK Computer', 'Radiohead');

    expect(album?.name).toBe('OK Computer');
    expect(album?.artistName).toBe('Radiohead');
    expect(album?.url).toBe('https://music.example/us/album/1');
  });

  it('maps an artist row with no artistName field at all, because the type has none', async () => {
    const api = serving({ results: { artists: { data: [dataRow({ artistName: undefined })] } } });

    const [found] = await api.searchArtists('Radiohead');

    expect(found?.name).toBe('OK Computer');
    expect(Object.keys(found ?? {})).not.toContain('artistName');
  });

  it('maps every row, not just the first', async () => {
    const api = serving({
      results: { albums: { data: [dataRow(), dataRow({ name: 'Kid A' })] } },
    });

    const albums = await api.searchAlbums('x');

    expect(albums.map((a) => a.name)).toEqual(['OK Computer', 'Kid A']);
  });

  it('substitutes empty strings for a row with no attributes, rather than crashing', async () => {
    // REPORTED, NOT PINNED: `name: attrs?.name ?? ''` makes an attribute-less row
    // indistinguishable from a row whose name genuinely is the empty string. The
    // cascade then does a strict title match against `''`, finds nothing, and
    // moves on - so the user-visible effect is "no cover", which is honest. The
    // row itself still carries a fabricated empty name, and a caller that trusted
    // it would render a blank label. Asserted as it behaves.
    const api = serving({ results: { albums: { data: [{ id: 'x' }] } } });

    const [album] = await api.searchAlbums('x');

    expect(album?.name).toBe('');
    expect(album?.artistName).toBe('');
    expect(album?.url).toBeUndefined();
    expect(album?.artwork).toBeUndefined();
  });
});

describe('AppleMusicWebApi: the artwork size contract', () => {
  const albumArtworkFor = async (artwork: unknown, requested = 3000) => {
    const api = serving({ results: { albums: { data: [dataRow({ artwork })] } } });
    const [album] = await api.searchAlbums('OK Computer', 'Radiohead', 3, requested);
    return album?.artwork;
  };

  it('clamps the declared size to what the asset actually has', async () => {
    // The load-bearing part of the contract. Requesting 3000 from a 600px asset
    // gives a 600px image; declaring 3000 would make a mosaic tile size itself
    // from a number the pixels do not support.
    expect(await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg', width: 600, height: 600 })).toEqual({
      url: 'https://x/600x600bb.jpg',
      width: 600,
      height: 600,
    });
  });

  it('renders the template at the clamped size, not at the requested one', async () => {
    const art = await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg', width: 600, height: 600 });
    expect(art?.url).toContain('600x600');
    expect(art?.url).not.toContain('3000');
  });

  it('uses the requested size when the asset is larger than asked for', async () => {
    const art = await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg', width: 6000, height: 6000 }, 1200);
    expect(art).toEqual({ url: 'https://x/1200x1200bb.jpg', width: 1200, height: 1200 });
  });

  it('clamps width and height independently, for a non-square asset', async () => {
    const art = await albumArtworkFor(
      { url: 'https://x/{w}x{h}bb.jpg', width: 600, height: 6000 },
      1000,
    );
    expect(art).toEqual({ url: 'https://x/600x1000bb.jpg', width: 600, height: 1000 });
  });

  it('falls back to the requested size when the asset declares neither dimension', async () => {
    const art = await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg' }, 800);
    expect(art).toEqual({ url: 'https://x/800x800bb.jpg', width: 800, height: 800 });
  });

  it('falls back per-axis, so a half-declared asset still gets a sane square', async () => {
    const art = await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg', width: 600 }, 900);
    expect(art).toEqual({ url: 'https://x/600x900bb.jpg', width: 600, height: 900 });
  });

  it('returns no artwork at all when the asset has no url', async () => {
    // `undefined`, not an object with empty strings: an object would render as a
    // broken image rather than as "there is no artwork here".
    expect(await albumArtworkFor(undefined)).toBeUndefined();
    expect(await albumArtworkFor({ width: 600, height: 600 })).toBeUndefined();
    expect(await albumArtworkFor({ url: '' })).toBeUndefined();
  });

  it('attaches artwork to an artist row as well as an album row', async () => {
    const api = serving({ results: { artists: { data: [dataRow()] } } });
    const [found] = await api.searchArtists('Radiohead', 3, 512);

    expect(found?.artwork).toEqual({
      url: 'https://img.example/thumb/abc/512x512bb.jpg',
      width: 512,
      height: 512,
    });
  });

  it('attaches artwork to a song row', async () => {
    const api = serving({ results: { songs: { data: [dataRow({ name: 'Creep' })] } } });
    const [found] = await api.searchSongs('Creep', 'Radiohead', 3, 256);

    expect(found?.name).toBe('Creep');
    expect(found?.artwork?.width).toBe(256);
  });

  it('never renders a placeholder token into a size, so the URL cannot 404', async () => {
    // A literal `{w}` reaching the card is an unsendable image, not a missing one.
    const art = await albumArtworkFor({ url: 'https://x/{w}x{h}bb.jpg', width: 600, height: 600 });
    expect(art?.url).not.toContain('{w}');
    expect(art?.url).not.toContain('{h}');
  });
});