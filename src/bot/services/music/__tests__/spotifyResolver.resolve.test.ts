import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { SpotifyScraperService } from '@bot/services/music/spotifyScraperService';

/**
 * `resolve()` and the four per-type resolvers behind it.
 *
 * The two URL-parsing test files already pin `isSpotifyUrl` / `parseSpotifyUrl`
 * and the 401 refresh on the SEARCH methods. Everything below `resolve()` was
 * uncovered: 216 of 345 lines. That is where a pasted link becomes an actual
 * queue, and where the three rules that shape it live:
 *
 *  1. **A failed read is `null`, never a partly-built result.** `resolve()`
 *     answers null when the token is missing, when the API refuses, and when
 *     the fetch throws. It never invents a title.
 *  2. **A playlist with an unreadable size says so.** `totalKnown: false` is
 *     the only thing standing between a 347-track playlist and a confident
 *     "100 tracks" (see `spotifyScraperService.totalKnown.test.ts`). This file
 *     pins the FORWARDING of that flag: a resolver that dropped it would leave
 *     the flag's own test green while reintroducing the lie one layer up.
 *  3. **Every list is paginated, and a page that fails to read stops the walk
 *     instead of publishing a truncated count as if it were whole.**
 */

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let fetchMock: ReturnType<typeof vi.fn>;

const build = (token: string | null = 'TOKEN') => {
  const tokenManager = { getToken: vi.fn(async () => token), invalidate: vi.fn() };
  const resolver = new SpotifyResolver(tokenManager as never);
  return { resolver, tokenManager };
};

/** A resolver carrying a scraper double, for the playlist rung. */
const buildWithScraper = (
  token: string | null,
  scraper: Partial<SpotifyScraperService> | null,
) => {
  const tokenManager = { getToken: vi.fn(async () => token), invalidate: vi.fn() };
  const resolver = new SpotifyResolver(
    tokenManager as never,
    (scraper ?? undefined) as SpotifyScraperService | undefined,
  );
  return { resolver, tokenManager };
};

/**
 * Routes each request URL to its own canned response.
 *
 * Longest matching prefix wins, and every key is a full endpoint (query string
 * included) rather than a bare path segment. That matters because a pagination
 * cursor CONTAINS its own base endpoint — `.../albums/bbb/tracks?offset=50`
 * matches both `/v1/albums/bbb` and the cursor — so a table keyed on path
 * segments alone hands every page the first page's body and the walk silently
 * publishes page one.
 *
 * A value may be a BODY (wrapped in a 200) or a THUNK (used as the whole
 * Response), which is how the failure-status cases are expressed.
 */
const route = (table: Record<string, unknown>, fallback: unknown = null) => {
  const prefixes = Object.keys(table).sort((a, b) => b.length - a.length);
  fetchMock.mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    const hit = prefixes.find((prefix) => url.includes(prefix));
    if (hit === undefined) return json(fallback, 404);
    const value = table[hit];
    return typeof value === 'function' ? (value as () => unknown)() : json(value);
  });
};

/** Every URL the resolver asked for, in order. */
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TRACK = {
  name: 'Bohemian Rhapsody',
  artists: [{ name: 'Queen' }],
  duration_ms: 355_000,
  album: { name: 'A Night at the Opera', images: [{ url: 'https://img.test/opera.jpg' }] },
  external_urls: { spotify: 'https://open.spotify.com/track/aaa' },
  external_ids: { isrc: 'GBAYE0601498' },
};

describe('resolve() — the answer to a bad link is null, never a guess', () => {
  it('routes each link type to its own endpoint', async () => {
    // The routing table itself: a resolver that sent an album link to the track
    // endpoint would return 404 and answer "null" for every album link ever
    // pasted, which is indistinguishable from a deleted album.
    route({
      '/v1/tracks/aaa': TRACK,
      '/v1/albums/bbb': { name: 'Album', artists: [{ name: 'Queen' }], tracks: { items: [TRACK], total: 1, next: null } },
      '/v1/playlists/ccc': { name: 'List', tracks: { items: [{ track: TRACK }], total: 1, next: null } },
      '/v1/artists/ddd/top-tracks': { tracks: [TRACK] },
      '/v1/artists/ddd': { name: 'Queen', images: [] },
          });

    const { resolver } = build();
    expect((await resolver.resolve('https://open.spotify.com/track/aaa'))?.type).toBe('track');
    expect((await resolver.resolve('https://open.spotify.com/album/bbb'))?.type).toBe('album');
    expect((await resolver.resolve('https://open.spotify.com/playlist/ccc'))?.type).toBe('playlist');
    expect((await resolver.resolve('https://open.spotify.com/artist/ddd'))?.type).toBe('artist');

    expect(urls()[0]).toContain('/v1/tracks/aaa');
    expect(urls().some((u) => u.includes('/v1/albums/bbb'))).toBe(true);
    expect(urls().some((u) => u.includes('/v1/playlists/ccc'))).toBe(true);
    expect(urls().some((u) => u.includes('/v1/artists/ddd/top-tracks'))).toBe(true);
  });

  it('a RESOLVE that throws is null, so a bad link never becomes an exception in the command', async () => {
    const { resolver } = build();
    // `fetchSpotify` already swallows, so this forces the outer catch by making
    // the JSON parse throw after an ok response.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    await expect(resolver.resolve('https://open.spotify.com/track/aaa')).resolves.toBeNull();
  });

  it('a 401 on RESOLVE refreshes the token and retries, rather than failing the link', async () => {
    // Same expiry the search path has to survive, on the path a user pastes.
    // Tokens last about an hour and the bot runs for days.
    const tokenManager = {
      getToken: vi.fn().mockResolvedValueOnce('STALE').mockResolvedValueOnce('FRESH'),
      invalidate: vi.fn(),
    };
    const resolver = new SpotifyResolver(tokenManager as never);
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(TRACK));

    const res = await resolver.resolve('https://open.spotify.com/track/aaa');

    expect(tokenManager.invalidate).toHaveBeenCalledTimes(1);
    expect(res?.title).toBe('Bohemian Rhapsody');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 5xx does NOT invalidate the token, because the credential is not the problem', async () => {
    const { resolver, tokenManager } = build();
    fetchMock.mockResolvedValue(json({}, 503));

    await expect(resolver.resolve('https://open.spotify.com/track/aaa')).resolves.toBeNull();
    expect(tokenManager.invalidate).not.toHaveBeenCalled();
  });
});

describe('resolve() — a track link', () => {
  it('carries the ISRC, because it is the exact-recording key for the audio search', async () => {
    route({ '/v1/tracks/aaa': TRACK });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/track/aaa');

    expect(res?.tracks[0]).toMatchObject({
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
      durationMs: 355_000,
      album: 'A Night at the Opera',
      searchQuery: 'Queen - Bohemian Rhapsody',
      artworkUrl: 'https://img.test/opera.jpg',
      spotifyUri: 'https://open.spotify.com/track/aaa',
      isrc: 'GBAYE0601498',
      provider: 'spotify',
    });
    expect(res?.totalTracks).toBe(1);
  });

  it('a blank or whitespace ISRC reads as absent, never as an empty-string key', async () => {
    // An empty ISRC sent to the ladder's ISRC rung would be searched as if it
    // were a real code — a guaranteed miss that reads as "this recording does
    // not exist".
    route({ '/v1/tracks/': { ...TRACK, external_ids: { isrc: '   ' } } });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/track/aaa');

    expect(res?.tracks[0]?.isrc).toBeUndefined();
  });

  it('a track with no album or no external_urls still resolves, with those fields absent', async () => {
    // Spotify omits `images` on a track whose release has no artwork. Omitting
    // the field is honest; `artworkUrl: ''` would be a URL that renders broken.
    route({ '/v1/tracks/': { name: 'Untitled', artists: [{ name: 'X' }], duration_ms: 1 } });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/track/aaa');

    expect(res?.tracks[0]?.artworkUrl).toBeUndefined();
    expect(res?.tracks[0]?.album).toBeUndefined();
    expect(res?.tracks[0]?.spotifyUri).toBeUndefined();
  });

  it('an API refusal on a track link is null, not an empty track list', async () => {
    route({}, null);
    const { resolver } = build();
    fetchMock.mockResolvedValue(json({ error: { status: 404 } }, 404));

    await expect(resolver.resolve('https://open.spotify.com/track/aaa')).resolves.toBeNull();
  });
});

describe('resolve() — an album link', () => {
  const albumBody = (n: number, next: string | null = null) => ({
    name: 'Greatest Hits',
    artists: [{ name: 'Queen' }],
    images: [{ url: 'https://img.test/gh.jpg' }],
    tracks: {
      items: Array.from({ length: n }, (_, i) => ({ ...TRACK, name: `Cut ${i + 1}` })),
      total: 199,
      next,
    },
  });

  it('every album track inherits the ALBUM cover, and carries its own ISRC', async () => {
    route({ '/v1/albums/bbb': albumBody(3) });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    expect(res?.tracks).toHaveLength(3);
    expect(res?.tracks.every((t) => t.artworkUrl === 'https://img.test/gh.jpg')).toBe(true);
    expect(res?.tracks[0]?.album).toBe('Greatest Hits');
    expect(res?.tracks[0]?.isrc).toBe('GBAYE0601498');
    expect(res?.artworkUrl).toBe('https://img.test/gh.jpg');
    expect(res?.author).toBe('Queen');
  });

  it('walks the pages, so a 199-track album is not published as its first 50', async () => {
    // Spotify's own docs and the live measurement both say limit=50 is honoured
    // and the `next` cursor is the only way past it.
    route({
      '/v1/albums/bbb/tracks?offset=100': {
        items: Array.from({ length: 49 }, (_, i) => ({ ...TRACK, name: `Cut ${101 + i}` })),
        next: null,
      },
      '/v1/albums/bbb/tracks?offset=50': {
        items: Array.from({ length: 50 }, (_, i) => ({ ...TRACK, name: `Cut ${51 + i}` })),
        next: 'https://api.spotify.com/v1/albums/bbb/tracks?offset=100',
      },
      '/v1/albums/bbb': albumBody(50, 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50'),
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    expect(res?.tracks).toHaveLength(149);
    // The vendor's own total is reported, not the shard size.
    expect(res?.totalTracks).toBe(199);
  });

  it('a page that comes back UNREADABLE stops the walk instead of claiming a whole album', async () => {
    // The A1 rule at the pagination layer: publishing 50 tracks and the real
    // total 199 tells the listener "149 missing, here is your album" when what
    // actually happened is that page two failed to load. It is truncated either
    // way, but only one of those is true.
    route({
      '/v1/albums/bbb': albumBody(50, 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50'),
      'tracks?offset=50': () => json({ error: 'boom' }, 500),
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    expect(res?.tracks).toHaveLength(50);
    // A partial read is a partial result, and it says so.
    expect(res?.totalTracks).toBe(199);
    expect(res?.tracks.length).toBeLessThan(res!.totalTracks);
  });

  it('a page with no items array stops the walk rather than looping on the same cursor', async () => {
    route({
      '/v1/albums/bbb': albumBody(50, 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50'),
      'tracks?offset=50': { next: 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50' },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    expect(res?.tracks).toHaveLength(50);
    // Two requests, not fifty: the walk must be able to terminate.
    expect(urls().filter((u) => u.includes('tracks?offset=50'))).toHaveLength(1);
  });

  it('a 500-track walk stops at the cap instead of paging forever', async () => {
    // A self-repeating `next` would otherwise be an unbounded loop on a live
    // queue. The cap is the third brake on it (the other two are the empty-page
    // break above and the vendor's own `next: null`).
    route({
      '/v1/albums/bbb/tracks?offset=50': {
        items: Array.from({ length: 50 }, (_, i) => ({ ...TRACK, name: `Cut ${51 + i}` })),
        next: 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50',
      },
      '/v1/albums/bbb': albumBody(50, 'https://api.spotify.com/v1/albums/bbb/tracks?offset=50'),
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    // 50 first page + 450 paged = the 500 cap.
    expect(res?.tracks.length).toBe(500);
  });

  it('an album whose tracks.total is absent falls back to the rows actually read', async () => {
    route({
      '/v1/albums/bbb': { ...albumBody(4), tracks: { items: albumBody(4).tracks.items, next: null } },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/album/bbb');

    expect(res?.totalTracks).toBe(4);
  });
});

describe('resolve() — a playlist link goes through the scraper FIRST', () => {
  const scraped = (over: Record<string, unknown> = {}) => ({
    name: 'RAGE',
    owner: 'someone',
    artworkUrl: 'https://img.test/rage.jpg',
    total: 347,
    totalKnown: true,
    hasMore: true,
    nextOffset: 100,
    tracks: [
      { name: 'GONE 4 A MIN', artist: 'Yeat', durationMs: 135_053, artworkUrl: 'https://img.test/1.jpg', spotifyUri: 'spotify:track:one' },
      { name: 'KILL YA', artist: 'Yeat', durationMs: 200_000, spotifyUri: 'spotify:track:two' },
    ],
    ...over,
  });

  it('a scraper page is preferred and the API is never asked', async () => {
    const page = vi.fn(async (..._a: unknown[]) => scraped());
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.type).toBe('playlist');
    expect(res?.title).toBe('RAGE');
    expect(res?.author).toBe('someone');
    expect(res?.tracks.map((t) => t.name)).toEqual(['GONE 4 A MIN', 'KILL YA']);
    expect(res?.tracks[1]?.artworkUrl).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('FORWARDS totalKnown:false, so the unreadable-size lie cannot come back one layer up', async () => {
    // The flag is the whole point of the scraper's unreadable-count work. A
    // resolver that dropped it would leave `totalKnown.test.ts` fully green
    // while every playlist again reported its 100-track shard as the size.
    const page = vi.fn(async (..._a: unknown[]) => scraped({ total: 100, totalKnown: false }));
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.totalKnown).toBe(false);
    expect(res?.totalTracks).toBe(100);
  });

  it('totalKnown defaults to TRUE when the scraper omits it, because silence is not uncertainty', async () => {
    const page = vi.fn(async (..._a: unknown[]) => scraped({ totalKnown: undefined }));
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.totalKnown).toBe(true);
  });

  it('asks the scraper for the first 100 at offset 0, which is the shard size the pager works in', async () => {
    const page = vi.fn(async (..._a: unknown[]) => scraped());
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(page.mock.calls[0]).toEqual(['ccc', 0, 100]);
  });

  it('a scraper that returns NOTHING usable falls back to the API, because a rung failing is not an empty playlist', async () => {
    const page = vi.fn(async (..._a: unknown[]) => null);
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        owner: { display_name: 'Owner' },
        images: [{ url: 'https://img.test/list.jpg' }],
        tracks: { items: [{ track: TRACK }], total: 1, next: null },
      },
    });
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.title).toBe('List');
    expect(res?.author).toBe('Owner');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('an EMPTY scraper page is also a rung failing, not an empty playlist', async () => {
    // The dangerous shape: an accepted empty page would render "this playlist
    // has no tracks" for a playlist the scraper simply could not read.
    const page = vi.fn(async (..._a: unknown[]) => scraped({ tracks: [] }));
    route({ '/v1/playlists/ccc': { name: 'List', tracks: { items: [{ track: TRACK }], total: 1, next: null } } });
    const { resolver } = buildWithScraper('TOKEN', { fetchPlaylistPage: page } as never);

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks).toHaveLength(1);
    expect(res?.tracks[0]?.name).toBe('Bohemian Rhapsody');
  });

  it('a resolver built WITHOUT a scraper goes straight to the API, so playlists still work', async () => {
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        tracks: { items: [{ track: TRACK }], total: 1, next: null },
      },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks).toHaveLength(1);
    expect(res?.author).toBe('Spotify Playlist');
  });

  it('a playlist API answer with NO tracks is null, never an empty queue', async () => {
    route({ '/v1/playlists/ccc': { name: 'List' } });
    const { resolver } = build();

    await expect(resolver.resolve('https://open.spotify.com/playlist/ccc')).resolves.toBeNull();
  });

  it('SKIPS rows Spotify could not resolve (a removed track carries track: null)', async () => {
    // Real playlist payloads carry `{"track": null}` for a track that has been
    // taken down. Reading `item.track.name` off that is a TypeError that used to
    // take the whole playlist down with it.
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        tracks: {
          items: [{ track: null }, { track: TRACK }, { track: null }],
          total: 3,
          next: null,
        },
      },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks).toHaveLength(1);
    expect(res?.tracks[0]?.name).toBe('Bohemian Rhapsody');
  });

  it('a track-level cover wins over the playlist cover, because it is the right image', async () => {
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        images: [{ url: 'https://img.test/playlist.jpg' }],
        tracks: {
          items: [
            { track: { ...TRACK, album: { name: 'Op', images: [{ url: 'https://img.test/album.jpg' }] } } },
            { track: { ...TRACK, album: { images: [] } } },
          ],
          total: 2,
          next: null,
        },
      },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks[0]?.artworkUrl).toBe('https://img.test/album.jpg');
    expect(res?.tracks[1]?.artworkUrl).toBe('https://img.test/playlist.jpg');
  });

  it('walks playlist pages too, so a long playlist is not silently cut at the first page', async () => {
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        tracks: {
          items: [{ track: TRACK }],
          total: 2,
          next: 'https://api.spotify.com/v1/playlists/ccc/tracks?offset=1',
        },
      },
      '/v1/playlists/ccc/tracks?offset=1': { items: [{ track: null }, { track: { ...TRACK, name: 'Second' } }], next: null },
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks.map((t) => t.name)).toEqual(['Bohemian Rhapsody', 'Second']);
  });

  it('an unreadable playlist page stops the walk, leaving a partial result that is visibly partial', async () => {
    route({
      '/v1/playlists/ccc': {
        name: 'List',
        tracks: { items: [{ track: TRACK }], total: 500, next: 'https://api.spotify.com/v1/playlists/ccc/tracks?offset=1' },
      },
      '/v1/playlists/ccc/tracks?offset=1': () => json({}, 500),
    });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/playlist/ccc');

    expect(res?.tracks).toHaveLength(1);
    expect(res?.totalTracks).toBe(500);
  });
});

describe('resolve() — an artist link', () => {
  const artistBody = {
    name: 'Queen',
    images: [{ url: 'https://img.test/queen.jpg' }],
  };

  const topTracks = (n: number) => ({
    tracks: Array.from({ length: n }, (_, i) => ({ ...TRACK, name: `Hit ${i + 1}` })),
  });

  it('reads the artist and its top tracks together, and titles the result for the card', async () => {
    route({ '/v1/artists/ddd/top-tracks': topTracks(3), '/v1/artists/ddd': artistBody });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/artist/ddd');

    expect(res?.type).toBe('artist');
    expect(res?.title).toBe("Queen's Top Tracks");
    expect(res?.author).toBe('Queen');
    expect(res?.totalTracks).toBe(3);
    expect(res?.tracks[0]?.artworkUrl).toBe('https://img.test/opera.jpg');
  });

  it('caps the top tracks at ten, because that is what the picker card can show', async () => {
    route({ '/v1/artists/ddd/top-tracks': topTracks(40), '/v1/artists/ddd': artistBody });
    const { resolver } = build();

    const res = await resolver.resolve('https://open.spotify.com/artist/ddd');

    expect(res?.tracks).toHaveLength(10);
    // The cap is honest: the reported total is the number actually returned,
    // never the vendor's larger set, or the card would promise 40.
    expect(res?.totalTracks).toBe(10);
  });

  it('an artist whose top-tracks call failed is null, not an artist with no tracks', async () => {
    route({ '/v1/artists/ddd/top-tracks': () => json({}, 403), '/v1/artists/ddd': artistBody });
    const { resolver } = build();

    await expect(resolver.resolve('https://open.spotify.com/artist/ddd')).resolves.toBeNull();
  });

  it('an artist whose own profile failed is null too', async () => {
    route({ '/v1/artists/ddd': () => json({}, 404), '/v1/artists/ddd/top-tracks': topTracks(3) });
    const { resolver } = build();

    await expect(resolver.resolve('https://open.spotify.com/artist/ddd')).resolves.toBeNull();
  });

  it('a top-tracks answer with no tracks array is null, never an empty list', async () => {
    route({ '/v1/artists/ddd/top-tracks': { total: 0 }, '/v1/artists/ddd': artistBody });
    const { resolver } = build();

    await expect(resolver.resolve('https://open.spotify.com/artist/ddd')).resolves.toBeNull();
  });
});
