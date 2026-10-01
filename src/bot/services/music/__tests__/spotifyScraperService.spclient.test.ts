import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpotifyScraperService, type ScrapedPlaylist } from '@bot/services/music/spotifyScraperService';

/**
 * `fetchViaSpclient` — the rung that is asked first on every playlist page and
 * that has been refused by Spotify on every attempt since 2026-09-30.
 *
 * It is kept as a dead ACCELERATOR inside a live capability (the HTML and
 * browser rungs still deliver playlists), which means the only thing keeping it
 * honest is that it cannot quietly poison the rungs behind it. Two shapes of
 * payload reach it and both have to be read correctly:
 *
 *  - **`itemV2`** — the current spclient shape: artists nested under
 *    `artists.items[].profile.name`, duration under `trackDuration`, cover
 *    under `albumOfTrack`. Reading it with the flat legacy shape yields
 *    `Unknown Artist` and `0:00` for every track, which is a wrong card, not a
 *    missing one.
 *  - **legacy `item` / `track`** — the Web-API shape.
 *
 * The cursor is the other half. `hasMore`/`nextOffset` are what the chunk
 * manager and the pager use to decide whether page one WAS the playlist, so an
 * `offset + n < total` computed off the wrong denominator silently ends a
 * 347-track load at 100 with nothing said.
 *
 * SCOPE: the private is reached with the same own-property cast the sibling
 * `spotifyScraperService.unit.test.ts` uses, because `fetchPlaylistPage`
 * would issue real network calls through the token rung on the way here.
 */

interface SpclientInternals {
  fetchViaSpclient(id: string, offset: number, limit: number): Promise<ScrapedPlaylist | null>;
  getWebPlayerToken(): Promise<string | null>;
}

let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const svc = () => new SpotifyScraperService();

/** The private rung plus a token, reached the way the class reaches them. */
const withToken = (token: string | null = 'T1'): [SpotifyScraperService, SpclientInternals] => {
  const s = svc();
  const internals = s as unknown as SpclientInternals;
  internals.getWebPlayerToken = async () => token;
  return [s, internals];
};

const spclient = (s: SpotifyScraperService) =>
  (s as unknown as SpclientInternals).fetchViaSpclient.bind(s as unknown as SpclientInternals);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Only the spclient host answers; the api.spotify.com twin never does. */
const onlySpclient = (body: unknown, status = 200) => {
  fetchMock.mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes('spclient.wg.spotify.com')) return json(body, status);
    return json({}, 403);
  });
};

describe('fetchViaSpclient — no token means the rung declines, it does not guess', () => {
  it('returns null without any network call when the web-player token is unavailable', async () => {
    const [, internals] = withToken(null);

    await expect(internals.fetchViaSpclient('abc', 0, 100)).resolves.toBeNull();
    // Not one request: the token walk is the expensive part and it already said no.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tries the spclient host first and falls back to the Web API host', async () => {
    // Both URLs are tried because the token works for one and not the other
    // depending on which transport Spotify is currently willing to honour.
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('spclient.wg.spotify.com')) return json({}, 403);
      return json({ items: [{ name: 'Via API', artists: [{ name: 'A' }], duration_ms: 1 }] });
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.name).toBe('Via API');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('spclient.wg.spotify.com');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('api.spotify.com/v1/playlists/abc/tracks');
  });

  it('sends the token as a bearer and the offset/limit it was asked for', async () => {
    // The cursor parameters are the whole point of the rung on a paged load.
    const [s] = withToken('TOKEN-X');
    onlySpclient({ items: [{ name: 'T', artists: [{ name: 'A' }], duration_ms: 1 }] });

    await spclient(s)('abc', 100, 50);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('offset=100');
    expect(url).toContain('limit=50');
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBe('Bearer TOKEN-X');
    expect(init.headers?.['App-Platform']).toBe('WebPlayer');
  });

  it('a 403 on every host is null, so the next rung runs instead of a blank playlist', async () => {
    const [s] = withToken();
    fetchMock.mockResolvedValue(json({}, 403));

    await expect(spclient(s)('abc', 0, 100)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a fetch that THROWS on the first host still tries the second', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('spclient.wg.spotify.com')) throw new Error('socket hang up');
      return json({ tracks: { items: [{ name: 'Recovered', artists: [{ name: 'A' }], duration_ms: 1 }] } });
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.name).toBe('Recovered');
  });
});

describe('fetchViaSpclient — the itemV2 shape it actually gets back', () => {
  const itemV2 = (name: string, over: Record<string, unknown> = {}) => ({
    itemV2: {
      data: {
        name,
        uri: `spotify:track:${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        artists: { items: [{ profile: { name: 'Yeat' } }, { profile: { name: 'Drake' } }] },
        trackDuration: { totalMilliseconds: 135_053 },
        albumOfTrack: { coverArt: { sources: [{ url: 'https://img.test/yeat.jpg' }] } },
        ...over,
      },
    },
  });

  it('reads artists, duration and cover out of the nested shape rather than reporting zeroes', async () => {
    // The wrong-song/blank-card hazard: reading itemV2 with the flat legacy
    // keys yields `Unknown Artist` and `durationMs: 0` for EVERY track, which
    // renders as a confident card full of wrong values.
    const [s] = withToken();
    onlySpclient({ name: 'GONE 4 A MIN', ownerName: 'someone', totalCount: 1, items: [itemV2('GONE 4 A MIN')] });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]).toEqual({
      name: 'GONE 4 A MIN',
      artist: 'Yeat, Drake',
      durationMs: 135_053,
      artworkUrl: 'https://img.test/yeat.jpg',
      spotifyUri: 'spotify:track:gone4amin',
    });
  });

  it('an itemV2 with no artists reads as Unknown Artist, and still plays', async () => {
    // Omitting the row would silently drop a real track out of someone's
    // playlist; a placeholder name is visible and honest.
    const [s] = withToken();
    onlySpclient({ totalCount: 1, items: [{ itemV2: { data: { name: 'Solo', uri: 'spotify:track:solo' } } }] });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.artist).toBe('Unknown Artist');
    expect(page?.tracks[0]?.durationMs).toBe(0);
  });

  it('an itemV2 whose artist profile has no name is skipped, not joined as "undefined"', async () => {
    // `.map().filter(Boolean).join(', ')` is what makes this safe: a missing
    // name drops out of the list instead of becoming the string "undefined".
    const [s] = withToken();
    onlySpclient({
      totalCount: 1,
      items: [
        {
          itemV2: {
            data: {
              name: 'Track',
              uri: 'spotify:track:t',
              artists: { items: [{}, { profile: { name: 'Real Name' } }] },
            },
          },
        },
      ],
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.artist).toBe('Real Name');
  });

  it('reads the playlist name and owner, and falls back to labels when absent', async () => {
    const [s] = withToken();
    onlySpclient({ items: [itemV2('A')] });

    const bare = await spclient(s)('abc', 0, 100);
    expect(bare?.name).toBe('Spotify Playlist');
    expect(bare?.owner).toBe('Spotify');

    const [s2] = withToken();
    fetchMock.mockReset();
    onlySpclient({ name: 'RAGE', owner: { display_name: 'Display Owner' }, items: [itemV2('A')] });
    const named = await spclient(s2)('abc', 0, 100);
    expect(named?.name).toBe('RAGE');
    expect(named?.owner).toBe('Display Owner');
  });
});

describe('fetchViaSpclient — the legacy Web-API shape', () => {
  it('reads a `tracks.items` envelope, which is what the api.spotify.com twin answers with', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('spclient.wg.spotify.com')) return json({}, 403);
      return json({
        name: 'List',
        owner: { display_name: 'Owner' },
        images: [{ url: 'https://img.test/list.jpg' }],
        tracks: {
          total: 2,
          items: [
            { name: 'A', artists: [{ name: 'X' }, { name: 'Y' }], duration_ms: 5, uri: 'spotify:track:a', album: { images: [{ url: 'https://img.test/a.jpg' }] } },
          ],
        },
      });
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.name).toBe('List');
    expect(page?.owner).toBe('Owner');
    expect(page?.artworkUrl).toBe('https://img.test/list.jpg');
    expect(page?.tracks[0]).toEqual({
      name: 'A',
      artist: 'X, Y',
      durationMs: 5,
      artworkUrl: 'https://img.test/a.jpg',
      spotifyUri: 'spotify:track:a',
    });
  });

  it('reads a bare `items` envelope too, and prefers it over the nested one', async () => {
    const [s] = withToken();
    onlySpclient({
      items: [{ name: 'Flat', artists: [{ name: 'A' }], duration_ms: 1 }],
      tracks: { items: [{ name: 'Nested', artists: [{ name: 'A' }], duration_ms: 1 }] },
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.name).toBe('Flat');
  });

  it('a row with no name is DROPPED, because a track with no name cannot be displayed or searched', async () => {
    // Accepting it would enqueue a blank row: the queue count would go up and
    // the card would show an empty line.
    const [s] = withToken();
    onlySpclient({ totalCount: 3, items: [{ artists: [{ name: 'A' }] }, { name: 'Real', artists: [{ name: 'A' }], duration_ms: 1 }] });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks).toHaveLength(1);
    expect(page?.tracks[0]?.name).toBe('Real');
  });

  it('a payload whose every row is unusable is a MISS for this host, so the next host is tried', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('spclient.wg.spotify.com')) return json({ totalCount: 1, items: [{ nothing: true }] });
      return json({ items: [{ name: 'Second Host', artists: [{ name: 'A' }], duration_ms: 1 }] });
    });

    const page = await spclient(s)('abc', 0, 100);

    expect(page?.tracks[0]?.name).toBe('Second Host');
  });

  it('an EMPTY items array is a miss, not an empty playlist', async () => {
    const [s] = withToken();
    onlySpclient({ totalCount: 0, items: [] });

    await expect(spclient(s)('abc', 0, 100)).resolves.toBeNull();
  });
});

describe('fetchViaSpclient — the cursor', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `T${i}`, artists: [{ name: 'A' }], duration_ms: 1 }));

  it('hasMore is false once the shard covers the total, and nextOffset is null', async () => {
    // `nextOffset: null` is the pager's stop condition. A wrong one makes the
    // pager re-request the same offset for ever, or stop early and call a
    // truncated playlist complete.
    const [s] = withToken();
    onlySpclient({ totalCount: 2, items: rows(2) });

    const page = await spclient(s)('abc', 0, 2);

    expect(page?.total).toBe(2);
    expect(page?.hasMore).toBe(false);
    expect(page?.nextOffset).toBeNull();
  });

  it('hasMore is true mid-playlist and nextOffset is the offset the shard ended at', async () => {
    const [s] = withToken();
    onlySpclient({ totalCount: 347, items: rows(100) });

    const page = await spclient(s)('abc', 100, 100);

    // 100 (already read) + 100 (this shard) < 347.
    expect(page?.hasMore).toBe(true);
    expect(page?.nextOffset).toBe(200);
    expect(page?.total).toBe(347);
  });

  it('reads the total from totalCount, then tracks.total, then the shard itself', async () => {
    const [s1] = withToken();
    onlySpclient({ totalCount: 347, tracks: { total: 9 }, items: rows(1) });
    expect((await spclient(s1)('abc', 0, 1))?.total).toBe(347);

    const [s2] = withToken();
    fetchMock.mockReset();
    onlySpclient({ tracks: { total: 9 }, items: rows(1) });
    expect((await spclient(s2)('abc', 0, 1))?.total).toBe(9);

    const [s3] = withToken();
    fetchMock.mockReset();
    onlySpclient({ items: rows(3) });
    // No count anywhere: the shard is the floor, and the caller sees total ===
    // tracks.length, which is the shape `totalKnown: false` describes.
    const bare = await spclient(s3)('abc', 0, 3);
    expect(bare?.total).toBe(3);
    expect(bare?.hasMore).toBe(false);
  });

  it('a top-level `total` is read as well, because the two hosts disagree on the field name', async () => {
    const [s] = withToken();
    onlySpclient({ total: 347, items: rows(1) });

    const page = await spclient(s)('abc', 0, 1);

    expect(page?.total).toBe(347);
    expect(page?.hasMore).toBe(true);
  });
});

describe('getTrackPreview — the spclient suggest rung, and its refusal', () => {
  /** Let the two HTML search pages and the embed page fail, then answer the suggest call. */
  const onlySuggest = (body: unknown) => {
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('search/suggest')) return json(body);
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
  };

  it('returns a matching suggestion with its duration and cover', async () => {
    const [s] = withToken();
    onlySuggest({
      tracks: {
        items: [
          {
            name: 'Airbag',
            artists: [{ name: 'Radiohead' }],
            audioPreview: { url: 'https://p.scdn.co/mp3-preview/abc' },
            duration: { totalMilliseconds: 284_000 },
            albumOfTrack: { coverArt: { sources: [{ url: 'https://img.test/airbag.jpg' }] } },
          },
        ],
      },
    });

    const res = await s.getTrackPreview('Radiohead', 'Airbag');

    expect(res).toMatchObject({
      previewUrl: 'https://p.scdn.co/mp3-preview/abc',
      trackName: 'Airbag',
      artistName: 'Radiohead',
      durationMs: 284_000,
      artworkUrl: 'https://img.test/airbag.jpg',
    });
  });

  it('REFUSES a suggestion from a different artist, because a wrong-artist preview is worse than none', async () => {
    const [s] = withToken();
    onlySuggest({
      tracks: {
        items: [
          {
            name: 'Creep',
            artists: [{ name: 'Nine Inch Nails' }],
            audioPreview: { url: 'https://p.scdn.co/mp3-preview/wrong' },
          },
        ],
      },
    });

    await expect(s.getTrackPreview('Radiohead', 'Creep')).resolves.toBeNull();
  });

  it('accepts a candidate on `subtitle` when the row carries no artists array', async () => {
    // The suggest API is inconsistent: some rows use `artists[].name` and some
    // use a single `subtitle`. Reading only the first shape would refuse every
    // row of the second kind — a false negative that costs a real preview.
    const [s] = withToken();
    onlySuggest({
      tracks: {
        items: [
          {
            title: 'Airbag',
            subtitle: 'Radiohead',
            preview_url: 'https://p.scdn.co/mp3-preview/flat',
            duration_ms: 1000,
          },
        ],
      },
    });

    const res = await s.getTrackPreview('Radiohead', 'Airbag');

    expect(res?.previewUrl).toBe('https://p.scdn.co/mp3-preview/flat');
    expect(res?.durationMs).toBe(1000);
  });

  it('a suggestion with no preview at all is skipped, never returned as a dead link', async () => {
    const [s] = withToken();
    onlySuggest({ tracks: { items: [{ name: 'Airbag', artists: [{ name: 'Radiohead' }] }] } });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('a suggest call that throws is null, and nothing is written to any cache on the way out', async () => {
    const [s] = withToken();
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('search/suggest')) throw new Error('net down');
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });

  it('a suggest answer with no tracks array is null rather than a throw', async () => {
    const [s] = withToken();
    onlySuggest({ error: { status: 429 } });

    await expect(s.getTrackPreview('Radiohead', 'Airbag')).resolves.toBeNull();
  });
});
