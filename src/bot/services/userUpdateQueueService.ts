import type {
  IUserUpdateQueue,
  UserUpdateQueueItem,
} from '@domain/interfaces/iuserUpdateQueue';
import type { CacheService } from './cacheService';
import { Logger } from '@domain/logger';

const BATCH_SIZE = 25;
const REDIS_LIST_KEY = 'queue:user-updates';
const REDIS_IDS_KEY = 'queue:user-updates:ids';
const IDS_TTL_SECONDS = 86400;

export class UserUpdateQueueService implements IUserUpdateQueue {
  private items: UserUpdateQueueItem[] = [];
  private readonly queuedIds: Set<number> = new Set();
  private processor: ((items: UserUpdateQueueItem[]) => Promise<void>) | null = null;
  private draining: boolean = false;
  private rehydrated: boolean = false;
  public readonly maxCapacity = 10000;

  constructor(private readonly cache?: CacheService) {}

  public enqueue(item: UserUpdateQueueItem): boolean {
    if (this.queuedIds.has(item.userId) || this.items.length >= this.maxCapacity) {
      return false;
    }
    this.queuedIds.add(item.userId);
    this.items.push(item);
    // Durability mirror: a restart used to silently drop every queued user.
    // The mirror is rehydrated on the next pump; trim happens only after the
    // batch processes, so a crash replays at most one (idempotent) batch.
    if (this.cache?.isRedisReady()) {
      void this.cache.listPush(REDIS_LIST_KEY, [item]).catch(() => undefined);
      void this.cache.setAddNX(REDIS_IDS_KEY, String(item.userId), IDS_TTL_SECONDS).catch(() => undefined);
    }
    return true;
  }

  public size(): number {
    return this.items.length;
  }

  public registerProcessor(processor: (items: UserUpdateQueueItem[]) => Promise<void>): void {
    this.processor = processor;
  }

  private async rehydrate(): Promise<void> {
    if (this.rehydrated || !this.cache?.isRedisReady() || this.items.length > 0) {
      this.rehydrated = true;
      return;
    }
    this.rehydrated = true;
    try {
      const backlog = await this.cache.listPopCount<UserUpdateQueueItem>(REDIS_LIST_KEY, this.maxCapacity);
      let restored = 0;
      for (const item of backlog) {
        if (!item || typeof item.userId !== 'number') continue;
        if (this.queuedIds.has(item.userId) || this.items.length >= this.maxCapacity) continue;
        this.queuedIds.add(item.userId);
        this.items.push(item);
        restored++;
      }
      if (restored > 0) {
        Logger.info(`User update queue rehydrated ${restored} items from Redis after restart`);
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
        const batch = this.items.splice(0, BATCH_SIZE);
        for (const item of batch) {
          this.queuedIds.delete(item.userId);
          if (this.cache?.isRedisReady()) {
            void this.cache.setRemove(REDIS_IDS_KEY, String(item.userId)).catch(() => undefined);
          }
        }
        try {
          await this.processor(batch);
          if (this.cache?.isRedisReady()) {
            await this.cache.listPopCount(REDIS_LIST_KEY, batch.length).catch(() => undefined);
          }
        } catch (err) {
          Logger.error({ err, batchSize: batch.length }, 'Error processing user update queue batch');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
