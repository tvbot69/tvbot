import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeaturedService } from './featuredService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { PrismaClient } from '@prisma/client';

describe('FeaturedService', () => {
  let service: FeaturedService;
  let mockLastfmRepo: Partial<ILastfmRepository>;
  let mockPrisma: any;

  beforeEach(() => {
    mockLastfmRepo = {
      getTopAlbums: vi.fn(),
      getTopTracks: vi.fn(),
    };

    mockPrisma = {
      user: {
        findMany: vi.fn(),
      },
    };

    service = new FeaturedService(
      mockLastfmRepo as ILastfmRepository,
      mockPrisma as PrismaClient,
    );
  });

  it('selects and records a new featured user from active listeners', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { userId: 1, discordUserId: BigInt('1001'), userNameLastFm: 'active_listener' },
    ]);

    vi.mocked(mockLastfmRepo.getTopAlbums!).mockResolvedValue([
      {
        name: 'In Rainbows',
        artistName: 'Radiohead',
        playcount: 45,
        imageUrl: 'https://lastfm.freetls.fastly.net/in_rainbows.jpg',
      },
    ]);

    const featured = await service.pickNewFeatured();

    expect(featured).toBeDefined();
    expect(featured?.artistName).toBe('Radiohead');
    expect(featured?.albumName).toBe('In Rainbows');
    expect(featured?.playcount).toBe(45);
    expect(featured?.userNameLastFm).toBe('active_listener');

    const log = service.getFeaturedLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.artistName).toBe('Radiohead');
  });

  it('falls back to top tracks if no top albums exist', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { userId: 2, discordUserId: BigInt('1002'), userNameLastFm: 'track_listener' },
    ]);

    vi.mocked(mockLastfmRepo.getTopAlbums!).mockResolvedValue([]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockResolvedValue([
      {
        name: 'Pyramid Song',
        artistName: 'Radiohead',
        playcount: 22,
        imageUrl: 'https://lastfm.freetls.fastly.net/pyramid_song.jpg',
      },
    ]);

    const featured = await service.pickNewFeatured();

    expect(featured).toBeDefined();
    expect(featured?.artistName).toBe('Radiohead');
    expect(featured?.trackName).toBe('Pyramid Song');
    expect(featured?.playcount).toBe(22);
  });
});
