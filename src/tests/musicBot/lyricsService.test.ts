import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LyricsService } from '@bot/services/music/lyricsService';

describe('LyricsService', () => {
  let lyricsService: LyricsService;

  beforeEach(() => {
    lyricsService = new LyricsService();
    vi.restoreAllMocks();
  });

  describe('cleanTitle', () => {
    it('strips (Official Video), [HD], and feat suffixes', () => {
      expect(lyricsService.cleanTitle('Starboy (Official Music Video)')).toBe('Starboy');
      expect(lyricsService.cleanTitle('Blinding Lights [Official Audio]')).toBe('Blinding Lights');
      expect(lyricsService.cleanTitle('Save Your Tears feat. Ariana Grande')).toBe('Save Your Tears');
      expect(lyricsService.cleanTitle('Creepin ft. 21 Savage (Remastered 4K)')).toBe('Creepin');
    });

    it('preserves clean titles untouched', () => {
      expect(lyricsService.cleanTitle('Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
    });

    it('strips - Topic and VEVO from artist names in cleanSearchQuery', () => {
      const q = lyricsService.cleanSearchQuery(
        'Lancey Foux - ALL MY GIRLS (Official Audio)',
        'Lancey Foux - Topic',
      );
      expect(q.cleanArtist).toBe('Lancey Foux');
      expect(q.cleanTitle).toBe('ALL MY GIRLS');
      expect(q.combined).toBe('Lancey Foux ALL MY GIRLS');
    });
  });

  describe('getLyrics', () => {
    it('returns formatted lyrics when LRCLIB returns a match', async () => {
      const mockResponse = {
        name: 'Bohemian Rhapsody',
        artistName: 'Queen',
        plainLyrics: 'Is this the real life? Is this just fantasy?',
        instrumental: false,
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response);

      const result = await lyricsService.getLyrics('Bohemian Rhapsody', 'Queen');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Bohemian Rhapsody');
      expect(result?.artist).toBe('Queen');
      expect(result?.plainLyrics).toContain('Is this the real life?');
    });

    it('falls back to Genius when LRCLIB returns 404', async () => {
      // LRCLIB /get fails
      // LRCLIB /search fails
      // Genius search succeeds
      // Genius HTML succeeds
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response) // LRCLIB get
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response) // LRCLIB search
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            response: {
              sections: [
                {
                  type: 'song',
                  hits: [
                    {
                      result: {
                        title: 'ALL MY GIRLS',
                        artist_names: 'Lancey Foux',
                        url: 'https://genius.com/Lancey-foux-all-my-girls-lyrics',
                      },
                    },
                  ],
                },
              ],
            },
          }),
        } as unknown as Response) // Genius search
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            '<html><body><div data-lyrics-container="true">10 ContributorsALL MY GIRLS Lyrics<br/>Bend it over, touch ya toes</div></body></html>',
        } as unknown as Response); // Genius page

      const result = await lyricsService.getLyrics('ALL MY GIRLS', 'Lancey Foux');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('genius');
      expect(result?.title).toBe('ALL MY GIRLS');
      expect(result?.plainLyrics).toContain('Bend it over, touch ya toes');
    });

    it('returns instrumental notice for instrumental tracks', async () => {
      const mockResponse = {
        name: 'Orion',
        artistName: 'Metallica',
        instrumental: true,
        plainLyrics: '',
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response);

      const result = await lyricsService.getLyrics('Orion', 'Metallica');
      expect(result).not.toBeNull();
      expect(result?.instrumental).toBe(true);
      expect(result?.plainLyrics).toContain('instrumental');
    });

    it('returns null if track is not found across all providers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      const result = await lyricsService.getLyrics('NonExistentSong123456');
      expect(result).toBeNull();
    });
  });
});
