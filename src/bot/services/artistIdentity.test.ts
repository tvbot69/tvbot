import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { isArtistIndexPartial } from './artistTrackService';
import { GenreService } from './genreService';
import { ArtworkService } from './artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

describe('isArtistIndexPartial', () => {
  it('returns false when indexed plays cover the total', () => {
    const tracks = [{ playcount: 9 }, { playcount: 8 }, { playcount: 8 }];
    expect(isArtistIndexPartial(tracks, 25)).toBe(false);
  });

  it('returns true when only a fraction is indexed (friend just registered)', () => {
    const tracks = [{ playcount: 2 }, { playcount: 1 }];
    expect(isArtistIndexPartial(tracks, 135)).toBe(true);
  });

  it('ignores tiny totals and empty lists to avoid noise', () => {
    expect(isArtistIndexPartial([{ playcount: 1 }], 9)).toBe(false);
    expect(isArtistIndexPartial([], 135)).toBe(false);
  });
});

describe('track-anchored artist identity (Mond vs Mond)', () => {
  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeGenreService = () =>
    new GenreService(
      cache as never,
      {
        getForArtistName: vi.fn().mockResolvedValue([]),
        setForArtistId: vi.fn().mockResolvedValue(undefined),
      } as never,
      { getOrCreateArtist: vi.fn().mockResolvedValue({ artistId: 1 }) } as never,
      { getArtistInfo: vi.fn().mockResolvedValue({ tags: ['black metal', 'ambient'] }) } as never,
      {} as never,
    );

  it('prefers the anchored Spotify entity genres over the namesake Last.fm tags', async () => {
    container.registerInstance(
      SpotifySearchApi,
      {
        getArtistIdViaTrackSample: vi.fn().mockResolvedValue('egypt-mond-id'),
        getArtistById: vi.fn().mockResolvedValue({ genres: ['Hip-Hop', 'Egyptian Hip-Hop', 'Rap'] }),
        searchArtists: vi.fn().mockResolvedValue([]),
      } as never,
    );

    const genres = await makeGenreService().getGenresForArtist('Mond', 'Esme');
    expect(genres).toEqual(['hip-hop', 'egyptian hip-hop', 'rap']);
  });

  it('suppresses wrong-entity Last.fm tags on proven name collision', async () => {
    container.registerInstance(
      SpotifySearchApi,
      {
        getArtistIdViaTrackSample: vi.fn().mockResolvedValue('egypt-mond-id'),
        getArtistById: vi.fn().mockResolvedValue({ genres: [] }),
        searchArtists: vi.fn().mockResolvedValue([{ name: 'Mond', id: 'metal-mond-id' }]),
      } as never,
    );

    const lastfmRepo = { getArtistInfo: vi.fn() };
    const service = new GenreService(
      cache as never,
      { getForArtistName: vi.fn().mockResolvedValue([]) } as never,
      { getOrCreateArtist: vi.fn() } as never,
      lastfmRepo as never,
      {} as never,
    );
    const genres = await service.getGenresForArtist('Mond', 'Esme');
    expect(genres).toEqual([]);
    expect(lastfmRepo.getArtistInfo).not.toHaveBeenCalled();
  });

  it('falls back to Last.fm tags when the anchor agrees with the naive winner', async () => {
    container.registerInstance(
      SpotifySearchApi,
      {
        getArtistIdViaTrackSample: vi.fn().mockResolvedValue('same-id'),
        getArtistById: vi.fn().mockResolvedValue({ genres: [] }),
        searchArtists: vi.fn().mockResolvedValue([{ name: 'Mond', id: 'same-id' }]),
      } as never,
    );

    const genres = await makeGenreService().getGenresForArtist('Mond', 'Esme');
    expect(genres).toContain('black metal');
  });

  it('resolves the anchored artist image without touching the global name row', async () => {
    const artistRepository = { getArtistByName: vi.fn(), setSpotifyImage: vi.fn() };
    const service = new ArtworkService(
      {
        getArtistIdViaTrackSample: vi.fn().mockResolvedValue('egypt-mond-id'),
        getArtistById: vi.fn().mockResolvedValue({
          images: [{ url: 'https://i.scdn.co/image/egypt-mond', height: 640, width: 640 }],
        }),
        searchArtists: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      artistRepository as never,
      {} as never,
      {} as never,
      {} as never,
      cache as never,
    );

    const url = await service.getArtistImageUrl('Mond', 'Esme');
    expect(url).toBe('https://i.scdn.co/image/egypt-mond');
    expect(artistRepository.getArtistByName).not.toHaveBeenCalled();
  });
});
