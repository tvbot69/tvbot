import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ArtworkService, sanitizeMusicName } from './artworkService';

interface ProviderOverrides {
  spotify?: () => Promise<string | null>;
  deezer?: () => Promise<string | null>;
}

const makeService = (overrides: ProviderOverrides) => {
  const service = new ArtworkService(
    {
      searchAlbums: async () =>
        overrides.spotify ? [{ images: [{ url: 'spotify-url', height: 640 }] }] : [],
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
