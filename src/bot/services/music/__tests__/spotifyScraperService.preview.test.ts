import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifyScraperService, type ScrapedPlaylist } from '../spotifyScraperService';
import { Logger } from '@domain/logger';

/**
 * `getPreviewById` and the browser rung, plus the nested-`trackList` walk in
 * `extractPreviewFromNextData`.
 *
 * Two things here are load-bearing and neither is visible from a signature:
 *
 *  1. **The strict guard is called with EMPTY expectations on the by-id path**
 *     (`getPreviewById` → `extractPreviewFromNextData(data, '', '')`), so its
 *     final line `return cExpA === cActA` compares `''` against a real artist
 *     name and refuses every candidate that has one. There is a test below
 *     named for that, and it pins the CURRENT behaviour deliberately: the
 *     fallback on `spotifyScraperService.ts:440-441` cannot fire for any
 *     candidate carrying a subtitle. It is a reported defect, not a fix — see
 *     the file header note and the run report.
 *  2. **The browser rung's count is measured, not invented.** It used to read
 *     `totalText ?? 473`, which reported every playlist as exactly 473 tracks.
 *     The tests below pin `totalKnown: false` when the page carries no count, so
 *     the fabricated denominator cannot come back through a different route.
 *
 * Puppeteer is MOCKED at the module boundary — no browser is launched and no
 * page is rendered.
 */

vi.mock('puppeteer', () => ({
  default: { launch: (...args: unknown[]) => (globalThis as unknown as { __puppeteerLaunch: (...a: unknown[]) => unknown }).__puppeteerLaunch(...args) },
  launch: (...args: unknown[]) => (globalThis as unknown as { __puppeteerLaunch: (...a: unknown[]) => unknown }).__puppeteerLaunch(...args),
}));

interface Internals {
  fetchViaPuppeteer(id: string, offset?: number, limit?: number): Promise<ScrapedPlaylist | null>;
  fetchViaHtml(id: string): Promise<ScrapedPlaylist | null>;
  getWebPlayerToken(): Promise<string | null>;
}

let fetchMock: ReturnType<typeof vi.fn>;

const svc = () => new SpotifyScraperService();

const nextDataHtml = (payload: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;

const withToken = (token: string | null = null): [SpotifyScraperService, Internals] => {
  const s = svc();
  const internals = s as unknown as Internals;
  internals.getWebPlayerToken = async () => token;
  return [s, internals];
};

/** The NEXT_DATA entity shape `getPreviewById` reads first. */
const entityPage = (entity: Record<string, unknown>) =>
  nextDataHtml({ props: { pageProps: { state: { data: { entity } } } } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getPreviewById — the NEXT_DATA entity read', () => {
  it('takes the preview, names, duration and cover off the entity', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        entityPage({
          audioPreview: { url: 'https://p.scdn.co/mp3-preview/aaa' },
          name: 'Airbag',
          artists: [{ name: 'Radiohead' }, { name: 'Guest' }],
          duration: 284_000,
          coverArt: { sources: [{ url: 'https://img.test/a.jpg' }] },
        }),
      json: async () => ({}),
    });

    const res = await svc().getPreviewById('abc123');

    expect(res).toEqual({
      previewUrl: 'https://p.scdn.co/mp3-preview/aaa',
      trackName: 'Airbag',
      artistName: 'Radiohead',
      durationMs: 284_000,
      artworkUrl: 'https://img.test/a.jpg',
      spotifyUrl: 'https://open.spotify.com/track/abc123',
    });
  });

  it('falls back to `title` and to the first name in `subtitle` when there is no `name`', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        entityPage({
          audioPreview: { url: 'https://p.scdn.co/mp3-preview/bbb' },
          title: 'KILL YA',
          subtitle: 'Yeat, Someone Else',
        }),
      json: async () => ({}),
    });

    const res = await svc().getPreviewById('abc123');

    expect(res?.trackName).toBe('KILL YA');
    // Only the FIRST billed artist, not the whole subtitle string.
    expect(res?.artistName).toBe('Yeat');
  });

  it('reads the cover from `image[0]` when there is no `coverArt`', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        entityPage({
          audioPreview: { url: 'https://p.scdn.co/mp3-preview/ccc' },
          name: 'X',
          image: [{ url: 'https://img.test/x.jpg' }],
        }),
      json: async () => ({}),
    });

    const res = await svc().getPreviewById('abc123');

    expect(res?.artworkUrl).toBe('https://img.test/x.jpg');
  });

  it('names the track "Unknown" rather than undefined when the entity carries neither', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => entityPage({ audioPreview: { url: 'https://p.scdn.co/mp3-preview/ddd' } }),
      json: async () => ({}),
    });

    const res = await svc().getPreviewById('abc123');

    // "undefined" on the card would be a different wrong answer from "Unknown".
    expect(res?.trackName).toBe('Unknown');
    expect(res?.artistName).toBe('Unknown');
    expect(res?.durationMs).toBe(0);
  });

  it('a non-ok embed page is null, and it is a MISS rather than a verdict on the track', async () => {
    // previewResolverService falls through to Apple and Deezer after this, and
    // caches only a success, so a refused embed cannot become "no preview
    // exists" anywhere downstream.
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '', json: async () => ({}) });

    await expect(svc().getPreviewById('abc123')).resolves.toBeNull();
  });

  it('a NEXT_DATA block that will not parse falls through to the raw URL scrape', async () => {
    // Unparseable JSON means this page shape carries no usable data, not that
    // the track has no preview. The raw `p.scdn.co` read is the next thing to
    // try, and it works on the same page.
    const html = `<script id="__NEXT_DATA__" type="application/json">{not json</script>` +
      `${'x'.repeat(400)}https://p.scdn.co/mp3-preview/deadbeefcafe "duration": 30000`;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/deadbeefcafe');
  });

  it('a page with no preview URL at all is null, not a fabricated link', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>no preview here</html>',
      json: async () => ({}),
    });

    await expect(svc().getPreviewById('abc123')).resolves.toBeNull();
  });

  it('a fetch that throws is null rather than a rejection out of the artwork path', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    await expect(svc().getPreviewById('abc123')).resolves.toBeNull();
  });
});

describe('getPreviewById — the raw URL scrape fallback', () => {
  it('returns the marker it found, not one from elsewhere on the page', async () => {
    // The scan is anchored: it takes the FIRST `p.scdn.co/mp3-preview/` marker
    // and reads only a window around it. A page-wide regex would pick whichever
    // the markup happened to render first, which is not necessarily this track.
    const html = `https://p.scdn.co/mp3-preview/abcdef0123456789 "duration": 30000${'y'.repeat(900)}https://p.scdn.co/mp3-preview/0000000000000000`;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/abcdef0123456789');
    expect(res?.durationMs).toBe(30000);
  });

  it('a decoy marker BEFORE the real one wins, which is the known limit of the anchor', async () => {
    // Pinned deliberately. The anchor is "first marker on the page", not "the
    // marker that belongs to this track" — nothing here can tell them apart.
    // Asserted so the behaviour is documented rather than discovered, and so a
    // change to the anchor is visible as a change to THIS test.
    const html = `https://p.scdn.co/mp3-preview/0000000000000000${'y'.repeat(400)}https://p.scdn.co/mp3-preview/abcdef0123456789`;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/0000000000000000');
  });

  it('names the track and artist from the page JSON when NEXT_DATA gave nothing', async () => {
    const html = `https://p.scdn.co/mp3-preview/abcdef0123456789 "duration": 1000 "title": "GONE 4 A MIN" "artists": [{"name": "Yeat"}]`;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.trackName).toBe('GONE 4 A MIN');
    expect(res?.artistName).toBe('Yeat');
  });

  it('leaves the names as Unknown when the page carries none', async () => {
    const html = 'https://p.scdn.co/mp3-preview/abcdef0123456789 "duration": 1000';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.trackName).toBe('Unknown');
    expect(res?.artistName).toBe('Unknown');
  });

  it('a marker with no duration reads 0 rather than NaN', async () => {
    // `Number(undefined)` is NaN, and NaN on a card renders as a broken clock.
    const html = 'https://p.scdn.co/mp3-preview/abcdef0123456789';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const res = await svc().getPreviewById('abc123');

    expect(res?.durationMs).toBe(0);
  });
});

describe('extractPreviewFromNextData — the nested trackList walk', () => {
  /** A search page whose candidates are reachable only through `trackList`. */
  const searchPage = (items: unknown[]) =>
    nextDataHtml({ props: { pageProps: { state: { data: { entity: { tracks: { items } } } } } } });

  const candidate = (title: string, subtitle: string, preview: string) => ({
    title,
    subtitle,
    uri: 'spotify:track:xyz',
    duration: 111_000,
    audioPreview: { url: preview },
  });

  it('descends into a nested trackList and accepts the matching row', async () => {
    // The search page carries its candidates two levels down. A visitor that did
    // not recurse would find nothing and answer null — a false negative that
    // costs a real preview.
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/search/')) {
        return { ok: true, status: 200, text: async () => searchPage([{ trackList: [candidate('Airbag', 'Radiohead', 'https://p.scdn.co/mp3-preview/nested')] }]), json: async () => ({}) };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    const res = await s.getTrackPreview('Radiohead', 'Airbag');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/nested');
    expect(res?.spotifyUrl).toBe('https://open.spotify.com/track/xyz');
  });

  it('prefers the row matching BOTH artist and title over one matching only the artist', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/search/')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            searchPage([
              candidate('Creep', 'Radiohead', 'https://p.scdn.co/mp3-preview/artist-only'),
              candidate('Airbag', 'Radiohead', 'https://p.scdn.co/mp3-preview/both'),
            ]),
          json: async () => ({}) as unknown,
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    const res = await s.getTrackPreview('Radiohead', 'Airbag');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/both');
  });

  it('a page with candidates but no audioPreview anywhere is null, never a wrong row', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/search/')) {
        return { ok: true, status: 200, text: async () => searchPage([{ title: 'Airbag', subtitle: 'Radiohead' }]), json: async () => ({}) };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('a candidate with no subtitle is REFUSED, because an empty operand satisfies nothing', async () => {
    // Was accepted until the guard was tightened: `'radiohead'.includes('')`
    // is `true`, so an artist-less row used to pass on the title alone. There is
    // no positive evidence that such a row is the requested recording.
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/search/')) {
        return {
          ok: true,
          status: 200,
          text: async () => searchPage([{ title: 'Airbag', subtitle: '', audioPreview: { url: 'https://p.scdn.co/mp3-preview/nosub' } }]),
          json: async () => ({}) as unknown,
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('a candidate whose TITLE is missing is refused too, for the same reason', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/search/')) {
        return {
          ok: true,
          status: 200,
          text: async () => searchPage([{ title: '', subtitle: 'Radiohead', audioPreview: { url: 'https://p.scdn.co/mp3-preview/notitle' } }]),
          json: async () => ({}) as unknown,
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });
});

describe('getPreviewById — the empty-expectation fallback, which now refuses everything', () => {
  /**
   * `getPreviewById` calls `extractPreviewFromNextData(data, '', '')` when the
   * entity itself carries no `audioPreview`
   * (`spotifyScraperService.ts:440-441`). With no artist and no track to match
   * against, `isCloseMatch` now returns false on its empty-operand guard, so
   * that fallback cannot return a row.
   *
   * That is the RIGHT answer for a wrong-song guard — the branch has no way to
   * know the candidate is the requested recording, and a wrong preview is worse
   * than none. It is also DEAD in practice, so it is pinned here: a reader who
   * sees the branch in the source can tell from this test that it refuses
   * rather than reaching the raw URL scrape beneath it.
   */
  it('refuses a candidate that has an artist, because the guard is given none to match', async () => {
    const html = nextDataHtml({
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                tracks: { items: [{ title: 'Airbag', subtitle: 'Radiohead', audioPreview: { url: 'https://preview.invalid/deadbranch' } }] },
              },
            },
          },
        },
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    await expect(svc().getPreviewById('abc123')).resolves.toBeNull();
  });

  it('refuses a candidate with no artist as well, so the branch is inert in both directions', async () => {
    // The companion case. Before the empty-operand guard this one DID return a
    // row, which is how the branch looked alive in a coverage report.
    const html = nextDataHtml({
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                tracks: { items: [{ title: 'Airbag', subtitle: '', audioPreview: { url: 'https://preview.invalid/alive' } }] },
              },
            },
          },
        },
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    await expect(svc().getPreviewById('abc123')).resolves.toBeNull();
  });

  it('the entity read above it still works, so the guard is not what makes getPreviewById useful', async () => {
    // Without this, "the fallback refuses" and "getPreviewById never returns
    // anything" are indistinguishable — and the second would be a real loss.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        entityPage({
          audioPreview: { url: 'https://p.scdn.co/mp3-preview/entity' },
          name: 'Airbag',
          artists: [{ name: 'Radiohead' }],
        }),
      json: async () => ({}),
    });

    await expect(svc().getPreviewById('abc123')).resolves.toMatchObject({
      previewUrl: 'https://p.scdn.co/mp3-preview/entity',
      trackName: 'Airbag',
      artistName: 'Radiohead',
    });
  });
});

describe('fetchViaPuppeteer — the browser rung, with the browser mocked', () => {
  interface PageDouble {
    rows: Array<{ name: string; artist: string }>;
    totalText: number | null;
    visibleRows: number;
    close: () => Promise<void>;
    goto: () => Promise<void>;
  }

  const installPuppeteer = (page: Partial<PageDouble>, launchThrows = false) => {
    const evaluate = vi.fn(async (fn: () => unknown) => {
      const src = String(fn);
      if (src.includes('scrollBy')) return undefined;
      if (src.includes('og:description')) return page.totalText ?? null;
      if (src.includes('data-encore-id')) return page.rows ?? [];
      return page.visibleRows ?? 999;
    });
    const newPage = {
      setUserAgent: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      evaluate,
      close: vi.fn(async () => undefined),
    };
    const browser = { newPage: vi.fn(async () => newPage), close: vi.fn(async () => undefined) };
    (globalThis as unknown as { __puppeteerLaunch: unknown }).__puppeteerLaunch = async () => {
      if (launchThrows) throw new Error('chrome not found');
      return browser;
    };
    return { browser, newPage };
  };

  const rows = (n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => ({ name: `Row ${start + i + 1}`, artist: 'Some Artist' }));

  it('reads the rows and reports the shard as the size when the page carries no count', async () => {
    // The regression: this rung used to report `totalText ?? 473`, so EVERY
    // playlist it scraped was published as exactly 473 tracks.
    const { newPage } = installPuppeteer({ rows: rows(3), totalText: null });
    const [, internals] = withToken();

    const page = await internals.fetchViaPuppeteer('abc', 0, 100);

    expect(page?.tracks).toHaveLength(3);
    expect(page?.total).toBe(3);
    expect(page?.totalKnown).toBe(false);
    expect(page?.hasMore).toBe(false);
    expect(page?.nextOffset).toBeNull();
    expect(newPage.goto).toHaveBeenCalled();
  });

  it('a READABLE count is honoured, and the pager is told there is more', async () => {
    const { browser } = installPuppeteer({ rows: rows(3), totalText: 347 });
    const [, internals] = withToken();

    const page = await internals.fetchViaPuppeteer('abc', 0, 100);

    expect(page?.total).toBe(347);
    expect(page?.totalKnown).toBe(true);
    expect(page?.hasMore).toBe(true);
    expect(page?.nextOffset).toBe(3);
    // The browser is always closed, or it leaks a process per playlist.
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('slices the requested window, so a later page does not re-deliver page one', async () => {
    installPuppeteer({ rows: rows(50), totalText: 347 });
    const [, internals] = withToken();

    const page = await internals.fetchViaPuppeteer('abc', 10, 5);

    expect(page?.tracks.map((t) => t.name)).toEqual(['Row 11', 'Row 12', 'Row 13', 'Row 14', 'Row 15']);
    expect(page?.nextOffset).toBe(15);
  });

  it('a window past the end of what was scraped is null, not an empty "page"', async () => {
    installPuppeteer({ rows: rows(3), totalText: 3 });
    const [, internals] = withToken();

    await expect(internals.fetchViaPuppeteer('abc', 100, 100)).resolves.toBeNull();
  });

  it('a page with no rows at all is null, so the caller falls through rather than caching a blank', async () => {
    installPuppeteer({ rows: [], totalText: null });
    const [, internals] = withToken();

    await expect(internals.fetchViaPuppeteer('abc', 0, 100)).resolves.toBeNull();
  });

  it('a browser that will not launch is a rung failing, reported once and not thrown', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    installPuppeteer({}, true);
    const [, internals] = withToken();

    await expect(internals.fetchViaPuppeteer('abc', 0, 100)).resolves.toBeNull();
    // Golden rule 10: a lost capability is WARN, and this one is logged with
    // the id so a deploy log says WHICH playlist could not be read.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ playlistId: 'abc' });
  });

  it('a browser that will not close still yields the result, because the finally swallows it', async () => {
    installPuppeteer({ rows: rows(2), totalText: 2 });
    const { browser } = installPuppeteer({ rows: rows(2), totalText: 2 });
    (browser.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('already gone'));
    const [, internals] = withToken();

    const page = await internals.fetchViaPuppeteer('abc', 0, 100);

    // Throwing from the `finally` would replace a usable page with a rejection.
    expect(page?.tracks).toHaveLength(2);
  });

  it('reports owner and name as placeholders, because the browser rung reads neither', async () => {
    // Stated so a caller does not treat these as vendor data: the album cover
    // is therefore absent on this path too.
    installPuppeteer({ rows: rows(1), totalText: 1 });
    const [, internals] = withToken();

    const page = await internals.fetchViaPuppeteer('abc', 0, 100);

    expect(page?.name).toBe('Spotify Playlist');
    expect(page?.owner).toBe('Spotify');
    expect(page?.artworkUrl).toBeUndefined();
    expect(page?.tracks[0]?.durationMs).toBe(0);
  });
});
