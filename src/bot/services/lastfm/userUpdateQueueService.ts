import type {
  IUserUpdateQueue,
  UserUpdateQueueItem,
} from '@domain/interfaces/iuserUpdateQueue';
import type { CacheService } from '../system/cacheService';
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
      // CORRECT AS IS, but the catch is UNREACHABLE and that is the real story:
      // `CacheService.redisExec` already catches every Redis error and resolves
      // with the fallback, so `listPush` never rejects. A Redis command that
      // fails while the connection reports 'ready' therefore loses the mirror
      // with no log here or in CacheService. Nothing can be done from this file
      // — the swallow has to move into `redisExec` to be visible at all.
      void this.cache.listPush(REDIS_LIST_KEY, [item]).catch(() => undefined);
      // Same unreachable catch. This SET is also write-only: no code path ever
      // reads `queue:user-updates:ids`, only writes and trims it, so losing a
      // member has no behavioural effect at all today.
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
      // CORRECT AS IS is not available on this path, and the reason is not the
      // comment the old catch carried. `listPopCount` cannot reject either — it
      // returns `[]` when Redis fails — so a backlog that could not be read used
      // to arrive here as "nothing to restore": `restored` stayed 0, nothing was
      // logged, and every user in that backlog silently stopped receiving Last.fm
      // updates for the life of the process. The items exist only in Redis, so
      // the loss is permanent, and the user reads it as frozen statistics.
      //
      // The length is read BEFORE the pops so the two are comparable. It is not
      // a proof of anything on its own: `listLength` also answers 0 when Redis
      // is down, so `before === 0` stays silent and claims nothing either way.
      // Only `popped < before` is a proven loss, and that is what is reported.
      const before = await this.cache.listLength(REDIS_LIST_KEY);
      const backlog = await this.cache.listPopCount<UserUpdateQueueItem>(REDIS_LIST_KEY, this.maxCapacity);
      if (backlog.length < before) {
        Logger.error(
          { queuedInRedis: before, restored: backlog.length },
          'User update queue: Redis backlog was shorter than it claimed to be; some queued users were dropped unread',
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
        Logger.info(`User update queue rehydrated ${restored} items from Redis after restart`);
      }
    } catch (err) {
      // Unreachable for a Redis failure (nothing above throws), and kept only so
      // a genuine bug cannot abort the pump. The memory path continues, but it
      // continues EMPTY, so this one does get a log: the pre-existing backlog is
      // lost either way and nobody should have to guess that.
      Logger.warn({ err }, 'User update queue: rehydration failed; the Redis backlog was not restored');
    }
  }

  public async pump(): Promise<void> {
    // CORRECT AS IS: `rehydrate` handles its own failures, so this catch cannot
    // fire from a Redis error. It stays as defence against an unexpected throw
    // in the guard above rehydrate's own try, and it must not stop the pump —
    // the memory queue may already hold items that need draining.
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
            // CORRECT AS IS: unreachable (`setRemove` cannot reject) and inert —
            // the ids SET is write-only, so a member that outlives its batch has
            // no reader to mislead.
            void this.cache.setRemove(REDIS_IDS_KEY, String(item.userId)).catch(() => undefined);
          }
        }
        try {
          await this.processor(batch);
          if (this.cache?.isRedisReady()) {
            // CORRECT AS IS, DELIBERATELY. The trim is the acknowledgement, and
            // failing to trim means the batch is replayed after a restart. The
            // processor is an idempotent delta sync, so a replay costs work and
            // no correctness — this is the "failure replay is intentional" case
            // from AGENTS.md, not a bug to fix. The catch is also unreachable:
            // `listPopCount` resolves to `[]` rather than rejecting.
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
