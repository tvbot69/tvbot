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
});
