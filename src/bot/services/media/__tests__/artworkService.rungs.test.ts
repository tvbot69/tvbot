import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtworkService } from '@bot/services/media/artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

/**
 * The four provider rungs, rung by rung.
 *
 * `artworkService.test.ts` already covers the negative-cache semantics, the
 * single-flight dedupe, the outage gate and the DB containment. What it does
 * not do is walk the ladder: each of the album, artist and track cascades has
 * five providers plus two "retry with a looser query" escape hatches, and the
 * escaping-hatch rules are the ones that keep producing wrong covers.
 *
 * Two rules run through every block:
 *
 *   1. A result is only accepted when the ARTIST matched. First-result trust is
 *      what gave a same-name artist someone else's record, and the album-only
 *      retries exist specifically for catalogues where the artist name is
 *      transliterated differently - which is also exactly where an unverified
 *      first result is most likely to be wrong.
 *   2. A failure is not an answer. A provider that throws pushes an attempt, and
 *      a run with attempts never writes the `none` marker, so a later lookup
 *      retries instead of believing a cover does not exist.
 *
 * The rate limit is opened through the real static (`noteTransportFailure` x4)
 * rather than a spy, so nothing here leaves an own property on a class.
 */

const memCache = () => {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k) : null),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
  };
};

type AnyRec = Record<string, unknown>;

interface Harness {
  spotify: AnyRec;
  deezer: AnyRec;
  amWeb: AnyRec;
  amSearch: AnyRec;
  artists: AnyRec;
  albums: AnyRec;
  tracks: AnyRec;
  lastfm: AnyRec;
  cache: ReturnType<typeof memCache>;
  service: ArtworkService;
}

const harness = (
  over: {
    spotify?: AnyRec;
    deezer?: AnyRec;
    amWeb?: AnyRec;
    amSearch?: AnyRec;
    artists?: AnyRec;
    albums?: AnyRec;
    tracks?: AnyRec;
    lastfm?: AnyRec;
  } = {},
): Harness => {
  const spotify = {
    searchAlbums: async () => [],
    searchArtists: async () => [],
    searchTracks: async () => [],
    getArtistIdViaTrackSample: async () => null,
    getArtistById: async () => null,
    getTrack: async () => null,
    ...over.spotify,
  };
  const deezer = {
    searchAlbums: async () => [],
    searchArtists: async () => [],
    searchTracks: async () => [],
    ...over.deezer,
  };
  const amWeb = { searchAlbums: async () => [], searchArtists: async () => [], searchSongs: async () => [], ...over.amWeb };
  const amSearch = { searchAlbums: async () => [], searchSongs: async () => [], ...over.amSearch };
  const artists = {
    getArtistByName: async () => null,
    getOrCreateArtist: async () => ({ artistId: 1 }),
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setAppleMusicUrl: async () => undefined,
    ...over.artists,
  };
  const albums = {
    getAlbumByNameAndArtist: async () => null,
    setSpotifyImage: async () => undefined,
    setDeezerImage: async () => undefined,
    setImageUrl: async () => undefined,
    ...over.albums,
  };
  const tracks = {
    getTrackByNameAndArtist: async () => null,
    setSpotifyImage: async () => undefined,
    setImageUrl: async () => undefined,
    ...over.tracks,
  };
  const lastfm = {
    getAlbumInfo: async () => null,
    getArtistInfo: async () => null,
    getTrackInfo: async () => null,
    ...over.lastfm,
  };
  const cache = memCache();
  const service = new ArtworkService(
    spotify as never,
    deezer as never,
    amWeb as never,
    amSearch as never,
    artists as never,
    albums as never,
    tracks as never,
    lastfm as never,
    cache as never,
  );
  return { spotify, deezer, amWeb, amSearch, artists, albums, tracks, lastfm, cache, service };
};

beforeEach(() => SpotifySearchApi.clearRateLimit());
afterEach(() => SpotifySearchApi.clearRateLimit());

describe('album cascade — the database row is checked before any provider', () => {
  /**
   * `findExistingAlbumRow` reads the ARTIST row first and returns null without
   * asking for the album when the artist is unknown, so every "stored album
   * cover" fixture below has to give it an artist row as well.
   */
  const withAlbumRow = (row: AnyRec) => ({
    artists: { getArtistByName: async () => ({ artistId: 4 }) },
    albums: { getAlbumByNameAndArtist: async () => row },
  });

  const freshRow = (over: AnyRec = {}) => ({
    albumId: 9,
    spotifyImageUrl: 'https://img/fresh-spotify.jpg',
    spotifyImageDate: new Date(),
    deezerImageUrl: null,
    lastFmImageUrl: null,
    ...over,
  });

  it('serves a fresh stored Spotify cover without calling any provider', async () => {
    const asked: string[] = [];
    const h = harness({
      spotify: { searchAlbums: async (q: string) => { asked.push(q); return []; } },
      ...withAlbumRow(freshRow()),
    });

    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/fresh-spotify.jpg');
    expect(asked).toEqual([]);
  });

  it('re-caches that cover so the next lookup never touches the database', async () => {
    let probes = 0;
    const h = harness({
      artists: { getArtistByName: async () => ({ artistId: 4 }) },
      albums: {
        getAlbumByNameAndArtist: async () => { probes++; return freshRow(); },
      },
    });
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(h.cache.store.get('art:album:daft punk|homework')).toBe('https://img/fresh-spotify.jpg');

    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(probes).toBe(1);
  });

  it('still uses a STALE stored Spotify cover when the fresh-row shortcut misses', async () => {
    // The 90-day window guards the early return, not the cover itself: below it
    // the row's Spotify URL is still a legitimate fallback, and dropping it
    // would blank cards for long-idle guilds. The point is that no provider is
    // consulted - the row answered.
    const asked: string[] = [];
    const h = harness({
      spotify: { searchAlbums: async (q: string) => { asked.push(q); return []; } },
      ...withAlbumRow(freshRow({ spotifyImageDate: new Date(Date.now() - 120 * 24 * 3600 * 1000) })),
    });

    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/fresh-spotify.jpg');
    expect(asked).toEqual([]);
  });

  it('prefers a stored Deezer cover over a stored Last.fm cover', async () => {
    const h = harness({
      ...withAlbumRow(freshRow({ spotifyImageUrl: null, deezerImageUrl: 'https://img/deezer.jpg', lastFmImageUrl: 'https://img/lfm.jpg' })),
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/deezer.jpg');
  });

  it('ignores a stored Last.fm cover that is the placeholder', async () => {
    // The stored URL is what Last.fm gave us when there was no image, so
    // trusting it reproduces the exact 1x1 tile the cascade exists to avoid.
    const h = harness({
      ...withAlbumRow(freshRow({ spotifyImageUrl: null, lastFmImageUrl: 'https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png' })),
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
  });

  it('does not call the album repository when there is no artist row', async () => {
    const h = harness({ albums: { getAlbumByNameAndArtist: async () => { throw new Error('must not be called'); } } });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Nobody')).resolves.toBeNull();
  });
});

describe('album cascade — the Spotify rung and its album-only retry', () => {
  const spAlbum = (name: string, artists: string[], url: string) => ({
    id: 'x', name, uri: 'u', artists: artists.map((n) => ({ name: n })), images: [{ url, height: 640, width: 640 }],
  });

  it('accepts the quoted query result when the artist matches', async () => {
    const h = harness({ spotify: { searchAlbums: async () => [spAlbum('Homework', ['Daft Punk'], 'https://img/sp.jpg')] } });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/sp.jpg');
  });

  it('retries without the artist clause when the quoted query found nothing', async () => {
    const queries: string[] = [];
    const h = harness({
      spotify: {
        searchAlbums: async (q: string) => {
          queries.push(q);
          return queries.length === 1 ? [] : [spAlbum('Homework', ['Daft Punk'], 'https://img/sp.jpg')];
        },
      },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/sp.jpg');
    expect(queries).toEqual(['album:"Homework" artist:"Daft Punk"', 'Homework Daft Punk']);
  });

  it('refuses the album-only retry when the artist does not match', async () => {
    // This is the whole reason the retry verifies the artist. An unverified
    // first result here is how a transliterated query serves a stranger's
    // record cover, and then persists it for 90 days.
    const queries: string[] = [];
    const h = harness({
      spotify: {
        searchAlbums: async (q: string) => {
          queries.push(q);
          return queries.length === 3
            ? [spAlbum('Homework', ['Somebody Else'], 'https://img/wrong.jpg')]
            : [];
        },
      },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
    expect(queries).toEqual([
      'album:"Homework" artist:"Daft Punk"',
      'Homework Daft Punk',
      'Homework',
    ]);
  });

  it('accepts the album-only retry once the artist does match', async () => {
    let call = 0;
    const h = harness({
      spotify: {
        searchAlbums: async () => {
          call++;
          return call === 3 ? [spAlbum('Homework', ['Daft Punk'], 'https://img/retry.jpg')] : [];
        },
      },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/retry.jpg');
  });

  it('persists the Spotify cover only onto an existing album row', async () => {
    const persisted: unknown[][] = [];
    const h = harness({
      spotify: { searchAlbums: async () => [spAlbum('Homework', ['Daft Punk'], 'https://img/sp.jpg')] },
      artists: { getArtistByName: async () => ({ artistId: 4 }) },
      albums: {
        getAlbumByNameAndArtist: async () => ({ albumId: 9, spotifyImageUrl: null, deezerImageUrl: null, lastFmImageUrl: null }),
        setSpotifyImage: async (...args: unknown[]) => { persisted.push(args); },
      },
    });
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(persisted[0]?.[0]).toBe(9);
    expect(persisted[0]?.[1]).toBe('https://img/sp.jpg');
  });

  it('persists nothing when there is no album row to persist onto', async () => {
    const persisted: unknown[][] = [];
    const h = harness({
      spotify: { searchAlbums: async () => [spAlbum('Homework', ['Daft Punk'], 'https://img/sp.jpg')] },
      albums: { setSpotifyImage: async (...args: unknown[]) => { persisted.push(args); } },
    });
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(persisted).toEqual([]);
  });
});

describe('album cascade — the Deezer rung', () => {
  const dzAlbum = (name: string, artist: string, url: string, id = 1) => ({
    id, title: name, cover_xl: url, artist: { id: 1, name: artist },
  });

  it('answers from Deezer when Spotify found nothing', async () => {
    const h = harness({ deezer: { searchAlbums: async () => [dzAlbum('Homework', 'Daft Punk', 'https://dz/x.jpg')] } });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://dz/x.jpg');
  });

  it('falls back to cover_big when there is no cover_xl', async () => {
    const h = harness({
      deezer: {
        searchAlbums: async () => [{ id: 1, title: 'Homework', cover_big: 'https://dz/big.jpg', artist: { id: 1, name: 'Daft Punk' } }],
      },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://dz/big.jpg');
  });

  it('retries album-only and refuses a different artist on that retry', async () => {
    const queries: string[] = [];
    const h = harness({
      deezer: {
        searchAlbums: async (q: string) => {
          queries.push(q);
          return q === 'Homework' ? [dzAlbum('Homework', 'Somebody Else', 'https://dz/wrong.jpg')] : [];
        },
      },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
    expect(queries).toEqual(['album:"Homework" artist:"Daft Punk"', 'Homework Daft Punk', 'Homework']);
  });

  it('persists the Deezer hit with the provider id, which is what the re-fetch needs', async () => {
    const persisted: unknown[][] = [];
    const h = harness({
      deezer: { searchAlbums: async () => [dzAlbum('Homework', 'Daft Punk', 'https://dz/x.jpg', 4242)] },
      artists: { getArtistByName: async () => ({ artistId: 4 }) },
      albums: {
        getAlbumByNameAndArtist: async () => ({ albumId: 9, spotifyImageUrl: null, deezerImageUrl: null, lastFmImageUrl: null }),
        setDeezerImage: async (...args: unknown[]) => { persisted.push(args); },
      },
    });
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(persisted[0]).toEqual([9, 4242, 'https://dz/x.jpg']);
  });
});

describe('album cascade — the two Apple rungs', () => {
  it('answers from the Apple web endpoint when Spotify and Deezer both missed', async () => {
    const h = harness({
      amWeb: { searchAlbums: async () => [{ name: 'Homework', artistName: 'Daft Punk', artwork: { url: 'https://am/x.jpg', width: 3000, height: 3000 } }] },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://am/x.jpg');
  });

  it('answers from iTunes, upscaling the 100px artwork rather than rendering a thumbnail', async () => {
    const h = harness({
      amSearch: { searchAlbums: async () => [{ artistName: 'Daft Punk', artworkUrl100: 'https://is1/100x100bb.jpg' }] },
    });
    const url = await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(url).toBe('https://is1/1200x1200bb.jpg');
  });

  it('refuses an Apple row whose artist does not match', async () => {
    const h = harness({
      amWeb: { searchAlbums: async () => [{ name: 'Homework', artistName: 'Portishead', artwork: { url: 'https://am/wrong.jpg', width: 1, height: 1 } }] },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
  });

  it('keeps the Spotify cover rather than overwriting it with an Apple one', async () => {
    const h = harness({
      spotify: { searchAlbums: async () => [{ id: 'x', name: 'Homework', uri: 'u', artists: [{ name: 'Daft Punk' }], images: [{ url: 'https://img/sp.jpg', height: 640, width: 640 }] }] },
      amWeb: { searchAlbums: async () => [{ name: 'Homework', artistName: 'Daft Punk', artwork: { url: 'https://am/x.jpg', width: 1, height: 1 } }] },
    });
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img/sp.jpg');
  });
});

describe('album cascade — what gets written to the cache', () => {
  it('writes none when every provider answered no', async () => {
    const h = harness();
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(h.cache.store.get('art:album:daft punk|homework')).toBe('none');
  });

  it('writes nothing at all when Spotify was rate-limited', async () => {
    // The single most damaging version of a confident miss: a global 429 would
    // otherwise write "no cover exists" for every album in every chart.
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    const h = harness();
    await h.service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(h.cache.store.get('art:album:daft punk|homework')).toBeUndefined();
  });

  it('serves a stored none without re-running the cascade', async () => {
    let calls = 0;
    const h = harness({ spotify: { searchAlbums: async () => { calls++; return []; } } });
    h.cache.store.set('art:album:daft punk|homework', 'none');

    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('never serves a stored placeholder as a cover', async () => {
    const h = harness();
    h.cache.store.set('art:album:daft punk|homework', 'https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png');
    await expect(h.service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBeNull();
  });

  it('rejects a lookup with no album or no artist rather than guessing', async () => {
    const h = harness();
    await expect(h.service.getAlbumCoverUrl()).resolves.toBeNull();
    await expect(h.service.getAlbumCoverUrl('Homework')).resolves.toBeNull();
    await expect(h.service.getAlbumCoverUrl(undefined, 'Daft Punk')).resolves.toBeNull();
    expect(h.cache.store.size).toBe(0);
  });
});

describe('artist cascade — the track-anchored rung', () => {
  it('pins the artist by the caller\'s own scrobble and skips the name search', async () => {
    let nameSearches = 0;
    const h = harness({
      spotify: {
        getArtistIdViaTrackSample: async () => 'SPOTIFY_ARTIST_ID',
        getArtistById: async () => ({ id: 'SPOTIFY_ARTIST_ID', name: 'Kanye West', uri: 'u', images: [{ url: 'https://img/anchored.jpg', height: 640, width: 640 }] }),
        searchArtists: async () => { nameSearches++; return []; },
      },
    });

    await expect(h.service.getArtistImageUrl('Kanye West', 'Stronger')).resolves.toBe('https://img/anchored.jpg');
    expect(nameSearches).toBe(0);
  });

  it('caches the anchored hit under a track-scoped key, never the global name key', async () => {
    // A globally popular same-name artist would otherwise be pinned into the
    // row every other track for this artist reads.
    const h = harness({
      spotify: {
        getArtistIdViaTrackSample: async () => 'SPOTIFY_ARTIST_ID',
        getArtistById: async () => ({ id: 'x', name: 'Kanye West', uri: 'u', images: [{ url: 'https://img/anchored.jpg', height: 640, width: 640 }] }),
      },
    });
    await h.service.getArtistImageUrl('Kanye West', 'Stronger');
    expect(h.cache.store.get('art:artist:kanye west:via:stronger')).toBe('https://img/anchored.jpg');
    expect(h.cache.store.get('art:artist:kanye west')).toBeUndefined();
  });

  it('serves an anchored hit from cache without touching the provider', async () => {
    let calls = 0;
    const h = harness({ spotify: { getArtistIdViaTrackSample: async () => { calls++; return 'x'; } } });
    h.cache.store.set('art:artist:kanye west:via:stronger', 'https://img/cached.jpg');
    await expect(h.service.getArtistImageUrl('Kanye West', 'Stronger')).resolves.toBe('https://img/cached.jpg');
    expect(calls).toBe(0);
  });

  it('serves a stored anchored none as a miss, and never as a URL', async () => {
    let calls = 0;
    const h = harness({ spotify: { getArtistIdViaTrackSample: async () => { calls++; return 'x'; } } });
    h.cache.store.set('art:artist:kanye west:via:stronger', 'none');
    await expect(h.service.getArtistImageUrl('Kanye West', 'Stronger')).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('records a clean anchored miss so the same track is not re-searched', async () => {
    const h = harness({ spotify: { getArtistIdViaTrackSample: async () => null } });
    await h.service.getArtistImageUrl('Kanye West', 'Stronger');
    expect(h.cache.store.get('art:artist:kanye west:via:stronger')).toBe('none');
  });

  it('does NOT record an anchored miss when the lookup threw', async () => {
    // A throw tells us nothing about whether the artist exists. Remembering
    // "no" would pin a 10-minute wrong answer over a momentary network error.
    const h = harness({
      spotify: { getArtistIdViaTrackSample: async () => { throw new Error('upstream 500'); } },
    });
    await h.service.getArtistImageUrl('Kanye West', 'Stronger');
    expect(h.cache.store.get('art:artist:kanye west:via:stronger')).toBeUndefined();
  });

  it('does NOT record an anchored miss while Spotify is rate-limited', async () => {
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    SpotifySearchApi.noteTransportFailure();
    const h = harness();
    await h.service.getArtistImageUrl('Kanye West', 'Stronger');
    expect(h.cache.store.get('art:artist:kanye west:via:stronger')).toBeUndefined();
  });

  it('falls through to the name-based rung after a clean anchored miss', async () => {
    const h = harness({
      spotify: {
        getArtistIdViaTrackSample: async () => null,
        searchArtists: async () => [{ id: 'x', name: 'Kanye West', uri: 'u', images: [{ url: 'https://img/name.jpg', height: 640, width: 640 }] }],
      },
    });
    await expect(h.service.getArtistImageUrl('Kanye West', 'Stronger')).resolves.toBe('https://img/name.jpg');
  });

  it('ignores a blank sample track and goes straight to the name rung', async () => {
    let anchored = 0;
    const h = harness({ spotify: { getArtistIdViaTrackSample: async () => { anchored++; return 'x'; } } });
    await h.service.getArtistImageUrl('Kanye West', '   ');
    expect(anchored).toBe(0);
  });
});

describe('artist cascade — the name-based rung', () => {
  it('serves the stored Spotify cover when it is fresh', async () => {
    const h = harness({
      artists: { getArtistByName: async () => ({ artistId: 3, spotifyImageUrl: 'https://img/fresh.jpg', spotifyImageDate: new Date() }) },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBe('https://img/fresh.jpg');
  });

  it('prefers a stored Deezer or Last.fm cover over calling Deezer again', async () => {
    let deezerCalls = 0;
    const h = harness({
      artists: {
        getArtistByName: async () => ({
          artistId: 3, spotifyImageUrl: null, deezerImageUrl: 'https://img/db.jpg', imageUrl: 'https://img/lfm.jpg',
        }),
      },
      deezer: { searchArtists: async () => { deezerCalls++; return []; } },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBe('https://img/db.jpg');
    expect(deezerCalls).toBe(0);
  });

  it('re-runs the search with `$` read as `s` for a stylised name', async () => {
    const queries: string[] = [];
    const h = harness({
      spotify: {
        searchArtists: async (q: string) => {
          queries.push(q);
          return q === 'Travis Scott' ? [{ id: 'x', name: 'Travis Scott', uri: 'u', images: [{ url: 'https://img/ts.jpg', height: 640, width: 640 }] }] : [];
        },
      },
    });
    await expect(h.service.getArtistImageUrl('Travi$ Scott')).resolves.toBe('https://img/ts.jpg');
    expect(queries).toEqual(['Travi$ Scott', 'Travis Scott']);
  });

  it('refuses a same-name artist whose image belongs to somebody else', async () => {
    const h = harness({
      spotify: { searchArtists: async () => [{ id: 'x', name: 'Jordana', uri: 'u', images: [{ url: 'https://img/other.jpg', height: 640, width: 640 }] }] },
    });
    // 'Jordana' has a dedicated correct-answer branch below; this asserts the
    // hotfix is what answers it, not a search.
    await expect(h.service.getArtistImageUrl('Jordana')).resolves.toContain('i.scdn.co');
  });

  it('follows a Last.fm canonical-name redirect to the real artist', async () => {
    // Last.fm answers "Travi$ Scott" with a redirect to "Travis Scott"; without
    // the follow-up the card falls back to the artist picture. The first two
    // Spotify calls (the `$` query and its transliteration retry) are made by
    // the OUTER cascade and must find nothing, so the only way to get an image
    // is the follow-up.
    let n = 0;
    const h = harness({
      lastfm: { getArtistInfo: async () => ({ name: 'Travis Scott', imageUrl: null }) },
      spotify: {
        searchArtists: async () => {
          n++;
          return n <= 2 ? [] : [{ id: 'x', name: 'Travis Scott', uri: 'u', images: [{ url: 'https://img/redirected.jpg', height: 640, width: 640 }] }];
        },
      },
    });
    await expect(h.service.getArtistImageUrl('Travi$ Scott')).resolves.toBe('https://img/redirected.jpg');
    expect(n).toBeGreaterThan(2);
  });

  it('still resolves normally when the redirected lookup finds nothing', async () => {
    const h = harness({ lastfm: { getArtistInfo: async () => ({ name: 'Travis Scott', imageUrl: null }) } });
    await expect(h.service.getArtistImageUrl('Travi$ Scott')).resolves.toBeNull();
  });

  it('does not report a redirect that resolved to nothing as a definitive miss', async () => {
    const h = harness({ lastfm: { getArtistInfo: async () => ({ name: 'Travis Scott', imageUrl: null }) } });
    await h.service.getArtistImageUrl('Travi$ Scott');
    expect(h.cache.store.get('art:artist:travi scott')).not.toBe('none');
  });

  it('answers the Jordana name from the pinned id, not from a search', async () => {
    let searches = 0;
    const h = harness({ spotify: { searchArtists: async () => { searches++; return []; } } });
    await expect(h.service.getArtistImageUrl('Jordana')).resolves.toContain('i.scdn.co');
    expect(searches).toBe(0);
  });

  it('rewrites a wrong stored cover for the Jordana hotfix', async () => {
    const written: unknown[][] = [];
    const h = harness({
      artists: {
        getArtistByName: async () => ({ artistId: 3, spotifyImageUrl: 'https://img/wrong-bryant.jpg' }),
        setSpotifyImage: async (...args: unknown[]) => { written.push(args); },
      },
    });
    await h.service.getArtistImageUrl('Jordana');
    expect(written[0]?.[0]).toBe(3);
    expect(written[0]?.[1]).toContain('i.scdn.co');
  });

  it('leaves a correct stored cover alone', async () => {
    const written: unknown[][] = [];
    const h = harness({
      artists: {
        getArtistByName: async () => ({
          artistId: 3,
          spotifyImageUrl: 'https://i.scdn.co/image/ab6761610000e5eb856b7f7308eff9c24c17cb88',
        }),
        setSpotifyImage: async (...args: unknown[]) => { written.push(args); },
      },
    });
    await h.service.getArtistImageUrl('Jordana');
    expect(written).toEqual([]);
  });

  it('rejects a blank artist name instead of running the whole ladder on it', async () => {
    const h = harness();
    await expect(h.service.getArtistImageUrl()).resolves.toBeNull();
    expect(h.cache.store.size).toBe(0);
  });

  it('writes none for a clean sweep of every provider', async () => {
    const h = harness();
    await h.service.getArtistImageUrl('Nobody At All');
    expect(h.cache.store.get('art:artist:nobody at all')).toBe('none');
  });

  it('writes nothing when a provider threw', async () => {
    const h = harness({ spotify: { searchArtists: async () => { throw new Error('429'); } } });
    await h.service.getArtistImageUrl('Kanye West');
    expect(h.cache.store.get('art:artist:kanye west')).toBeUndefined();
  });

  it('keeps going when persisting a Spotify cover fails', async () => {
    // The URL is right; only the write failed. Returning null here would blank
    // a cover the provider already gave us.
    const h = harness({
      spotify: { searchArtists: async () => [{ id: 'x', name: 'Kanye West', uri: 'u', images: [{ url: 'https://img/sp.jpg', height: 640, width: 640 }] }] },
      artists: { setSpotifyImage: async () => { throw new Error('db down'); } },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBe('https://img/sp.jpg');
  });

  it('answers from the Apple web endpoint when Spotify and Deezer both missed', async () => {
    // The artist cascade's Apple rung. The album and track cascades accept an
    // Apple result without any database row; this used to require one, so an
    // artist who had never been indexed was answered `null` by a provider that
    // had just handed over a perfect match.
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Kanye West', artwork: { url: 'https://am/a.jpg', width: 3000, height: 3000 } }] },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBe('https://am/a.jpg');
  });

  it('does not remember the un-indexed artist as a definitive miss', async () => {
    // The half of the bug nobody sees: nothing threw and nothing pushed an
    // attempt, so the bottom gate wrote the 'none' marker and the bot believed
    // for ten minutes that this artist has no cover at all.
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Nobody At All', artwork: { url: 'https://am/n.jpg', width: 3000, height: 3000 } }] },
    });
    await expect(h.service.getArtistImageUrl('Nobody At All')).resolves.toBe('https://am/n.jpg');
    expect(h.cache.store.get('art:artist:nobody at all')).toBe('https://am/n.jpg');
  });

  it('creates the artist row to persist the Apple cover when there is none', async () => {
    // Same shape as the Spotify and Deezer rungs above: `existing ?? getOrCreate`.
    const written: unknown[][] = [];
    const created: string[] = [];
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Kanye West', artwork: { url: 'https://am/a.jpg', width: 3000, height: 3000 } }] },
      artists: {
        getOrCreateArtist: async (name: string) => { created.push(name); return { artistId: 42 }; },
        setAppleMusicUrl: async (...args: unknown[]) => { written.push(args); },
      },
    });
    await h.service.getArtistImageUrl('Kanye West');
    expect(created).toEqual(['Kanye West']);
    expect(written).toEqual([[42, 'https://am/a.jpg']]);
  });

  it('persists onto the EXISTING row when there is one, without creating a second', async () => {
    const written: unknown[][] = [];
    let creates = 0;
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Kanye West', artwork: { url: 'https://am/a.jpg', width: 3000, height: 3000 } }] },
      artists: {
        getArtistByName: async () => ({ artistId: 3 }),
        getOrCreateArtist: async () => { creates += 1; return { artistId: 42 }; },
        setAppleMusicUrl: async (...args: unknown[]) => { written.push(args); },
      },
    });
    await h.service.getArtistImageUrl('Kanye West');
    expect(creates).toBe(0);
    expect(written).toEqual([[3, 'https://am/a.jpg']]);
  });

  it('keeps going when persisting the Apple cover fails, like every other rung', async () => {
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Kanye West', artwork: { url: 'https://am/a.jpg', width: 3000, height: 3000 } }] },
      artists: { setAppleMusicUrl: async () => { throw new Error('db down'); } },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBe('https://am/a.jpg');
  });

  it('refuses an Apple artist row whose name does not match', async () => {
    // Same-name artists are the reason this cascade matches at all; an
    // unmatched provider row must fall through, not be accepted.
    const h = harness({
      amWeb: { searchArtists: async () => [{ name: 'Kanye East', artwork: { url: 'https://am/wrong.jpg', width: 3000, height: 3000 } }] },
    });
    await expect(h.service.getArtistImageUrl('Kanye West')).resolves.toBeNull();
  });
});

describe('track cascade — every rung must match artist AND title', () => {
  const spTrack = (title: string, artists: string[], url: string) => ({
    id: 'x', name: title, uri: 'u', artists: artists.map((n) => ({ name: n })), album: { images: [{ url, height: 640, width: 640 }] },
  });

  it('answers from Spotify when both artist and title match', async () => {
    const h = harness({ spotify: { searchTracks: async () => [spTrack('Esme', ['Mond'], 'https://img/t.jpg')] } });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://img/t.jpg');
  });

  it('refuses the right title by the wrong artist', async () => {
    const h = harness({ spotify: { searchTracks: async () => [spTrack('Esme', ['Mac DeMarco'], 'https://img/wrong.jpg')] } });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
  });

  it('refuses a same-title different recording', async () => {
    // "Song" must not match "Song 2" — the strictness rule from AGENTS.md 3.3,
    // seen from the cascade rather than from the predicate.
    const h = harness({ spotify: { searchTracks: async () => [spTrack('Esme (Remix)', ['Mond'], 'https://img/remix.jpg')] } });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
  });

  it('persists the Spotify cover onto the track row, not the album row', async () => {
    const written: unknown[][] = [];
    const h = harness({
      spotify: { searchTracks: async () => [spTrack('Esme', ['Mond'], 'https://img/t.jpg')] },
      artists: { getArtistByName: async () => ({ artistId: 8 }) },
      tracks: {
        getTrackByNameAndArtist: async () => ({ trackId: 21 }),
        setSpotifyImage: async (...args: unknown[]) => { written.push(args); },
      },
    });
    await h.service.getTrackCoverUrl('Esme', 'Mond');
    expect(written[0]?.[0]).toBe(21);
  });

  it('answers from Deezer, preferring cover_xl over cover_big', async () => {
    const h = harness({
      deezer: {
        searchTracks: async () => [{ id: 1, title: 'Esme', artist: { id: 1, name: 'Mond' }, album: { id: 2, title: 'I', cover_xl: 'https://dz/xl.jpg', cover_big: 'https://dz/big.jpg' } }],
      },
    });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://dz/xl.jpg');
  });

  it('re-queries Deezer artist-first when the first query was empty', async () => {
    const queries: string[] = [];
    const h = harness({
      deezer: {
        searchTracks: async (q: string) => {
          queries.push(q);
          return q === 'Mond Esme'
            ? [{ id: 1, title: 'Esme', artist: { id: 1, name: 'Mond' }, album: { id: 2, title: 'I', cover_xl: 'https://dz/xl.jpg' } }]
            : [];
        },
      },
    });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://dz/xl.jpg');
    expect(queries).toEqual(['Esme Mond', 'Mond Esme']);
  });

  it('answers from the Apple web endpoint', async () => {
    const h = harness({
      amWeb: { searchSongs: async () => [{ name: 'Esme', artistName: 'Mond', artwork: { url: 'https://am/t.jpg', width: 3000, height: 3000 } }] },
    });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://am/t.jpg');
  });

  it('answers from iTunes with upscaled artwork', async () => {
    const h = harness({
      amSearch: { searchSongs: async () => [{ trackName: 'Esme', artistName: 'Mond', artworkUrl100: 'https://is1/100x100bb.jpg' }] },
    });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://is1/1200x1200bb.jpg');
  });

  it('uses the album cover Last.fm names, and shares the miss with the album gate', async () => {
    const h = harness({
      spotify: { searchAlbums: async () => [{ id: 'x', name: 'I', uri: 'u', artists: [{ name: 'Mond' }], images: [{ url: 'https://img/album.jpg', height: 640, width: 640 }] }] },
      lastfm: { getTrackInfo: async () => ({ albumName: 'I' }) },
    });
    await expect(h.service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://img/album.jpg');
  });

  it('rejects a track lookup with no track or no artist', async () => {
    const h = harness();
    await expect(h.service.getTrackCoverUrl()).resolves.toBeNull();
    await expect(h.service.getTrackCoverUrl('Esme')).resolves.toBeNull();
    expect(h.cache.store.size).toBe(0);
  });
});

describe('getTrackCoverBySpotifyId — one GET, no matching risk', () => {
  it('rejects an id of the wrong length without calling the provider', async () => {
    let calls = 0;
    const h = harness({ spotify: { getTrack: async () => { calls++; return null; } } });
    await expect(h.service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0')).resolves.toBeNull();
    await expect(h.service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0gx')).resolves.toBeNull();
    await expect(h.service.getTrackCoverBySpotifyId('')).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('serves a stored inconclusive marker as a miss, not as a URL', async () => {
    let calls = 0;
    const h = harness({ spotify: { getTrack: async () => { calls++; return null; } } });
    h.cache.store.set('art:spid:4mF0aVVHtmHQSIdem2Wh0g', 'inconclusive');
    await expect(h.service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('never serves a stored placeholder', async () => {
    const h = harness();
    h.cache.store.set('art:spid:4mF0aVVHtmHQSIdem2Wh0g', 'https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png');
    await expect(h.service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBeNull();
  });

  it('falls through to the provider when the cache cannot be read', async () => {
    // An unreadable cache is a miss, never a rejection: a Redis blip must not
    // take the chapter artwork with it.
    const h = harness({
      spotify: { getTrack: async () => ({ id: 'x', name: 'Esme', uri: 'u', album: { images: [{ url: 'https://img/x.jpg', height: 640, width: 640 }] } }) },
    });
    const broken = {
      get: async () => { throw new Error('redis down'); },
      set: async () => undefined,
    };
    const service = new ArtworkService(
      h.spotify as never, h.deezer as never, h.amWeb as never, h.amSearch as never,
      h.artists as never, h.albums as never, h.tracks as never, h.lastfm as never,
      broken as never,
    );
    await expect(service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBe('https://img/x.jpg');
  });
});
