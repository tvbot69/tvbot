import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtworkService, matchesTrackTitle } from './artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

describe('matchesTrackTitle', () => {
  it('matches identical and edition-tagged titles', () => {
    expect(matchesTrackTitle('Esme', 'Esme')).toBe(true);
    expect(matchesTrackTitle('Esme (Remastered)', 'Esme')).toBe(true);
    expect(matchesTrackTitle('ESME', 'esme')).toBe(true);
  });

  it('rejects different songs and empty input', () => {
    expect(matchesTrackTitle('Song 2', 'Song')).toBe(false);
    expect(matchesTrackTitle('Caracas en el 2000', 'Macacoa 2000')).toBe(false);
    expect(matchesTrackTitle('', 'Esme')).toBe(false);
  });
});

describe('ArtworkService provider validation', () => {
  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  const makeService = (overrides: {
    spotifyTracks?: unknown[];
    deezerTracks?: unknown[];
    appleWebSongs?: unknown[];
    itunesSongs?: unknown[];
    lastfmTrackInfo?: unknown;
  }) =>
    new ArtworkService(
      {
        searchTracks: vi.fn().mockResolvedValue(overrides.spotifyTracks ?? []),
        searchAlbums: vi.fn().mockResolvedValue([]),
        searchArtists: vi.fn().mockResolvedValue([]),
      } as never,
      {
        searchTracks: vi.fn().mockResolvedValue(overrides.deezerTracks ?? []),
        searchAlbums: vi.fn().mockResolvedValue([]),
        searchArtists: vi.fn().mockResolvedValue([]),
      } as never,
      {
        searchSongs: vi.fn().mockResolvedValue(overrides.appleWebSongs ?? []),
        searchAlbums: vi.fn().mockResolvedValue([]),
        searchArtists: vi.fn().mockResolvedValue([]),
      } as never,
      {
        searchSongs: vi.fn().mockResolvedValue(overrides.itunesSongs ?? []),
        searchAlbums: vi.fn().mockResolvedValue([]),
        searchArtists: vi.fn().mockResolvedValue([]),
      } as never,
      { getArtistByName: vi.fn().mockResolvedValue(null) } as never,
      {} as never,
      {
        getTrackByNameAndArtist: vi.fn().mockResolvedValue(null),
        setSpotifyImage: vi.fn(),
      } as never,
      { getTrackInfo: vi.fn().mockResolvedValue(overrides.lastfmTrackInfo ?? null) } as never,
      cache as never,
    );

  it('picks the matching recording, not the first Spotify result', async () => {
    const service = makeService({
      spotifyTracks: [
        {
          name: 'Esme (Cover)',
          artists: [{ name: 'Random Singer' }],
          album: { images: [{ url: 'https://wrong.example/cover.jpg', height: 640 }] },
        },
        {
          name: 'Esme',
          artists: [{ name: 'Mond' }],
          album: { images: [{ url: 'https://right.example/cover.jpg', height: 640 }] },
        },
      ],
    });

    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe(
      'https://right.example/cover.jpg',
    );
  });

  it('returns null instead of a wrong-artist cover when nothing matches', async () => {
    const service = makeService({
      spotifyTracks: [
        {
          name: 'Esme (Cover)',
          artists: [{ name: 'Random Singer' }],
          album: { images: [{ url: 'https://wrong.example/cover.jpg', height: 640 }] },
        },
      ],
    });

    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBeNull();
  });

  it('validates Deezer results by artist and title', async () => {
    const service = makeService({
      deezerTracks: [
        {
          title: 'Esme',
          artist: { name: 'Metal Mond' },
          album: { cover_xl: 'https://wrong.example/dz.jpg' },
        },
        {
          title: 'Esme',
          artist: { name: 'Mond' },
          album: { cover_xl: 'https://right.example/dz.jpg' },
        },
      ],
    });

    await expect(service.getTrackCoverUrl('Esme', 'Mond')).resolves.toBe(
      'https://right.example/dz.jpg',
    );
  });

  it('never accepts an unmatched first album result from any provider', async () => {
    const service = makeService({});
    // Spotify album retry + Deezer retry + Apple fall back to first hits in the
    // old code; with validation they must all miss here.
    const spotifyApi = (service as unknown as { spotifyApi: { searchAlbums: ReturnType<typeof vi.fn> } }).spotifyApi;
    spotifyApi.searchAlbums.mockResolvedValue([
      { name: 'Wrong Album', artists: [{ name: 'Someone Else' }], images: [{ url: 'https://wrong.example/a.jpg', height: 640 }] },
    ]);

    await expect(service.getAlbumCoverUrl('Esme', 'Mond')).resolves.toBeNull();
  });
});
