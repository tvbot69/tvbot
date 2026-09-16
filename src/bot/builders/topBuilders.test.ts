import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { TopBuilders } from './topBuilders';
import { ResponseMode } from '@domain/enums/responseMode';
import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';

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

    container.registerInstance(WhoKnowsGenerator, mockGenerator as any);

    const res = await TopBuilders.buildTopArtistsResponse(
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

    container.registerInstance(WhoKnowsGenerator, mockGenerator as any);

    const res = await TopBuilders.buildTopAlbumsResponse(
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

    container.registerInstance(WhoKnowsGenerator, mockGenerator as any);

    const res = await TopBuilders.buildTopTracksResponse(
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
