import { container } from 'tsyringe';
import { CacheService } from '@bot/services/system/cacheService';
import { Logger } from '@domain/logger';

/** Lazily resolves the shared cache without constructor churn. */
export const resolveCacheService = (): CacheService | null => {
  try {
    return container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
  } catch (err) {
    // CORRECT AS IS: a container that cannot answer is broken for every consumer
    // at once, and raising here would turn a DI problem into a crash in whichever
    // interaction happened to read a session first. Every caller below already
    // treats a null cache as "memory only", which is a working store.
    Logger.warn({ err }, '[TtlStore] CacheService could not be resolved; sessions are memory-only');
    return null;
  }
};

/**
 * Dual-layer TTL store for interaction sessions (paginators, search results,
 * ranking queries). Memory first for speed; Redis mirror for survival across
 * restarts and (later) shards. Values must be JSON-serializable — pass a
 * `revive` hook for types JSON mangles (e.g. Date fields).
 *
 * `set` stays synchronous for the memory write (call sites are sync) with a
 * fire-and-forget Redis mirror; `get` is async for the Redis read-through.
 */
export class TtlStore<T> {
  private readonly mem = new Map<string, { value: T; expiresAt: number }>();
  /**
   * Memory entries were only ever removed on a matching `get`, and every
   * `/music search` writes TWO keys (user id + interaction id) holding up to
   * 10 MusicTrack objects. A user who searched a few hundred times grew this
   * without bound until restart. Bounded, oldest-first, and expired entries
   * are swept opportunistically.
   */
  private static readonly MAX_ENTRIES = 500;

  constructor(
    private readonly prefix: string,
    private readonly ttlSeconds: number,
    private readonly revive?: (value: T) => T,
  ) {}

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.mem) {
      if (entry.expiresAt <= now) this.mem.delete(key);
    }
    while (this.mem.size > TtlStore.MAX_ENTRIES) {
      const oldest = this.mem.keys().next();
      if (oldest.done) break;
      this.mem.delete(oldest.value);
    }
  }

  public set(key: string, value: T): void {
    this.prune();
    this.mem.set(key, { value, expiresAt: Date.now() + this.ttlSeconds * 1000 });
    const cache = resolveCacheService();
    if (cache?.isRedisReady()) {
      // CORRECT AS IS, and the catch is UNREACHABLE — `CacheService.set` catches
      // its own Redis error and returns, having already written memory above.
      // Memory is the deciding path for this process, so a surviving Redis key
      // affects only another shard and only until the TTL.
      void cache.set(`${this.prefix}${key}`, value, this.ttlSeconds).catch(() => undefined);
    }
  }

  public async get(key: string): Promise<T | undefined> {
    const now = Date.now();
    const local = this.mem.get(key);
    if (local) {
      if (local.expiresAt > now) return local.value;
      this.mem.delete(key);
    }
    const cache = resolveCacheService();
    if (cache?.isRedisReady()) {
      try {
        const remote = await cache.get<T>(`${this.prefix}${key}`);
        if (remote !== null && remote !== undefined) {
          const value = this.revive ? this.revive(remote) : remote;
          this.mem.set(key, { value, expiresAt: now + this.ttlSeconds * 1000 });
          return value;
        }
      } catch (err) {
        // Unreachable: `CacheService.get` catches its own Redis error and answers
        // null, so this only fires on a bug in the `revive` hook. It is still not
        // silent, because the value this returns IS the answer a paginator renders
        // — an undefined here reads to the user as "your session expired".
        Logger.warn({ err, key: `${this.prefix}${key}` }, '[TtlStore] Read-through failed; session reported as absent');
      }
    }
    return undefined;
  }

  public delete(key: string): void {
    this.mem.delete(key);
    const cache = resolveCacheService();
    if (cache?.isRedisReady()) {
      // CORRECT AS IS, and the catch is UNREACHABLE — `CacheService.delete` eats
      // its own Redis error after the local delete above has already happened, so
      // this process is consistent either way.
      void cache.delete(`${this.prefix}${key}`).catch(() => undefined);
    }
  }
}
