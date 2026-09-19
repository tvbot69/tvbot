import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { ImportService } from './importService';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { IndexService } from './indexService';
import type { PrismaClient } from '@prisma/client';

describe('ImportService', () => {
  let mockPrisma: any;
  let service: ImportService;

  beforeEach(() => {
    mockPrisma = {
      user: {
        update: vi.fn().mockResolvedValue({}),
      },
      userPlay: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new ImportService(mockPrisma as PrismaClient);
  });

  afterEach(() => {
    container.clearInstances();
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

    it('deletes imported rows so the library matches the counter', async () => {
      await service.resetImport(123);
      expect(mockPrisma.userPlay.deleteMany).toHaveBeenCalledWith({
        where: { userId: 123, playSource: { in: ['SpotifyImport', 'AppleMusicImport'] } },
      });
    });
  });

  describe('persistence (Phase 1.1)', () => {
    const sample = [
      {
        ts: '2023-01-01T12:00:00Z',
        master_metadata_track_name: 'Paranoid Android',
        master_metadata_album_artist_name: 'Radiohead',
        master_metadata_album_album_name: 'OK Computer',
        ms_played: 380000,
      },
      {
        ts: '2023-01-02T15:00:00Z',
        master_metadata_track_name: 'One More Time',
        master_metadata_album_artist_name: 'Daft Punk',
        master_metadata_album_album_name: 'Discovery',
        ms_played: 320000,
      },
    ];

    const wireRepos = (existingKeys: Set<string>) => {
      const batchInsertPlays = vi.fn(async (rows: unknown[]) => rows.length);
      const recalculateTopLists = vi.fn(async () => undefined);
      container.registerInstance(
        PlayRepository,
        { findExistingPlayKeys: vi.fn(async () => existingKeys), batchInsertPlays } as never,
      );
      container.registerInstance(IndexService, { recalculateTopLists } as never);
      return { batchInsertPlays, recalculateTopLists };
    };

    it('stores parsed scrobbles and rebuilds aggregates', async () => {
      const { batchInsertPlays, recalculateTopLists } = wireRepos(new Set());

      const result = await service.parseAndImport(123, JSON.stringify(sample));

      expect(result.newRowsInserted).toBe(2);
      expect(batchInsertPlays).toHaveBeenCalledTimes(1);
      const rows = batchInsertPlays.mock.calls[0]![0] as Array<{ playSource: string }>;
      expect(rows.every((r) => r.playSource === 'SpotifyImport')).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { userId: 123 },
        data: { totalPlayCount: { increment: 2 } },
      });
      expect(recalculateTopLists).toHaveBeenCalledWith(123);
    });

    it('treats re-uploads as no-ops without moving the counter', async () => {
      const { batchInsertPlays } = wireRepos(
        new Set([
          `${new Date('2023-01-01T12:00:00Z').getTime()}|Radiohead|Paranoid Android`,
          `${new Date('2023-01-02T15:00:00Z').getTime()}|Daft Punk|One More Time`,
        ]),
      );

      const result = await service.parseAndImport(123, JSON.stringify(sample));

      expect(result.newRowsInserted).toBe(0);
      expect(batchInsertPlays).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
