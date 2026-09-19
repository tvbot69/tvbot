import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { UserUpdateQueueService } from './userUpdateQueueService';
import { UserIndexQueueService } from './userIndexQueueService';

const makeCache = (backlog: unknown[] = []) => {
  const list = [...backlog];
  return {
    isRedisReady: vi.fn(() => true),
    listPush: vi.fn(async (_key: string, values: unknown[]) => {
      list.push(...values);
    }),
    listPopCount: vi.fn(async (_key: string, count: number) => list.splice(0, count)),
    listLength: vi.fn(async () => list.length),
    setAddNX: vi.fn(async () => true),
    setRemove: vi.fn(async () => undefined),
    __list: list,
  };
};

describe('durable queues (Phase 2.2)', () => {
  it('mirrors update enqueues to Redis and trims after processing', async () => {
    const cache = makeCache();
    const queue = new UserUpdateQueueService(cache as never);
    const processed: unknown[][] = [];
    queue.registerProcessor(async (batch) => {
      processed.push(batch);
    });

    expect(queue.enqueue({ userId: 1, discordUserId: 'd1', userNameLastFm: 'u1' })).toBe(true);
    expect(cache.listPush).toHaveBeenCalledTimes(1);
    expect(cache.setAddNX).toHaveBeenCalledWith('queue:user-updates:ids', '1', 86400);

    await queue.pump();
    expect(processed).toHaveLength(1);
    expect(cache.__list).toHaveLength(0);
  });

  it('rehydrates the update queue from Redis after a restart', async () => {
    const cache = makeCache([
      { userId: 7, discordUserId: 'd7', userNameLastFm: 'u7' },
      { userId: 8, discordUserId: 'd8', userNameLastFm: 'u8' },
    ]);
    const queue = new UserUpdateQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (batch) => {
      seen.push(...batch.map((b) => b.userId));
    });

    await queue.pump();
    expect(seen.sort()).toEqual([7, 8]);
    expect(queue.size()).toBe(0);
  });

  it('rehydrates the index queue from Redis after a restart', async () => {
    const cache = makeCache([
      { userId: 9, indexQueue: true },
    ]);
    const queue = new UserIndexQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => {
      seen.push(item.userId);
    });

    await queue.pump();
    expect(seen).toEqual([9]);
  });

  it('falls back to memory when Redis is down', async () => {
    const downCache = {
      isRedisReady: () => false,
      listPush: vi.fn(),
      listPopCount: vi.fn(),
      setAddNX: vi.fn(),
      setRemove: vi.fn(),
    };
    const queue = new UserUpdateQueueService(downCache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (batch) => {
      seen.push(...batch.map((b) => b.userId));
    });

    expect(queue.enqueue({ userId: 3, discordUserId: 'd3', userNameLastFm: 'u3' })).toBe(true);
    await queue.pump();
    expect(seen).toEqual([3]);
    expect(downCache.listPush).not.toHaveBeenCalled();
  });
});
