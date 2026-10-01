import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeaturedService } from '@bot/services/library/featuredService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
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

  /**
   * The other half of the test above, and the reason for it.
   *
   * Both Last.fm reads used to end in `.catch(() => [])`, and an empty list
   * leaves `artistName` at its `'Unknown Artist'` default. The entry this builds
   * is rendered with the selected user's real Discord name, so a Last.fm outage
   * published a card asserting that a named human featured "Unknown Artist" with
   * 0 plays, and pushed it onto `historyLog` where the featured log keeps
   * showing it for the next 25 picks. Confidently wrong, about a person, and
   * not self-clearing.
   */
  it('propagates a Last.fm outage rather than featuring an "Unknown Artist"', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { userId: 3, discordUserId: BigInt('1003'), userNameLastFm: 'outage_listener' },
    ]);

    vi.mocked(mockLastfmRepo.getTopAlbums!).mockRejectedValue(
      new LastFmUnavailableError('user.gettopalbums', new Error('Last.fm returned HTTP 500')),
    );

    await expect(service.pickNewFeatured()).rejects.toBeInstanceOf(LastFmUnavailableError);
    // Nothing may be recorded: a raised read that still pushed an entry would
    // leave the bad card in the history log even though the command failed.
    expect(service.getFeaturedLog()).toHaveLength(0);
  });

  it('propagates a Last.fm outage on the track fallback read as well', async () => {
    // The second `.catch` is a separate statement, so it is a separate hole.
    // The albums read resolving to `[]` is the REAL not-found path, which must
    // still fall through to tracks exactly as before.
    mockPrisma.user.findMany.mockResolvedValue([
      { userId: 4, discordUserId: BigInt('1004'), userNameLastFm: 'track_outage_listener' },
    ]);

    vi.mocked(mockLastfmRepo.getTopAlbums!).mockResolvedValue([]);
    vi.mocked(mockLastfmRepo.getTopTracks!).mockRejectedValue(
      new LastFmUnavailableError('user.gettoptracks', new Error('Last.fm returned HTTP 500')),
    );

    await expect(service.pickNewFeatured()).rejects.toBeInstanceOf(LastFmUnavailableError);
    expect(service.getFeaturedLog()).toHaveLength(0);
  });
});
