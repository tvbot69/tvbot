import type { IndexUserQueueItem, IUserIndexQueue } from '@domain/interfaces/iuserIndexQueue';
import type { CacheService } from '@bot/services/system/cacheService';
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
      // CORRECT AS IS, but the catch is UNREACHABLE: `CacheService.redisExec`
      // catches every Redis error and resolves with the fallback, so `listPush`
      // never rejects. A command that fails while the connection reports 'ready'
      // loses the mirror with no log here or in CacheService; that swallow has to
      // move into `redisExec` to be visible at all.
      void this.cache.listPush(REDIS_LIST_KEY, [item]).catch(() => undefined);
      // Same unreachable catch, and inert besides: nothing ever READS
      // `queue:user-index:ids`, only writes and trims it.
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
      // A Redis failure CANNOT arrive here as a throw: `listPopCount` answers
      // `[]`. So the old bare catch could never run, and a backlog that could not
      // be read looked exactly like an empty one — `restored` stayed 0, nothing
      // was logged, and every user in that backlog silently lost their pending
      // full index for the life of the process. The length is therefore read
      // BEFORE the pops so the two can be compared. `listLength` also answers 0
      // when Redis is down, so `before === 0` stays silent and claims nothing;
      // only `popped < before` is a proven loss.
      const before = await this.cache.listLength(REDIS_LIST_KEY);
      const backlog = await this.cache.listPopCount<IndexUserQueueItem>(REDIS_LIST_KEY, this.maxCapacity);
      if (backlog.length < before) {
        Logger.error(
          { queuedInRedis: before, restored: backlog.length },
          'User index queue: Redis backlog was shorter than it claimed to be; some queued users were dropped unread',
        );
      }
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
    } catch (err) {
      // Unreachable for a Redis failure; kept only so an unexpected throw cannot
      // abort the pump. The memory path continues, but it continues EMPTY and the
      // backlog is lost, so this one is worth a log.
      Logger.warn({ err }, 'User index queue: rehydration failed; the Redis backlog was not restored');
    }
  }

  public async pump(): Promise<void> {
    // CORRECT AS IS: `rehydrate` handles its own failures, so this catch cannot
    // fire from a Redis error. Kept as defence against a throw in the guard above
    // rehydrate's own try; it must not stop the pump, which may already hold
    // in-memory items.
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
          // CORRECT AS IS: unreachable (`setRemove` cannot reject) and inert —
          // the ids SET is write-only, so a member that outlives its item has no
          // reader to mislead.
          void this.cache.setRemove(REDIS_IDS_KEY, String(item.userId)).catch(() => undefined);
        }
        try {
          await this.processor(item);
          if (this.cache?.isRedisReady()) {
            // CORRECT AS IS, DELIBERATELY — see UserUpdateQueueService.pump. The
            // trim is the acknowledgement; failing to trim replays an
            // idempotent index after a restart, which costs work and no
            // correctness. The catch is unreachable: `listPopCount` resolves.
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
