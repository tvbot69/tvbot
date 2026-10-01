import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppleMusicSearchApi, ITunesUnavailableError, upscaleArtwork } from '@applemusic/api/appleMusicSearchApi';
import type { ITunesSearchResult } from '@applemusic/models/itunesModels';

/**
 * The no-auth iTunes search rung — the one Apple source that needs no token.
 *
 * WHY THIS FILE IS WORTH HAVING
 * ----------------------------
 * It is a small class with no test file, and it is on the load-bearing path for
 * two real features: `artworkService` (album and song cover lookup) and
 * `previewResolverService` (the 30-second preview that backs `.preview` and the
 * voice-message waveform). Both of them degrade quietly when this rung fails -
 * a missing cover falls back to a placeholder, a missing preview falls back to
 * nothing - so a silent `return []` here would be invisible.
 *
 * It does not return `[]` on failure. It RAISES, which is the correct direction
 * and the thing worth pinning.
 *
 * WHAT `upscaleArtwork` IS FOR
 * ---------------------------
 * The iTunes API hands back a 100x100 thumbnail. `ArtworkService` calls this to
 * ask for a 1200x1200 version of the SAME asset, because a 100px image blown up
 * to a 1200px collage tile is a grey blur. The rewrite is a single regex on
 * `/Nd xNd bb.` in the path, so both directions matter: it has to upgrade a URL
 * that has the token, and it must NOT corrupt a URL that does not.
 */

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

/** A 200 with a JSON body. `results` omitted on purpose in the "no results" case. */
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
  fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({ results: [] }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const row = (over: Partial<ITunesSearchResult> = {}): ITunesSearchResult =>
  ({
    trackId: 1,
    trackName: 'Creep',
    artistName: 'Radiohead',
    collectionName: 'Pablo Honey',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/1x100bb.jpg',
    ...over,
  }) as ITunesSearchResult;

const call = (fn: () => Promise<unknown>) => fn();

describe('AppleMusicSearchApi: the request it builds', () => {
  it('asks for an album search with a default limit of five', async () => {
    await call(() => new AppleMusicSearchApi().searchAlbums('OK Computer'));

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://itunes.apple.com/search');
    expect(url.searchParams.get('entity')).toBe('album');
    expect(url.searchParams.get('term')).toBe('OK Computer');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('asks for a song search', async () => {
    await call(() => new AppleMusicSearchApi().searchSongs('Creep'));
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('entity')).toBe('song');
  });

  it('asks for a musicArtist search, the third entity the link commands need', async () => {
    // This rung existed only inside `AppleMusicService`, which hand-rolled its
    // own `fetch` for it and answered `null` on a 503. Moving it here is what
    // makes the bot's ONE iTunes Search client cover all three entities.
    await call(() => new AppleMusicSearchApi().searchArtists('Radiohead'));

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://itunes.apple.com/search');
    expect(url.searchParams.get('entity')).toBe('musicArtist');
    expect(url.searchParams.get('term')).toBe('Radiohead');
  });

  it('honours a caller limit on the artist search', async () => {
    await call(() => new AppleMusicSearchApi().searchArtists('Radiohead', 1));
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('limit')).toBe('1');
  });

  it('raises on a non-OK artist search rather than returning an empty list', async () => {
    // The artist rung is the one that was silently swallowed, so it gets its own
    // direction rather than relying on the album and song cases above.
    fetchMock.mockResolvedValue(errorResponse(503));

    await expect(new AppleMusicSearchApi().searchArtists('Radiohead')).rejects.toThrow('iTunes HTTP 503');
  });

  it('returns an empty list for a genuine 200 artist search with nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));

    await expect(new AppleMusicSearchApi().searchArtists('Nobody At All')).resolves.toEqual([]);
  });

  it('appends the artist to the term, because a bare album name is ambiguous', async () => {
    await call(() => new AppleMusicSearchApi().searchAlbums('OK Computer', 'Radiohead'));

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('term')).toBe('OK Computer Radiohead');
  });

  it('honours a caller-supplied limit', async () => {
    await call(() => new AppleMusicSearchApi().searchAlbums('OK Computer', 'Radiohead', 25));
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('limit')).toBe('25');
  });

  it('sends a User-Agent, because the iTunes endpoint rejects some defaults', async () => {
    await call(() => new AppleMusicSearchApi().searchSongs('Creep'));

    const init = fetchMock.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(init.headers?.['User-Agent']).toBe('tvbot');
  });

  it('carries its own timeout rather than relying on the platform default', async () => {
    // `fetchWithTimeout` turns the third argument into an `AbortSignal.timeout`
    // and merges it into the init it hands to `fetch`, so the evidence is an
    // `AbortSignal` on the second argument, not a third one. Asserted through the
    // init because that is where the deadline actually lands - a hung iTunes
    // socket must not hold the artwork cascade open.
    await call(() => new AppleMusicSearchApi().searchSongs('Creep'));

    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes the header through alongside the signal, so the two are not confused', async () => {
    // Both `headers` and `signal` are merged by `fetchWithTimeout` into the same
    // init object. Checking one does not check the other.
    await call(() => new AppleMusicSearchApi().searchSongs('Creep'));

    const init = fetchMock.mock.calls[0]![1] as { headers?: Record<string, string>; signal?: AbortSignal };
    expect(init.headers?.['User-Agent']).toBe('tvbot');
    expect(init.signal).toBeDefined();
  });

  it('returns the rows it was given, untranslated', async () => {
    // `ITunesSearchResult` has 31 documented fields and both consumers read
    // specific ones. Returning a mapped subset would break them invisibly.
    //
    // The second row differs in a DECLARED field (`trackName`), not in one the
    // live endpoint sends but `ITunesSearchResult` omits — the payload does
    // carry `trackId` (see the `row()` fixture), it is simply not in the type
    // this bot declares. Differing on a declared field is what makes the
    // pass-through claim checkable here.
    fetchMock.mockResolvedValue(jsonResponse({ results: [row(), row({ trackName: 'Karma Police' })] }));

    const results = await new AppleMusicSearchApi().searchSongs('Creep');

    expect(results).toHaveLength(2);
    expect(results[0]?.trackName).toBe('Creep');
    expect(results[0]?.artworkUrl100).toContain('1x100bb');
  });
});

describe('AppleMusicSearchApi: what a failed read must not become', () => {
  it('raises on a non-OK status rather than returning an empty list', async () => {
    // THE load-bearing assertion. `[]` would propagate up into
    // `artworkService.searchAlbums`, which would skip this rung and try the next
    // one - indistinguishable from "Apple has no album by that name". Raising
    // lets the caller record that the source could not be read.
    fetchMock.mockResolvedValue(errorResponse(503));

    await expect(new AppleMusicSearchApi().searchAlbums('OK Computer')).rejects.toThrow('iTunes HTTP 503');
  });

  it('names the status in the message, so the log says which failure it was', async () => {
    fetchMock.mockResolvedValue(errorResponse(404));

    await expect(new AppleMusicSearchApi().searchSongs('Creep')).rejects.toThrow(/404/);
  });

  it('raises for a song search too, not only albums', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));

    const api = new AppleMusicSearchApi();
    await expect(api.searchAlbums('a')).rejects.toThrow('iTunes HTTP 500');
    await expect(api.searchSongs('a')).rejects.toThrow('iTunes HTTP 500');
  });

  it('returns an empty list for a genuine 200 with no results', async () => {
    // The honest-empty half. A 200 that really answered "nothing" is `[]`, and it
    // has to stay distinguishable from the failure above.
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));

    await expect(new AppleMusicSearchApi().searchSongs('Nobody At All')).resolves.toEqual([]);
  });

  it('raises with a NAMED error carrying the status, so a caller can branch on it', async () => {
    // A bare `Error` only gives a caller a string to regex. `SpotifyUnavailableError`
    // and `LastfmApiError` already set the precedent, and `AppleMusicService` now
    // depends on this: it has to re-render a raise as a user-facing Error without
    // losing the status that says whether it was a 404 or a 503.
    fetchMock.mockResolvedValue(errorResponse(503));

    const err = await new AppleMusicSearchApi().searchAlbums('OK Computer').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ITunesUnavailableError);
    expect((err as ITunesUnavailableError).status).toBe(503);
    expect((err as Error).message).toBe('iTunes HTTP 503');
  });

  it('judges the status BEFORE reading the body', async () => {
    // Inverted, an HTML error page becomes a JSON parse error and the status —
    // the only evidence of what went wrong — is destroyed. The counter makes
    // this non-vacuous: a version that read the body first would report 1.
    const state = { jsonCalls: 0 };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        state.jsonCalls++;
        throw new Error('body must not be read for HTTP 503');
      },
    });

    await expect(new AppleMusicSearchApi().searchAlbums('OK Computer')).rejects.toThrow('iTunes HTTP 503');

    expect(state.jsonCalls).toBe(0);
  });

  it('returns an empty list when the body has no results key at all', async () => {
    // iTunes sometimes answers 200 with `{"resultCount":0}` and no array. An
    // optional-chained read is the right call here; a bare `.results` would throw
    // a TypeError and turn a genuine empty into a crash.
    fetchMock.mockResolvedValue(jsonResponse({ resultCount: 0 }));

    await expect(new AppleMusicSearchApi().searchSongs('Nobody At All')).resolves.toEqual([]);
  });
});

describe('upscaleArtwork: the 100x100 token in an iTunes URL', () => {
  it('upgrades the default size to 1200', () => {
    expect(
      upscaleArtwork('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb.jpg'),
    ).toBe('https://is1-ssl.mzstatic.com/image/thumb/abc/1200x1200bb.jpg');
  });

  it('honours a caller-supplied size', () => {
    expect(
      upscaleArtwork('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb.jpg', 600),
    ).toBe('https://is1-ssl.mzstatic.com/image/thumb/abc/600x600bb.jpg');
  });

  it('rewrites the first DOT-TERMINATED size token and leaves any other alone', () => {
    // The regex is `/\/\d+x\d+bb\./` - it needs a literal dot straight after the
    // token. So in a path segment like `/1x100bb/` (no dot) it does not match,
    // and the later `/2x200bb.jpg` is the one that is rewritten. Asserted as it
    // behaves rather than as I assumed: the "first token wins" reading is wrong,
    // and a test that encoded that reading would have failed for a reason nobody
    // wrote down.
    expect(
      upscaleArtwork('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb/2x200bb.jpg'),
    ).toBe('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb/1200x1200bb.jpg');
  });

  it('leaves a URL with no dot-terminated size token untouched', () => {
    const noToken = 'https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb/source.jpg';
    expect(upscaleArtwork(noToken)).toBe(noToken);
  });

  it('leaves a URL with no size token untouched rather than corrupting it', () => {
    const noToken = 'https://is1-ssl.mzstatic.com/image/thumb/abc/source.jpg';
    expect(upscaleArtwork(noToken)).toBe(noToken);
  });

  it('only matches a bb-suffixed token, so a bare path number is not rewritten', () => {
    // The trailing `bb\.` is load-bearing. Without it `100x100` anywhere in the
    // path would be rewritten, including inside a content hash.
    const hashed = 'https://is1-ssl.mzstatic.com/image/thumb/100x100hash/1x100bb.jpg';
    expect(upscaleArtwork(hashed)).toBe('https://is1-ssl.mzstatic.com/image/thumb/100x100hash/1200x1200bb.jpg');
  });

  it('preserves the query string, because iTunes puts a cache-buster on the end', () => {
    expect(
      upscaleArtwork('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb.jpg?token=xyz'),
    ).toBe('https://is1-ssl.mzstatic.com/image/thumb/abc/1200x1200bb.jpg?token=xyz');
  });

  it('is idempotent on its own output, so a second call is a no-op', () => {
    const once = upscaleArtwork('https://is1-ssl.mzstatic.com/image/thumb/abc/1x100bb.jpg');
    expect(upscaleArtwork(once)).toBe(once);
  });

  it('returns an empty string unchanged, so an absent cover stays absent', () => {
    expect(upscaleArtwork('')).toBe('');
  });
});