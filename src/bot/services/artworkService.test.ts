import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArtworkService, sanitizeMusicName } from './artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

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
