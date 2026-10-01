import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IndexService } from '@bot/services/lastfm/indexService';
import { CacheService } from '@bot/services/system/cacheService';

/**
 * The full-index lock had the same check-then-act race as the delta-sync one.
 *
 *   if (await cache.get(key)) return;      // two round trips
 *   await cache.set(key, true, 180);
 *
 * The mutation pass for the delta-sync fix caught this surviving, which is the
 * only reason it is tested: nothing else exercised indexUser's guard.
 *
 * Driven against the real CacheService rather than a double that pretends to be
 * atomic - the whole question is whether the lock is genuinely exclusive.
 */

describe('IndexService.indexUser concurrency guard', () => {
  let service: IndexService;
  let modularUpdate: ReturnType<typeof vi.fn>;
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
    modularUpdate = vi.fn(async () => undefined);

    // 8 positional args, all repositories. Passing 4 typechecks nowhere and
    // vitest nowhere - the suite was green and tsc was the thing that noticed.
    service = new IndexService(
      { add: vi.fn(), registerProcessor: vi.fn() } as never,
      cache as never,
      { getUserById: vi.fn(async () => ({ id: 7, userId: 7, userNameLastFm: 'someone', lastUpdate: new Date(0) })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    (service as unknown as { modularUpdate: typeof modularUpdate }).modularUpdate = modularUpdate;
  });

  it('runs the index exactly once for five concurrent calls', async () => {
    await Promise.all(Array.from({ length: 5 }, () => service.indexUser(7)));

    expect(modularUpdate).toHaveBeenCalledTimes(1);
  });

  it('skips a second call while the first is still running', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    modularUpdate.mockImplementationOnce(async () => { await held; });

    const first = service.indexUser(7);
    await Promise.resolve();
    await Promise.resolve();

    await service.indexUser(7);
    expect(modularUpdate).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('releases the lock so a later index can run', async () => {
    await service.indexUser(7);
    await service.indexUser(7);
    expect(modularUpdate).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when the index throws', async () => {
    // Otherwise a single failure wedges the user for the whole 180s TTL, and
    // the nightly sweep keeps skipping them with only a log line to show.
    modularUpdate.mockRejectedValueOnce(new Error('upstream 500'));
    await expect(service.indexUser(7)).rejects.toThrow();

    await service.indexUser(7);
    expect(modularUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not lock a user that does not exist', async () => {
    (service as unknown as { userRepository: { getUserById: unknown } }).userRepository = {
      getUserById: vi.fn(async () => null),
    };

    await service.indexUser(999);
    expect(modularUpdate).not.toHaveBeenCalled();
  });
});
