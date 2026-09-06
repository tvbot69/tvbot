import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscogsService } from './discogsService';

describe('DiscogsService', () => {
  let service: DiscogsService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DiscogsService();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('searchRelease', () => {
    it('returns parsed release item on successful API response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 12345,
              title: 'Radiohead - OK Computer',
              year: '1997',
              format: ['Vinyl', 'LP', 'Album'],
              label: ['Parlophone'],
              genre: ['Rock'],
              style: ['Alternative Rock'],
              country: 'UK',
              cover_image: 'https://example.com/okc.jpg',
              uri: '/release/12345-okc',
            },
          ],
        }),
      } as any);

      const result = await service.searchRelease('Radiohead OK Computer');
      expect(result).not.toBeNull();
      expect(result?.id).toBe(12345);
      expect(result?.artist).toBe('Radiohead');
      expect(result?.title).toBe('OK Computer');
      expect(result?.year).toBe('1997');
      expect(result?.format).toContain('Vinyl');
      expect(result?.url).toBe('https://www.discogs.com/release/12345-okc');
    });

    it('falls back to heuristic search object when API fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const result = await service.searchRelease('Daft Punk Discovery');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Daft Punk Discovery');
      expect(result?.url).toContain('https://www.discogs.com/search');
    });
  });

  describe('collection management', () => {
    it('adds and retrieves items from collection', () => {
      const item = service.addToCollection('user123', 'Pink Floyd', 'Animals', 'Vinyl');
      expect(item.artist).toBe('Pink Floyd');
      expect(item.album).toBe('Animals');
      expect(item.format).toBe('Vinyl');
      expect(item.id).toBeDefined();

      const collection = service.getCollection('user123');
      expect(collection).toHaveLength(1);
      expect(collection[0]?.album).toBe('Animals');
    });

    it('removes item by 1-based index', () => {
      service.addToCollection('user123', 'Pink Floyd', 'Animals', 'Vinyl');
      service.addToCollection('user123', 'Pink Floyd', 'The Wall', 'CD');

      const removed = service.removeFromCollection('user123', '1');
      expect(removed).toBe(true);

      const collection = service.getCollection('user123');
      expect(collection).toHaveLength(1);
      expect(collection[0]?.album).toBe('The Wall');
    });

    it('removes item by id', () => {
      const item = service.addToCollection('user123', 'The Beatles', 'Abbey Road', 'Vinyl');
      const removed = service.removeFromCollection('user123', item.id);
      expect(removed).toBe(true);

      const collection = service.getCollection('user123');
      expect(collection).toHaveLength(0);
    });

    it('returns false when removing non-existent item', () => {
      const removed = service.removeFromCollection('user999', '99');
      expect(removed).toBe(false);
    });
  });

  describe('findWhoHas', () => {
    it('finds members owning release matching artist or album', () => {
      service.addToCollection('user1', 'Radiohead', 'Kid A', 'Vinyl');
      service.addToCollection('user2', 'Radiohead', 'In Rainbows', 'CD');
      service.addToCollection('user3', 'Daft Punk', 'Discovery', 'Vinyl');

      const matches = service.findWhoHas('Radiohead', ['user1', 'user2', 'user3']);
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.discordUserId)).toEqual(expect.arrayContaining(['user1', 'user2']));

      const albumMatches = service.findWhoHas('Discovery', ['user1', 'user2', 'user3']);
      expect(albumMatches).toHaveLength(1);
      expect(albumMatches[0]?.discordUserId).toBe('user3');
    });

    it('returns empty array when no members match', () => {
      const matches = service.findWhoHas('Nonexistent Band', ['user1', 'user2']);
      expect(matches).toHaveLength(0);
    });
  });
});
