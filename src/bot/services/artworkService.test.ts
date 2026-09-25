import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArtworkService, matchesArtistName, matchesTrackTitle, sanitizeMusicName, stripChannelSuffix } from './artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

describe('matcher name normalization', () => {
  it('folds diacritics in stylized artist and title names', () => {
    expect(matchesTrackTitle('Monëy so big', 'Money so big')).toBe(true);
    expect(matchesTrackTitle('GEEK TIMË', 'Geek time')).toBe(true);
    expect(matchesArtistName('Beyoncé', 'Beyonce')).toBe(true);
    expect(matchesArtistName('Yeat', 'YEAT')).toBe(true);
  });

  it('stays strict across different recordings', () => {
    expect(matchesTrackTitle('Money so big', 'Money')).toBe(false);
    expect(matchesTrackTitle('Song', 'Song 2')).toBe(false);
    expect(matchesArtistName('Yeat', 'Drake')).toBe(false);
  });
});

interface ProviderOverrides {
  spotify?: () => Promise<string | null>;
  deezer?: () => Promise<string | null>;
}

const makeService = (overrides: ProviderOverrides) => {
  const service = new ArtworkService(
    {
      // Real Spotify album results always carry artists — validation requires it.
      searchAlbums: async () =>
        overrides.spotify
          ? [{ artists: [{ name: 'Daft Punk' }], images: [{ url: 'spotify-url', height: 640 }] }]
          : [],
      searchArtists: async () => [],
      searchTracks: async () => [],
    } as never,
    {
      searchAlbums: async () =>
        overrides.deezer ? [{ cover_xl: 'deezer-url' }] : [],
      searchArtists: async () => [],
      searchTracks: async () => [],
    } as never,
    {
      searchAlbums: async () => [],
      searchArtists: async () => [],
      searchSongs: async () => [],
    } as never,
    {
      searchAlbums: async () => [],
      searchArtists: async () => [],
      searchSongs: async () => [],
    } as never,
    {
      getArtistByName: async () => null,
      setSpotifyImage: async () => undefined,
      setDeezerImage: async () => undefined,
      setAppleMusicUrl: async () => undefined,
    } as never,
    {
      getAlbumByNameAndArtist: async () => null,
      setSpotifyImage: async () => undefined,
      setDeezerImage: async () => undefined,
      setImageUrl: async () => undefined,
    } as never,
    {
      getTrackByNameAndArtist: async () => null,
      setSpotifyImage: async () => undefined,
      setImageUrl: async () => undefined,
    } as never,
    {
      getAlbumInfo: async () => ({ imageUrl: 'lastfm-url' }),
      getArtistInfo: async () => ({ imageUrl: 'lastfm-artist-url' }),
    } as never,
    { get: async () => null, set: async () => undefined } as never,
  );
  return service;
};

describe('sanitizeMusicName', () => {
  it('strips single/ep suffixes', () => {
    expect(sanitizeMusicName('Random Access Memories - Single')).toBe(
      'Random Access Memories',
    );
  });
  it('strips deluxe annotations', () => {
    expect(sanitizeMusicName('Discovery (Deluxe Edition)')).toBe('Discovery');
  });
});

describe('stripChannelSuffix', () => {
  it('strips auto-generated channel suffixes', () => {
    expect(stripChannelSuffix('Drake - Topic')).toBe('Drake');
    expect(stripChannelSuffix('Taylor Swift VEVO')).toBe('Taylor Swift');
    expect(stripChannelSuffix('  Drake  -  Topic  ')).toBe('Drake');
  });

  it('leaves real artist names untouched', () => {
    expect(stripChannelSuffix('Drake')).toBe('Drake');
    expect(stripChannelSuffix('G.L.O.S.S.')).toBe('G.L.O.S.S.');
    expect(stripChannelSuffix('')).toBe('');
  });
});

describe('ArtworkService priority chain', () => {
  it('falls through to lastfm when no providers return', async () => {
    const service = makeService({});
    const url = await service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(url).toBe('lastfm-url');
  });

  it('uses spotify first when available', async () => {
    const service = makeService({ spotify: async () => 'spotify-url' });
    const url = await service.getAlbumCoverUrl('Homework', 'Daft Punk');
    expect(url).toBe('spotify-url');
  });

  it('uses spotify first for artist images when available', async () => {
    const service = new ArtworkService(
      {
        searchAlbums: async () => [],
        searchArtists: async () => [
          { name: 'Kanye West', images: [{ url: 'https://spotify.com/kanye.jpg', height: 640 }] },
        ],
        searchTracks: async () => [],
      } as never,
      {
        searchAlbums: async () => [],
        searchArtists: async () => [
          { name: 'Kanye West', picture_xl: 'https://deezer.com/kanye.jpg' },
        ],
        searchTracks: async () => [],
      } as never,
      { searchArtists: async () => [] } as never,
      { searchArtists: async () => [] } as never,
      {
        getArtistByName: async () => null,
        getOrCreateArtist: async () => ({ artistId: 1 }),
        setSpotifyImage: async () => undefined,
        setDeezerImage: async () => undefined,
      } as never,
      {} as never,
      {} as never,
      { getArtistInfo: async () => ({ imageUrl: 'https://lastfm.com/kanye.jpg' }) } as never,
      { get: async () => null, set: async () => undefined } as never,
    );
    const url = await service.getArtistImageUrl('Kanye West');
    expect(url).toBe('https://spotify.com/kanye.jpg');
  });

  it('falls through to deezer for artist images when spotify misses', async () => {
    const service = new ArtworkService(
      {
        searchAlbums: async () => [],
        searchArtists: async () => [],
        searchTracks: async () => [],
      } as never,
      {
        searchAlbums: async () => [],
        searchArtists: async () => [
          { name: 'Kanye West', picture_xl: 'https://deezer.com/kanye.jpg' },
        ],
        searchTracks: async () => [],
      } as never,
      { searchArtists: async () => [] } as never,
      { searchArtists: async () => [] } as never,
      {
        getArtistByName: async () => null,
        getOrCreateArtist: async () => ({ artistId: 1 }),
        setSpotifyImage: async () => undefined,
        setDeezerImage: async () => undefined,
      } as never,
      {} as never,
      {} as never,
      { getArtistInfo: async () => ({ imageUrl: 'https://lastfm.com/kanye.jpg' }) } as never,
      { get: async () => null, set: async () => undefined } as never,
    );
    const url = await service.getArtistImageUrl('Kanye West');
    expect(url).toBe('https://deezer.com/kanye.jpg');
  });
});

describe('negative-cache semantics (definitive vs inconclusive misses)', () => {
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

  const repos = {
    artist: { getArtistByName: async () => null },
    album: { getAlbumByNameAndArtist: async () => null },
    track: { getTrackByNameAndArtist: async () => null },
    lastfm: { getTrackInfo: async () => null, getAlbumInfo: async () => null, getArtistInfo: async () => null },
  };

  const makeTrackArt = (
    spotifyImpl: () => Promise<any[]>,
    opts: { cache?: ReturnType<typeof memCache>; deezerImpl?: () => Promise<any[]> } = {},
  ) => {
    const cache = opts.cache ?? memCache();
    const service = new ArtworkService(
      { searchTracks: spotifyImpl, searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchTracks: opts.deezerImpl ?? (async () => []), searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      repos.artist as never,
      repos.album as never,
      repos.track as never,
      repos.lastfm as never,
      cache as never,
    );
    return { service, cache };
  };

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
  });

  it('does not cache inconclusive misses (provider throws) — next lookup retries', async () => {
    let calls = 0;
    const { service, cache } = makeTrackArt(async () => {
      calls++;
      throw new Error('boom');
    });
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect([...cache.store.values()]).not.toContain('none');
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it('caches definitive misses briefly — clean provider no-hits are not retried', async () => {
    let calls = 0;
    const { service, cache } = makeTrackArt(async () => {
      calls++;
      return [];
    });
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect([...cache.store.values()]).toContain('none');
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    // 2 calls per lookup (initial + empty-retry); the second lookup hits cache.
    expect(calls).toBe(2);
  });

  it('caches hits normally', async () => {
    let calls = 0;
    const { service } = makeTrackArt(async () => {
      calls++;
      return [{ artists: [{ name: 'Mond' }], name: 'Esme', album: { images: [{ url: 'https://img.test/hit.jpg' }] } }];
    });
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://img.test/hit.jpg');
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe('https://img.test/hit.jpg');
    expect(calls).toBe(1);
  });
});

describe('getTrackCoverBySpotifyId', () => {
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

  const makeById = (getTrackImpl: () => Promise<any>, cache = memCache()) => {
    const getTrack = vi.fn(getTrackImpl);
    const service = new ArtworkService(
      { getTrack, searchTracks: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchTracks: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      { getArtistByName: async () => null } as never,
      { getAlbumByNameAndArtist: async () => null } as never,
      { getTrackByNameAndArtist: async () => null } as never,
      { getTrackInfo: async () => null, getAlbumInfo: async () => null, getArtistInfo: async () => null } as never,
      cache as never,
    );
    return { service, cache, getTrack };
  };

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('returns exact art and caches it (no refetch)', async () => {
    const { service, getTrack } = makeById(async () => ({
      album: { images: [{ url: 'https://img.test/exact.jpg', height: 640 }] },
    }));
    await expect(service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBe(
      'https://img.test/exact.jpg',
    );
    await expect(service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBe(
      'https://img.test/exact.jpg',
    );
    expect(getTrack).toHaveBeenCalledTimes(1);
  });

  it('caches definitive no-art briefly, never caches throws', async () => {
    const { service, cache, getTrack } = makeById(async () => ({ album: { images: [] } }));
    await expect(service.getTrackCoverBySpotifyId('0000000000000000000000')).resolves.toBeNull();
    expect([...cache.store.values()]).toContain('none');

    const throwing = makeById(async () => {
      throw new Error('boom');
    });
    await expect(throwing.service.getTrackCoverBySpotifyId('1111111111111111111111')).resolves.toBeNull();
    expect([...throwing.cache.store.values()]).not.toContain('none');
    expect(throwing.getTrack).toHaveBeenCalledTimes(1);
    await expect(throwing.service.getTrackCoverBySpotifyId('1111111111111111111111')).resolves.toBeNull();
    expect(throwing.getTrack).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed ids and stays silent when rate-limited', async () => {
    const { service, getTrack } = makeById(async () => ({}));
    await expect(service.getTrackCoverBySpotifyId('short')).resolves.toBeNull();
    expect(getTrack).not.toHaveBeenCalled();
    vi.spyOn(SpotifySearchApi, 'isRateLimited').mockReturnValue(true);
    await expect(service.getTrackCoverBySpotifyId('4mF0aVVHtmHQSIdem2Wh0g')).resolves.toBeNull();
    expect(getTrack).not.toHaveBeenCalled();
  });
});

describe('topic-channel artists (Drake - Topic class)', () => {
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

  it('resolves the track cover, not the artist picture, for topic uploads', async () => {
    const queries: string[] = [];
    const service = new ArtworkService(
      {
        searchTracks: async (q: string) => {
          queries.push(q);
          return [
            {
              name: 'In My Feelings',
              artists: [{ name: 'Drake' }],
              album: { images: [{ url: 'https://img.test/scorpion.jpg', height: 640 }] },
            },
          ];
        },
        searchAlbums: async () => [],
        searchArtists: async () => [],
      } as never,
      { searchTracks: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      { searchSongs: async () => [] } as never,
      { getArtistByName: async () => null } as never,
      { getAlbumByNameAndArtist: async () => null } as never,
      { getTrackByNameAndArtist: async () => null } as never,
      { getTrackInfo: async () => null, getAlbumInfo: async () => null, getArtistInfo: async () => null } as never,
      memCache() as never,
    );
    SpotifySearchApi.clearRateLimit();
    try {
      const url = await service.getTrackCoverUrl('In My Feelings', 'Drake - Topic');
      expect(url).toBe('https://img.test/scorpion.jpg');
      expect(queries[0]).toContain('Drake');
      expect(queries[0]).not.toContain('Topic');
    } finally {
      SpotifySearchApi.clearRateLimit();
    }
  });
});

describe('cascade resilience (single-flight, DB containment, outage gate)', () => {
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

  interface HarnessOpts {
    spotifyTracks?: () => Promise<any[]>;
    spotifyAlbums?: () => Promise<any[]>;
    spotifyArtists?: () => Promise<any[]>;
    lastFmTrackInfo?: () => Promise<any>;
    lastFmAlbumInfo?: () => Promise<any>;
    getArtistByName?: () => Promise<any>;
    tracker?: { isElevated: () => boolean };
  }

  const makeResilient = (opts: HarnessOpts = {}) => {
    const cache = memCache();
    const calls = { spotifyTracks: 0 };
    const service = new ArtworkService(
      {
        searchTracks: async (..._a: unknown[]) => {
          calls.spotifyTracks++;
          return opts.spotifyTracks ? opts.spotifyTracks() : [];
        },
        searchAlbums: async () => (opts.spotifyAlbums ? opts.spotifyAlbums() : []),
        searchArtists: async () => (opts.spotifyArtists ? opts.spotifyArtists() : []),
      } as never,
      { searchTracks: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchSongs: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      { searchSongs: async () => [], searchAlbums: async () => [], searchArtists: async () => [] } as never,
      {
        getArtistByName: opts.getArtistByName ?? (async () => null),
        getOrCreateArtist: async () => ({ artistId: 1 }),
        setSpotifyImage: async () => undefined,
        setDeezerImage: async () => undefined,
        setAppleMusicUrl: async () => undefined,
      } as never,
      { getAlbumByNameAndArtist: async () => null, setSpotifyImage: async () => undefined, setDeezerImage: async () => undefined, setImageUrl: async () => undefined } as never,
      { getTrackByNameAndArtist: async () => null, setSpotifyImage: async () => undefined, setImageUrl: async () => undefined } as never,
      {
        getTrackInfo: opts.lastFmTrackInfo ?? (async () => null),
        getAlbumInfo: opts.lastFmAlbumInfo ?? (async () => null),
        getArtistInfo: async () => null,
      } as never,
      cache as never,
      opts.tracker as never,
    );
    return { service, cache, calls };
  };

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
  });

  it('shares one cascade between concurrent lookups of the same track', async () => {
    let resolveSpotify!: (v: any[]) => void;
    const gate = new Promise<any[]>((resolve) => {
      resolveSpotify = resolve;
    });
    const { service, calls } = makeResilient({ spotifyTracks: () => gate });
    const p1 = service.getTrackCoverUrl('Esme', 'Mond');
    const p2 = service.getTrackCoverUrl('Esme', 'Mond');
    resolveSpotify([
      { artists: [{ name: 'Mond' }], name: 'Esme', album: { images: [{ url: 'https://img.test/hit.jpg' }] } },
    ]);
    await expect(p1).resolves.toBe('https://img.test/hit.jpg');
    await expect(p2).resolves.toBe('https://img.test/hit.jpg');
    expect(calls.spotifyTracks).toBe(1);
  });

  it('a lookup joining a shared album cascade never caches a definitive none', async () => {
    let resolveAlbums!: (v: any[]) => void;
    const gate = new Promise<any[]>((resolve) => {
      resolveAlbums = resolve;
    });
    const { service, cache } = makeResilient({
      lastFmTrackInfo: async () => ({ albumName: 'Homework' }),
      spotifyAlbums: () => gate,
    });
    const p1 = service.getTrackCoverUrl('Esme', 'Mond');
    const p2 = service.getTrackCoverUrl('Around The World', 'Mond');
    resolveAlbums([]);
    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    // First run concluded definitively (the album sweep answered no)…
    expect(cache.store.get('art:album:mond|homework')).toBe('none');
    expect(cache.store.get('art:track:mond|esme')).toBe('none');
    // …but the second track joined the in-flight album cascade — inconclusive.
    expect(cache.store.get('art:track:mond|around the world')).toBeUndefined();
  });

  it('contains DB probe failures instead of rejecting the cascade', async () => {
    const { service } = makeResilient({
      getArtistByName: async () => {
        throw new Error('db down');
      },
      spotifyAlbums: async () => [
        { artists: [{ name: 'Daft Punk' }], images: [{ url: 'https://img.test/album.jpg', height: 640 }] },
      ],
    });
    await expect(service.getAlbumCoverUrl('Homework', 'Daft Punk')).resolves.toBe('https://img.test/album.jpg');

    const { service: artistSvc } = makeResilient({
      getArtistByName: async () => {
        throw new Error('db down');
      },
      spotifyArtists: async () => [
        { name: 'Kanye West', images: [{ url: 'https://img.test/kanye.jpg', height: 640 }] },
      ],
    });
    await expect(artistSvc.getArtistImageUrl('Kanye West')).resolves.toBe('https://img.test/kanye.jpg');
  });

  it('does not negative-cache ambiguous Last.fm nulls during an outage', async () => {
    const { service, cache, calls } = makeResilient({ tracker: { isElevated: () => true } });
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect(cache.store.get('art:track:mond|esme')).toBeUndefined();
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    // 2 spotify calls per cascade — the second lookup retried instead of
    // being served a poisoned 'none'.
    expect(calls.spotifyTracks).toBe(4);
  });

  it('still caches definitive misses when Last.fm is healthy', async () => {
    const { service, cache, calls } = makeResilient({ tracker: { isElevated: () => false } });
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect(cache.store.get('art:track:mond|esme')).toBe('none');
    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
    expect(calls.spotifyTracks).toBe(2);
  });
});
