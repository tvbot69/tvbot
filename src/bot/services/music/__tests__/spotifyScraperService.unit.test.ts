import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SpotifyScraperService } from '@bot/services/music/spotifyScraperService';
import { Logger } from '@domain/logger';

/**
 * spotifyScraperService was 32% with 297 uncovered lines.
 *
 * Two things here are load-bearing and neither is obvious from the signature:
 *
 *  1. The RUNG ORDER. fetchPlaylistPage tries the spclient API, then HTML, then
 *     a real browser, and only moves on when the previous one returns nothing
 *     usable. A rung that returns an EMPTY track list must not be accepted -
 *     an empty playlist and a failed fetch are different outcomes, and
 *     accepting the first would silently produce a blank queue.
 *
 *  2. `isCloseMatch` is what stops the wrong song being played. Spotify's
 *     search returns the nearest match, not the exact one, so a "Radiohead"
 *     query can hand back a remix by someone else. A wrong-artist preview is
 *     worse than no preview, so the guard rejects rather than degrades.
 */

let fetchMock: ReturnType<typeof vi.fn>;

const svc = () => new SpotifyScraperService();

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const trackNode = (title: string, subtitle: string, preview = 'https://p.scdn.co/mp3-preview/abc') => ({
  title,
  subtitle,
  uri: `spotify:track:${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
  duration: 210000,
  audioPreview: { url: preview },
  coverArt: { sources: [{ url: 'https://img/art.png' }] },
});

const nextDataHtml = (payload: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The private guard, reached the way the class reaches it. */
const closeMatch = (s: SpotifyScraperService, ea: string, et: string, aa: string, at: string) =>
  (s as unknown as { isCloseMatch(ea: string, et: string, aa: string, at: string): boolean })
    .isCloseMatch(ea, et, aa, at);

describe('SpotifyScraperService.isCloseMatch', () => {
  it('accepts an exact artist and title match', () => {
    expect(closeMatch(svc(), 'Radiohead', 'Airbag', 'Radiohead', 'Airbag')).toBe(true);
  });

  it('ignores case and punctuation, so "AC/DC" matches "AC DC"', () => {
    expect(closeMatch(svc(), 'AC/DC', 'T.N.T.', 'AC DC', 'TNT')).toBe(true);
  });

  it('accepts a title that CONTAINS the expected one', () => {
    // Spotify frequently returns "Airbag (Remastered)" for "Airbag".
    expect(closeMatch(svc(), 'Radiohead', 'Airbag', 'Radiohead', 'Airbag (Remastered)')).toBe(true);
  });

  it('REJECTS the right artist with a DIFFERENT title, which the loose tail used to accept', async () => {
    // THE INVERSION. This test used to read "accepts when the artist matches and
    // the title differs slightly" and assert `true` for ('Radiohead','Airbag')
    // against ('Radiohead','Airbag Redux'), pinning the predicate's final
    // `return cExpA === cActA` — which accepted ANY title once the artist
    // matched.
    //
    // That is the wrong answer for both of this class's callers. `getTrackPreview`
    // and `extractPreviewFromNextData` both ask "is this the recording the user
    // asked for", and Spotify's search returns the NEAREST match rather than the
    // exact one — so a "Radiohead Creep" query routinely returns "Karma Police",
    // which the old tail accepted and handed back as a working preview button.
    // `previewResolverService.validateTrack` was later added around this file to
    // close the Spotify rung inside `resolve`, and its own test file recorded
    // this predicate as still loose; the predicate itself was never tightened.
    //
    // The behaviour a user would see: asking for a preview of one Radiohead song
    // and being handed a different Radiohead song, with no indication.
    const svc = new SpotifyScraperService();
    // A right-artist row whose title shares nothing with the expected one.
    expect(closeMatch(svc, 'Radiohead', 'Creep', 'Radiohead', 'Karma Police')).toBe(false);
    expect(closeMatch(svc, 'Radiohead', 'Airbag', 'Radiohead', 'Let Down')).toBe(false);
    // And the same pair the old test used, which is now decided by the
    // CONTAINMENT rule rather than by the loose tail: 'Airbag Redux' contains
    // 'Airbag', so this one is still accepted — by a rule that was always
    // intended, not by the one being removed.
    expect(closeMatch(svc, 'Radiohead', 'Airbag', 'Radiohead', 'Airbag Redux')).toBe(true);
  });

  it('rejects a row with NO title to corroborate against', async () => {
    // The other half of the strictness. Empty strings clean to '', so a missing
    // title or artist must not satisfy a containment test. `getPreviewById`
    // reaches `extractPreviewFromNextData` with empty expectations, and this is
    // the line that stops that path claiming a match.
    const svc = new SpotifyScraperService();
    expect(closeMatch(svc, '', '', 'Radiohead', 'Airbag')).toBe(false);
    expect(closeMatch(svc, 'Radiohead', 'Airbag', '', 'Airbag')).toBe(false);
    expect(closeMatch(svc, 'Radiohead', 'Airbag', 'Radiohead', '')).toBe(false);
  });

  it('REJECTS a different artist even when the title matches exactly', () => {
    // The whole point of the guard: a same-titled song by someone else is a
    // wrong track, and playing it silently is worse than playing nothing.
    expect(closeMatch(svc(), 'Radiohead', 'Creep', 'Nine Inch Nails', 'Creep')).toBe(false);
  });

  it('rejects an unrelated artist and title', () => {
    expect(closeMatch(svc(), 'Radiohead', 'Airbag', 'Aphex Twin', 'Xtal')).toBe(false);
  });

  it('rejects when only the title partially overlaps', () => {
    // "Air" must not be accepted for "Airbag" with a different artist.
    expect(closeMatch(svc(), 'Radiohead', 'Airbag', 'Boards of Canada', 'Air')).toBe(false);
  });
});

describe('SpotifyScraperService web player token', () => {
  const token = async (s: SpotifyScraperService) =>
    (s as unknown as { getWebPlayerToken(): Promise<string | null> }).getWebPlayerToken();

  it('caches the token and does not refetch on the second call', async () => {
    fetchMock.mockResolvedValue(
      res({ accessToken: 'T1', accessTokenExpirationTimestampMs: Date.now() + 3600_000 }),
    );
    const s = svc();

    await expect(token(s)).resolves.toBe('T1');
    const afterFirst = fetchMock.mock.calls.length;
    await expect(token(s)).resolves.toBe('T1');

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('refetches once the cached token is within a minute of expiring', async () => {
    // The 60s margin exists so a token cannot expire mid-request.
    fetchMock.mockResolvedValue(
      res({ accessToken: 'T1', accessTokenExpirationTimestampMs: Date.now() + 30_000 }),
    );
    const s = svc();

    await token(s);
    const afterFirst = fetchMock.mock.calls.length;
    await token(s);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('returns null when every endpoint and header combination fails', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    await expect(token(svc())).resolves.toBeNull();
  });

  it('returns null when the response carries no token at all', async () => {
    fetchMock.mockResolvedValue(res({ unrelated: true }));
    await expect(token(svc())).resolves.toBeNull();
  });

  it('walks to the next endpoint after a non-ok response', async () => {
    fetchMock
      .mockResolvedValueOnce(res({}, 500))
      .mockResolvedValue(res({ accessToken: 'FOUND', accessTokenExpirationTimestampMs: Date.now() + 3600_000 }));
    await expect(token(svc())).resolves.toBe('FOUND');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('survives fetch throwing outright', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(token(svc())).resolves.toBeNull();
  });
});

/**
 * The token is unobtainable. Measured 2026-09-30: every endpoint answers 403,
 * 403 and then 400, on every header set, forever. Before this block the walk
 * cost ~2 seconds on EVERY call and said nothing at all — golden rule 10 puts a
 * lost capability at WARN, and a rung that keeps paying for a no costs a
 * playlist load its whole budget.
 *
 * The rung is KEPT, deliberately. `fetchViaSpclient` is one of three rungs
 * behind `fetchPlaylistPage`, and the other two (the embed/HTML read and the
 * browser read) still deliver playlists, so this is a dead ACCELERATOR inside a
 * live capability rather than a dead feature. Deleting it would remove a path
 * that now costs one short-circuit and would work again the moment Spotify's
 * transport endpoint opens. The negative cache is what makes keeping it honest.
 */
describe('SpotifyScraperService web player token — a refused token is negative-cached and reported', () => {
  const token = async (s: SpotifyScraperService) =>
    (s as unknown as { getWebPlayerToken(): Promise<string | null> }).getWebPlayerToken();

  /** A clock the test drives. Only installed per-test, so the rest of the file keeps real time. */
  const freezeClock = (start: number) => {
    const state = { now: start };
    vi.spyOn(Date, 'now').mockImplementation(() => state.now);
    return state;
  };

  it('warns ONCE, then does not re-attempt inside the backoff window', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(res({}, 403));
    const s = svc();

    await expect(token(s)).resolves.toBeNull();
    // Three endpoints x two header sets. Every one of them is a real round trip,
    // which is where the ~2 seconds went.
    const attempts = fetchMock.mock.calls.length;
    expect(attempts).toBe(6);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(token(s)).resolves.toBeNull();
    await expect(token(s)).resolves.toBeNull();

    // The whole point: the same 2 seconds, three times over, is now paid once.
    expect(fetchMock.mock.calls.length).toBe(attempts);
    // Still one warn — a backoff that re-warns is a log-flood in disguise.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-attempts on the first call after the window, and warns again', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const clock = freezeClock(1_700_000_000_000);
    fetchMock.mockResolvedValue(res({}, 403));
    const s = svc();

    await token(s);
    const attempts = fetchMock.mock.calls.length;

    // Comfortably inside the window: nothing moves.
    clock.now += 9 * 60_000;
    await token(s);
    expect(fetchMock.mock.calls.length).toBe(attempts);
    expect(warn).toHaveBeenCalledTimes(1);

    // The first call past it walks the endpoints again, and the capability
    // being unavailable is reported again rather than staying quiet.
    clock.now += 2 * 60_000;
    await token(s);
    expect(fetchMock.mock.calls.length).toBe(attempts * 2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a token that starts working clears the negative cache', async () => {
    // The other direction, and the one that matters if Spotify ever reopens the
    // transport endpoint: the backoff must not outlive the first success, or the
    // spclient rung stays dark for the rest of the process's life.
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const clock = freezeClock(1_700_000_000_000);
    fetchMock.mockResolvedValue(res({}, 403));
    const s = svc();
    await token(s);

    // A while later Spotify answers.
    clock.now += 11 * 60_000;
    fetchMock.mockResolvedValue(
      res({ accessToken: 'T1', accessTokenExpirationTimestampMs: clock.now + 3600_000 }),
    );
    await expect(token(s)).resolves.toBe('T1');
    expect(warn).toHaveBeenCalledTimes(1);

    // Backoff gone, so a later failure is reported immediately rather than
    // sitting silent until the old window would have expired.
    clock.now += 7200_000;
    fetchMock.mockResolvedValue(res({}, 403));
    await expect(token(s)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the warn names WHAT was refused, so a deploy log tells a 403 from a blip', async () => {
    // A warn that only says "no token" is the A1 violation in log form: nobody
    // reading the deploy log can tell a vendor refusal from a network drop.
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(res({}, 403));

    await token(svc());

    const payload = warn.mock.calls[0]?.[0] as { refusals?: string[]; backoffMs?: number };
    expect(payload.refusals).toHaveLength(6);
    expect(payload.refusals?.[0]).toBe('403 from open.spotify.com');
    expect(payload.backoffMs).toBe(600_000);
    expect(String(warn.mock.calls[0]?.[1])).toContain('web-player token unobtainable');
  });

  it('a throwing fetch is reported as a throw, not as a status code', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new Error('network down'));

    await token(svc());

    const payload = warn.mock.calls[0]?.[0] as { refusals?: string[] };
    expect(payload.refusals?.[0]).toBe('throw from open.spotify.com: network down');
  });

  it('a 200 carrying no token is reported as a 200, not as a refusal status', async () => {
    // The two failure modes are genuinely different to whoever reads the log:
    // one is the vendor withholding, the other is a schema change on their
    // side. Collapsing both into "no token" is what made this invisible.
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(res({ unrelated: true }));

    await token(svc());

    const payload = warn.mock.calls[0]?.[0] as { refusals?: string[] };
    expect(payload.refusals?.[0]).toBe('200 with no token from open.spotify.com');
  });

  it('a public entry point pays the walk once, not once per lookup', async () => {
    // The saving asserted on the PRIVATE method is worth nothing if the real
    // callers still walk every time. `getTrackPreview` ends in a token request,
    // and it is called once per now-playing card, per chapter and per voice
    // message, so this is where the 2 seconds actually went.
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(res({}, 403));
    const s = svc();

    await expect(s.getTrackPreview('Radiohead', 'Creep')).resolves.toBeNull();
    const first = fetchMock.mock.calls.length;
    // Two search pages, then the six-way token walk.
    expect(first).toBe(8);

    await expect(s.getTrackPreview('Radiohead', 'Creep')).resolves.toBeNull();

    // Only the two search pages. The token walk is inside the backoff.
    expect(fetchMock.mock.calls.length).toBe(first + 2);
  });
});


describe('SpotifyScraperService.fetchPlaylistPage rung order', () => {
  const stub = (s: SpotifyScraperService, over: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(over)) {
      (s as unknown as Record<string, unknown>)[name] = vi.fn(value as never);
    }
  };
  const page = (n: number) => ({
    name: 'P', owner: 'O', total: n,
    tracks: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, artist: 'A', durationMs: 1 })),
    hasMore: false, nextOffset: null,
  });

  it('uses the spclient result when it has tracks', async () => {
    const s = svc();
    stub(s, { fetchViaSpclient: async () => page(3) });
    const result = await s.fetchPlaylistPage('abc');
    expect(result?.tracks).toHaveLength(3);
  });

  it('falls through to HTML when spclient returns an EMPTY page', async () => {
    // An empty result is not a success. Accepting it would render a blank
    // queue where a second rung could have supplied the tracks.
    const s = svc();
    stub(s, { fetchViaSpclient: async () => page(0), fetchViaHtml: async () => page(2) });
    const result = await s.fetchPlaylistPage('abc');
    expect(result?.tracks).toHaveLength(2);
  });

  it('falls through to the browser when both API and HTML are empty', async () => {
    const s = svc();
    stub(s, {
      fetchViaSpclient: async () => null,
      fetchViaHtml: async () => null,
      fetchViaPuppeteer: async () => page(5),
    });
    const result = await s.fetchPlaylistPage('abc');
    expect(result?.tracks).toHaveLength(5);
  });

  it('returns null when every rung fails', async () => {
    const s = svc();
    stub(s, {
      fetchViaSpclient: async () => null,
      fetchViaHtml: async () => null,
      fetchViaPuppeteer: async () => null,
    });
    await expect(s.fetchPlaylistPage('abc')).resolves.toBeNull();
  });

  it('skips the HTML rung for a later page, since it always returns page 1', async () => {
    // Calling HTML on offset>0 would silently return the FIRST page again
    // and the caller would loop forever over page one.
    const s = svc();
    const html = vi.fn(async () => page(2));
    stub(s, { fetchViaSpclient: async () => null, fetchViaHtml: html, fetchViaPuppeteer: async () => null });
    await s.fetchPlaylistPage('abc', 100, 100);
    expect(html).not.toHaveBeenCalled();
  });

  it('strips a query string from the playlist id', async () => {
    const s = svc();
    const sp = vi.fn(async (_id: string, _offset?: number, _limit?: number) => page(1));
    stub(s, { fetchViaSpclient: sp });
    await s.fetchPlaylistPage('abc123?si=tracking');
    expect(sp.mock.calls[0]?.[0]).toBe('abc123');
  });
});

describe('SpotifyScraperService.getTrackPreview', () => {
  it('extracts a preview from the embed page when given a track id', async () => {
    const html = `...${'x'.repeat(400)}https://p.scdn.co/mp3-preview/0123456789abcdef... "duration": 284000`;
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

    const result = await svc().getTrackPreview('Artist', 'spotify:track:abc123');

    expect(result?.previewUrl).toContain('p.scdn.co/mp3-preview/0123456789abcdef');
    expect(result?.durationMs).toBe(284000);
  });

  it('returns null when the embed page has no preview URL', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>nothing here</html>', json: async () => ({}) });
    await expect(svc().getTrackPreview('Artist', 'spotify:track:abc123')).resolves.toBeNull();
  });

  it('returns null rather than throwing when every request fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(svc().getTrackPreview('A', 'B')).resolves.toBeNull();
  });

  it('extracts a matching track from search NEXT_DATA', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, text: async () => nextDataHtml({ props: { pageProps: { state: { data: { entity: { tracks: { items: [trackNode('Airbag', 'Radiohead')] } } } } } } }),
      json: async () => ({}),
    });
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '', json: async () => ({}) });

    const result = await svc().getTrackPreview('Radiohead', 'Airbag');

    expect(result?.previewUrl).toBe('https://p.scdn.co/mp3-preview/abc');
    expect(result?.trackName).toBe('Airbag');
  });

  it('REFUSES a NEXT_DATA candidate from a different artist', async () => {
    // The search returns the nearest match, not the exact one. Accepting it
    // would play the wrong song with no indication anything went wrong.
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => nextDataHtml({ state: { data: { entity: { tracks: { items: [trackNode('Creep', 'Nine Inch Nails')] } } } } }),
      json: async () => ({}),
    });
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '', json: async () => ({}) });

    const result = await svc().getTrackPreview('Radiohead', 'Creep');

    expect(result).toBeNull();
  });
});
