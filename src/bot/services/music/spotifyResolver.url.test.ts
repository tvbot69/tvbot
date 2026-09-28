import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SpotifyResolver } from './spotifyResolver';

/**
 * URL parsing and the token-refresh path, both of which the search ladder
 * depends on. spotifyResolver was 11.37% with 304 uncovered lines.
 *
 * The 401 handling is the part worth pinning. Spotify access tokens expire in
 * about an hour and the bot runs for days, so a 401 is a ROUTINE event, not an
 * error. The resolver must invalidate the cached token, fetch a new one, and
 * retry ONCE. Two failure modes are worth locking down: a resolver that does
 * not refresh turns every stale token into a dead music link, and one that
 * loops would hammer the auth endpoint.
 */

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let fetchMock: ReturnType<typeof vi.fn>;

const build = (token: string | null = 'TOKEN') => {
  const tokenManager = {
    getToken: vi.fn(async () => token),
    invalidate: vi.fn(),
  };
  const resolver = new SpotifyResolver(tokenManager as never);
  return { resolver, tokenManager };
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpotifyResolver.parseSpotifyUrl', () => {
  it.each([
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'track', '4uLU6hMCjMI75M1A2tKUQC'],
    ['https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', 'album', '1DFixLWuPkv3KT3TnV35m3'],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'playlist', '37i9dQZF1DXcBWIGoYBM5M'],
    ['https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb', 'artist', '4Z8W4fKeB5YxbusRsdQVPb'],
  ])('parses %s', (url, type, id) => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl(url)).toEqual({ type, id });
  });

  it('handles the localised /intl-xx/ prefix Spotify serves in some regions', () => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl('https://open.spotify.com/intl-de/track/abc123')).toEqual({
      type: 'track',
      id: 'abc123',
    });
  });

  it('handles the spotify: URI scheme', () => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl('spotify:track:abc123')).toEqual({ type: 'track', id: 'abc123' });
  });

  it('handles a slash separator instead of a colon', () => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl('spotify:album/abc123')).toEqual({ type: 'album', id: 'abc123' });
  });

  it('tolerates surrounding whitespace, which pasting from a browser adds', () => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl('   https://open.spotify.com/track/abc123  ')).toEqual({
      type: 'track',
      id: 'abc123',
    });
  });

  it.each([
    ['a Last.fm link', 'https://www.last.fm/music/Radiohead'],
    ['a bare word', 'radiohead'],
    ['an empty string', ''],
    ['a Spotify link with no id', 'https://open.spotify.com/track/'],
    ['an unrelated Spotify host', 'https://evil.spotify.com/track/abc123'],
  ])('returns null for %s', (_label, url) => {
    const { resolver } = build();
    expect(resolver.parseSpotifyUrl(url)).toBeNull();
  });

  it('agrees with isSpotifyUrl', () => {
    const { resolver } = build();
    expect(resolver.isSpotifyUrl('https://open.spotify.com/track/abc123')).toBe(true);
    expect(resolver.isSpotifyUrl('https://www.last.fm/music/Radiohead')).toBe(false);
  });
});

describe('SpotifyResolver token handling', () => {
  it('does not call the API at all when there is no token', async () => {
    const { resolver } = build(null);
    await expect(resolver.resolve('https://open.spotify.com/track/abc123')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for an unparseable URL without asking for a token', async () => {
    const { resolver, tokenManager } = build();
    await expect(resolver.resolve('not a url')).resolves.toBeNull();
    expect(tokenManager.getToken).not.toHaveBeenCalled();
  });
});

describe('SpotifyResolver 401 refresh', () => {
  it('invalidates the token and retries once, succeeding on the second call', async () => {
    // The ordinary case: an hour-old token. Without the refresh every search
    // would start failing once the bot had been up for an hour.
    const tokenManager = {
      getToken: vi.fn().mockResolvedValueOnce('STALE').mockResolvedValueOnce('FRESH'),
      invalidate: vi.fn(),
    };
    const resolver = new SpotifyResolver(tokenManager as never);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          tracks: { items: [{ name: 'Airbag', artists: [{ name: 'Radiohead' }], duration_ms: 284000 }] },
        }),
      );

    const result = await resolver.searchTrack('airbag');

    expect(tokenManager.invalidate).toHaveBeenCalledTimes(1);
    expect(result?.name).toBe('Airbag');
  });

  it('does not retry more than once, so a dead token cannot hammer the API', async () => {
    const tokenManager = { getToken: vi.fn().mockResolvedValue('STALE'), invalidate: vi.fn() };
    const resolver = new SpotifyResolver(tokenManager as never);
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await expect(resolver.searchTrack('airbag')).resolves.toBeNull();

    // Two calls: the original and exactly one retry. Both 401.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the retry also fails', async () => {
    const tokenManager = {
      getToken: vi.fn().mockResolvedValueOnce('STALE').mockResolvedValueOnce('ALSO_BAD'),
      invalidate: vi.fn(),
    };
    const resolver = new SpotifyResolver(tokenManager as never);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(resolver.searchTrack('airbag')).resolves.toBeNull();
  });

  it('returns null when the 401 leaves no usable replacement token', async () => {
    const tokenManager = {
      getToken: vi.fn().mockResolvedValueOnce('STALE').mockResolvedValueOnce(null),
      invalidate: vi.fn(),
    };
    const resolver = new SpotifyResolver(tokenManager as never);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(resolver.searchTrack('airbag')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-401 failure WITHOUT invalidating the token', async () => {
    // A 500 is a Spotify outage, not an expired credential. Invalidating here
    // would throw away a perfectly good token and cause an extra auth call.
    const { resolver, tokenManager } = build();
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(resolver.searchTrack('airbag')).resolves.toBeNull();
    expect(tokenManager.invalidate).not.toHaveBeenCalled();
  });

  it('returns null when the network throws, rather than propagating', async () => {
    const { resolver } = build();
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    await expect(resolver.searchTrack('airbag')).resolves.toBeNull();
  });
});

describe('SpotifyResolver search', () => {
  const trackItem = {
    name: 'Airbag',
    artists: [{ name: 'Radiohead' }],
    duration_ms: 284000,
    album: { name: 'OK Computer', images: [{ url: 'https://img/airbag.png' }] },
    external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
  };

  it('joins multiple artists with a comma', async () => {
    const { resolver } = build();
    fetchMock.mockResolvedValue(
      jsonResponse({ tracks: { items: [{ ...trackItem, artists: [{ name: 'A' }, { name: 'B' }] }] } }),
    );

    const result = await resolver.searchTrack('airbag');

    expect(result?.artist).toBe('A, B');
  });

  it('builds a searchQuery of "artist - track", which the ladder parses back', async () => {
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    const result = await resolver.searchTrack('airbag');

    expect(result?.searchQuery).toBe('Radiohead - Airbag');
  });

  it('returns null when the search finds nothing', async () => {
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [] } }));
    await expect(resolver.searchTrack('zzzznothing')).resolves.toBeNull();
  });

  it('returns null for an empty query without calling the API', async () => {
    const { resolver } = build();
    await expect(resolver.searchTrack('   ')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncates an over-long query rather than sending it', async () => {
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    await resolver.searchTrack('x'.repeat(400));

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.length).toBeLessThan(400);
  });

  it('caps the multi-track limit at the Spotify maximum of 50', async () => {
    // Spotify rejects limit>50 with a 400, so an uncapped value would turn a
    // caller asking for 200 into a hard failure rather than a clamped search.
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    await resolver.searchTracks('airbag', 200);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=50');
  });

  it('returns an empty list, not null, from the plural search', async () => {
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [] } }));
    await expect(resolver.searchTracks('nothing')).resolves.toEqual([]);
  });

  it('returns an empty list for a blank plural query without calling the API', async () => {
    const { resolver } = build();
    await expect(resolver.searchTracks('')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
