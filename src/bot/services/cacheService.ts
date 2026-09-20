import Redis from 'ioredis';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

const DEFAULT_MAX_ENTRIES = 3000;
const SWEEP_INTERVAL_MS = 60000;

export class CacheService {
  private readonly memory: Map<string, MemoryEntry> = new Map();
  private readonly maxEntries: number;
  private readonly sweepInterval: NodeJS.Timeout | null = null;
  private redis: Redis | null = null;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;

    const hasExplicitRedis = !!process.env.REDIS_URL;
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
          // Populate into memory cache
          this.setMemory(key, parsed, undefined);
          return parsed;
        }
      } catch {
        return null;
      }
    }
    return null;
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
        return;
      }
    }
  }

  public async delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.del(key);
      } catch {
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

  public async keyDelete(key: string): Promise<void> {
    await this.delete(key);
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
