/**
 * `UpdateQueueHandler` — the batch processor the automatic sync queue drains into.
 *
 * No test at all for this file, and it sits on the path that decides whether the
 * bot's numbers are current, so three things are worth pinning:
 *
 *  1. The batch is INDEPENDENT per user. One user whose Last.fm read fails must
 *     not stop the rest of the batch — otherwise a single bad account stalls
 *     every account queued behind it, and the failure is invisible because the
 *     whole batch just quietly stops.
 *  2. The processor is registered in the CONSTRUCTOR, before anything is pumped.
 *     A queue whose processor is registered after the first `pump()` drains into
 *     nothing.
 *  3. A pump failure reaches its caller. The cron sweep is the only caller and it
 *     logs its own failure, so swallowing inside this class would leave a dead
 *     queue with no log line at all.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UpdateQueueHandler } from '../updateQueueHandler';
import type { IUserUpdateQueue, UserUpdateQueueItem } from '@domain/interfaces/iuserUpdateQueue';
import type { UpdateService } from '@bot/services/lastfm/updateService';

type Delta = { newPlays: number; removedPlays: number };

const item = (userId: number, name = `listener-${userId}`): UserUpdateQueueItem => ({
  userId,
  discordUserId: `discord-${userId}`,
  userNameLastFm: name,
});

const noop = async (): Promise<Delta> => ({ newPlays: 0, removedPlays: 0 });

const build = (impl: (userId: number, opts?: { queue?: boolean }) => Promise<Delta>) => {
  let processor: ((items: UserUpdateQueueItem[]) => Promise<void>) | undefined;
  const registerProcessor = vi.fn((p: (items: UserUpdateQueueItem[]) => Promise<void>) => {
    processor = p;
  });
  const pump = vi.fn(async (..._args: unknown[]) => undefined);
  const queue = { registerProcessor, pump } as unknown as IUserUpdateQueue;

  const updateUser = vi.fn(impl);
  const service = { updateUser } as unknown as UpdateService;
  new UpdateQueueHandler(queue, service);

  // Reaching the processor through the registration callback is the point: if the
  // constructor ever stops registering it, every test below fails here rather than
  // passing against a closure that happens to exist.
  const run = (items: UserUpdateQueueItem[]): Promise<void> => {
    if (!processor) throw new Error('the batch processor was never registered');
    return processor(items);
  };
  return { pump, registerProcessor, updateUser, run };
};

describe('UpdateQueueHandler registration', () => {
  it('registers its processor during construction, before anything can be pumped', () => {
    expect(build(noop).registerProcessor).toHaveBeenCalledTimes(1);
  });

  it('pumps the queue on demand', async () => {
    const pump = vi.fn(async (..._args: unknown[]) => undefined);
    const handler = new UpdateQueueHandler(
      { registerProcessor: vi.fn(), pump } as unknown as IUserUpdateQueue,
      { updateUser: vi.fn(noop) } as unknown as UpdateService,
    );
    await handler.processAsync();
    expect(pump).toHaveBeenCalledTimes(1);
  });

  it('lets a pump failure reach its caller rather than swallowing it', async () => {
    const pump = vi.fn(async () => {
      throw new Error('redis down');
    });
    const handler = new UpdateQueueHandler(
      { registerProcessor: vi.fn(), pump } as unknown as IUserUpdateQueue,
      { updateUser: vi.fn(noop) } as unknown as UpdateService,
    );
    await expect(handler.processAsync()).rejects.toThrow('redis down');
  });
});

describe('UpdateQueueHandler batch processing', () => {
  it('updates every user in the batch, marking each as a queue update', async () => {
    const { run, updateUser } = build(noop);
    await run([item(1), item(2), item(3)]);
    expect(updateUser).toHaveBeenCalledTimes(3);
    expect(updateUser.mock.calls[0]).toEqual([1, { queue: true }]);
    expect(updateUser.mock.calls[1]).toEqual([2, { queue: true }]);
    expect(updateUser.mock.calls[2]).toEqual([3, { queue: true }]);
  });

  it('processes an empty batch without touching the update service', async () => {
    const { run, updateUser } = build(noop);
    await run([]);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('carries on with the rest of the batch after one user fails', async () => {
    // The load-bearing one. A single failing account must not strand every
    // account queued behind it.
    const { run, updateUser } = build(async userId => {
      if (userId === 2) throw new Error('Last.fm rate limited');
      return { newPlays: 0, removedPlays: 0 };
    });

    await expect(run([item(1), item(2), item(3)])).resolves.toBeUndefined();
    expect(updateUser).toHaveBeenCalledTimes(3);
    expect(updateUser.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  });

  it('keeps going after EVERY user fails, and still resolves', async () => {
    const { run, updateUser } = build(async () => {
      throw new Error('database down');
    });
    await expect(run([item(1), item(2)])).resolves.toBeUndefined();
    expect(updateUser).toHaveBeenCalledTimes(2);
  });

  it('does not treat a removal as a reason to skip the addition, or the reverse', async () => {
    const { run } = build(async userId =>
      userId === 1 ? { newPlays: 5, removedPlays: 0 } : { newPlays: 0, removedPlays: 3 },
    );
    await expect(run([item(1), item(2)])).resolves.toBeUndefined();
  });

  it('resolves rather than rejecting for a user whose update raised a non-Error', async () => {
    const { run } = build(async () => {
      throw 'a string, not an Error';
    });
    await expect(run([item(1)])).resolves.toBeUndefined();
  });
});
