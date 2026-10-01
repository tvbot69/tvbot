import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { TopBuilders } from '@bot/builders/library/topBuilders';
import { ResponseMode } from '@domain/enums/responseMode';
import type { TopBuildersDeps } from '@bot/builders/library/topBuildersDeps';

/** Nothing registered: the shape of a partially built container. */
const NO_DEPS: TopBuildersDeps = {
  generator: null,
  artistsService: null,
  artworkService: null,
  deezerApi: null,
  lastfmRepo: null,
  spotifyApi: null,
};

/** NO_DEPS plus a stub generator, for the Image-mode cases. */
const depsWithGenerator = (mockGenerator: unknown): TopBuildersDeps => ({
  ...NO_DEPS,
  generator: mockGenerator as never,
});

describe('TopBuilders', () => {
  const dummyArtists = [
    { name: 'Radiohead', playcount: 500, imageUrl: 'https://img.spotify.com/radiohead.jpg' },
    { name: 'The Beatles', playcount: 350, imageUrl: 'https://img.spotify.com/beatles.jpg' },
  ];

  const dummyAlbums = [
    { name: 'OK Computer', artistName: 'Radiohead', playcount: 300, imageUrl: 'https://img.spotify.com/okc.jpg' },
    { name: 'Abbey Road', artistName: 'The Beatles', playcount: 200, imageUrl: 'https://img.spotify.com/abbey.jpg' },
  ];

  const dummyTracks = [
    { name: 'Paranoid Android', artistName: 'Radiohead', playcount: 150, imageUrl: 'https://img.spotify.com/pa.jpg' },
    { name: 'Karma Police', artistName: 'Radiohead', playcount: 100, imageUrl: 'https://img.spotify.com/kp.jpg' },
  ];

  const timeSettings = {
    timePeriod: 'weekly',
    description: 'Weekly',
    urlParameter: 'LAST_7_DAYS',
  } as any;

  it('builds standard embed when mode is Embed', async () => {
    const res = await TopBuilders.buildTopArtistsResponse(
      NO_DEPS,
      'moha',
      'moha',
      dummyArtists,
      timeSettings,
      0,
      0x5500ff,
      ResponseMode.Embed,
    );

    expect(res.hasEmbed()).toBe(true);
    expect(res.hasFile()).toBe(false);
    expect(res.embed?.data.description).toContain('Radiohead');
  });

  it('generates image card using WhoKnowsGenerator when mode is Image', async () => {
    const mockGenerator = {
      generateWhoKnowsImage: vi.fn().mockResolvedValue(Buffer.from('fake_image_bytes')),
    };

    
    const res = await TopBuilders.buildTopArtistsResponse(
      depsWithGenerator(mockGenerator),
      'moha',
      'moha',
      dummyArtists,
      timeSettings,
      0,
      0x5500ff,
      ResponseMode.Image,
    );

    expect(mockGenerator.generateWhoKnowsImage).toHaveBeenCalled();
    expect(res.hasFile()).toBe(true);
    const files = res.getFiles();
    expect(files.length).toBe(1);
    expect((files[0] as any).name).toBe('topartists.png');
  });

  it('generates image card for top albums in Image mode', async () => {
    const mockGenerator = {
      generateWhoKnowsImage: vi.fn().mockResolvedValue(Buffer.from('fake_album_image')),
    };

    
    const res = await TopBuilders.buildTopAlbumsResponse(
      depsWithGenerator(mockGenerator),
      'moha',
      'moha',
      dummyAlbums,
      timeSettings,
      0,
      0x5500ff,
      ResponseMode.Image,
    );

    expect(mockGenerator.generateWhoKnowsImage).toHaveBeenCalled();
    expect(res.hasFile()).toBe(true);
    const files = res.getFiles();
    expect((files[0] as any).name).toBe('topalbums.png');
  });

  it('generates image card for top tracks in Image mode', async () => {
    const mockGenerator = {
      generateWhoKnowsImage: vi.fn().mockResolvedValue(Buffer.from('fake_track_image')),
    };

    
    const res = await TopBuilders.buildTopTracksResponse(
      depsWithGenerator(mockGenerator),
      'moha',
      'moha',
      dummyTracks,
      timeSettings,
      0,
      0x5500ff,
      ResponseMode.Image,
    );

    expect(mockGenerator.generateWhoKnowsImage).toHaveBeenCalled();
    expect(res.hasFile()).toBe(true);
    const files = res.getFiles();
    expect((files[0] as any).name).toBe('toptracks.png');
  });
});
