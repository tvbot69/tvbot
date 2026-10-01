import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * The delta-sync lock was check-then-act across two awaits.
 *
 *   if (await cache.get(dedupKey)) return { newPlays: 0, ... };
 *   await cache.set(dedupKey, true, TTL);
 *   ... performDeltaSync ...
 *
 * Between the `get` and the `set` another caller can run, see the key missing,
 * and proceed too. This is reachable, not theoretical: every artist/album/track
 * command fires `void updateUser(...)`, and the cron sweep fires its own, all
 * for the same user. Both proceed, both insert the same scrobbles, and the
 * duplicate plays are healed only later by the nightly ReconcileService.
 *
 * The fix is a single atomic `SET key 1 NX EX ttl`, via CacheService.setNX.
 *
 * These tests drive the REAL CacheService in its in-memory mode, not a stub
 * that pretends to be atomic. A stub would be a decoration: the whole question
 * is whether the real thing is atomic, and only the real thing can answer it.
 */

type Deferred = { promise: Promise<void>; resolve: () => void };

/** A gate the sync blocks on, so all five callers are genuinely in flight. */
const gate = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('CacheService.setNX', () => {
  let CacheService: typeof import('../system/cacheService').CacheService;
  let cache: import('../system/cacheService').CacheService;

  beforeEach(async () => {
    ({ CacheService } = await import('../system/cacheService'));
    cache = new CacheService();
  });

  afterEach(() => vi.useRealTimers());

  it('returns true once and false to everyone else, under a simultaneous burst', async () => {
    // The property the lock depends on. 20 calls fired without awaiting, so all
    // 20 are inside setNX before any resolves.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.setNX('lock', true, 60)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(19);
  });

  it('is not fooled by an expired entry', async () => {
    // A stale lock must not block a legitimate run forever, which is what the
    // TTL is for. Guards against the "key exists" check ignoring expiry.
    await cache.set('stale', true, 60);
    // Backdate the memory entry past its TTL rather than sleeping 60s.
    const internals = cache as unknown as { memory: Map<string, { expiresAt: number }> };
    const entry = internals.memory.get('stale');
    if (entry) entry.expiresAt = Date.now() - 1;

    await expect(cache.setNX('stale', true, 60)).resolves.toBe(true);
  });

  it('releases the lock on delete, so the next caller gets it', async () => {
    await expect(cache.setNX('lock', true, 60)).resolves.toBe(true);
    await expect(cache.setNX('lock', true, 60)).resolves.toBe(false);
    await cache.delete('lock');
    await expect(cache.setNX('lock', true, 60)).resolves.toBe(true);
  });

  it('does not leak the value: setNX stores, get reads it back', async () => {
    await cache.setNX('k', { owner: 'a' }, 60);
    await expect(cache.get('k')).resolves.toEqual({ owner: 'a' });
  });
});

describe('delta sync runs once for five concurrent callers', () => {
  let UpdateService: typeof import('../lastfm/updateService').UpdateService;
  let performDeltaSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ UpdateService } = await import('../lastfm/updateService'));
    performDeltaSync = vi.fn(async () => ({ newPlays: 3, removedPlays: 0 }));
  });

  afterEach(() => vi.restoreAllMocks());

  // A real user, declared before buildService so there is no ordering question.
  // lastUpdate is epoch so the staleness gate lets the sync through.
  const user = {
    id: 7,
    userId: 7,
    userNameLastFm: 'someone',
    sessionKey: 'k',
    lastUpdate: new Date(0),
  };

  const buildService = (cache: import('../system/cacheService').CacheService) => {
    const lastFmRepository = { getUserRecentTracks: vi.fn(async () => []) };
    const userRepository = { setLastUpdate: vi.fn(async () => undefined), getUserById: vi.fn(async () => user) };
    const playRepository = { insertPlays: vi.fn(async () => 3) };

    // Constructor order is (userRepository, playRepository, lastfmRepository,
    // cache, recalculateTopLists) - positional, and getting it wrong silently
    // passes a repository where a cache is expected, which is exactly the
    // "bad constructor arity passes vitest and breaks the build" trap.
    const service = new UpdateService(
      userRepository as never,
      playRepository as never,
      lastFmRepository as never,
      cache as never,
      vi.fn(async () => undefined),
    );

    // The real delta sync, stubbed at its outermost point so we count how many
    // times the lock let a caller through. Everything above it - the guard, the
    // key shape, the release in `finally` - is production code.
    (service as unknown as { performDeltaSync: typeof performDeltaSync }).performDeltaSync = performDeltaSync;
    return { service, lastFmRepository, userRepository };
  };


  it('lets exactly one of five through', async () => {
    const { CacheService } = await import('../system/cacheService');
    const cache = new CacheService();
    const { service } = buildService(cache);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.updateUser(7)),
    );

    expect(performDeltaSync).toHaveBeenCalledTimes(1);
    // Four callers get the zero result, one gets the real one.
    const totals = results.map((r) => r.newPlays);
    expect(totals.filter((n) => n === 3)).toHaveLength(1);
    expect(totals.filter((n) => n === 0)).toHaveLength(4);
  });

  it('releases the lock in finally, so a throwing sync does not wedge the user', async () => {
    // Without the release, one failed sync would block every later sync for the
    // full TTL, and the user would silently stop updating.
    const { CacheService } = await import('../system/cacheService');
    const cache = new CacheService();
    const { service } = buildService(cache);

    performDeltaSync.mockRejectedValueOnce(new Error('upstream 500'));
    await service.updateUser(7);

    // The next call must be allowed through.
    await service.updateUser(7);
    expect(performDeltaSync).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent callers out while the first is still running', async () => {
    // Distinct from the burst test: here the winner is held open on a gate, so
    // the losers arrive while the lock is genuinely held rather than after it
    // was released. This is the shape the cron sweep plus a user command
    // actually take.
    const { CacheService } = await import('../system/cacheService');
    const cache = new CacheService();
    const { service } = buildService(cache);

    const bar = gate();
    performDeltaSync.mockImplementationOnce(async () => {
      await bar.promise;
      return { newPlays: 1, removedPlays: 0 };
    });

    const first = service.updateUser(7);
    await Promise.resolve();
    await Promise.resolve();

    // Second caller arrives while the first holds the lock.
    const second = await service.updateUser(7);

    expect(performDeltaSync).toHaveBeenCalledTimes(1);
    expect(second.newPlays).toBe(0);

    bar.resolve();
    await expect(first).resolves.toEqual({ newPlays: 1, removedPlays: 0 });
  });
});
