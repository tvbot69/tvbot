import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MusicIntelligenceService } from './musicIntelligenceService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { PrismaClient } from '@prisma/client';

describe('MusicIntelligenceService', () => {
  let service: MusicIntelligenceService;
  let mockLastfmRepo: Partial<ILastfmRepository>;
  let mockPrisma: any;
  let mockGenreService: any;
  let mockCountryService: any;

  beforeEach(() => {
    mockLastfmRepo = {
      loveTrack: vi.fn().mockResolvedValue(true),
      unloveTrack: vi.fn().mockResolvedValue(true),
      getLovedTracks: vi.fn().mockResolvedValue({
        tracks: [
          { name: 'Paranoid Android', artistName: 'Radiohead', playcount: 1, url: 'https://last.fm/track1' },
          { name: 'Heroes', artistName: 'David Bowie', playcount: 1, url: 'https://last.fm/track2' },
        ],
        total: 2,
      }),
      scrobbleTrack: vi.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      $queryRawUnsafe: vi.fn(),
      artist: {
        findMany: vi.fn(),
      },
      guildUser: {
        findMany: vi.fn(),
      },
      userArtist: {
        findMany: vi.fn(),
      },
    };

    mockGenreService = {
      getTopGenresForTopArtists: vi.fn().mockResolvedValue([
        { genreName: 'rock', userPlaycount: 100 },
        { genreName: 'alternative', userPlaycount: 80 },
      ]),
    };

    mockCountryService = {
      getTopCountriesForTopArtists: vi.fn().mockResolvedValue([
        { countryCode: 'gb', countryName: 'United Kingdom', playcount: 120 },
      ]),
    };

    service = new MusicIntelligenceService(
      mockLastfmRepo as ILastfmRepository,
      mockPrisma as PrismaClient,
      mockGenreService,
      mockCountryService,
    );
  });

  describe('getListeningGaps', () => {
    it('returns artist gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486.2,
          total_plays: 350n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'artist', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('The Cure');
      expect(gaps[0]!.gapDays).toBe(486);
      expect(gaps[0]!.totalPlays).toBe(350);
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('returns album gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'Disintegration',
          artist_name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486,
          total_plays: 80n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'album', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('Disintegration');
      expect(gaps[0]!.artistName).toBe('The Cure');
    });

    it('returns track gaps correctly from raw SQL results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          name: 'Pictures of You',
          artist_name: 'The Cure',
          resume_date: new Date('2024-05-01T00:00:00Z'),
          prev_played: new Date('2023-01-01T00:00:00Z'),
          gap_days: 486,
          total_plays: 40n,
        },
      ]);

      const gaps = await service.getListeningGaps(1, 'track', 90);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.name).toBe('Pictures of You');
      expect(gaps[0]!.artistName).toBe('The Cure');
    });
  });

  describe('getDiscoveries', () => {
    it('returns newly discovered artists in the timeframe', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        {
          artist_name: 'Fontaines D.C.',
          first_play: new Date('2024-02-15T00:00:00Z'),
          playcount: 142n,
        },
        {
          artist_name: 'Geese',
          first_play: new Date('2024-03-10T00:00:00Z'),
          playcount: 65n,
        },
      ]);

      const start = new Date('2024-01-01');
      const end = new Date('2024-04-01');
      const discoveries = await service.getDiscoveries(1, start, end);

      expect(discoveries).toHaveLength(2);
      expect(discoveries[0]!.artistName).toBe('Fontaines D.C.');
      expect(discoveries[0]!.playcount).toBe(142);
      expect(discoveries[1]!.artistName).toBe('Geese');
    });
  });

  describe('getIceberg', () => {
    it('distributes artists into 5 tiers based on popularity', async () => {
      mockPrisma.artist.findMany.mockResolvedValueOnce([
        { name: 'Taylor Swift', popularity: 95 },
        { name: 'Deftones', popularity: 72 },
        { name: 'Sweet Trip', popularity: 48 },
        { name: 'Parannoul', popularity: 28 },
        { name: 'Panchiko', popularity: 12 },
      ]);

      const topArtists = [
        { name: 'Taylor Swift', playcount: 500 },
        { name: 'Deftones', playcount: 300 },
        { name: 'Sweet Trip', playcount: 200 },
        { name: 'Parannoul', playcount: 150 },
        { name: 'Panchiko', playcount: 100 },
      ];

      const iceberg = await service.getIceberg(1, topArtists, 'Alex', 'alex_lfm', 'All time');

      expect(iceberg.tiers).toHaveLength(5);
      expect(iceberg.tiers[0]!.artists[0]!.name).toBe('Taylor Swift'); // Tier 1: 95
      expect(iceberg.tiers[1]!.artists[0]!.name).toBe('Deftones');     // Tier 2: 72
      expect(iceberg.tiers[2]!.artists[0]!.name).toBe('Sweet Trip');   // Tier 3: 48
      expect(iceberg.tiers[3]!.artists[0]!.name).toBe('Parannoul');    // Tier 4: 28
      expect(iceberg.tiers[4]!.artists[0]!.name).toBe('Panchiko');     // Tier 5: 12
    });
  });

  describe('getGuildAffinity', () => {
    it('computes taste similarity between target user and guild members', async () => {
      mockPrisma.guildUser.findMany.mockResolvedValueOnce([
        {
          userId: 2,
          guildId: 1000n,
          user: {
            userId: 2,
            discordUserId: 222222222222222222n,
            userNameLastFm: 'charlie_lfm',
          },
        },
      ]);

      mockPrisma.userArtist.findMany
        .mockResolvedValueOnce([
          { name: 'Radiohead', playcount: 500 },
          { name: 'Slowdive', playcount: 300 },
          { name: 'The Cure', playcount: 200 },
        ])
        .mockResolvedValueOnce([
          { userId: 2, name: 'Radiohead', playcount: 400 },
          { userId: 2, name: 'Slowdive', playcount: 250 },
        ]);

      const affinity = await service.getGuildAffinity(
        '1000',
        1,
        'Alex',
        'alex_lfm',
        'Music Server',
      );

      expect(affinity.neighbors).toHaveLength(1);
      expect(affinity.neighbors[0]!.userNameLastFm).toBe('charlie_lfm');
      expect(affinity.neighbors[0]!.totalPercentage).toBeGreaterThan(0);
      expect(affinity.neighbors[0]!.sharedArtists).toContain('Radiohead');
      expect(affinity.neighbors[0]!.sharedArtists).toContain('Slowdive');
    });
  });

  describe('Last.fm actions', () => {
    it('loves a track', async () => {
      const result = await service.loveTrack('test_sk', 'Radiohead', 'Creep');
      expect(result).toBe(true);
      expect(mockLastfmRepo.loveTrack).toHaveBeenCalledWith('Radiohead', 'Creep', 'test_sk');
    });

    it('unloves a track', async () => {
      const result = await service.unloveTrack('test_sk', 'Radiohead', 'Creep');
      expect(result).toBe(true);
      expect(mockLastfmRepo.unloveTrack).toHaveBeenCalledWith('Radiohead', 'Creep', 'test_sk');
    });

    it('gets loved tracks', async () => {
      const result = await service.getLovedTracks('alex_lfm', 20, 1, 'test_sk');
      expect(result.tracks).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(mockLastfmRepo.getLovedTracks).toHaveBeenCalledWith('alex_lfm', 20, 1, 'test_sk');
    });

    it('scrobbles a track', async () => {
      const result = await service.scrobbleTrack('test_sk', 'Radiohead', 'Karma Police', 'OK Computer', 1700000000);
      expect(result).toBe(true);
      expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledWith(
        'Radiohead',
        'Karma Police',
        1700000000,
        'test_sk',
        'OK Computer',
      );
    });
  });
});
