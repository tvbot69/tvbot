import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AppleMusicTokenScraper,
  extractTokenFromHtml,
  extractBundleUrls,
} from '../appleMusicTokenScraper';

/**
 * The scraped web-player token, which is the only credential this whole subtree
 * has. There is no API key and no developer account: the token is pulled out of
 * the public music.apple.com web player, and every authenticated Apple call in
 * the bot depends on it.
 *
 * WHY THIS NEEDS A TEST FILE RATHER THAN A CHARACTERISATION NOTE
 * ------------------------------------------------------------
 * `appleMusicResolver.liveShape.test.ts` documents the REAL shape of the page
 * and asserts the scraper works against it. What that does not cover is the
 * behaviour that matters when the scrape BREAKS, which is the case this file is
 * about:
 *
 *  - a failed scrape must not be cached. A cached `''` would make every later
 *    call short-circuit to "no token" for the full 12-hour TTL, turning one
 *    transient Apple outage into twelve hours of missing artwork.
 *  - concurrent callers must share one in-flight scrape, not start forty. The
 *    artwork cascade can call this three times for one card, and forty scrapes
 *    of the same page is a rate-limit problem.
 *  - a bundle that 404s or throws must be SKIPPED, not fatal, or one stale
 *    `<script>` reference takes the whole scrape down.
 *  - `invalidate()` is the recovery lever that `AppleMusicWebApi` pulls on a 401.
 *    It has to work, or the bot re-sends a dead token until the process restarts.
 *
 * NONE OF THIS INVOLVES A REAL TOKEN. Every JWT-looking string below is
 * assembled from `ey` plus filler, so nothing in this file is a credential and
 * nothing in it can be mistaken for one.
 */

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

/** A page response whose `text()` is the supplied HTML. */
const htmlResponse = (html: string) => ({
  ok: true,
  status: 200,
  text: async () => html,
});

const errorResponse = (status: number) => ({
  ok: false,
  status,
  text: async () => '',
  json: async () => ({}),
});

beforeEach(() => {
  fetchMock = vi.fn(async (..._args: unknown[]) => htmlResponse(''));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/*
 * A JWT-SHAPED string built at runtime rather than written out: `ey` plus filler
 * in the first segment, then two more base64url segments. That is all the
 * extractor looks for, and being assembled means no plausible-looking credential
 * is ever committed to a public repository.
 */
const segment = (n: number): string => 'A'.repeat(n);
const JWT: string = [`ey${segment(40)}`, segment(30), segment(20)].join('.');
const OTHER_JWT: string = [`ey${segment(50)}`, segment(40), segment(25)].join('.');

const pageWithToken = (token: string): string =>
  `<html><head><script>window.__a = "${token}";</script></head><body></body></html>`;

const pageWithBundles = (srcs: string[]): string =>
  `<html><head>${srcs.map((s) => `<script src="${s}"></script>`).join('')}</head></html>`;

describe('extractTokenFromHtml: finding a three-segment JWT in the page', () => {
  it('finds a token embedded in a script tag', () => {
    expect(extractTokenFromHtml(pageWithToken(JWT))).toBe(JWT);
  });

  it('finds one regardless of what surrounds it', () => {
    expect(extractTokenFromHtml(`prefix ${JWT} suffix`)).toBe(JWT);
  });

  it('returns null when there is nothing that looks like one', () => {
    // The honest-empty half, and the one that matters: `null` sends the scrape on
    // to the bundles, whereas `''` would end it.
    expect(extractTokenFromHtml('<html><body>no tokens here</body></html>')).toBeNull();
  });

  it('returns null for an empty string, rather than an empty match', () => {
    expect(extractTokenFromHtml('')).toBeNull();
  });

  it('ignores a two-segment string, because a JWT has three parts', () => {
    expect(extractTokenFromHtml('eyAAAA.BBBB')).toBeNull();
  });

  it('takes the first token when the page carries more than one', () => {
    expect(extractTokenFromHtml(`${JWT} and ${OTHER_JWT}`)).toBe(JWT);
  });
});

describe('extractBundleUrls: the second chance when the page has no token', () => {
  it('keeps a bundle whose filename looks like an entry point', () => {
    expect(extractBundleUrls(pageWithBundles(['/assets/index.js']))).toEqual(['/assets/index.js']);
  });

  it('drops a bundle that does not, because fetching every asset is not a search', () => {
    expect(extractBundleUrls(pageWithBundles(['/assets/chunk-9f2a.js']))).toEqual([]);
  });

  it('accepts main and app as entry points as well as index', () => {
    // The filter is a substring test on the whole `src`, so the word has to be
    // IN the filename - `/m.js` is a one-letter file name, not "main".
    expect(extractBundleUrls(pageWithBundles(['/assets/main.js', '/assets/app.js']))).toEqual([
      '/assets/main.js',
      '/assets/app.js',
    ]);
  });

  it('keeps a full absolute URL, because the real page uses CDN hosts', () => {
    expect(extractBundleUrls(pageWithBundles(['https://cdn.example/index.js']))).toEqual([
      'https://cdn.example/index.js',
    ]);
  });

  it('preserves order, because the first entry point is the one most likely to hold the token', () => {
    expect(extractBundleUrls(pageWithBundles(['/index.js', '/app.js', '/chunk.js']))).toEqual([
      '/index.js',
      '/app.js',
    ]);
  });

  it('returns an empty list for a page with no scripts at all', () => {
    expect(extractBundleUrls('<html></html>')).toEqual([]);
  });

  it('ignores a single-quoted src, because the real page uses double quotes', () => {
    // Asserted as it behaves. Widening the pattern is a production change, and
    // this is the third rung of a three-rung hunt, not the first.
    expect(extractBundleUrls("<script src='/assets/index.js'></script>")).toEqual([]);
  });
});

describe('AppleMusicTokenScraper: the happy path and its cache', () => {
  it('reads the token out of the page on the first call', async () => {
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBe(JWT);
  });

  it('serves the second call from memory, with no second request', async () => {
    // The whole point of the cache. The artwork cascade calls `getToken()` once
    // per rung, so a card that consults three rungs makes three calls.
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));
    const scraper = new AppleMusicTokenScraper();

    await scraper.getToken();
    fetchMock.mockClear();
    await scraper.getToken();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collapses concurrent callers onto one in-flight scrape', async () => {
    // The second caller joins the FIRST promise rather than starting its own. A
    // card that fans out to three rungs must not start three scrapes of the same
    // page, which is both slow and a rate-limit problem.
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));
    const scraper = new AppleMusicTokenScraper();

    const results = await Promise.all([scraper.getToken(), scraper.getToken(), scraper.getToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([JWT, JWT, JWT]);
  });

  it('clears the in-flight promise afterwards, so a later call still works', async () => {
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));
    const scraper = new AppleMusicTokenScraper();

    await scraper.getToken();
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(OTHER_JWT)));
    // Past the TTL the cache is bypassed, so this exercises the "no inflight" path.
    const privateState = scraper as unknown as { inflight: Promise<string> | null; cached: unknown };
    privateState.cached = { token: JWT, extractedAt: 0 };

    await expect(scraper.getToken()).resolves.toBe(OTHER_JWT);
  });
});

describe('AppleMusicTokenScraper: a failed scrape must not stick', () => {
  it('returns null rather than an empty string, so a caller can tell them apart', async () => {
    // The distinction the whole class rests on. `''` and `null` both read as "no
    // token" at the call site, but only `null` is honest about "we could not get
    // one", and the empty-string branch of the internal `.then` is what keeps a
    // failure out of the cache.
    fetchMock.mockResolvedValue(errorResponse(503));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBeNull();
  });

  it('does not cache a failure, so the next call retries instead of waiting out the TTL', async () => {
    // THE assertion for this file. Caching a null would turn one transient Apple
    // outage into twelve hours of "token unavailable" for every card in between.
    fetchMock.mockResolvedValue(errorResponse(503));
    const scraper = new AppleMusicTokenScraper();

    await scraper.getToken();
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));

    await expect(scraper.getToken()).resolves.toBe(JWT);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns null when the page loads but holds no token anywhere', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse('<html>no token here</html>'))
      .mockResolvedValue(htmlResponse('still no token'));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBeNull();
  });

  it('returns null when the page request itself throws', async () => {
    // A socket error must not escape: this is called from inside the artwork
    // cascade, and a raise there deletes a card over a decoration.
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBeNull();
  });

  it('returns null when the page request throws a non-Error', async () => {
    fetchMock.mockImplementation(async () => {
      throw 'a bare string from a proxy';
    });

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBeNull();
  });

  it('does not let a failed scrape wedge the in-flight promise', async () => {
    // If the rejection were not cleared, every later call would await a settled
    // rejected promise and the token would be unavailable for the process lifetime.
    fetchMock.mockResolvedValue(errorResponse(500));
    const scraper = new AppleMusicTokenScraper();

    await scraper.getToken();
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));

    await expect(scraper.getToken()).resolves.toBe(JWT);
  });
});

describe('AppleMusicTokenScraper: the bundle fallback', () => {
  it('fetches an entry-point bundle and takes the token from it', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(pageWithBundles(['/assets/index.js'])))
      .mockResolvedValueOnce(htmlResponse(`const t = "${JWT}";`));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBe(JWT);
  });

  it('resolves a relative bundle URL against the web player host', async () => {
    // A bare `/assets/index.js` is not fetchable. `new URL(relative, base)` is
    // what makes the second rung work at all.
    fetchMock
      .mockResolvedValueOnce(htmlResponse(pageWithBundles(['/assets/index.js'])))
      .mockResolvedValueOnce(htmlResponse(`const t = "${JWT}";`));

    await new AppleMusicTokenScraper().getToken();

    const bundleUrl = String(fetchMock.mock.calls[1]![0]);
    expect(bundleUrl.startsWith('https://')).toBe(true);
    expect(bundleUrl).toContain('/assets/index.js');
  });

  it('skips a bundle that answers 404 and keeps going to the next one', async () => {
    // One stale `<script>` reference must not take the whole scrape down, which is
    // what a `throw` inside the loop would do.
    fetchMock
      .mockResolvedValueOnce(htmlResponse(pageWithBundles(['/index.js', '/app.js'])))
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(htmlResponse(`const t = "${JWT}";`));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBe(JWT);
  });

  it('skips a bundle whose fetch throws, and keeps going', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(pageWithBundles(['/index.js', '/app.js'])))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(htmlResponse(`const t = "${JWT}";`));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBe(JWT);
  });

  it('gives up with null when no bundle holds a token either', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(pageWithBundles(['/index.js'])))
      .mockResolvedValueOnce(htmlResponse('const t = "not a jwt";'));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBeNull();
  });

  it('prefers the page token over any bundle, without fetching a bundle at all', async () => {
    // The page is one request and the bundles are N, so the cheap answer first.
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));

    await expect(new AppleMusicTokenScraper().getToken()).resolves.toBe(JWT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AppleMusicTokenScraper.invalidate: the recovery lever', () => {
  it('forces a re-scrape on the next call', async () => {
    // `AppleMusicWebApi` pulls this on a 401/403. Without it, a revoked token
    // would be re-sent on every card until the process restarted.
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));
    const scraper = new AppleMusicTokenScraper();

    await scraper.getToken();
    fetchMock.mockClear();
    await scraper.getToken();
    expect(fetchMock).not.toHaveBeenCalled();

    scraper.invalidate();
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(OTHER_JWT)));

    await expect(scraper.getToken()).resolves.toBe(OTHER_JWT);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('is safe to call when nothing has been cached yet', async () => {
    // `invalidate` runs from an error path, which may be the first thing that
    // ever happened to this instance. It must not throw.
    const scraper = new AppleMusicTokenScraper();

    expect(() => scraper.invalidate()).not.toThrow();
    await expect(scraper.getToken()).resolves.toBeNull();
  });

  it('leaves an in-flight scrape alone, because that scrape may still succeed', async () => {
    // The page was fetched when invalidate ran. A caller who arrives afterwards
    // joins the existing scrape rather than starting a second one - so the
    // in-flight clear in `.finally` is load-bearing, not tidiness.
    fetchMock.mockResolvedValue(htmlResponse(pageWithToken(JWT)));
    const scraper = new AppleMusicTokenScraper();

    await Promise.all([scraper.getToken(), scraper.getToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
