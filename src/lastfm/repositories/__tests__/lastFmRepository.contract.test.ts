import 'reflect-metadata';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import { LastfmApiError } from '@domain/models/errors/lastfmError';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { ICache } from '@domain/interfaces/ports/icache';

/**
 * Contract tests for the repository half of the Last.fm read path.
 *
 * These pin the routing and degradation rules the class itself owns: which
 * method is called, whether the call is signed, what reaches the cache, and
 * what a failure returns. Converter output is asserted only where the
 * repository makes a decision about it.
 *
 * Fixtures follow the captured shapes in `lastFmRepository.recentTracks.test.ts`
 * (AGENTS.md section 11): every count is a STRING, `artist` may arrive as a bare
 * string, and a one-entry list arrives unwrapped.
 *
 * WHAT A FAILURE MEANS, PINNED BOTH WAYS. These tests used to say "returns null
 * rather than throwing when the call fails" and threw a bare `Error`. That
 * pinned the defect: a Last.fm 5xx and a deleted account produced the same
 * `null`, so the bot told users their friend had been removed whenever
 * Last.fm had a bad minute. A "not found" code is a real answer and is
 * returned; anything else raises `LastFmUnavailableError`. Both directions are
 * asserted below, because a test that only checks the happy half cannot tell
 * the fix from the bug.
 */

/**
 * A genuine "this does not exist" answer, which IS a real result and must
 * still come back as the empty list. The code is a parameter because all three
 * of 6/7/8 have to keep working after the raise went in, and only exercising
 * 6 would let a `=== 6` predicate through.
 */
const notFound = (code: number = 6): LastfmApiError => new LastfmApiError(code, 'User not found');


const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

const userPayload = (over: Record<string, unknown> = {}) => ({
  user: {
    name: 'DreadRock',
    realname: 'Real Name',
    country: 'UK',
    playcount: '11361',
    registered: { unixtime: '1037793040' },
    artist_count: '1201',
    album_count: '340',
    track_count: '9800',
    image: [
      { size: 'small', '#text': `https://lastfm-img.freetls.fastly.net/i/u/34s/${PLACEHOLDER}.png` },
      { size: 'extralarge', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/300x300/user.png' },
    ],
    ...over,
  },
});

const recentEnvelope = (tracks: unknown, attr: Record<string, unknown> = {}) => ({
  recenttracks: {
    '@attr': { user: 'DreadRock', total: '11361', page: '1', perPage: '3', totalPages: '3787', ...attr },
    track: tracks,
  },
});

const lfmTrack = (over: Record<string, unknown> = {}) => ({
  name: 'Fine Without You',
  artist: { mbid: '477b8c0c', '#text': 'Armin van Buuren' },
  album: { mbid: '', '#text': 'Dream Dance Vol.48' },
  url: 'https://www.last.fm/music/Armin+van+Buuren/_/Fine+Without+You',
  mbid: 'c1945b02',
  date: { uts: '1287702031', '#text': '21 Oct 2010, 23:00' },
  image: [
    { size: 'extralarge', '#text': `https://lastfm-img.freetls.fastly.net/i/u/300x300/${PLACEHOLDER}.png` },
    { size: 'small', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/34s/real-small.png' },
  ],
  ...over,
});

/** A cache double backed by a Map, so a test can assert what was written. */
const makeCache = (initial: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(initial));
  const cache: ICache = {
    get: vi.fn(async (key: string) => (store.has(key) ? (store.get(key) as never) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
  return { cache, store };
};

type Responder = (method: string, params: Record<string, string>) => unknown;

const makeRepo = (responder: Responder, cache?: ICache) => {
  const api = {
    call: vi.fn(async (method: string, params: Record<string, string> = {}) => responder(method, params)),
    callSigned: vi.fn(async (method: string, params: Record<string, string> = {}) => responder(method, params)),
  };
  return { repo: new LastFmRepository(api as never, cache), api };
};

describe('LastFmRepository auth', () => {
  it('returns the token from a signed auth.gettoken', async () => {
    const { repo, api } = makeRepo(() => ({ token: 'TOKEN123' }));
    await expect(repo.getAuthToken()).resolves.toBe('TOKEN123');
    expect(api.callSigned).toHaveBeenCalledWith('auth.gettoken');
  });

  it('returns null when the response carries no token', async () => {
    const { repo } = makeRepo(() => ({}));
    await expect(repo.getAuthToken()).resolves.toBeNull();
  });

  it('returns null rather than throwing when the call fails', async () => {
    const { repo } = makeRepo(() => {
      throw new Error('lastfm down');
    });
    await expect(repo.getAuthToken()).resolves.toBeNull();
  });

  it('returns the session name and key from a signed auth.getsession', async () => {
    const { repo, api } = makeRepo(() => ({ session: { name: 'DreadRock', key: 'SK' } }));
    await expect(repo.getAuthSession('TOKEN123')).resolves.toEqual({ name: 'DreadRock', key: 'SK' });
    expect(api.callSigned).toHaveBeenCalledWith('auth.getsession', { token: 'TOKEN123' });
  });

  it.each([
    ['a missing session object', {}],
    ['a session with no key', { session: { name: 'DreadRock' } }],
    ['a session with an empty key', { session: { name: 'DreadRock', key: '' } }],
  ])('returns null for %s', async (_label, payload) => {
    const { repo } = makeRepo(() => payload);
    await expect(repo.getAuthSession('TOKEN123')).resolves.toBeNull();
  });

  it('returns null rather than throwing when the session call fails', async () => {
    const { repo } = makeRepo(() => {
      throw new Error('bad token');
    });
    await expect(repo.getAuthSession('TOKEN123')).resolves.toBeNull();
  });
});

describe('LastFmRepository.getUserInfo', () => {
  it('converts a captured user payload', async () => {
    const { repo, api } = makeRepo(() => userPayload());
    const user = await repo.getUserInfo('DreadRock');
    expect(user?.name).toBe('DreadRock');
    expect(user?.playCount).toBe(11361);
    expect(api.call).toHaveBeenCalledWith('user.getinfo', { user: 'DreadRock' });
  });

  it('treats the literal country "None" as absent', async () => {
    // Last.fm sends the STRING "None", not null. Truthiness would keep it.
    const { repo } = makeRepo(() => userPayload({ country: 'None' }));
    const user = await repo.getUserInfo('DreadRock');
    expect(user?.country).toBeUndefined();
  });

  it('returns null when Last.fm says the user does not exist', async () => {
    const { repo } = makeRepo(() => {
      throw notFound();
    });
    await expect(repo.getUserInfo('ghost')).resolves.toBeNull();
  });

  it('raises rather than reporting a deleted user when Last.fm is merely down', async () => {
    // The single worst case in the repo: a timeout used to return null, and
    // every caller read that as "this account no longer exists".
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
    });
    await expect(repo.getUserInfo('DreadRock')).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});

describe('LastFmRepository.getUserRecentTracksWithMetadata', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the paging metadata alongside the converted tracks', async () => {
    const { repo } = makeRepo(() => recentEnvelope([lfmTrack()], { totalPages: '42', total: '900' }));
    const result = await repo.getUserRecentTracksWithMetadata('DreadRock', 3, 2);
    expect(result.totalPages).toBe(42);
    expect(result.totalScrobbles).toBe(900);
    expect(result.tracks).toHaveLength(1);
  });

  it('sends from and sk only when both are supplied', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([]));
    await repo.getUserRecentTracksWithMetadata('DreadRock', 5, 1, 1287702031, 'SK');
    expect(api.callSigned).toHaveBeenCalledWith(
      'user.getrecenttracks',
      { user: 'DreadRock', limit: '5', page: '1', from: '1287702031', sk: 'SK' },
      'GET',
    );
  });

  it('uses the unsigned call when there is no session key', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([]));
    await repo.getUserRecentTracksWithMetadata('DreadRock');
    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '10', page: '1',
    });
  });

  it('returns an empty list when the response has no recenttracks envelope', async () => {
    // Last.fm returns `{ error: 8 }` with HTTP 200, so this is a real shape.
    const { repo } = makeRepo(() => ({ error: 8, message: 'no recent tracks' }));
    await expect(repo.getUserRecentTracksWithMetadata('DreadRock')).resolves.toEqual({
      tracks: [], totalPages: 0, totalScrobbles: 0,
    });
  });

  it('retries a transient failure and returns the eventual success', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { repo, api } = makeRepo(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('timeout');
      }
      return recentEnvelope([lfmTrack()]);
    });

    const pending = repo.getUserRecentTracksWithMetadata('DreadRock', 1, 1, undefined, undefined, 1);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(result.tracks).toHaveLength(1);
  });

  it('throws Unavailable once retries exhaust instead of empty impersonating genuine', async () => {
    const { repo, api } = makeRepo(() => {
      throw new Error('error 6');
    });
    await expect(
      repo.getUserRecentTracksWithMetadata('DreadRock', 1, 1, undefined, undefined, 0),
    ).rejects.toBeInstanceOf(LastFmUnavailableError);
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('returns empty for genuine total=0 rather than throwing', async () => {
    const { repo } = makeRepo(() => recentEnvelope([], { total: '0', totalPages: '0' }));
    await expect(
      repo.getUserRecentTracksWithMetadata('DreadRock', 1, 1, undefined, undefined, 0),
    ).resolves.toEqual({ tracks: [], totalPages: 0, totalScrobbles: 0 });
  });

  it('clamps limit/page so caller bugs cannot produce 400{error:6}', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([]));
    await repo.getUserRecentTracksWithMetadata('DreadRock', 0, -3, undefined, undefined, 0);
    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '1', page: '1',
    });
    await repo.getUserRecentTracksWithMetadata('DreadRock', 5000, 1, undefined, undefined, 0);
    const params = (api.call as unknown as { mock: { calls: Array<Array<Record<string, string>>> } }).mock.calls[1]?.[1];
    expect(params?.limit).toBe('1000');
  });

  it('surfaces code 26 distinct from generic Unavailable', async () => {
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(26, 'Suspended API key');
    });
    const err = await repo.getUserRecentTracksWithMetadata('DreadRock', 1, 1, undefined, undefined, 0).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LastfmApiError);
    expect((err as LastfmApiError).code).toBe(26);
  });
});

describe('LastFmRepository info lookups', () => {
  it('omits username from artist.getinfo when it was not supplied', async () => {
    const { repo, api } = makeRepo(() => ({
      artist: { name: 'Mond', stats: { listeners: '100', playcount: '200' } },
    }));
    const info = await repo.getArtistInfo('Mond');
    expect(api.call).toHaveBeenCalledWith('artist.getinfo', { artist: 'Mond' });
    expect(info?.name).toBe('Mond');
  });

  it('passes username through when supplied', async () => {
    const { repo, api } = makeRepo(() => ({
      artist: { name: 'Mond', stats: { listeners: '1', playcount: '2' } },
    }));
    await repo.getArtistInfo('Mond', 'DreadRock');
    expect(api.call).toHaveBeenCalledWith('artist.getinfo', { artist: 'Mond', username: 'DreadRock' });
  });

  it('strips HTML from an artist bio summary', async () => {
    const { repo } = makeRepo(() => ({
      artist: {
        name: 'Mond',
        stats: { listeners: '1', playcount: '2' },
        bio: { summary: '<a href="/tags/ambient">Ambient</a> is a genre' },
      },
    }));
    const info = await repo.getArtistInfo('Mond');
    expect(info?.summary).toBe('Ambient is a genre');
  });

  it('reads album.getinfo and keeps the duration, which that method reports in seconds', async () => {
    // MEASURED against the live API, not assumed. `album.getinfo` returns
    // duration 284 (a NUMBER, already seconds) while `track.getinfo` returns
    // "284000" (a STRING, milliseconds). infoConverter divides only on the
    // track path, so both are correct - making them uniform would break one.
    const { repo, api } = makeRepo(() => ({
      album: {
        name: 'OK Computer',
        artist: 'Radiohead',
        playcount: '99',
        tracks: { track: [{ name: 'Airbag', duration: 284 }] },
      },
    }));
    const info = await repo.getAlbumInfo('Radiohead', 'OK Computer');
    expect(api.call).toHaveBeenCalledWith('album.getinfo', {
      artist: 'Radiohead', album: 'OK Computer',
    });
    expect(info?.tracks?.[0]?.durationSeconds).toBe(284);
  });

  it('accepts a single album track arriving unwrapped', async () => {
    const { repo } = makeRepo(() => ({
      album: { name: 'One', artist: 'A', tracks: { track: { name: 'Only' } } },
    }));
    const info = await repo.getAlbumInfo('A', 'One');
    expect(info?.tracks).toHaveLength(1);
  });

  it('leaves tracks undefined for an album with no track list', async () => {
    const { repo } = makeRepo(() => ({ album: { name: 'Empty', artist: 'A' } }));
    const info = await repo.getAlbumInfo('A', 'Empty');
    expect(info?.tracks).toBeUndefined();
  });

  it('reads track.getinfo and converts the ms duration to seconds', async () => {
    const { repo, api } = makeRepo(() => ({
      track: { name: 'Fine Without You', artist: { name: 'Armin van Buuren' }, duration: '210000' },
    }));
    const info = await repo.getTrackInfo('Fine Without You', 'Armin van Buuren');
    expect(api.call).toHaveBeenCalledWith('track.getinfo', {
      track: 'Fine Without You', artist: 'Armin van Buuren',
    });
    expect(info?.durationSeconds).toBe(210);
  });

  it('drops a zero duration, which Last.fm reports for a live broadcast', async () => {
    const { repo } = makeRepo(() => ({
      track: { name: 'Live Set', artist: { name: 'A' }, duration: '0' },
    }));
    const info = await repo.getTrackInfo('Live Set', 'A');
    expect(info?.durationSeconds).toBeUndefined();
  });

  it.each([
    ['getArtistInfo', (r: LastFmRepository) => r.getArtistInfo('Mond')],
    ['getAlbumInfo', (r: LastFmRepository) => r.getAlbumInfo('A', 'B')],
    ['getTrackInfo', (r: LastFmRepository) => r.getTrackInfo('T', 'A')],
  ])('%s returns null when Last.fm says "not found"', async (_label, invoke) => {
    const { repo } = makeRepo(() => {
      throw notFound();
    });
    await expect(invoke(repo)).resolves.toBeNull();
  });

  it.each([
    ['getArtistInfo', (r: LastFmRepository) => r.getArtistInfo('Mond')],
    ['getAlbumInfo', (r: LastFmRepository) => r.getAlbumInfo('A', 'B')],
    ['getTrackInfo', (r: LastFmRepository) => r.getTrackInfo('T', 'A')],
  ])('%s raises rather than pretending the artist does not exist', async (_label, invoke) => {
    // The load-bearing half. A 5xx here used to return null, and every caller
    // read that as "this artist/album/track is not in Last.fm".
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
    });
    await expect(invoke(repo)).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});

describe('LastFmRepository search', () => {
  it('maps artist.search listeners onto the playcount field', async () => {
    const { repo, api } = makeRepo(() => ({
      results: { artistmatches: { artist: [{ name: 'Mond', listeners: '4321', mbid: 'abc' }] } },
    }));
    const results = await repo.searchArtists('mond');
    expect(api.call).toHaveBeenCalledWith('artist.search', { artist: 'mond' });
    expect(results[0]).toEqual({ name: 'Mond', playcount: 4321, mbid: 'abc', url: undefined });
  });

  it('wraps a single artist match, which Last.fm sends unwrapped', async () => {
    const { repo } = makeRepo(() => ({
      results: { artistmatches: { artist: { name: 'Only', listeners: '1' } } },
    }));
    const results = await repo.searchArtists('only');
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('Only');
  });

  it('reports zero playcount when the match has no listeners field', async () => {
    const { repo } = makeRepo(() => ({ results: { artistmatches: { artist: [{ name: 'Obscure' }] } } }));
    const results = await repo.searchArtists('obscure');
    expect(results[0]?.playcount).toBe(0);
  });

  it('returns an empty list when artistmatches is absent', async () => {
    const { repo } = makeRepo(() => ({ results: {} }));
    await expect(repo.searchArtists('nothing')).resolves.toEqual([]);
  });

  it('maps album.search and reads the artist off a single unwrapped match', async () => {
    const { repo, api } = makeRepo(() => ({
      results: { albummatches: { album: { name: 'Only Album', artist: 'Only Artist' } } },
    }));
    const results = await repo.searchAlbums('only');
    expect(api.call).toHaveBeenCalledWith('album.search', { album: 'only' });
    expect(results[0]?.artistName).toBe('Only Artist');
    expect(results[0]?.playcount).toBe(0);
  });

  it('maps track.search and defaults a missing artist to an empty string', async () => {
    const { repo, api } = makeRepo(() => ({
      results: { trackmatches: { track: [{ name: 'Untitled' }] } },
    }));
    const results = await repo.searchTracks('untitled');
    expect(api.call).toHaveBeenCalledWith('track.search', { track: 'untitled' });
    expect(results[0]?.artistName).toBe('');
  });

  it.each([
    ['searchArtists', (r: LastFmRepository) => r.searchArtists('x')],
    ['searchAlbums', (r: LastFmRepository) => r.searchAlbums('x')],
    ['searchTracks', (r: LastFmRepository) => r.searchTracks('x')],
  ])('%s returns an empty list when Last.fm says "not found"', async (_label, invoke) => {
    const { repo } = makeRepo(() => {
      throw notFound();
    });
    await expect(invoke(repo)).resolves.toEqual([]);
  });

  it.each([
    ['searchArtists', (r: LastFmRepository) => r.searchArtists('x')],
    ['searchAlbums', (r: LastFmRepository) => r.searchAlbums('x')],
    ['searchTracks', (r: LastFmRepository) => r.searchTracks('x')],
  ])('%s raises rather than returning an empty search that looks like a real answer', async (_label, invoke) => {
    const { repo } = makeRepo(() => {
      // A 5xx-shaped code, not 6/7/8. Codes 6-8 are genuine "no such thing"
      // answers and correctly return []; anything else is Last.fm failing.
      throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
    });
    // An empty search box is indistinguishable from "nothing matches", which is
    // what a user reads when Last.fm is down rather than when it has no data.
    await expect(invoke(repo)).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});

describe('LastFmRepository.getUserFriends', () => {
  it('converts an array of friends', async () => {
    const { repo, api } = makeRepo(() => ({ friends: { user: [userPayload().user] } }));
    const friends = await repo.getUserFriends('DreadRock', 20, 2);
    expect(api.call).toHaveBeenCalledWith('user.getfriends', {
      user: 'DreadRock', limit: '20', page: '2',
    });
    expect(friends).toHaveLength(1);
    expect(friends[0]?.name).toBe('DreadRock');
  });

  it('wraps a single friend, which arrives unwrapped', async () => {
    const { repo } = makeRepo(() => ({ friends: { user: userPayload().user } }));
    const friends = await repo.getUserFriends('DreadRock');
    expect(friends).toHaveLength(1);
  });

  it('returns an empty list when the friends key is absent', async () => {
    const { repo } = makeRepo(() => ({}));
    await expect(repo.getUserFriends('DreadRock')).resolves.toEqual([]);
  });

  it('returns an empty list when Last.fm says the user does not exist', async () => {
    const { repo } = makeRepo(() => {
      throw notFound();
    });
    await expect(repo.getUserFriends('DreadRock')).resolves.toEqual([]);
  });

  it('raises rather than claiming the user has no friends when Last.fm is down', async () => {
    // An empty friend list is what a user with zero friends looks like.
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
    });
    await expect(repo.getUserFriends('DreadRock')).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});

const topArtistsPayload = (names: string[]) => ({
  topartists: {
    '@attr': { user: 'DreadRock', total: '900', page: '1', perPage: '3', totalPages: '300' },
    artist: names.map((name, i) => ({ name, playcount: String(100 - i), mbid: `mbid${i}` })),
  },
});

const topAlbumsPayload = (items: Array<{ name: string; artist: string }>) => ({
  topalbums: {
    '@attr': { user: 'DreadRock', total: '300', page: '1', perPage: '3', totalPages: '100' },
    album: items.map((it, i) => ({ ...it, playcount: String(50 - i) })),
  },
});

const topTracksPayload = (items: Array<{ name: string; artist: string }>) => ({
  toptracks: {
    '@attr': { user: 'DreadRock', total: '300', page: '1', perPage: '3', totalPages: '100' },
    track: items.map((it, i) => ({ ...it, playcount: String(40 - i) })),
  },
});

const weeklyArtistsPayload = (names: string[]) => ({
  weeklyartistchart: {
    '@attr': { user: 'DreadRock' },
    artist: names.map((name, i) => ({ name, playcount: String(10 - i) })),
  },
});

describe('LastFmRepository top lists: period routing and cache', () => {
  it('uses the period endpoint and sends the mapped Last.fm period', async () => {
    const { repo, api } = makeRepo(() => topArtistsPayload(['Mond']));
    await repo.getTopArtists('DreadRock', TimePeriod.Weekly, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.gettopartists', {
      user: 'DreadRock', period: '7day', limit: '10', page: '1',
    });
  });

  it('caches a non-empty result under a period-scoped key', async () => {
    const { cache } = makeCache();
    const { repo } = makeRepo(() => topArtistsPayload(['Mond', 'Tycho']), cache);
    await repo.getTopArtists('DreadRock', TimePeriod.Monthly, 10, 1);
    expect(cache.set).toHaveBeenCalledWith(
      'lfm:topartists:dreadrock:Monthly:10:1',
      expect.arrayContaining([expect.objectContaining({ name: 'Mond' })]),
      120,
    );
  });

  it('serves a cached list without calling the API at all', async () => {
    const cached = [{ name: 'Cached Artist', playcount: 999 }];
    const { cache } = makeCache({ 'lfm:topartists:dreadrock:AllTime:10:1': cached });
    const { repo, api } = makeRepo(() => topArtistsPayload(['Live']), cache);
    const result = await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(result).toEqual(cached);
    expect(api.call).not.toHaveBeenCalled();
  });

  it('does not cache an empty result, or a user with no plays would cache a miss', async () => {
    const { cache } = makeCache();
    const { repo } = makeRepo(() => ({ topartists: { '@attr': {}, artist: [] } }), cache);
    await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('skips the cache entirely when a session key is present', async () => {
    // A session makes the response user-specific, so a shared key would leak
    // one viewer result into another.
    const { cache } = makeCache();
    const { repo, api } = makeRepo(() => topArtistsPayload(['Mond']), cache);
    await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1, 'SK');
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(api.callSigned).toHaveBeenCalledWith(
      'user.gettopartists', expect.objectContaining({ sk: 'SK' }), 'GET',
    );
  });
});

describe('LastFmRepository weekly chart routing', () => {
  it('routes Daily to the weekly chart endpoint', async () => {
    const { repo, api } = makeRepo(() => weeklyArtistsPayload(['Mond']));
    await repo.getTopArtists('DreadRock', TimePeriod.Daily, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.getweeklyartistchart', expect.anything());
  });

  it('routes an explicit from/to range to the weekly chart endpoint', async () => {
    const { repo, api } = makeRepo(() => weeklyArtistsPayload(['Mond']));
    await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1, undefined, 1000, 2000);
    expect(api.call).toHaveBeenCalledWith('user.getweeklyartistchart', {
      user: 'DreadRock', from: '1000', to: '2000', limit: '10',
    });
  });

  it('truncates a weekly chart to the requested count', async () => {
    // The chart endpoint returns up to 50 regardless of limit, so the slice
    // is the only thing honouring a smaller ask.
    const { repo } = makeRepo(() => weeklyArtistsPayload(['A', 'B', 'C', 'D']));
    const result = await repo.getTopArtists('DreadRock', TimePeriod.Daily, 2, 1);
    expect(result).toHaveLength(2);
  });

  it('defaults a Daily range to the last 24 hours when no bounds are given', async () => {
    const { repo, api } = makeRepo(() => weeklyArtistsPayload(['Mond']));
    await repo.getTopArtists('DreadRock', TimePeriod.Daily, 10, 1);
    const params = api.call.mock.calls[0]?.[1] as Record<string, string>;
    expect(Number(params.to) - Number(params.from)).toBe(86400);
  });

  it('caches a weekly chart under a range-scoped key', async () => {
    const { cache } = makeCache();
    const { repo } = makeRepo(() => weeklyArtistsPayload(['Mond']), cache);
    await repo.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1, undefined, 1000, 2000);
    expect(cache.set).toHaveBeenCalledWith('lfm:weeklyartists:dreadrock:1000:2000:10', expect.any(Array), 120);
  });
});


describe('LastFmRepository top albums and tracks', () => {
  it('maps the artist onto each top album', async () => {
    const { repo, api } = makeRepo(() =>
      topAlbumsPayload([{ name: 'Dream Dance', artist: 'Armin van Buuren' }]),
    );
    const albums = await repo.getTopAlbums('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.gettopalbums', expect.objectContaining({ period: 'overall' }));
    expect(albums[0]?.artistName).toBe('Armin van Buuren');
  });

  it('routes Daily albums to the weekly album chart', async () => {
    const { repo, api } = makeRepo(() => ({
      weeklyalbumchart: { album: [{ name: 'Weekly Album', artist: 'A', playcount: '5' }] },
    }));
    await repo.getTopAlbums('DreadRock', TimePeriod.Daily, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.getweeklyalbumchart', expect.anything());
  });

  it('truncates a weekly album chart to the requested count', async () => {
    const { repo } = makeRepo(() => ({
      weeklyalbumchart: {
        album: [
          { name: 'A', artist: 'X', playcount: '3' },
          { name: 'B', artist: 'X', playcount: '2' },
          { name: 'C', artist: 'X', playcount: '1' },
        ],
      },
    }));
    await expect(repo.getTopAlbums('DreadRock', TimePeriod.Daily, 2, 1)).resolves.toHaveLength(2);
  });

  it('caches a non-empty album result', async () => {
    const { cache } = makeCache();
    const { repo } = makeRepo(() => topAlbumsPayload([{ name: 'A', artist: 'B' }]), cache);
    await repo.getTopAlbums('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(cache.set).toHaveBeenCalledWith('lfm:topalbums:dreadrock:AllTime:10:1', expect.any(Array), 120);
  });

  it('maps the artist onto each top track', async () => {
    const { repo, api } = makeRepo(() =>
      topTracksPayload([{ name: 'Fine Without You', artist: 'Armin van Buuren' }]),
    );
    const tracks = await repo.getTopTracks('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.gettoptracks', expect.objectContaining({ period: 'overall' }));
    expect(tracks[0]?.artistName).toBe('Armin van Buuren');
  });

  it('routes Daily tracks to the weekly track chart', async () => {
    const { repo, api } = makeRepo(() => ({
      weeklytrackchart: { track: [{ name: 'Weekly Track', artist: 'A', playcount: '5' }] },
    }));
    await repo.getTopTracks('DreadRock', TimePeriod.Daily, 10, 1);
    expect(api.call).toHaveBeenCalledWith('user.getweeklytrackchart', expect.anything());
  });

  it('caches a non-empty track result', async () => {
    const { cache } = makeCache();
    const { repo } = makeRepo(() => topTracksPayload([{ name: 'T', artist: 'A' }]), cache);
    await repo.getTopTracks('DreadRock', TimePeriod.AllTime, 10, 1);
    expect(cache.set).toHaveBeenCalledWith('lfm:toptracks:dreadrock:AllTime:10:1', expect.any(Array), 120);
  });
});

/**
 * A failed top-list read used to `Logger.warn` and `return []`, which rendered
 * a Last.fm 5xx as a confident claim about a person's listening history. There
 * are ~43 production call sites behind these three methods, and none of them
 * can tell an outage from a genuine empty library when both arrive as `[]`.
 *
 * BOTH DIRECTIONS, over all SIX catch sites. One assertion is not enough in
 * either direction: a raise-only test passes just as happily against a method
 * that always throws, and an empty-only test passes against the bug it replaces.
 * The pair is the fix; either half alone is one of the two wrongs.
 */
describe('LastFmRepository top lists: a failed read is not an empty library', () => {
  /**
   * Every catch site, one row each: the label, the not-found code it is
   * exercised with (6/7/8 all have to keep working), the transport failure, and
   * the real Last.fm method name that must appear on the raised error.
   *
   * The `method` column is a test in its own right. All six sites call the same
   * helper, so a wrong method string is invisible to a raise-only assertion -
   * yet `user.gettopalbums` and `user.getweeklyalbumchart` are what a Railway
   * log is read to find, and a transposed pair would send an operator to the
   * wrong endpoint.
   */
  const CASES: Array<{
    label: string;
    notFoundCode: number;
    method: string;
    invoke: (r: LastFmRepository) => Promise<unknown>;
  }> = [
    {
      label: 'getTopArtists/period',
      notFoundCode: 6,
      method: 'user.gettopartists',
      invoke: (r) => r.getTopArtists('DreadRock', TimePeriod.AllTime, 10, 1),
    },
    {
      label: 'getTopArtists/weekly',
      notFoundCode: 7,
      method: 'user.getweeklyartistchart',
      invoke: (r) => r.getTopArtists('DreadRock', TimePeriod.Daily, 10, 1),
    },
    {
      label: 'getTopAlbums/period',
      notFoundCode: 7,
      method: 'user.gettopalbums',
      invoke: (r) => r.getTopAlbums('DreadRock', TimePeriod.AllTime, 10, 1),
    },
    {
      label: 'getTopAlbums/weekly',
      notFoundCode: 8,
      method: 'user.getweeklyalbumchart',
      invoke: (r) => r.getTopAlbums('DreadRock', TimePeriod.Daily, 10, 1),
    },
    {
      label: 'getTopTracks/period',
      notFoundCode: 8,
      method: 'user.gettoptracks',
      invoke: (r) => r.getTopTracks('DreadRock', TimePeriod.AllTime, 10, 1),
    },
    {
      label: 'getTopTracks/weekly',
      notFoundCode: 6,
      method: 'user.getweeklytrackchart',
      invoke: (r) => r.getTopTracks('DreadRock', TimePeriod.Daily, 10, 1),
    },
  ];

  it.each(CASES)('$label still returns the empty answer for not-found code $notFoundCode', async ({ notFoundCode, invoke }) => {
    // "This user has no top artists" is a real answer when Last.fm says so.
    const { repo } = makeRepo(() => {
      throw notFound(notFoundCode);
    });
    await expect(invoke(repo)).resolves.toEqual([]);
  });

  it.each(CASES)('$label raises rather than reporting an empty library when Last.fm times out', async ({ method, invoke }) => {
    // The synthetic -1 `lastfmApi` raises for a network error or timeout. The
    // transport-failure half of the pair: a user must be able to tell this from
    // an empty library, and only a raise can tell them.
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
    });
    const err = await invoke(repo).then(() => null, (e: unknown) => e);
    expect(err, `${method} resolved instead of raising`).toBeInstanceOf(LastFmUnavailableError);
    expect((err as LastFmUnavailableError).method).toBe(method);
  });

  it.each(CASES)('$label raises on a 5xx, which is not a not-found code', async ({ invoke }) => {
    // The other realistic transport shape. `lastfmApi` throws
    // `LastfmApiError(response.status, ...)` once its retries are exhausted, so
    // the code is the HTTP status - 500 is not in NOT_FOUND_CODES and must not
    // be treated as a definitive "you have nothing".
    const { repo } = makeRepo(() => {
      throw new LastfmApiError(500, 'Last.fm returned HTTP 500');
    });
    await expect(invoke(repo)).rejects.toBeInstanceOf(LastFmUnavailableError);
  });

  it.each(CASES)('$label raises for a non-Lastfm failure too', async ({ invoke }) => {
    // The original three tests threw a bare `Error`, so a predicate that only
    // understood `LastfmApiError` would pass every raise assertion above while
    // still swallowing a thrown TypeError from the converter.
    const { repo } = makeRepo(() => {
      throw new Error('boom');
    });
    await expect(invoke(repo)).rejects.toBeInstanceOf(LastFmUnavailableError);
  });
});


describe('LastFmRepository.getScrobbleCountFromDate', () => {
  it('parses the total out of the response envelope', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([], { total: '4321' }));
    await expect(repo.getScrobbleCountFromDate('DreadRock')).resolves.toBe(4321);
    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '1', extended: '1',
    });
  });

  it('sends from, to and sk only when supplied', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([], { total: '5' }));
    await repo.getScrobbleCountFromDate('DreadRock', 1000, 'SK', 2000);
    expect(api.callSigned).toHaveBeenCalledWith(
      'user.getrecenttracks',
      { user: 'DreadRock', limit: '1', extended: '1', from: '1000', to: '2000', sk: 'SK' },
      'GET',
    );
  });

  it('treats a null from as absent rather than sending the string "null"', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([], { total: '5' }));
    await repo.getScrobbleCountFromDate('DreadRock', null, null, null);
    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '1', extended: '1',
    });
  });

  it('returns null when the envelope carries no total', async () => {
    // An explicit envelope with no @attr at all, which is the case that
    // distinguishes "absent" from "zero". The shared fixture supplies a
    // default total, so reusing it here would assert the wrong thing.
    const { repo } = makeRepo(() => ({ recenttracks: { '@attr': {}, track: [] } }));
    await expect(repo.getScrobbleCountFromDate('DreadRock')).resolves.toBeNull();
  });

  it('reads a total of "0" as a real count rather than as absent', async () => {
    const { repo } = makeRepo(() => recentEnvelope([], { total: '0' }));
    await expect(repo.getScrobbleCountFromDate('DreadRock')).resolves.toBe(0);
  });

  it('returns null rather than throwing when the call fails', async () => {
    const { repo } = makeRepo(() => {
      throw new Error('error 6');
    });
    await expect(repo.getScrobbleCountFromDate('ghost')).resolves.toBeNull();
  });
});

describe('LastFmRepository.getMilestoneScrobble', () => {
  it('derives the page that holds the milestone scrobble', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([lfmTrack()]));
    const track = await repo.getMilestoneScrobble('DreadRock', null, 1000, 100);
    expect(api.call).toHaveBeenCalledWith('user.getrecenttracks', {
      user: 'DreadRock', limit: '1', extended: '1', page: '901',
    });
    expect(track?.name).toBe('Fine Without You');
  });

  it('refuses a milestone beyond the history without calling the API', async () => {
    // total 100, milestone 200 => page -99. Asking for it would be nonsense.
    const { repo, api } = makeRepo(() => recentEnvelope([lfmTrack()]));
    await expect(repo.getMilestoneScrobble('DreadRock', null, 100, 200)).resolves.toBeNull();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('refuses page 0, which is the boundary a looser guard would let through', async () => {
    // total 100, milestone 101 => page 0. Last.fm pages are 1-indexed, so a
    // `< -1` guard would happily request page 0 and get the newest scrobble
    // back instead. A far-past milestone test cannot catch this; only 0 can.
    const { repo, api } = makeRepo(() => recentEnvelope([lfmTrack()]));
    await expect(repo.getMilestoneScrobble('DreadRock', null, 100, 101)).resolves.toBeNull();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('refuses page -1, the other side of the boundary', async () => {
    const { repo, api } = makeRepo(() => recentEnvelope([lfmTrack()]));
    await expect(repo.getMilestoneScrobble('DreadRock', null, 100, 102)).resolves.toBeNull();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('skips a nowplaying entry, which is not a scrobble and has no timestamp', async () => {
    const { repo } = makeRepo(() =>
      recentEnvelope([
        lfmTrack({ name: 'Live Set', '@attr': { nowplaying: 'true' } }),
        lfmTrack({ name: 'Real Scrobble' }),
      ]),
    );
    const track = await repo.getMilestoneScrobble('DreadRock', null, 1000, 100);
    expect(track?.name).toBe('Real Scrobble');
  });

  it('returns null when every entry on the page is nowplaying', async () => {
    const { repo } = makeRepo(() => recentEnvelope([lfmTrack({ '@attr': { nowplaying: 'true' } })]));
    await expect(repo.getMilestoneScrobble('DreadRock', null, 1000, 100)).resolves.toBeNull();
  });

  it('returns null when the response carries no track', async () => {
    const { repo } = makeRepo(() => ({ error: 6 }));
    await expect(repo.getMilestoneScrobble('ghost', null, 10, 1)).resolves.toBeNull();
  });

  it('returns null rather than throwing when the call fails', async () => {
    const { repo } = makeRepo(() => {
      throw new Error('error 6');
    });
    await expect(repo.getMilestoneScrobble('ghost', null, 10, 1)).resolves.toBeNull();
  });
});

describe('LastFmRepository loved tracks', () => {
  it('maps a loved track and converts the uts string into a Date', async () => {
    const { repo, api } = makeRepo(() => ({
      lovedtracks: {
        track: [
          {
            name: 'Fine Without You',
            artist: { name: 'Armin van Buuren', mbid: 'm1' },
            date: { uts: '1287702031' },
            mbid: 't1',
            url: 'https://last.fm/track',
            image: [{ size: 'small', '#text': 'a.png' }, { size: 'large', '#text': 'b.png' }],
          },
        ],
        '@attr': { total: '77', totalPages: '4', page: '1', perPage: '20' },
      },
    }));
    const result = await repo.getLovedTracks('DreadRock', 20, 1);
    expect(api.call).toHaveBeenCalledWith('user.getlovedtracks', {
      user: 'DreadRock', limit: '20', page: '1',
    });
    expect(result.total).toBe(77);
    expect(result.tracks[0]?.artistName).toBe('Armin van Buuren');
    expect(result.tracks[0]?.dateLoved?.toISOString()).toBe('2010-10-21T23:00:31.000Z');
  });

  it('accepts a single loved track arriving unwrapped', async () => {
    const { repo } = makeRepo(() => ({
      lovedtracks: { track: { name: 'Only', artist: { name: 'A' } }, '@attr': { total: '1' } },
    }));
    const result = await repo.getLovedTracks('DreadRock');
    expect(result.tracks).toHaveLength(1);
  });

  it('accepts an artist arriving as a bare string', async () => {
    const { repo } = makeRepo(() => ({
      lovedtracks: { track: { name: 'Only', artist: 'String Artist' }, '@attr': { total: '1' } },
    }));
    const result = await repo.getLovedTracks('DreadRock');
    expect(result.tracks[0]?.artistName).toBe('String Artist');
  });

  it('sends the session key when one is supplied', async () => {
    const { repo, api } = makeRepo(() => ({ lovedtracks: { track: { name: 'X', artist: 'A' } } }));
    await repo.getLovedTracks('DreadRock', 5, 2, 'SK');
    expect(api.call).toHaveBeenCalledWith('user.getlovedtracks', {
      user: 'DreadRock', limit: '5', page: '2', sk: 'SK',
    });
  });

  it('returns an empty list and zero total rather than throwing when the call fails', async () => {
    const { repo } = makeRepo(() => {
      throw new Error('error 9');
    });
    await expect(repo.getLovedTracks('DreadRock')).resolves.toEqual({ tracks: [], total: 0 });
  });
});

describe('LastFmRepository signed write actions', () => {
  it('loveTrack posts the artist, track and session key', async () => {
    const { repo, api } = makeRepo(() => ({ status: 'ok' }));
    await expect(repo.loveTrack('A', 'T', 'SK')).resolves.toBe(true);
    expect(api.callSigned).toHaveBeenCalledWith('track.love', { artist: 'A', track: 'T', sk: 'SK' }, 'POST');
  });

  it('unloveTrack posts the artist, track and session key', async () => {
    const { repo, api } = makeRepo(() => ({ status: 'ok' }));
    await expect(repo.unloveTrack('A', 'T', 'SK')).resolves.toBe(true);
    expect(api.callSigned).toHaveBeenCalledWith('track.unlove', { artist: 'A', track: 'T', sk: 'SK' }, 'POST');
  });

  it.each([
    ['loveTrack', (r: LastFmRepository) => r.loveTrack('A', 'T', 'SK')],
    ['unloveTrack', (r: LastFmRepository) => r.unloveTrack('A', 'T', 'SK')],
    ['scrobbleTrack', (r: LastFmRepository) => r.scrobbleTrack('A', 'T', 1, 'SK')],
  ])('%s reports false rather than throwing when the write fails', async (_label, invoke) => {
    const { repo } = makeRepo(() => {
      throw new Error('session expired');
    });
    await expect(invoke(repo)).resolves.toBe(false);
  });

  it('scrobbleTrack posts the timestamp as a string', async () => {
    const { repo, api } = makeRepo(() => ({ scrobbles: {} }));
    await expect(repo.scrobbleTrack('A', 'T', 1287702031, 'SK')).resolves.toBe(true);
    expect(api.callSigned).toHaveBeenCalledWith(
      'track.scrobble',
      { artist: 'A', track: 'T', timestamp: '1287702031', sk: 'SK' },
      'POST',
    );
  });

  it('includes the album on a scrobble only when supplied', async () => {
    const { repo, api } = makeRepo(() => ({ scrobbles: {} }));
    await repo.scrobbleTrack('A', 'T', 1, 'SK', 'Dream Dance');
    expect(api.callSigned).toHaveBeenCalledWith(
      'track.scrobble',
      { artist: 'A', track: 'T', timestamp: '1', sk: 'SK', album: 'Dream Dance' },
      'POST',
    );
  });
});
