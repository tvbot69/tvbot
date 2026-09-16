import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExposedService, ROAST_QUOTES } from './exposedService';
import type { User } from '@domain/interfaces/iuserRepository';

describe('ExposedService', () => {
  let mockGenreService: any;
  let mockPlayRepo: any;
  let mockPrisma: any;
  let service: ExposedService;

  const dummyUser: User = {
    userId: 1,
    discordUserId: BigInt(123456789),
    userNameLastFm: 'TestUser',
  } as unknown as User;

  beforeEach(() => {
    mockGenreService = {
      getTopGenresForTopArtists: vi.fn(),
      getGenresForArtist: vi.fn(),
    };

    mockPlayRepo = {
      getTopArtists: vi.fn(),
    };

    mockPrisma = {
      userArtist: {
        findMany: vi.fn(),
      },
      userPlay: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };

    service = new ExposedService(mockGenreService, mockPlayRepo, mockPrisma);
  });

  describe('generateReport', () => {
    it('returns null if user has no top artists', async () => {
      mockPlayRepo.getTopArtists.mockResolvedValue([]);
      const report = await service.generateReport(dummyUser, 'TestUser');
      expect(report).toBeNull();
    });

    it('successfully exposes a guilty pleasure artist with pop/disney genre', async () => {
      mockPlayRepo.getTopArtists.mockResolvedValue([
        { name: 'Travis Scott', playcount: 500 },
        { name: 'Playboi Carti', playcount: 450 },
        { name: 'Ken Carson', playcount: 300 },
      ]);

      mockGenreService.getTopGenresForTopArtists.mockResolvedValue([
        { genreName: 'hip-hop', userPlaycount: 950 },
        { genreName: 'trap', userPlaycount: 750 },
      ]);

      mockPrisma.userArtist.findMany.mockResolvedValue([
        { name: 'Sabrina Carpenter', playcount: 15 },
      ]);

      mockGenreService.getGenresForArtist.mockImplementation(async (artist: string) => {
        if (artist === 'Sabrina Carpenter') return ['dance-pop', 'pop'];
        return ['hip-hop'];
      });

      const report = await service.generateReport(dummyUser, 'TestUser');
      expect(report).not.toBeNull();
      expect(report?.publicArtists).toContain('Travis Scott');
      expect(report?.guiltyPleasures).toHaveLength(1);
      expect(report?.guiltyPleasures[0]?.artistName).toBe('Sabrina Carpenter');
      expect(report?.guiltyPleasures[0]?.playcount).toBe(15);
      expect(report?.shameScore).toBeGreaterThanOrEqual(50);
      expect(ROAST_QUOTES).toContain(report?.roast);
    });

    it('returns null if no divergent or loop guilty pleasures are found', async () => {
      mockPlayRepo.getTopArtists.mockResolvedValue([
        { name: 'Radiohead', playcount: 500 },
      ]);
      mockGenreService.getTopGenresForTopArtists.mockResolvedValue([
        { genreName: 'rock', userPlaycount: 500 },
      ]);
      mockPrisma.userArtist.findMany.mockResolvedValue([]);
      mockPrisma.userPlay.findMany.mockResolvedValue([]);

      const report = await service.generateReport(dummyUser, 'TestUser');
      expect(report).toBeNull();
    });
  });

  describe('checkLiveNowPlayingAnomaly', () => {
    it('returns null if artist is in user top 10', async () => {
      mockPlayRepo.getTopArtists.mockResolvedValue([
        { name: 'Travis Scott', playcount: 500 },
      ]);

      const result = await service.checkLiveNowPlayingAnomaly(dummyUser, 'guild-123', 'Travis Scott', 'FE!N');
      expect(result).toBeNull();
    });

    it('triggers an anomaly when user scrobbles an extreme outlier guilty pleasure', async () => {
      mockPlayRepo.getTopArtists.mockResolvedValue([
        { name: 'Death Grips', playcount: 800 },
        { name: 'Kendrick Lamar', playcount: 600 },
        { name: 'Denzel Curry', playcount: 400 },
      ]);

      mockGenreService.getTopGenresForTopArtists.mockResolvedValue([
        { genreName: 'experimental hip-hop', userPlaycount: 800 },
        { genreName: 'hardcore hip-hop', userPlaycount: 600 },
      ]);

      mockGenreService.getGenresForArtist.mockResolvedValue(['dance-pop', 'teen pop']);
      mockPrisma.userPlay.count.mockResolvedValue(3); // Has played it 3 times

      const result = await service.checkLiveNowPlayingAnomaly(dummyUser, 'guild-123', 'Hannah Montana', 'Best of Both Worlds');
      expect(result).not.toBeNull();
      expect(result?.isAnomaly).toBe(true);
      expect(result?.matchedGenre).toBe('dance-pop');
      expect(ROAST_QUOTES).toContain(result?.roast);

      // Second check should return null due to cooldown
      const cooldownCheck = await service.checkLiveNowPlayingAnomaly(dummyUser, 'guild-123', 'Hannah Montana', 'Best of Both Worlds');
      expect(cooldownCheck).toBeNull();
    });
  });
});
