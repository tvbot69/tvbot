import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { RateLimitService } from './rateLimitService';
import { CacheService } from './cacheService';

describe('RateLimitService', () => {
  beforeEach(() => {
    container.clearInstances();
  });

  it('limits via memory windows when Redis is unavailable', async () => {
    const service = new RateLimitService();
    for (let i = 0; i < 13; i++) {
      const res = await service.checkUserRateLimitAsync('user-mem');
      expect(res.rateLimited).toBe(false);
    }
    const limited = await service.checkUserRateLimitAsync('user-mem');
    expect(limited.rateLimited).toBe(true);
    expect(limited.retryAfterSeconds).toBe(8);
  });

  it('shares budgets across processes via Redis counters', async () => {
    const counts = new Map<string, number>();
    const store = new Map<string, number>();
    const mockCache = {
      isRedisReady: () => true,
      incrWithExpiry: vi.fn(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      }),
      get: vi.fn(async (key: string) => (store.has(key) ? 1 : null)),
      set: vi.fn(async (key: string, value: number) => {
        store.set(key, value);
      }),
    };
    container.registerInstance(CacheService, mockCache as never);

    // Simulate two processes (two service instances, one Redis)
    const procA = new RateLimitService();
    const procB = new RateLimitService();
    for (let i = 0; i < 6; i++) {
      await procA.checkUserRateLimitAsync('user-shared');
      await procB.checkUserRateLimitAsync('user-shared');
    }
    await procA.checkUserRateLimitAsync('user-shared');
    // 14th hits the 13-request short window across both instances
    const limited = await procB.checkUserRateLimitAsync('user-shared');
    expect(limited.rateLimited).toBe(true);
    expect(limited.messageSent).toBe(false);
    // Second violation reuses the penalty notice instead of spamming
    const again = await procA.checkUserRateLimitAsync('user-shared');
    expect(again.rateLimited).toBe(true);
    expect(again.messageSent).toBe(true);
  });

  it('degrades to memory when Redis blips mid-call', async () => {
    const mockCache = {
      isRedisReady: () => true,
      incrWithExpiry: vi.fn(async () => 0),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    container.registerInstance(CacheService, mockCache as never);

    const service = new RateLimitService();
    const res = await service.checkUserRateLimitAsync('user-blip');
    expect(res.rateLimited).toBe(false);
  });
});
