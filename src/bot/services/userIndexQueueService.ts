import type { IndexUserQueueItem, IUserIndexQueue } from '@domain/interfaces/iuserIndexQueue';
import type { CacheService } from './cacheService';
import { Logger } from '@domain/logger';

const REDIS_LIST_KEY = 'queue:user-index';
const REDIS_IDS_KEY = 'queue:user-index:ids';
const IDS_TTL_SECONDS = 86400;

export class UserIndexQueueService implements IUserIndexQueue {
  private items: IndexUserQueueItem[] = [];
  private readonly queuedIds: Set<number> = new Set();
  private processor: ((item: IndexUserQueueItem) => Promise<void>) | null = null;
  private draining: boolean = false;
  private rehydrated: boolean = false;
  public readonly maxCapacity = 10000;

  constructor(private readonly cache?: CacheService) {}

  public enqueue(item: IndexUserQueueItem): boolean {
    if (this.queuedIds.has(item.userId) || this.items.length >= this.maxCapacity) {
      return false;
    }
    this.queuedIds.add(item.userId);
    this.items.push(item);
    // Durability mirror — see UserUpdateQueueService for the protocol.
    if (this.cache?.isRedisReady()) {
      void this.cache.listPush(REDIS_LIST_KEY, [item]).catch(() => undefined);
      void this.cache.setAddNX(REDIS_IDS_KEY, String(item.userId), IDS_TTL_SECONDS).catch(() => undefined);
    }
    return true;
  }

  public size(): number {
    return this.items.length;
  }

  public registerProcessor(processor: (item: IndexUserQueueItem) => Promise<void>): void {
    this.processor = processor;
  }

  private async rehydrate(): Promise<void> {
    if (this.rehydrated || !this.cache?.isRedisReady() || this.items.length > 0) {
      this.rehydrated = true;
      return;
    }
    this.rehydrated = true;
    try {
      const backlog = await this.cache.listPopCount<IndexUserQueueItem>(REDIS_LIST_KEY, this.maxCapacity);
      let restored = 0;
      for (const item of backlog) {
        if (!item || typeof item.userId !== 'number') continue;
        if (this.queuedIds.has(item.userId) || this.items.length >= this.maxCapacity) continue;
        this.queuedIds.add(item.userId);
        this.items.push(item);
        restored++;
      }
      if (restored > 0) {
        Logger.info(`User index queue rehydrated ${restored} items from Redis after restart`);
      }
    } catch {
      // memory path continues uninterrupted
    }
  }

  public async pump(): Promise<void> {
    await this.rehydrate().catch(() => undefined);
    if (this.draining || !this.processor || this.items.length === 0) {
      return;
    }
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (!item) {
          break;
        }
        this.queuedIds.delete(item.userId);
        if (this.cache?.isRedisReady()) {
          void this.cache.setRemove(REDIS_IDS_KEY, String(item.userId)).catch(() => undefined);
        }
        try {
          await this.processor(item);
          if (this.cache?.isRedisReady()) {
            await this.cache.listPopCount(REDIS_LIST_KEY, 1).catch(() => undefined);
          }
        } catch (err) {
          Logger.error({ err, userId: item.userId }, 'Error processing user index queue item');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
