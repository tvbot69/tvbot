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

  it('caps the multi-track limit at the measured Spotify maximum of 10, not the documented 50', async () => {
    // MEASURED LIVE 2026-09-30 against api.spotify.com with client-credentials,
    // not read from the docs. The published Web API reference says 50; the
    // server disagrees: on `/v1/search?q=radiohead&type=track`, limit=10 -> 200
    // with 10 items, and limit=11, 15 and 50 each -> 400
    // `{"error":{"status":400,"message":"Invalid limit"}}`. This test used to
    // assert 50 and to explain it as "Spotify rejects limit>50 with a 400",
    // which pinned a fact about the vendor that was false in the only direction
    // that mattered — it made the clamp a no-op, because a clamped value the
    // server rejects is exactly the bug. A test that asserts a vendor's limits
    // is a claim about that vendor, so it carries its evidence.
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    await resolver.searchTracks('airbag', 200);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=10');
  });

  it('leaves an in-range limit alone, so the clamp is not what makes the search work', async () => {
    // The companion to the clamp test above, and the reason both exist: a clamp
    // that also mangled valid input would pass the test above while quietly
    // narrowing every real search. `artworkService` calls this with exactly 10
    // (lines 339, 344, 358, 780), so 10 must survive untouched.
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    await resolver.searchTracks('airbag', 10);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('limit=10');
    expect(url).not.toContain('limit=0');
  });

  it('clamps a non-integer or non-finite limit rather than sending it', async () => {
    // Same measurement, different shape: limit=0, -1, 1.5 and abc were all
    // measured returning 400 "Invalid limit", so a limit that is not a plain
    // positive integer is a rejection waiting to happen. NaN and Infinity are
    // included because a caller computing a limit from data can produce them.
    const { resolver } = build();
    fetchMock.mockResolvedValue(jsonResponse({ tracks: { items: [trackItem] } }));

    for (const [label, bad] of [['0', 0], ['negative', -3], ['fractional', 1.5], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY]] as Array<[string, number]>) {
      fetchMock.mockClear();
      await resolver.searchTracks('airbag', bad);
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url, `limit ${label} must be clamped into the accepted range`).toContain(
        'limit=',
      );
      const sent = Number(new URL(url).searchParams.get('limit'));
      expect(Number.isInteger(sent) && sent >= 1 && sent <= 10, `sent limit=${String(sent)}`).toBe(true);
    }
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
