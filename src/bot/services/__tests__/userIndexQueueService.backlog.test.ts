import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserIndexQueueService } from '../lastfm/userIndexQueueService';
import { UserUpdateQueueService } from '../lastfm/userUpdateQueueService';

/**
 * The durable full-index queue, and the one branch that decides whether a
 * restart silently drops a user's whole index.
 *
 * The items live ONLY in Redis. Nothing else holds a pending full index, so a
 * backlog that cannot be read is not a "retry later" — it is a permanent loss
 * for the life of the process, and the user reads it as frozen statistics.
 *
 * `CacheService.listPopCount` answers `[]` when Redis is down, and
 * `listLength` answers `0`, so a bare try/catch could never fire: an outage
 * and an empty queue looked identical and nothing was logged. The fix is to
 * read the length BEFORE the pops and compare the two, and only `popped <
 * before` is a proven loss. Both directions are asserted below: a genuine
 * short read is reported, and a genuine empty Redis is not.
 */

type Rec = Record<string, unknown>;

/** A Redis double whose list actually holds items. */
const redis = (backlog: Rec[] = [], over: Rec = {}) => {
  const list: Rec[] = [...backlog];
  return {
    __list: list,
    isRedisReady: vi.fn(() => true),
    listPush: vi.fn(async (_key: string, values: Rec[]) => { list.push(...values); }),
    listPopCount: vi.fn(async (_key: string, count: number) => list.splice(0, count)),
    listLength: vi.fn(async () => list.length),
    setAddNX: vi.fn(async () => true),
    // `_key`/`_member` are declared, not omitted: a zero-parameter `vi.fn()`
    // infers a `() => ...` call tuple, so the two-argument `mockImplementation`
    // the ordering tests install below would be a type error rather than a
    // working override.
    setRemove: vi.fn(async (_key: string, _member: string) => undefined),
    ...over,
  };
};

const down = () => ({
  isRedisReady: () => false,
  listPush: vi.fn(),
  listPopCount: vi.fn(),
  listLength: vi.fn(),
  setAddNX: vi.fn(),
  setRemove: vi.fn(),
});

beforeEach(() => vi.clearAllMocks());

describe('UserIndexQueueService.enqueue', () => {
  it('accepts a user and mirrors the item to Redis', () => {
    const cache = redis();
    const queue = new UserIndexQueueService(cache as never);

    expect(queue.enqueue({ userId: 7, indexQueue: true })).toBe(true);
    expect(cache.listPush).toHaveBeenCalledWith('queue:user-index', [{ userId: 7, indexQueue: true }]);
    expect(queue.size()).toBe(1);
  });

  it('refuses a second item for a user already queued', () => {
    // Two index runs for one user means two copies of every scrobble.
    const queue = new UserIndexQueueService(redis() as never);
    expect(queue.enqueue({ userId: 7, indexQueue: true })).toBe(true);
    expect(queue.enqueue({ userId: 7, indexQueue: false })).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('refuses a new item once the queue is at capacity', () => {
    const queue = new UserIndexQueueService(redis() as never);
    expect(queue.maxCapacity).toBe(10000);
    for (let i = 0; i < queue.maxCapacity; i++) queue.enqueue({ userId: i, indexQueue: true });
    expect(queue.enqueue({ userId: 999999, indexQueue: true })).toBe(false);
  });

  it('works with no cache at all, since the mirror is optional', () => {
    const queue = new UserIndexQueueService();
    expect(queue.enqueue({ userId: 7, indexQueue: true })).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it('skips the mirror when Redis is not ready', () => {
    const cache = down();
    const queue = new UserIndexQueueService(cache as never);
    queue.enqueue({ userId: 7, indexQueue: true });
    expect(cache.listPush).not.toHaveBeenCalled();
  });
});

describe('UserIndexQueueService.rehydration', () => {
  it('restores a backlog that survived the restart', async () => {
    const cache = redis([{ userId: 7, indexQueue: true }, { userId: 8, indexQueue: true }]);
    const queue = new UserIndexQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });

    await queue.pump();

    expect(seen).toEqual([7, 8]);
    expect(queue.size()).toBe(0);
  });

  it('REPORTS a backlog that came back shorter than Redis claimed', async () => {
    // The A1 branch. `listLength` says 3, the pops return 1: two users lost
    // their pending full index. Nothing can recover them, so it has to be
    // visible rather than read as an empty queue.
    const cache = redis([{ userId: 1, indexQueue: true }], { listLength: vi.fn(async () => 3) });
    const queue = new UserIndexQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });

    await queue.pump();

    expect(seen).toEqual([1]);
    expect(cache.listLength).toHaveBeenCalledWith('queue:user-index');
  });

  it('stays quiet when Redis genuinely held nothing', async () => {
    // The other direction of the same pairing: `listLength` also answers 0 when
    // Redis is DOWN, so `before === 0` is not evidence of anything and must not
    // be reported as a loss.
    const cache = redis([]);
    const queue = new UserIndexQueueService(cache as never);
    queue.registerProcessor(async () => undefined);

    await queue.pump();

    expect(queue.size()).toBe(0);
  });

  it('does not read Redis when the queue already holds items', async () => {
    // A fresh enqueue means this process is not the one that was restarted, and
    // draining the shared list here would steal another shard's work.
    const cache = redis([{ userId: 99, indexQueue: true }]);
    const queue = new UserIndexQueueService(cache as never);
    queue.enqueue({ userId: 7, indexQueue: true });
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });

    await queue.pump();

    expect(seen).toEqual([7]);
    // `listLength` is only read by the rehydration guard, so it not having been
    // called is what proves the mirror was left alone.
    expect(cache.listLength).not.toHaveBeenCalled();
  });

  it('rehydrates only once per process', async () => {
    const cache = redis([{ userId: 7, indexQueue: true }]);
    const queue = new UserIndexQueueService(cache as never);
    queue.registerProcessor(async () => undefined);

    await queue.pump();
    queue.enqueue({ userId: 8, indexQueue: true });
    await queue.pump();

    // One call per rehydration however many pumps run, so a queue that is
    // pumped every two minutes does not re-read the mirror every time.
    expect(cache.listLength).toHaveBeenCalledTimes(1);
  });

  it('skips a corrupt entry instead of crashing the pump', async () => {
    const cache = redis([null as never, { userId: 7, indexQueue: true }, { nope: true } as never]);
    const queue = new UserIndexQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });

    await queue.pump();

    expect(seen).toEqual([7]);
  });

  it('does not restore a user that is already in memory', async () => {
    const cache = redis([{ userId: 7, indexQueue: true }]);
    const queue = new UserIndexQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });

    await queue.pump();
    queue.enqueue({ userId: 7, indexQueue: true });
    await queue.pump();

    expect(seen).toEqual([7, 7]);
  });

  it('does not claim a loss when the list was already empty but popped to a negative', async () => {
    const cache = redis([], { listLength: vi.fn(async () => 0), listPopCount: vi.fn(async () => []) });
    const queue = new UserIndexQueueService(cache as never);
    queue.registerProcessor(async () => undefined);

    await expect(queue.pump()).resolves.toBeUndefined();
  });
});

describe('UserIndexQueueService.pump', () => {
  /**
   * A first pump with nothing queued, which is what the two-minute cron does
   * before any command ever runs. It marks rehydration as done, so everything
   * below observes the DRAIN rather than the restore - without it the
   * rehydrate pops the very item the test is about, and the assertions about
   * the mirror become vacuous.
   *
   * It also clears the call history, because priming is itself a Redis read:
   * `rehydrate` calls `listLength` and then `listPopCount(key, maxCapacity)`.
   * Leaving those on the record makes every "the mirror was not touched"
   * assertion below count a rehydration pop instead of a drain pop - and an
   * extra `listPopCount` is exactly what a lost item looks like.
   */
  const primed = async (cache: ReturnType<typeof redis>) => {
    const queue = new UserIndexQueueService(cache as never);
    await queue.pump();
    vi.clearAllMocks();
    return queue;
  };

  it('does nothing without a registered processor', async () => {
    const cache = redis();
    const queue = new UserIndexQueueService(cache as never);
    queue.enqueue({ userId: 7, indexQueue: true });
    await queue.pump();
    expect(queue.size()).toBe(1);
  });

  it('trims the mirror only after the item processed', async () => {
    // The order is the whole claim, so it is recorded rather than inferred
    // from a call count: the ids SET member goes BEFORE the processor runs
    // (nothing ever reads that set), and the durable LIST entry is popped only
    // once the processor has succeeded.
    const order: string[] = [];
    const cache = redis();
    const queue = await primed(cache);
    queue.registerProcessor(async () => { order.push('processed'); });
    cache.setRemove.mockImplementation(async (key: string, member: string) => {
      order.push(`setRemove(${key},${member})`);
      return undefined;
    });
    cache.listPopCount.mockImplementation(async (key: string, count: number) => {
      order.push(`listPopCount(${key},${count})`);
      return cache.__list.splice(0, count);
    });
    queue.enqueue({ userId: 7, indexQueue: true });

    await queue.pump();

    expect(order).toEqual([
      'setRemove(queue:user-index:ids,7)',
      'processed',
      'listPopCount(queue:user-index,1)',
    ]);
    expect(cache.__list).toHaveLength(0);
  });

  it('keeps draining after an item throws, instead of abandoning the rest', async () => {
    // One poisoned user must not cost the queue everything behind them.
    const cache = redis();
    const queue = await primed(cache);
    const seen: number[] = [];
    queue.registerProcessor(async (item) => {
      seen.push(item.userId);
      if (item.userId === 1) throw new Error('index failed');
    });
    queue.enqueue({ userId: 1, indexQueue: true });
    queue.enqueue({ userId: 2, indexQueue: true });

    await queue.pump();

    expect(seen).toEqual([1, 2]);
    expect(queue.size()).toBe(0);
  });

  it('does not trim the mirror for an item that failed', async () => {
    // The LIST pop is the acknowledgement. Popping on failure would lose the
    // item for good; not popping replays an idempotent index after a restart,
    // which costs work and nothing else.
    const cache = redis();
    const queue = await primed(cache);
    const order: string[] = [];
    queue.registerProcessor(async () => { order.push('processed'); throw new Error('index failed'); });
    cache.setRemove.mockImplementation(async (key: string, member: string) => {
      order.push(`setRemove(${key},${member})`);
      return undefined;
    });
    cache.listPopCount.mockImplementation(async (key: string, count: number) => {
      order.push(`listPopCount(${key},${count})`);
      return cache.__list.splice(0, count);
    });
    queue.enqueue({ userId: 7, indexQueue: true });

    await queue.pump();

    // The ids SET member is still removed before the processor runs, which is
    // harmless: nothing reads that set. What must NOT happen is the list pop.
    expect(order).toEqual(['setRemove(queue:user-index:ids,7)', 'processed']);
    expect(cache.listPopCount).not.toHaveBeenCalled();
    expect(cache.__list).toHaveLength(1);
  });

  it('lets the same user be queued again after their item was processed', async () => {
    const queue = await primed(redis());
    queue.registerProcessor(async () => undefined);
    queue.enqueue({ userId: 7, indexQueue: true });
    await queue.pump();
    expect(queue.enqueue({ userId: 7, indexQueue: true })).toBe(true);
  });

  it('processes items in the order they were enqueued', async () => {
    const queue = await primed(redis());
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });
    for (const id of [3, 1, 2]) queue.enqueue({ userId: id, indexQueue: true });

    await queue.pump();

    expect(seen).toEqual([3, 1, 2]);
  });

  it('runs a full in-memory drain with no cache at all', async () => {
    const queue = new UserIndexQueueService();
    const seen: number[] = [];
    queue.registerProcessor(async (item) => { seen.push(item.userId); });
    queue.enqueue({ userId: 1, indexQueue: true });
    queue.enqueue({ userId: 2, indexQueue: true });

    await queue.pump();

    expect(seen).toEqual([1, 2]);
  });
});

describe('UserUpdateQueueService, which shares the protocol', () => {
  /** See the index queue's `primed`: priming is a rehydrate, and a rehydrate
   * pops the mirror, so the call history is cleared to leave only the drain. */
  const primed = async (cache: ReturnType<typeof redis>) => {
    const queue = new UserUpdateQueueService(cache as never);
    await queue.pump();
    vi.clearAllMocks();
    return queue;
  };

  it('reports a short backlog the same way', async () => {
    const cache = redis([{ userId: 1, discordUserId: 'd1', userNameLastFm: 'u1' }], {
      listLength: vi.fn(async () => 5),
    });
    const queue = new UserUpdateQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (batch) => { seen.push(...batch.map((b) => b.userId)); });

    await queue.pump();

    expect(seen).toEqual([1]);
  });

  it('trims the mirror once per batch, sized to the batch', async () => {
    const cache = redis();
    const queue = await primed(cache);
    queue.registerProcessor(async () => undefined);
    for (let i = 0; i < 3; i++) queue.enqueue({ userId: i, discordUserId: `d${i}`, userNameLastFm: `u${i}` });

    await queue.pump();

    expect(cache.listPopCount).toHaveBeenCalledTimes(1);
    expect(cache.listPopCount).toHaveBeenCalledWith('queue:user-updates', 3);
    expect(cache.__list).toHaveLength(0);
  });

  it('does not trim a batch that failed', async () => {
    // Same protocol as the index queue: the LIST pop is the acknowledgement, so
    // a thrown batch keeps its entries and is replayed after a restart.
    const cache = redis();
    const queue = await primed(cache);
    queue.registerProcessor(async () => { throw new Error('delta sync failed'); });
    queue.enqueue({ userId: 1, discordUserId: 'd1', userNameLastFm: 'u1' });

    await queue.pump();

    expect(cache.listPopCount).not.toHaveBeenCalled();
    expect(cache.__list).toHaveLength(1);
  });

  it('keeps draining after a failed batch', async () => {
    // Two items are ONE batch — BATCH_SIZE is 25 — so a second processor call
    // would be asserting a batching that does not exist. 26 items force the
    // 25 + 1 split, and that split is what makes "keeps draining" a real claim:
    // the poisoned batch must not strand the one behind it.
    const cache = redis();
    const queue = await primed(cache);
    const sizes: number[] = [];
    queue.registerProcessor(async (batch) => {
      sizes.push(batch.length);
      if (sizes.length === 1) throw new Error('delta sync failed');
    });
    for (let i = 0; i < 26; i++) queue.enqueue({ userId: i, discordUserId: `d${i}`, userNameLastFm: `u${i}` });

    await queue.pump();

    expect(sizes).toEqual([25, 1]);
    expect(queue.size()).toBe(0);
  });

  it('splits a big backlog into batches of twenty-five', async () => {
    const queue = await primed(redis());
    const sizes: number[] = [];
    queue.registerProcessor(async (batch) => { sizes.push(batch.length); });
    for (let i = 0; i < 60; i++) queue.enqueue({ userId: i, discordUserId: `d${i}`, userNameLastFm: `u${i}` });

    await queue.pump();

    expect(sizes).toEqual([25, 25, 10]);
  });
});
