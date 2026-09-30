import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { AppleMusicService } from './appleMusicService';

/**
 * The iTunes search endpoint, and one property the bot has been bitten by.
 *
 * A search API call is judged on its HTTP status BEFORE its body is read. The
 * order matters: reading the body first turns an HTML error page into a JSON
 * parse error, so a 503 surfaces as "unparseable response" and an outage
 * becomes indistinguishable from a malformed reply. The tests below therefore
 * hand back a `json()` that THROWS on every non-2xx status - if the order is
 * ever inverted, they fail loudly rather than passing on a coincidence.
 *
 * The other direction is asserted too: a 200 with a body that genuinely has no
 * results must return null, not an error. "No such song" and "the service is
 * down" are different answers to the user and must not look alike.
 */

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/**
 * A non-2xx response whose body explodes if anything tries to read it, AND a
 * counter for whether it was read at all. The counter is what makes the
 * assertion non-vacuous: the service catches everything, so "resolves to null"
 * on its own would pass even with the order inverted.
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
 * the service calls (`appleMusicService.ts:21`). The previous declaration,
 * `ReturnType<typeof vi.spyOn>`, resolves that generic to its LAST overload and
 * therefore claims a `MockInstance<(this: unknown, ...args: unknown[]) =>
 * unknown>` — a shape no real `vi.spyOn(globalThis, 'fetch')` produces, so the
 * declaration was the lie rather than the double. `MockInstance<typeof fetch>`
 * is exactly the type the spy is returned as, so `mock.calls[0][0]` is the
 * `input` the call site really passed and the casts on it are real assertions.
 */
let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppleMusicService.searchSong', () => {
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

  it('asks the iTunes search endpoint for exactly one song', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ trackName: 'Esme' }] }) as never);

    await new AppleMusicService().searchSong('Mond Esme');

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe('https://itunes.apple.com/search');
    expect(url.searchParams.get('term')).toBe('Mond Esme');
    expect(url.searchParams.get('entity')).toBe('song');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('returns null on an error status without ever reading the body', async () => {
    const { state, response } = errorResponse(503);
    fetchMock.mockResolvedValue(response as never);

    await expect(new AppleMusicService().searchSong('Mond Esme')).resolves.toBeNull();
    expect(state.jsonCalls).toBe(0);
  });

  it('returns null when the search genuinely found nothing', async () => {
    // The other direction of the same pairing: a 200 with an empty result set is
    // a real answer, and must not read like an outage.
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);

    await expect(new AppleMusicService().searchSong('Nobody At All')).resolves.toBeNull();
  });

  it('returns null when the response has no results array at all', async () => {
    fetchMock.mockResolvedValue(okResponse({}) as never);
    await expect(new AppleMusicService().searchSong('Mond Esme')).resolves.toBeNull();
  });

  it('fills absent fields rather than emitting undefined-shaped rows', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);

    const song = await new AppleMusicService().searchSong('Mond Esme');

    expect(song).toEqual({ trackName: '', artistName: '', albumName: '', url: '', artworkUrl: undefined });
  });

  it('returns null rather than throwing when the network is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new AppleMusicService().searchSong('Mond Esme')).resolves.toBeNull();
  });

  it('returns null when the request times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));
    await expect(new AppleMusicService().searchSong('Mond Esme')).resolves.toBeNull();
  });

  it('bounds the request so one slow endpoint cannot hang a command', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);

    await new AppleMusicService().searchSong('Mond Esme');

    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('AppleMusicService.searchAlbum', () => {
  it('returns the collection URL when there is a result', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ collectionViewUrl: 'https://music.example/i' }] }) as never);

    await expect(new AppleMusicService().searchAlbum('Mond I')).resolves.toBe('https://music.example/i');
  });

  it('asks for the album entity', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await new AppleMusicService().searchAlbum('Mond I');
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('entity')).toBe('album');
  });

  it('returns null on an error status without reading the body', async () => {
    const { state, response } = errorResponse(500);
    fetchMock.mockResolvedValue(response as never);

    await expect(new AppleMusicService().searchAlbum('Mond I')).resolves.toBeNull();
    expect(state.jsonCalls).toBe(0);
  });

  it('returns null for a genuine empty result set', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await expect(new AppleMusicService().searchAlbum('Nobody')).resolves.toBeNull();
  });

  it('returns null when the network is down', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(new AppleMusicService().searchAlbum('Mond I')).resolves.toBeNull();
  });
});

describe('AppleMusicService.searchArtist', () => {
  it('returns the artist link URL when there is a result', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{ artistLinkUrl: 'https://music.example/mond' }] }) as never);

    await expect(new AppleMusicService().searchArtist('Mond')).resolves.toBe('https://music.example/mond');
  });

  it('asks for the musicArtist entity', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await new AppleMusicService().searchArtist('Mond');
    const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('entity')).toBe('musicArtist');
  });

  it('returns null on an error status without reading the body', async () => {
    const { state, response } = errorResponse(404);
    fetchMock.mockResolvedValue(response as never);

    await expect(new AppleMusicService().searchArtist('Nobody')).resolves.toBeNull();
    expect(state.jsonCalls).toBe(0);
  });

  it('returns null for a genuine empty result set', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }) as never);
    await expect(new AppleMusicService().searchArtist('Nobody')).resolves.toBeNull();
  });

  it('returns null when the response omits the link', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [{}] }) as never);
    await expect(new AppleMusicService().searchArtist('Mond')).resolves.toBeNull();
  });

  it('returns null when the network is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(new AppleMusicService().searchArtist('Mond')).resolves.toBeNull();
  });
});