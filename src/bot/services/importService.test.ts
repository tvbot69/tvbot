import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportService } from './importService';
import type { PrismaClient } from '@prisma/client';

describe('ImportService', () => {
  let mockPrisma: any;
  let service: ImportService;

  beforeEach(() => {
    mockPrisma = {
      user: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    service = new ImportService(mockPrisma as PrismaClient);
  });

  describe('getInstructions', () => {
    it('returns Spotify instructions when requested', () => {
      const text = service.getInstructions('spotify');
      expect(text).toContain('Spotify');
      expect(text).toContain('endsong_*.json');
    });

    it('returns Apple Music instructions when requested', () => {
      const text = service.getInstructions('apple');
      expect(text).toContain('Apple Music');
    });

    it('returns universal instructions for all', () => {
      const text = service.getInstructions('all');
      expect(text).toContain('Universal Music History Import');
      expect(text).toContain('zero paywalls');
    });
  });

  describe('parseAndImport', () => {
    it('parses Spotify endsong format and filters out plays < 30s', async () => {
      const sample = [
        {
          ts: '2023-01-01T12:00:00Z',
          master_metadata_track_name: 'Paranoid Android',
          master_metadata_album_artist_name: 'Radiohead',
          master_metadata_album_album_name: 'OK Computer',
          ms_played: 380000,
        },
        {
          ts: '2023-01-01T12:10:00Z',
          master_metadata_track_name: 'Karma Police',
          master_metadata_album_artist_name: 'Radiohead',
          master_metadata_album_album_name: 'OK Computer',
          ms_played: 20000, // < 30s, should be skipped
        },
        {
          ts: '2023-01-02T15:00:00Z',
          master_metadata_track_name: 'One More Time',
          master_metadata_album_artist_name: 'Daft Punk',
          master_metadata_album_album_name: 'Discovery',
          ms_played: 320000,
        },
      ];

      const result = await service.parseAndImport(123, JSON.stringify(sample));
      expect(result.totalScrobblesImported).toBe(2);
      expect(result.uniqueArtistsCount).toBe(2);
      expect(result.topArtists).toHaveLength(2);
      expect(result.dateRange?.from).toEqual(new Date('2023-01-01T12:00:00Z'));
      expect(result.dateRange?.to).toEqual(new Date('2023-01-02T15:00:00Z'));
      expect(mockPrisma.user.update).toHaveBeenCalled();
    });

    it('parses legacy StreamingHistory.json format', async () => {
      const sample = [
        {
          endTime: '2022-05-10 14:30',
          artistName: 'Pink Floyd',
          trackName: 'Time',
          msPlayed: 420000,
        },
      ];

      const result = await service.parseAndImport(123, JSON.stringify(sample));
      expect(result.totalScrobblesImported).toBe(1);
      expect(result.topArtists[0]?.name).toBe('Pink Floyd');
    });

    it('throws when JSON is malformed', async () => {
      await expect(service.parseAndImport(123, '{ invalid json')).rejects.toThrow('Invalid JSON file format');
    });

    it('throws when no valid scrobbles are found', async () => {
      const sample = [
        {
          ts: '2023-01-01T12:00:00Z',
          master_metadata_track_name: 'Short Track',
          master_metadata_album_artist_name: 'Artist',
          ms_played: 5000, // Skipped
        },
      ];
      await expect(service.parseAndImport(123, JSON.stringify(sample))).rejects.toThrow(
        'No valid scrobbles',
      );
    });
  });

  describe('resetImport', () => {
    it('resets totalPlayCount and returns true', async () => {
      const success = await service.resetImport(123);
      expect(success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { userId: 123 },
        data: { totalPlayCount: 0 },
      });
    });
  });
});
