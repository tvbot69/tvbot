import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { TtlStore } from './ttlStore';
import { CacheService } from './cacheService';

describe('TtlStore (Phase 2.2)', () => {
  const backing = new Map<string, unknown>();
  let redisUp = true;

  beforeEach(() => {
    backing.clear();
    redisUp = true;
    container.clearInstances();
    container.registerInstance(
      CacheService,
      {
        isRedisReady: () => redisUp,
        get: vi.fn(async (key: string) => (backing.has(key) ? backing.get(key) : null)),
        set: vi.fn(async (key: string, value: unknown) => {
          backing.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          backing.delete(key);
        }),
      } as never,
    );
  });

  it('serves from memory and mirrors to Redis', async () => {
    const store = new TtlStore<{ n: number }>('t:', 60);
    store.set('a', { n: 1 });
    await expect(store.get('a')).resolves.toEqual({ n: 1 });
    expect(backing.get('t:a')).toEqual({ n: 1 });
  });

  it('falls back to the Redis mirror after a restart (empty memory)', async () => {
    backing.set('t:b', { n: 2 });
    const store = new TtlStore<{ n: number }>('t:', 60);
    await expect(store.get('b')).resolves.toEqual({ n: 2 });
  });

  it('keeps serving memory values when Redis goes down', async () => {
    const store = new TtlStore<{ n: number }>('t:', 60);
    store.set('c', { n: 3 });
    redisUp = false;
    await expect(store.get('c')).resolves.toEqual({ n: 3 });
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('revives mangled types on Redis read-through', async () => {
    backing.set('t:d', { when: '2026-01-01T00:00:00.000Z' });
    const store = new TtlStore<{ when: unknown }>('t:', 60, (v) => ({
      when: typeof v.when === 'string' ? new Date(v.when) : v.when,
    }));
    const got = await store.get('d');
    expect(got?.when).toBeInstanceOf(Date);
  });

  it('deletes from both layers', async () => {
    const store = new TtlStore<{ n: number }>('t:', 60);
    store.set('e', { n: 5 });
    store.delete('e');
    await expect(store.get('e')).resolves.toBeUndefined();
    expect(backing.has('t:e')).toBe(false);
  });
});
