import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpotifyScraperService } from './spotifyScraperService';

/**
 * The bug these tests exist for
 *
 * Spotify's embed page carries **no item count at all** — measured live
 * 2026-09-30, `/(\d+)\s+items/` matches nothing on either the embed page or the
 * main playlist page, and og:description reads "The hottest 50. Cover: ADÉLA"
 * with no item token. So the count was unreadable, `total` stayed at the shard
 * size, `hasMore` became `total > tracks.length` (i.e. `100 > 100`, false), and
 * a 347-track playlist rendered as a confident **"100 tracks"** with no
 * truncation notice anywhere.
 *
 * A second site read `totalText ?? 473` — a hardcoded, invented size — so every
 * playlist that rung scraped was reported as exactly 473 tracks, rendering as
 * "Spotify only exposes the first N of 473 tracks".
 *
 * Both now publish `totalKnown: false`, and musicService treats an unknown
 * total as truncated by an unknown amount rather than inventing a denominator.
 *
 * SCOPE: these call the private `fetchViaHtml` directly rather than
 * `fetchPlaylistPage`. The public entry tries the spclient rung first, and that
 * rung issues real network calls (measured 403/403/400 against live Spotify),
 * so going through the public method made each test take the full 5s timeout
 * before reaching the logic under test. Reaching the private is the same cast
 * the sibling unit test uses for `isCloseMatch`.
 */

const nextDataHtml = (entity: Record<string, unknown>, ogDescription = 'The hottest 50. Cover: ADÉLA'): string =>
  `<html><head><meta property="og:description" content="${ogDescription}" /></head>` +
  `<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script></body></html>`;

/**
 * An embed shard of `n` tracks, shaped the way Spotify's NEXT_DATA carries it.
 *
 * `trackList` is a FLAT ARRAY of track nodes — the service reads
 * `entity.trackList.length` and then `.map`s it directly. An earlier version of
 * this fixture nested it as `{ tracks: [...] }`, which made every assertion
 * pass through a null return and fail for a reason that had nothing to do with
 * the total.
 */
const embedPage = (n: number, ogDescription?: string): string =>
  nextDataHtml(
    {
      name: 'Big Playlist',
      owner: { displayName: 'Someone' },
      trackList: Array.from({ length: n }, (_, i) => ({
        uri: `spotify:track:${i}`,
        title: `Track ${i + 1}`,
        subtitle: 'Some Artist',
        duration: 200_000,
      })),
    },
    ogDescription,
  );

interface PageShape {
  totalKnown?: boolean;
  total: number;
  hasMore: boolean;
  tracks: unknown[];
}

/** The private rung, reached the way the class reaches it. */
const fetchViaHtml = (s: SpotifyScraperService, id: string): Promise<PageShape | null> =>
  (s as unknown as { fetchViaHtml(id: string): Promise<PageShape | null> }).fetchViaHtml(id);

describe('SpotifyScraperService — an unreadable playlist total is unknown, not a number', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stubPages = (html: string): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => html })),
    );
  };

  it('marks the total UNKNOWN when the page carries no item count', async () => {
    stubPages(embedPage(100));

    const result = await fetchViaHtml(new SpotifyScraperService(), '73VZK7BqgCVuZr5Z3rv40k');

    expect(result).not.toBeNull();
    expect(result!.tracks).toHaveLength(100);
    // The load-bearing assertion: the shard size is NOT published as a count.
    expect(result!.totalKnown).toBe(false);
  });

  it('reports totalKnown true when the page DOES carry an item count', async () => {
    // The other direction. Without it, "always unknown" would pass every test
    // above and the fix would throw away a real count when one is present.
    stubPages(embedPage(100, '347 items'));

    const result = await fetchViaHtml(new SpotifyScraperService(), '73VZK7BqgCVuZr5Z3rv40k');

    expect(result!.totalKnown).toBe(true);
    expect(result!.total).toBe(347);
    expect(result!.hasMore).toBe(true);
  });

  it('an unknown total is not the same claim as hasMore', async () => {
    // `hasMore: total > tracks.length` with total === shard is `100 > 100`,
    // false — the state that made the chunk manager call a truncated playlist
    // complete. It stays false; `totalKnown: false` is the separate signal that
    // tells the caller to warn anyway. Both must agree.
    stubPages(embedPage(100));

    const result = await fetchViaHtml(new SpotifyScraperService(), 'abc');

    expect(result!.hasMore).toBe(false);
    expect(result!.totalKnown).toBe(false);
    // An unknown size is NOT an empty result — the shard is still usable.
    expect(result!.tracks).toHaveLength(100);
  });

  it('the live-shaped fixture really lacks an item count, or these tests are vacuous', async () => {
    // A detector that cannot fail proves nothing. This asserts the fixture
    // matches the measured wire shape, so the assertions above are not passing
    // because the regex was never reached.
    expect(embedPage(100)).not.toMatch(/(\d+)\s+items/);
    expect(embedPage(100, '347 items')).toMatch(/(\d+)\s+items/);
  });
});
