import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { AppleMusicService } from '@bot/services/media/appleMusicService';
import { AppleMusicSearchApi, ITunesUnavailableError } from '@applemusic/api/appleMusicSearchApi';

/**
 * AppleMusicService, after the three hand-rolled iTunes clients were deleted.
 *
 * THE DEFECT THIS FILE PINS
 * -------------------------
 * This service used to contain three near-identical `fetch` calls against
 * `https://itunes.apple.com/search` - one per public method - and every one of
 * them ended the same way:
 *
 *     if (!response.ok) return null;
 *     } catch (err) { Logger.warn(...); return null; }
 *
 * A 503 from iTunes.apple.com therefore produced `null`, and the command layer
 * read `null` as "Apple has no release by that name". The user was told a
 * catalogue fact that nobody had checked. That is the failure this repo calls a
 * confident wrong answer, and on a metadata provider it is the worst kind: it
 * looks exactly like a correct answer.
 *
 * There was already a second iTunes Search client in the repo -
 * `AppleMusicSearchApi`, on the `artworkService` and `previewResolverService`
 * path - and it RAISED on a non-OK status. So the bot had one client that knew
 * the difference between "could not ask" and "asked, nothing there", and three
 * that did not, all hitting the same anonymous endpoint.
 *
 * THE CONTRACT NOW
 * ---------------
 * `null` means GENUINE NO MATCH, and only that. A 4xx, a 5xx, a DNS failure and
 * a timeout all raise `ITunesUnavailableError` carrying the status. Both
 * directions are asserted below for all three methods, because a fix and its bug
 * are opposites here and a test that only asserted the fix would also have
 * passed on the version that returns `null` on everything.
 *
 * ORDER MATTERS, AND THE TESTS ENFORCE IT
 * ---------------------------------------
 * Status is judged BEFORE the body is read. Inverted, an HTML error page becomes
 * a JSON parse error, a 503 surfaces as "unparseable response", and the status
 * code - the only evidence of what went wrong - is destroyed. `errorResponse()`
 * below hands back a `json()` that THROWS and counts its own calls, so an
 * inverted order fails loudly instead of passing on a coincidence. A bare
 * "resolves to null" assertion would pass either way, because the service used
 * to catch everything.
 */

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/**
 * A non-2xx whose body explodes if anything reads it, plus a call counter.
 * The counter is what makes the ordering assertion non-vacuous.
 */
const errorResponse = (status: number) => {
  const state = { jsonCalls: 0 };
  return {
    state,
    response: {
      ok: false,
      status,
      json: async () => {
        state.jsonCalls++;
        throw new Error(`body must not be read for HTTP ${status}`);
      },
    },
  };
};

/**
 * Typed as the spy over the GLOBAL `fetch`, because the global `fetch` is what
 * `fetchWithTimeout` calls (`@domain/fetchWithTimeout.ts:16`), which is now the
 * only HTTP path in this service. `MockInstance<typeof fetch>` is exactly the
 * type the spy is returned as, so `mock.calls[0][0]` is the real input.
 */
let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const urlOf = (call: number): URL => new URL(String(fetchMock.mock.calls[call]?.[0]));

const entity = (call: number): string | null => urlOf(call).searchParams.get('entity');

describe('AppleMusicService: one iTunes Search client, three entities', () => {
  it('asks the search endpoint for exactly one song', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ trackName: 'Esme' }] }) as never);

    await new AppleMusicService().searchSong('Mond Esme');

    expect(urlOf(0).origin + urlOf(0).pathname).toBe('https://itunes.apple.com/search');
    expect(urlOf(0).searchParams.get('term')).toBe('Mond Esme');
    expect(entity(0)).toBe('song');
    expect(urlOf(0).searchParams.get('limit')).toBe('1');
  });

  it('asks the same endpoint for an album', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await new AppleMusicService().searchAlbum('Mond I');
    expect(entity(0)).toBe('album');
  });

  it('asks the same endpoint for a musicArtist', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await new AppleMusicService().searchArtist('Mond');
    expect(entity(0)).toBe('musicArtist');
  });

  it('makes exactly one request per lookup, where the old code also made one', async () => {
    // A guard on the consolidation itself: the service must not fan out into
    // a second provider call to "helpfully" enrich a row.
    fetchMock.mockResolvedValue(okResponse({ results: [{ trackName: 'Esme' }] }) as never);
    await new AppleMusicService().searchSong('Mond Esme');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries a timeout, because the old inline AbortSignal.timeout is gone', async () => {
    // The 5000ms deadline moved with the deleted code; `fetchWithTimeout` owns
    // the signal now. A client with no deadline can hang a command past
    // Discord's interaction window when an upstream stalls without closing.
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);

    await new AppleMusicService().searchSong('Mond Esme');

    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a User-Agent, which the surviving client was already sending', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await new AppleMusicService().searchSong('Mond Esme');
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(init?.headers?.['User-Agent']).toBe('tvbot');
  });
});

describe('AppleMusicService.searchSong: mapping a real row', () => {
  it('returns the top song with a 600px artwork, not the 100px thumbnail', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [{
          trackName: 'Esme',
          artistName: 'Mond',
          collectionName: 'I',
          trackViewUrl: 'https://music.example/esme',
          artworkUrl100: 'https://is1/100x100bb.jpg',
        }],
      }) as never,
    );

    const song = await new AppleMusicService().searchSong('Mond Esme');

    expect(song).toEqual({
      trackName: 'Esme',
      artistName: 'Mond',
      albumName: 'I',
      url: 'https://music.example/esme',
      artworkUrl: 'https://is1/600x600bb.jpg',
    });
  });

  it('fills absent fields rather than emitting undefined-shaped rows', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    const song = await new AppleMusicService().searchSong('Mond Esme');
    expect(song).toEqual({ trackName: '', artistName: '', albumName: '', url: '', artworkUrl: undefined });
  });

  it('leaves artwork undefined when the row carries no thumbnail', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ trackName: 'Esme' }] }) as never);
    const song = await new AppleMusicService().searchSong('Mond Esme');
    expect(song?.artworkUrl).toBeUndefined();
  });
});

describe('AppleMusicService: a failed read must not become a miss', () => {
  it('RAISES on a 503 rather than returning null - the defect this file exists for', async () => {
    const { state, response } = errorResponse(503);
    fetchMock.mockResolvedValue(response as never);

    // THE load-bearing assertion. Under the old code this resolved to `null` and
    // the command layer answered "No Apple Music release found for X".
    await expect(new AppleMusicService().searchSong('Mond Esme')).rejects.toThrow('iTunes HTTP 503');

    // And it must have judged the status BEFORE touching the body.
    expect(state.jsonCalls).toBe(0);
  });

  it('carries the status on a named error, so a caller can branch on it', async () => {
    const { response } = errorResponse(503);
    fetchMock.mockResolvedValue(response as never);

    const err = await new AppleMusicService().searchSong('Mond Esme').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ITunesUnavailableError);
    expect((err as ITunesUnavailableError).status).toBe(503);
  });

  it('raises for an album search too, not only songs', async () => {
    const { state, response } = errorResponse(500);
    fetchMock.mockResolvedValue(response as never);

    await expect(new AppleMusicService().searchAlbum('Mond I')).rejects.toThrow('iTunes HTTP 500');
    expect(state.jsonCalls).toBe(0);
  });

  it('raises for an artist search too, not only songs', async () => {
    const { state, response } = errorResponse(404);
    fetchMock.mockResolvedValue(response as never);

    await expect(new AppleMusicService().searchArtist('Mond')).rejects.toThrow('iTunes HTTP 404');
    expect(state.jsonCalls).toBe(0);
  });

  it('names the status for every non-2xx the endpoint can return', async () => {
    // A table, because "it raises for 503" would still pass on a version that
    // special-cased 503 and swallowed the rest.
    for (const status of [400, 403, 404, 429, 500, 502, 503, 504]) {
      const { response } = errorResponse(status);
      fetchMock.mockResolvedValue(response as never);
      await expect(new AppleMusicService().searchSong('x')).rejects.toThrow(`iTunes HTTP ${status}`);
    }
  });

  it('raises when the network is down, rather than reporting a catalogue miss', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new AppleMusicService().searchSong('Mond Esme')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('raises when the request times out', async () => {
    fetchMock.mockRejectedValue(new Error('Fetch timed out after 8000ms for https://itunes.apple.com/search'));
    await expect(new AppleMusicService().searchSong('Mond Esme')).rejects.toThrow(/timed out/);
  });

  it('raises for album and artist on a network failure as well', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(new AppleMusicService().searchAlbum('Mond I')).rejects.toThrow(/ENOTFOUND/);
    await expect(new AppleMusicService().searchArtist('Mond')).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('AppleMusicService: a genuine empty is NOT a failure', () => {
  it('returns null when a 200 search genuinely found no song', async () => {
    // The other direction of the same pairing. A 200 that really answered
    // "nothing" is `null`, and it has to stay distinguishable from the raise
    // above. Both directions or neither: a test asserting only the raise would
    // have passed on `return null` for everything.
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await expect(new AppleMusicService().searchSong('Nobody At All')).resolves.toBeNull();
  });

  it('returns null when a 200 body has no results array at all', async () => {
    // iTunes sometimes answers 200 with `{"resultCount":0}` and no array.
    fetchMock.mockResolvedValue(okResponse({ resultCount: 0 }) as never);
    await expect(new AppleMusicService().searchSong('Nobody At All')).resolves.toBeNull();
  });

  it('returns null for a genuine empty album search', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await expect(new AppleMusicService().searchAlbum('Nobody')).resolves.toBeNull();
  });

  it('returns null for a genuine empty artist search', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await expect(new AppleMusicService().searchArtist('Nobody')).resolves.toBeNull();
  });

  it('returns null when the row omits the link, which is a miss and not a fault', async () => {
    // A 200 whose result carries no URL is a real answer about the catalogue:
    // Apple matched something but there is nothing to send the user to.
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await expect(new AppleMusicService().searchAlbum('Mond')).resolves.toBeNull();
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await expect(new AppleMusicService().searchArtist('Mond')).resolves.toBeNull();
  });
});

describe('AppleMusicService.searchAlbum and searchArtist: mapping a real row', () => {
  it('returns the collection URL when there is a result', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ collectionViewUrl: 'https://music.example/i' }] }) as never);
    await expect(new AppleMusicService().searchAlbum('Mond I')).resolves.toBe('https://music.example/i');
  });

  it('returns the artist link URL when there is a result', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ artistLinkUrl: 'https://music.example/mond' }] }) as never);
    await expect(new AppleMusicService().searchArtist('Mond')).resolves.toBe('https://music.example/mond');
  });

  it('reads only the FIRST row, because the old client asked for limit=1', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ results: [{ collectionViewUrl: 'https://music.example/first' }, { collectionViewUrl: 'https://music.example/second' }] }) as never,
    );
    await expect(new AppleMusicService().searchAlbum('Mond I')).resolves.toBe('https://music.example/first');
  });
});

describe('AppleMusicService: the dependency is injectable rather than hard-wired', () => {
  it('uses the AppleMusicSearchApi it is given', async () => {
    // The default-argument constructor exists so `new AppleMusicService()` stays
    // valid for `startup.ts`, and so a test can hand in a double. Asserting it
    // means the consolidation cannot be undone by a future `new
    // AppleMusicSearchApi()` dropped back inside a method body.
    const searchApi = {
      searchSongs: vi.fn(async () => [{ trackName: 'Esme', trackViewUrl: 'https://music.example/esme' }]),
      searchAlbums: vi.fn(async () => []),
      searchArtists: vi.fn(async () => []),
    } as unknown as AppleMusicSearchApi;

    const song = await new AppleMusicService(searchApi).searchSong('Mond Esme');

    expect(searchApi.searchSongs).toHaveBeenCalledWith('Mond Esme', undefined, 1);
    expect(song?.url).toBe('https://music.example/esme');
  });

  it('lets a raise from the injected client through untouched', async () => {
    const searchApi = {
      searchSongs: vi.fn(async () => { throw new ITunesUnavailableError(503); }),
      searchAlbums: vi.fn(async () => []),
      searchArtists: vi.fn(async () => []),
    } as unknown as AppleMusicSearchApi;

    await expect(new AppleMusicService(searchApi).searchSong('Mond Esme')).rejects.toThrow('iTunes HTTP 503');
  });
});
