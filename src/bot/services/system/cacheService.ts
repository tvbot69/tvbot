import Redis from 'ioredis';
import { ConfigData } from '@bot/configurations/configData';
import { redisUrl } from '@config/runtimeEnv';
import { Logger } from '@domain/logger';

import type { ICache } from '@domain/interfaces/icache';
interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

const DEFAULT_MAX_ENTRIES = 3000;
const SWEEP_INTERVAL_MS = 60000;

export class CacheService implements ICache {
  private readonly memory: Map<string, MemoryEntry> = new Map();
  private readonly maxEntries: number;
  private readonly sweepInterval: NodeJS.Timeout | null = null;
  private redis: Redis | null = null;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;

    const hasExplicitRedis = !!redisUrl();
    if (hasExplicitRedis) {
      try {
        this.redis = new Redis(ConfigData.Data.redis.url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        this.redis.on('error', (err) => Logger.warn({ err }, 'Redis error'));
        this.redis.once('ready', () => Logger.info('Redis connected — durable queues/sessions active'));
        void this.redis.connect().catch(() => {
          Logger.warn('Redis unavailable, continuing with in-memory cache only');
        });
      } catch (err) {
        Logger.warn({ err }, 'Redis initialization failed');
        this.redis = null;
      }
    } else {
      this.redis = null;
    }

    // Background TTL sweep timer to prevent unaccessed expired keys from leaking memory
    this.sweepInterval = setInterval(() => {
      this.sweepExpired();
    }, SWEEP_INTERVAL_MS);

    if (typeof this.sweepInterval.unref === 'function') {
      this.sweepInterval.unref();
    }
  }

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.memory.get(key);
    if (entry) {
      if (!entry.expiresAt || entry.expiresAt > Date.now()) {
        // Refresh LRU order (delete & re-insert moves to end of iteration)
        this.memory.delete(key);
        this.memory.set(key, entry);
        return entry.value as T;
      }
      // Expired entry
      this.memory.delete(key);
    }

    if (this.redis && this.redis.status === 'ready') {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const parsed = JSON.parse(raw) as T;
          // Preserve the REMAINING Redis TTL when promoting into memory. It
          // used to be promoted with `undefined`, which means "never expires":
          // every finite TTL silently became permanent in this process. A
          // 10-minute negative artwork marker read at minute 9 then lived
          // until restart, so a cover that appeared on Spotify was never
          // re-fetched — and the 5-minute guild/command-disabled settings
          // froze for the life of the process (invisible across shards).
          const remaining = await this.remainingTtlSeconds(key);
          // `undefined` = the TTL could NOT be read, which is not the same as
          // "no expiry". Promoting on that path would re-create the exact
          // permanent-entry bug the call above exists to prevent, and only
          // when Redis fails mid-read — so serve the value and cache nothing
          // rather than cache it forever.
          if (remaining !== undefined) this.setMemory(key, parsed, remaining ?? undefined);
          return parsed;
        }
      } catch {
        // A Redis read failure is a cache MISS, not an absence: the caller
        // recomputes and re-populates. Returning null here never writes a
        // negative marker, so it cannot freeze "no cover / disabled" for a
        // later reader.
        return null;
      }
    }
    return null;
  }

  /**
   * Seconds left on a Redis key.
   *
   * Three outcomes, and conflating them is the bug this signature exists to
   * prevent: a number (finite TTL, safe to promote), `null` (Redis says the key
   * has NO expiry, so permanent is the truth), and `undefined` (we could not
   * find out — the TTL call threw, or the key vanished between the GET and the
   * TTL read). Only the third must not be cached.
   */
  private async remainingTtlSeconds(key: string): Promise<number | null | undefined> {
    if (!this.redis) return undefined;
    try {
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) return ttl;
      // -1 = genuinely no expiry. -2 = key already gone: nothing was read, so
      // report "unknown" rather than "permanent" and let the value stand.
      return ttl === -1 ? null : undefined;
    } catch {
      // Redis unreachable between the GET and the TTL: unknown, not permanent.
      return undefined;
    }
  }

  public async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.setMemory(key, value, ttlSeconds);

    if (this.redis && this.redis.status === 'ready') {
      try {
        if (ttlSeconds) {
          await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        } else {
          await this.redis.set(key, JSON.stringify(value));
        }
      } catch {
        // CORRECT AS IS: memory already holds the value (setMemory above ran
        // first, unconditionally). A failed Redis write costs cross-process
        // visibility until the key's TTL, not correctness in this process.
        return;
      }
    }
  }

  /**
   * Set a key only if it does not already exist. Returns true if it was set.
   *
   * This exists for locks, and it is NOT the same as `get` followed by `set`:
   * that is two round trips, so two concurrent callers can both observe the key
   * missing and both proceed. `updateService` used exactly that pattern to guard
   * delta syncs, while every command fires `void updateUser(...)` alongside the
   * cron queue - so duplicate plays were reachable, not theoretical.
   *
   * On Redis this is a single `SET key 1 NX EX ttl`, which is atomic server-side.
   * The in-memory path is also atomic, because `Map.has` plus `Map.set` run
   * synchronously with no await between them, so no other JS task can interleave.
   */
  public async setNX<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    // Memory is the deciding path here, and the check-then-write below is
    // atomic because both Map operations are synchronous with no await between
    // them, so no other task can interleave.
    const entry = this.memory.get(key);
    if (entry && (entry.expiresAt === null || entry.expiresAt > Date.now())) {
      return false; // still held
    }
    // Absent or expired, so the lock is free to take.
    this.setMemory(key, value, ttlSeconds);

    if (this.redis && this.redis.status === 'ready') {
      try {
        const ok = await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
        return ok === 'OK';
      } catch {
        // Redis is unreachable; trust the memory answer rather than guessing.
      }
    }
    return true;
  }

  public async delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.del(key);
      } catch {
        // CORRECT AS IS: the local delete above already happened, so this
        // process is consistent. A surviving Redis key can only be re-read by
        // another shard, and only until its own TTL expires — the
        // alternative (throwing) would make callers treat a delete as failed
        // and re-cache the same value.
        return;
      }
    }
  }

  public size(): number {
    return this.memory.size;
  }

  public isRedisReady(): boolean {
    return !!this.redis && this.redis.status === 'ready';
  }

  private async redisExec<T>(fn: (client: Redis) => Promise<T>, fallback: T): Promise<T> {
    if (!this.isRedisReady()) return fallback;
    try {
      return await fn(this.redis as Redis);
    } catch {
      return fallback;
    }
  }

  /** Durable FIFO lists (queue mirrors). Values are JSON-serialized. */
  public async listPush(key: string, values: unknown[]): Promise<void> {
    if (values.length === 0) return;
    await this.redisExec(
      (r) => r.rpush(key, ...values.map((v) => JSON.stringify(v))).then(() => undefined),
      undefined,
    );
  }

  public async listPopCount<T>(key: string, count: number): Promise<T[]> {
    return this.redisExec(async (r) => {
      const out: T[] = [];
      for (let i = 0; i < count; i++) {
        const raw = await r.lpop(key);
        if (raw === null || raw === undefined) break;
        try {
          out.push(JSON.parse(raw) as T);
        } catch {
          // corrupt entry — drop it
        }
      }
      return out;
    }, []);
  }

  public async listLength(key: string): Promise<number> {
    return this.redisExec((r) => r.llen(key), 0);
  }

  /** Returns true when the member was newly added (cross-process dedup). */
  public async setAddNX(key: string, member: string, ttlSeconds: number): Promise<boolean> {
    return this.redisExec(async (r) => {
      const added = await r.sadd(key, member);
      if (added === 1) {
        // CORRECT AS IS: the member is already in the set — SADD is what the
        // dedup answer depends on. A failed EXPIRE only means the KEY outlives
        // its ttl, so the member stays de-duplicated; the opposite (ignoring a
        // failed SADD) would report "already seen" for something never stored.
        await r.expire(key, ttlSeconds).catch(() => undefined);
        return true;
      }
      return false;
    }, true);
  }

  public async setRemove(key: string, member: string): Promise<void> {
    await this.redisExec((r) => r.srem(key, member).then(() => undefined), undefined);
  }

  /**
   * Atomic fixed-window counter (INCR + EXPIRE-on-first via Lua). Used for
   * cross-process rate limits — never falls back to a wrong answer, only to
   * zero (caller treats zero as "no Redis, use memory path").
   */
  public async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    return this.redisExec(
      (r) =>
        r.eval(
          `local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c;`,
          1,
          key,
          String(ttlSeconds),
        ) as Promise<number>,
      0,
    );
  }

  public sweepExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.memory.entries()) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.memory.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  public async disconnect(): Promise<void> {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
    }

    if (this.redis) {
      try {
        if (this.redis.status === 'ready' || this.redis.status === 'connecting') {
          await this.redis.quit().catch(() => this.redis?.disconnect());
        } else {
          this.redis.disconnect();
        }
      } catch {
        // CORRECT AS IS: shutdown. The connection is being abandoned anyway
        // and `this.redis = null` below drops the reference, so nothing this
        // process believes can outlive it.
        // ignore disconnect errors during shutdown
      }
      this.redis = null;
    }

    this.memory.clear();
  }

  private setMemory<T>(key: string, value: T, ttlSeconds?: number): void {
    if (this.memory.has(key)) {
      this.memory.delete(key);
    } else if (this.memory.size >= this.maxEntries) {
      // LRU eviction: remove the oldest accessed/inserted item
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey !== undefined) {
        this.memory.delete(oldestKey);
      }
    }

    this.memory.set(key, {
      value: value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }
}