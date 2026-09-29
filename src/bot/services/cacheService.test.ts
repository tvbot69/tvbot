import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from './cacheService';

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => {
    // Create cache with small maxEntries for testing LRU
    cache = new CacheService(3);
  });

  afterEach(async () => {
    await cache.disconnect();
  });

  it('sets and retrieves values from in-memory cache', async () => {
    await cache.set('user:1', { name: 'Alice' });
    const result = await cache.get<{ name: string }>('user:1');
    expect(result).toEqual({ name: 'Alice' });
  });

  it('returns null for nonexistent keys', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeNull();
  });

  it('deletes keys explicitly', async () => {
    await cache.set('key1', 'value1');
    expect(await cache.get('key1')).toBe('value1');
    await cache.delete('key1');
    expect(await cache.get('key1')).toBeNull();
  });

  it('expires entries after TTL seconds', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('temp', 'val', 10); // 10s TTL
      expect(await cache.get('temp')).toBe('val');

      // Fast-forward 11 seconds
      vi.advanceTimersByTime(11000);

      expect(await cache.get('temp')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts least recently used entry when maxEntries is exceeded', async () => {
    // Capacity is 3
    await cache.set('k1', 1);
    await cache.set('k2', 2);
    await cache.set('k3', 3);

    expect(cache.size()).toBe(3);

    // Access k1 to make it recently used (order now: k2, k3, k1)
    await cache.get('k1');

    // Add k4 -> should evict k2 (oldest)
    await cache.set('k4', 4);

    expect(cache.size()).toBe(3);
    expect(await cache.get('k2')).toBeNull(); // k2 was evicted!
    expect(await cache.get('k1')).toBe(1);
    expect(await cache.get('k3')).toBe(3);
    expect(await cache.get('k4')).toBe(4);
  });

  it('sweepExpired removes expired keys without calling get', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('e1', 'val1', 5);
      await cache.set('e2', 'val2', 30);
      expect(cache.size()).toBe(2);

      // Advance 10s -> e1 should be expired, e2 still valid
      vi.advanceTimersByTime(10000);

      const cleaned = cache.sweepExpired();
      expect(cleaned).toBe(1);
      expect(cache.size()).toBe(1);
      expect(await cache.get('e2')).toBe('val2');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('Redis promotion', () => {
    /**
     * Installs a fake Redis on the private field; no client is opened. The
     * returned store lets a test retire the Redis key so a later `get` cannot
     * re-promote it and mask a local expiry.
     */
    const withRedis = (ttl: () => Promise<number>) => {
      const store = { gone: false };
      (cache as unknown as { redis: unknown }).redis = {
        status: 'ready',
        get: async () => (store.gone ? null : JSON.stringify('from-redis')),
        ttl,
      };
      return store;
    };

    afterEach(() => {
      (cache as unknown as { redis: unknown }).redis = null;
    });

    it('promotes with the REMAINING ttl so a finite entry cannot become permanent', async () => {
      const store = withRedis(async () => 30);
      expect(await cache.get('promo')).toBe('from-redis');
      expect(cache.size()).toBe(1);

      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(31000);
        store.gone = true;
        // Served from memory until the remaining TTL ran out, then gone — a
        // permanent promotion would answer 'from-redis' here.
        expect(await cache.get('promo')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT promote when the remaining ttl cannot be read', async () => {
      // Redis died between the GET and the TTL. The value is still served —
      // what must not happen is caching it as "no expiry", which is how a
      // 10-minute negative artwork marker froze for the life of the process.
      withRedis(async () => {
        throw new Error('connection reset');
      });
      expect(await cache.get('promo')).toBe('from-redis');
      expect(cache.size()).toBe(0);
    });

    it('does NOT promote a key that vanished between the GET and the TTL (-2)', async () => {
      withRedis(async () => -2);
      expect(await cache.get('promo')).toBe('from-redis');
      expect(cache.size()).toBe(0);
    });

    it('promotes as permanent only when Redis says there is no expiry (-1)', async () => {
      withRedis(async () => -1);
      expect(await cache.get('promo')).toBe('from-redis');
      expect(cache.size()).toBe(1);
      // Still readable after any amount of local time: -1 really is permanent.
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(600000);
        expect(await cache.get('promo')).toBe('from-redis');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
