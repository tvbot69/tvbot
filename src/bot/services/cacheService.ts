import Redis from 'ioredis';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

const DEFAULT_MAX_ENTRIES = 5000;
const SWEEP_INTERVAL_MS = 60000;

export class CacheService {
  private readonly memory: Map<string, MemoryEntry> = new Map();
  private readonly maxEntries: number;
  private readonly sweepInterval: NodeJS.Timeout | null = null;
  private redis: Redis | null = null;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;

    try {
      this.redis = new Redis(ConfigData.Data.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.redis.on('error', (err) => Logger.warn({ err }, 'Redis error'));
      void this.redis.connect().catch(() => {
        Logger.warn('Redis unavailable, continuing with in-memory cache only');
      });
    } catch (err) {
      Logger.warn({ err }, 'Redis initialization failed');
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
