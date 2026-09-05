import { describe, it, expect } from 'vitest';
import { UserUpdateQueueService } from './userUpdateQueueService';
import type { UserUpdateQueueItem } from '@domain/interfaces/iuserUpdateQueue';

describe('UserUpdateQueueService', () => {
  it('enqueues items and reports correct size', () => {
    const queue = new UserUpdateQueueService();
    expect(queue.size()).toBe(0);

    const added = queue.enqueue({
      userId: 1,
      discordUserId: '100',
      userNameLastFm: 'user1',
    });
    expect(added).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it('deduplicates identical userIds', () => {
    const queue = new UserUpdateQueueService();
    queue.enqueue({ userId: 1, discordUserId: '100', userNameLastFm: 'user1' });

    // Second enqueue with same userId should return false
    const duplicate = queue.enqueue({ userId: 1, discordUserId: '100', userNameLastFm: 'user1' });
    expect(duplicate).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('batches items in chunks of 25 during pump', async () => {
    const queue = new UserUpdateQueueService();
    const batchesProcessed: UserUpdateQueueItem[][] = [];

    queue.registerProcessor(async (batch) => {
      batchesProcessed.push(batch);
    });

    // Enqueue 30 items
    for (let i = 1; i <= 30; i++) {
      queue.enqueue({
        userId: i,
        discordUserId: `discord_${i}`,
        userNameLastFm: `lfm_${i}`,
      });
    }

    expect(queue.size()).toBe(30);
    await queue.pump();

    // Should have 2 batches: first of 25, second of 5
    expect(batchesProcessed.length).toBe(2);
    expect(batchesProcessed[0]?.length).toBe(25);
    expect(batchesProcessed[1]?.length).toBe(5);
    expect(queue.size()).toBe(0);
  });

  it('isolates errors so subsequent batches continue processing', async () => {
    const queue = new UserUpdateQueueService();
    const processedIds: number[] = [];

    let callCount = 0;
    queue.registerProcessor(async (batch) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Transient batch failure');
      }
      for (const item of batch) {
        processedIds.push(item.userId);
      }
    });

    // Enqueue 30 items (first 25 in batch 1 which fails, next 5 in batch 2 which succeeds)
    for (let i = 1; i <= 30; i++) {
      queue.enqueue({
        userId: i,
        discordUserId: `discord_${i}`,
        userNameLastFm: `lfm_${i}`,
      });
    }

    await queue.pump();

    // Second batch of 5 should have succeeded despite the first batch failing
    expect(processedIds.length).toBe(5);
    expect(processedIds).toEqual([26, 27, 28, 29, 30]);
    expect(queue.size()).toBe(0);
  });
});
