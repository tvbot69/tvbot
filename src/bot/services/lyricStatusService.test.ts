import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LyricStatusService } from './lyricStatusService';
import { ActivityType } from 'discord.js';

describe('LyricStatusService', () => {
  let mockClient: any;
  let mockLyricsService: any;
  let mockPrisma: any;
  let service: LyricStatusService;

  beforeEach(() => {
    mockClient = {
      user: {
        setPresence: vi.fn(),
      },
    };

    mockLyricsService = {
      getLyrics: vi.fn(),
    };

    mockPrisma = {
      userPlay: {
        findMany: vi.fn(),
      },
      userTrack: {
        findMany: vi.fn(),
      },
    };

    service = new LyricStatusService(mockClient, mockLyricsService, mockPrisma);
  });

  describe('extractPunchyLyricLine', () => {
    it('returns null for empty or invalid lyrics', () => {
      expect(LyricStatusService.extractPunchyLyricLine('')).toBeNull();
      expect(LyricStatusService.extractPunchyLyricLine(null as any)).toBeNull();
    });

    it('filters out bracketed headers, genius tags, and very short/long lines', () => {
      const sample = `
[Verse 1: Kendrick Lamar]
14 Contributors
Yeah
Yo
Too short
[Chorus]
Now this is a properly sized lyric line that should definitely pass through
And this is another super great and catchy line from the song
Instrumental
1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890
Embed
`;
      const line = LyricStatusService.extractPunchyLyricLine(sample);
      expect(line).not.toBeNull();
      expect(line?.startsWith('[')).toBe(false);
      expect(line).not.toContain('Contributors');
      expect(line).not.toBe('Yeah');
      expect(line).not.toBe('Yo');
      expect(['Now this is a properly sized lyric line that should definitely pass through', 'And this is another super great and catchy line from the song']).toContain(line);
    });

    it('strips surrounding quotes from extracted lines', () => {
      const sample = `
"We're just two lost souls swimming in a fish bowl"
`;
      const line = LyricStatusService.extractPunchyLyricLine(sample);
      expect(line).toBe("We're just two lost souls swimming in a fish bowl");
    });
  });

  describe('formatStatus', () => {
    it('formats normal lyric and artist within limit', () => {
      const formatted = LyricStatusService.formatStatus('Swimming in a fish bowl year after year', 'Pink Floyd');
      expect(formatted).toBe('"Swimming in a fish bowl year after year" — Pink Floyd');
    });

    it('truncates long lyric line cleanly to stay under 120 characters', () => {
      const longLyric = 'A'.repeat(150);
      const formatted = LyricStatusService.formatStatus(longLyric, 'Very Long Artist Name Here');
      expect(formatted.length).toBeLessThanOrEqual(120);
      expect(formatted).toContain('…');
      expect(formatted).toContain('Very Long Artist Name Here');
    });
  });

  describe('getCandidateTracks', () => {
    it('fetches and deduplicates recent plays from userPlay', async () => {
      mockPrisma.userPlay.findMany.mockResolvedValue([
        { artistName: 'Radiohead', trackName: 'Creep' },
        { artistName: 'Radiohead', trackName: 'Creep' },
        { artistName: 'Daft Punk', trackName: 'One More Time' },
      ]);

      const candidates = await service.getCandidateTracks();
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toEqual({ artist: 'Radiohead', title: 'Creep' });
      expect(candidates[1]).toEqual({ artist: 'Daft Punk', title: 'One More Time' });
    });

    it('falls back to userTrack when userPlay returns no tracks', async () => {
      mockPrisma.userPlay.findMany.mockResolvedValue([]);
      mockPrisma.userTrack.findMany.mockResolvedValue([
        { name: 'Starboy', track: { artist: { name: 'The Weeknd' } } },
      ]);

      const candidates = await service.getCandidateTracks();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual({ artist: 'The Weeknd', title: 'Starboy' });
    });

    it('handles db errors safely and returns empty array', async () => {
      mockPrisma.userPlay.findMany.mockRejectedValue(new Error('DB Connection dropped'));

      const candidates = await service.getCandidateTracks();
      expect(candidates).toEqual([]);
    });
  });

  describe('updateLyricStatusAsync', () => {
    it('successfully updates presence when valid lyric is found', async () => {
      mockPrisma.userPlay.findMany.mockResolvedValue([
        { artistName: 'Daft Punk', trackName: 'Get Lucky' },
      ]);

      mockLyricsService.getLyrics.mockResolvedValue({
        title: 'Get Lucky',
        artist: 'Daft Punk',
        instrumental: false,
        plainLyrics: `
[Chorus]
We've come too far to give up who we are
So let's raise the bar and our cups to the stars
`,
      });

      const success = await service.updateLyricStatusAsync();
      expect(success).toBe(true);
      expect(mockClient.user.setPresence).toHaveBeenCalledTimes(1);
      const callArg = mockClient.user.setPresence.mock.calls[0][0];
      expect(callArg.status).toBe('online');
      expect(callArg.activities[0].type).toBe(ActivityType.Listening);
      expect(callArg.activities[0].name).toContain('Daft Punk');
    });

    it('tries next candidate if first candidate is instrumental or has no lyrics', async () => {
      mockPrisma.userPlay.findMany.mockResolvedValue([
        { artistName: 'Ludwig Göransson', trackName: 'Can You Hear The Music' },
        { artistName: 'Queen', trackName: 'Bohemian Rhapsody' },
      ]);

      mockLyricsService.getLyrics
        .mockResolvedValueOnce({
          title: 'Can You Hear The Music',
          artist: 'Ludwig Göransson',
          instrumental: true,
          plainLyrics: '',
        })
        .mockResolvedValueOnce({
          title: 'Bohemian Rhapsody',
          artist: 'Queen',
          instrumental: false,
          plainLyrics: 'Is this the real life? Is this just fantasy?\nCaught in a landslide, no escape from reality',
        });

      const success = await service.updateLyricStatusAsync();
      expect(success).toBe(true);
      expect(mockClient.user.setPresence).toHaveBeenCalledTimes(1);
    });

    it('skips rotation if minimum interval has not elapsed and force is false', async () => {
      mockPrisma.userPlay.findMany.mockResolvedValue([
        { artistName: 'Daft Punk', trackName: 'Get Lucky' },
      ]);
      mockLyricsService.getLyrics.mockResolvedValue({
        title: 'Get Lucky',
        artist: 'Daft Punk',
        instrumental: false,
        plainLyrics: 'We have come too far to give up who we are\nSo let us raise the bar',
      });

      const first = await service.updateLyricStatusAsync();
      expect(first).toBe(true);
      expect(mockClient.user.setPresence).toHaveBeenCalledTimes(1);

      // Second immediate update should skip
      const second = await service.updateLyricStatusAsync();
      expect(second).toBe(false);
      expect(mockClient.user.setPresence).toHaveBeenCalledTimes(1);

      // Force = true bypasses cooldown
      const third = await service.updateLyricStatusAsync(true);
      expect(third).toBe(true);
      expect(mockClient.user.setPresence).toHaveBeenCalledTimes(2);
    });
  });
});
