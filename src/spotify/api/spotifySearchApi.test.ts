import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifySearchApi, SpotifyUnavailableError } from './spotifySearchApi';
import { SpotifyTokenManager } from './spotifyTokenManager';

describe('SpotifySearchApi', () => {
  let tokenManager: SpotifyTokenManager;
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    tokenManager = {
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager;
    api = new SpotifySearchApi(tokenManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('enters cooldown and reads Retry-After on HTTP 429', async () => {
    const mockResponse = {
      status: 429,
      ok: false,
      headers: new Headers({ 'Retry-After': '15' }),
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    await expect(api.searchArtists('Travis Scott')).rejects.toThrow(SpotifyUnavailableError);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);

    // Subsequent calls immediately fail without network call
    vi.spyOn(globalThis, 'fetch').mockClear();
    await expect(api.searchArtists('Travis Scott')).rejects.toThrow(/cooldown active/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('invalidates token and retries once on HTTP 401', async () => {
    const mock401 = {
      status: 401,
      ok: false,
      headers: new Headers(),
    } as unknown as Response;

    const mock200 = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        artists: {
          items: [{ name: 'Travis Scott', images: [{ url: 'https://spotify.com/travis.jpg', height: 640 }] }],
        },
      }),
    } as unknown as Response;

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mock401)
      .mockResolvedValueOnce(mock200);

    const artists = await api.searchArtists('Travis Scott');

    expect(tokenManager.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(artists).toHaveLength(1);
    expect(artists[0]?.name).toBe('Travis Scott');
  });

  it('anchors the exact artist id via a track sample (same-name disambiguation)', async () => {
    const mock200 = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        tracks: {
          items: [
            {
              name: 'Esme',
              artists: [
                { name: 'Mond', id: 'egypt-mond-id' },
                { name: 'EVO', id: 'evo-id' },
              ],
            },
          ],
        },
      }),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mock200);

    const id = await api.getArtistIdViaTrackSample('mond', 'Esme');
    expect(id).toBe('egypt-mond-id');
  });

  it('returns null from track anchoring when no artist matches exactly', async () => {
    const mock200 = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        tracks: {
          items: [{ name: 'Esme', artists: [{ name: 'Someone Else', id: 'other-id' }] }],
        },
      }),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mock200);

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).resolves.toBeNull();
  });

  it('fetches the canonical artist entity by id', async () => {
    const mock200 = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        id: 'egypt-mond-id',
        name: 'Mond',
        genres: ['hip-hop'],
        images: [{ url: 'https://i.scdn.co/image/egypt-mond', height: 640 }],
      }),
    } as unknown as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mock200);

    const artist = await api.getArtistById('egypt-mond-id');
    expect(artist?.name).toBe('Mond');
    expect(artist?.genres).toEqual(['hip-hop']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/artists/egypt-mond-id',
      expect.anything(),
    );
  });

  it('rotates credential and retries immediately when backup credential is available', async () => {
    const mock429 = {
      status: 429,
      ok: false,
      headers: new Headers({ 'Retry-After': '30' }),
    } as unknown as Response;

    const mock200 = {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        artists: {
          items: [{ name: 'Drake', images: [{ url: 'https://spotify.com/drake.jpg', height: 640 }] }],
        },
      }),
    } as unknown as Response;

    (tokenManager.rotateCredential as any).mockReturnValueOnce(true);

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mock429)
      .mockResolvedValueOnce(mock200);

    const artists = await api.searchArtists('Drake');

    expect(tokenManager.rotateCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(artists[0]?.name).toBe('Drake');
    expect(SpotifySearchApi.isRateLimited()).toBe(false);
  });
});

describe('SpotifySearchApi.getTrack', () => {
  let tokenManager: SpotifyTokenManager;
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    tokenManager = {
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager;
    api = new SpotifySearchApi(tokenManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('returns the parsed track on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({
        id: '4mF0aVVHtmHQSIdem2Wh0g',
        name: 'GONE 4 A MIN',
        album: { images: [{ url: 'https://img.test/t.jpg', height: 640 }] },
      }),
    } as unknown as Response);
    const track = await api.getTrack('4mF0aVVHtmHQSIdem2Wh0g');
    expect(track?.album?.images?.[0]?.url).toBe('https://img.test/t.jpg');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/tracks/4mF0aVVHtmHQSIdem2Wh0g',
      expect.anything(),
    );
  });

  it('cools down and throws on 429 without a backup credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 429,
      ok: false,
      headers: new Headers({ 'Retry-After': '5' }),
    } as unknown as Response);
    await expect(api.getTrack('abc')).rejects.toThrow(SpotifyUnavailableError);
    expect(SpotifySearchApi.isRateLimited()).toBe(true);
  });

  it('throws (never null) on network failure and HTTP 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'));
    await expect(api.getTrack('abc')).rejects.toThrow(/network error/i);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 500,
      ok: false,
      headers: new Headers(),
    } as unknown as Response);
    await expect(api.getTrack('abc')).rejects.toThrow(/HTTP 500/);
  });
});
