import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `node-cron` is mocked rather than left running: eleven real timers with
// minute-boundary expressions would be non-deterministic and would leak handles
// into every later file.
const cronMock = vi.hoisted(() => {
  const schedule = vi.fn((expression: string, fn: () => Promise<void> | void) => ({
    expression,
    fn,
    stop: vi.fn(),
  }));
  return {
    // `validate` takes the expression, because `registerJob` calls
    // `cron.validate(cronExpression)` (timerService.ts:232) — a zero-arg double
    // was a signature the production call cannot satisfy, which is why the
    // "one expression is rejected" test below could not be written.
    validate: vi.fn((_expression: string) => true),
    schedule,
    /** Every registered job body, in registration order. */
    jobs: () => schedule.mock.calls.map((c) => ({ expression: c[0] as string, run: c[1] as () => Promise<void> })),
  };
});

vi.mock('node-cron', () => ({
  default: { validate: cronMock.validate, schedule: cronMock.schedule, getTasks: vi.fn(() => []) },
}));

// The privacy purge reaches a module-level prisma singleton. Unmocked it would
// open a real connection mid-unit-test against a database this repo must never
// touch.
vi.mock('@persistence/prismaClient', () => ({
  prisma: {
    $transaction: vi.fn(async () => undefined),
    userArtist: { deleteMany: vi.fn() },
    userAlbum: { deleteMany: vi.fn() },
    userTrack: { deleteMany: vi.fn() },
  },
}));

import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { TimerService } from '@bot/services/lastfm/timerService';
import { UpdateQueueHandler } from '@bot/handlers/queues/updateQueueHandler';
import { UserIndexQueueService } from '@bot/services/lastfm/userIndexQueueService';
import { UserUpdateQueueService } from '@bot/services/lastfm/userUpdateQueueService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { AutopostService } from '@bot/services/charts/autopostService';
import { LyricStatusService } from '@bot/services/music/lyricStatusService';
import { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';
import { AbuseFilterService } from '@bot/services/system/abuseFilterService';
import { ReconcileService } from '@bot/services/lastfm/reconcileService';
import { CacheService } from '@bot/services/system/cacheService';

/**
 * The cron surface. Every job here fires on a timer with no user watching, so
 * the properties that matter are structural: which jobs exist, which of them are
 * shard-gated, that a slow run does not overlap its own next tick, and that one
 * failure does not stop the schedule.
 *
 * The overlap guard is the one with a production incident behind it: the
 * index-queue pump walks up to 10k users every two minutes, and on a slow
 * database a run outlives its interval, so four concurrent pumps used to hammer
 * Postgres and the shared Last.fm token bucket at once.
 *
 * Job bodies are addressed BY INDEX rather than by cron expression, because two
 * of them share the same ten-minute expression and picking the first match would
 * silently assert about the wrong job. (Written out rather than quoted: a literal
 * `*` followed by `/` inside a block comment ends the comment.)
 */

type Rec = Record<string, unknown>;

const JOB = {
  updateQueue: 0,   // */5  * * * *  user-update-queue
  indexPump: 1,     // */2  * * * *  index-queue-pump
  enqueueOutdated: 2,  // 0 6,14 * * *
  enqueueStale: 3,  // 0 8 * * *
  privacyPurge: 4,  // 0 4 * * *
  abuseScan: 5,     // 0 5 * * *
  statistics: 6,    // */10 * * * *
  memorySample: 7,  // 0 * * * *
  reconcile: 8,     // 0 9 * * *
  autopost: 9,      // */15 * * * *
  lyrics: 10,       // */10 * * * *
} as const;

const run = (index: number) => cronMock.jobs()[index]?.run;

const OUTDATED_USER = { userId: 1, discordUserId: 'd1', userNameLastFm: 'u1' };

interface Wiring {
  updateHandler: { processAsync: () => Promise<void> };
  indexQueue: { pump: () => Promise<void>; enqueue: (item: unknown) => boolean };
  updateQueue: { enqueue: (item: unknown) => boolean; pump: () => Promise<void> };
  userRepository: Rec;
  playRepository: Rec;
  crownRepository: Rec;
  autopostService: Rec;
  lyricService: Rec;
  tracker: Rec;
  cache: Rec;
  abuse?: Rec;
  reconcile?: Rec;
}

/** Register exactly the collaborators the job bodies resolve out of the container. */
const registerAll = (over: { userRepository?: Rec; playRepository?: Rec; abuse?: Rec; reconcile?: Rec } = {}): Wiring => {
  const w: Wiring = {
    updateHandler: { processAsync: vi.fn(async () => undefined) },
    indexQueue: { pump: vi.fn(async () => undefined), enqueue: vi.fn(() => true) },
    updateQueue: { enqueue: vi.fn(() => true), pump: vi.fn(async () => undefined) },
    userRepository: {
      getOutdatedUsers: vi.fn(async () => []),
      getUsersWithStaleIndex: vi.fn(async () => []),
      getPrivacyHiddenUserIds: vi.fn(async () => []),
      getUserById: vi.fn(async () => null),
      ...(over.userRepository as Rec),
    },
    playRepository: {
      deleteAllPlaysForUser: vi.fn(async () => undefined),
      ...(over.playRepository as Rec),
    },
    crownRepository: { deactivateCrownsForUser: vi.fn(async () => undefined) },
    autopostService: { runScheduledAutoposts: vi.fn(async () => ({ executed: 0, failed: 0 })) },
    lyricService: { updateLyricStatusAsync: vi.fn(async () => undefined) },
    tracker: { logAndReset: vi.fn() },
    cache: { delete: vi.fn(async () => undefined) },
    abuse: over.abuse as Rec | undefined,
    reconcile: over.reconcile as Rec | undefined,
  };
  container.registerInstance(UpdateQueueHandler, w.updateHandler as never);
  container.registerInstance(UserIndexQueueService, w.indexQueue as never);
  container.registerInstance(UserUpdateQueueService, w.updateQueue as never);
  container.registerInstance(UserRepository, w.userRepository as never);
  container.registerInstance(PlayRepository, w.playRepository as never);
  container.registerInstance(CrownRepository, w.crownRepository as never);
  container.registerInstance(AutopostService, w.autopostService as never);
  container.registerInstance(LyricStatusService, w.lyricService as never);
  container.registerInstance(LastfmErrorRateTracker, w.tracker as never);
  container.registerInstance(CacheService, w.cache as never);
  if (w.abuse) container.registerInstance(AbuseFilterService, w.abuse as never);
  if (w.reconcile) container.registerInstance(ReconcileService, w.reconcile as never);
  return w;
};

const noShard = () => ({ shard: undefined, channels: { fetch: vi.fn(async () => null) } });
const shardOn = (ids: number[]) => ({ shard: { ids }, channels: { fetch: vi.fn(async () => null) } });

let service: TimerService;

beforeEach(() => {
  cronMock.schedule.mockClear();
  cronMock.validate.mockReturnValue(true);
  service = new TimerService();
});

afterEach(() => {
  service.stopAsync();
  container.clearInstances();
  vi.clearAllMocks();
});

describe('TimerService.startAsync — what gets scheduled', () => {
  it('registers every job this bot relies on', () => {
    service.startAsync();
    expect(cronMock.schedule).toHaveBeenCalledTimes(11);
    expect(cronMock.jobs().map((j) => j.expression).sort()).toEqual([
      '*/10 * * * *',
      '*/10 * * * *',
      '*/15 * * * *',
      '*/2 * * * *',
      '*/5 * * * *',
      '0 * * * *',
      '0 4 * * *',
      '0 5 * * *',
      '0 6,14 * * *',
      '0 8 * * *',
      '0 9 * * *',
    ]);
  });

  it('pumps the index queue on a tighter schedule than the update queue', () => {
    // The full index walks far more rows than the delta sync, so it cannot
    // share the five-minute cadence.
    service.startAsync();
    expect(cronMock.jobs()[JOB.indexPump]?.expression).toBe('*/2 * * * *');
    expect(cronMock.jobs()[JOB.updateQueue]?.expression).toBe('*/5 * * * *');
  });

  it('refuses an invalid cron expression instead of scheduling a broken job', () => {
    cronMock.validate.mockReturnValue(false);
    service.startAsync();
    expect(cronMock.schedule).not.toHaveBeenCalled();
  });

  it('skips a job whose expression is rejected while keeping the valid ones', () => {
    cronMock.validate.mockImplementation((e: string) => e !== '0 8 * * *');
    service.startAsync();
    expect(cronMock.jobs().some((j) => j.expression === '0 8 * * *')).toBe(false);
    expect(cronMock.schedule).toHaveBeenCalledTimes(10);
  });

  it('never schedules the same job name twice', () => {
    // `startAsync` runs once per boot, but a re-entrant boot would otherwise
    // double every interval.
    service.startAsync();
    service.startAsync();
    expect(cronMock.schedule).toHaveBeenCalledTimes(11);
  });
});

describe('TimerService — the overlap guard', () => {
  it('skips a tick while the previous run is still going', async () => {
    const w = registerAll();
    service.startAsync();

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    w.indexQueue.pump = vi.fn(async () => { calls++; await held; });

    const first = run(JOB.indexPump)?.();
    await Promise.resolve();
    await Promise.resolve();
    await run(JOB.indexPump)?.();

    expect(calls).toBe(1);
    release();
    await first;
  });

  it('lets the next tick run once the previous one finished', async () => {
    const w = registerAll();
    service.startAsync();

    let calls = 0;
    w.indexQueue.pump = vi.fn(async () => { calls++; });

    await run(JOB.indexPump)?.();
    await run(JOB.indexPump)?.();

    expect(calls).toBe(2);
  });

  it('releases the guard after a job throws, so the schedule is not wedged', async () => {
    const w = registerAll();
    service.startAsync();

    let calls = 0;
    w.indexQueue.pump = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('database is gone');
    });

    await expect(run(JOB.indexPump)?.()).resolves.toBeUndefined();
    await run(JOB.indexPump)?.();

    expect(calls).toBe(2);
  });

  it('contains a throwing job instead of letting it escape the timer', async () => {
    const w = registerAll();
    w.updateHandler.processAsync = vi.fn(async () => { throw new Error('queue handler exploded'); });
    service.startAsync();

    await expect(run(JOB.updateQueue)?.()).resolves.toBeUndefined();
  });
});

describe('TimerService — shard ownership', () => {
  it('runs the global jobs on an unsharded process', async () => {
    const w = registerAll();
    container.registerInstance(Client, noShard() as never);
    service.startAsync();

    await run(JOB.enqueueOutdated)?.();

    expect(w.userRepository.getOutdatedUsers).toHaveBeenCalled();
  });

  it('skips every global job on a non-zero shard', async () => {
    // Each shard would run the same fan-out, so autoposts and purges would
    // repeat N times per day.
    const w = registerAll();
    container.registerInstance(Client, shardOn([2]) as never);
    service.startAsync();

    await run(JOB.enqueueOutdated)?.();
    await run(JOB.enqueueStale)?.();
    await run(JOB.privacyPurge)?.();
    await run(JOB.autopost)?.();
    await run(JOB.reconcile)?.();
    await run(JOB.abuseScan)?.();
    await run(JOB.lyrics)?.();

    expect(w.userRepository.getOutdatedUsers).not.toHaveBeenCalled();
    expect(w.userRepository.getUsersWithStaleIndex).not.toHaveBeenCalled();
    expect(w.userRepository.getPrivacyHiddenUserIds).not.toHaveBeenCalled();
    expect(w.autopostService.runScheduledAutoposts).not.toHaveBeenCalled();
  });

  it('still runs the per-shard jobs on a non-zero shard', async () => {
    // The index and update queues are per-process state, so every shard pumps
    // its own, and shard 1's heap is the one nobody else can see.
    const w = registerAll();
    container.registerInstance(Client, shardOn([1]) as never);
    service.startAsync();

    await run(JOB.indexPump)?.();
    await run(JOB.updateQueue)?.();
    await run(JOB.memorySample)?.();

    expect(w.indexQueue.pump).toHaveBeenCalled();
    expect(w.updateHandler.processAsync).toHaveBeenCalled();
  });

  it('runs the global jobs on shard zero', async () => {
    const w = registerAll();
    container.registerInstance(Client, shardOn([0]) as never);
    service.startAsync();

    await run(JOB.autopost)?.();

    expect(w.autopostService.runScheduledAutoposts).toHaveBeenCalled();
  });

  it('fail-closed when the shard check throws, so one shard incident cannot duplicate fan-out', async () => {
    // Old catch returned true: a throwing resolve ran global jobs everywhere.
    const w = registerAll();
    container.registerInstance(Client, noShard() as never);
    const spy = vi.spyOn(container, 'resolve').mockImplementationOnce(() => {
      throw new Error('shard incident');
    });
    service.startAsync();

    try {
      await run(JOB.enqueueOutdated)?.();
    } finally {
      spy.mockRestore();
    }

    expect(w.userRepository.getOutdatedUsers).not.toHaveBeenCalled();
  });

  it('does nothing for the autopost job when no client is registered', async () => {
    registerAll();
    service.startAsync();
    await expect(run(JOB.autopost)?.()).resolves.toBeUndefined();
  });
});

describe('TimerService — the stale-user sweeps', () => {
  it('queues every outdated user and then pumps', async () => {
    const w = registerAll({
      userRepository: { getOutdatedUsers: vi.fn(async () => [OUTDATED_USER]) },
    });
    service.startAsync();

    await run(JOB.enqueueOutdated)?.();

    expect(w.updateQueue.enqueue).toHaveBeenCalledWith(OUTDATED_USER);
    expect(w.updateQueue.pump).toHaveBeenCalled();
  });

  it('does not claim success when the outdated read failed', async () => {
    // The throw is contained by the job wrapper, but nothing downstream runs -
    // and crucially nothing is stamped anywhere - so the next sweep retries.
    const w = registerAll({
      userRepository: {
        getOutdatedUsers: vi.fn(async () => { throw new Error('relation does not exist'); }),
      },
    });
    service.startAsync();

    await expect(run(JOB.enqueueOutdated)?.()).resolves.toBeUndefined();
    expect(w.updateQueue.pump).not.toHaveBeenCalled();
  });

  it('queues stale-index users with the flag the daily-skip guard keys off', async () => {
    const w = registerAll({
      userRepository: { getUsersWithStaleIndex: vi.fn(async () => [{ userId: 1 }]) },
    });
    service.startAsync();

    await run(JOB.enqueueStale)?.();

    expect(w.indexQueue.enqueue).toHaveBeenCalledWith({ userId: 1, indexQueue: true });
  });
});

describe('TimerService — the privacy purge', () => {
  const hidden = (over: Rec = {}) => ({
    getPrivacyHiddenUserIds: vi.fn(async () => [1]),
    getUserById: vi.fn(async () => ({ discordUserId: 'd1' })),
    ...over,
  });

  it('deletes plays, aggregates and crowns for every hidden user', async () => {
    const w = registerAll({ userRepository: hidden() });
    service.startAsync();

    await run(JOB.privacyPurge)?.();

    expect(w.playRepository.deleteAllPlaysForUser).toHaveBeenCalledWith(1);
    expect(w.crownRepository.deactivateCrownsForUser).toHaveBeenCalledWith(1);
  });

  it('drops the identity cache entry so another reader cannot resolve the user', async () => {
    const w = registerAll({ userRepository: hidden() });
    service.startAsync();

    await run(JOB.privacyPurge)?.();

    expect(w.cache.delete).toHaveBeenCalledWith('user-discord:d1');
    expect(w.cache.delete).toHaveBeenCalledWith('user-1-topartists-alltime');
  });

  it('keeps purging the remaining users after one of them failed', async () => {
    const w = registerAll({
      userRepository: hidden({ getPrivacyHiddenUserIds: vi.fn(async () => [1, 2]) }),
      playRepository: {
        deleteAllPlaysForUser: vi.fn(async () => { throw new Error('deadlock'); }),
      },
    });
    service.startAsync();

    await expect(run(JOB.privacyPurge)?.()).resolves.toBeUndefined();

    expect(w.playRepository.deleteAllPlaysForUser).toHaveBeenCalledTimes(2);
  });

  it('does not treat a failed purge as done', async () => {
    // `getUserById` is deliberately NOT swallowed: a failure used to return
    // null, skip the cache delete below and still count the user as cleaned.
    const w = registerAll({
      userRepository: hidden({
        getUserById: vi.fn(async () => { throw new Error('db down'); }),
      }),
    });
    service.startAsync();

    await expect(run(JOB.privacyPurge)?.()).resolves.toBeUndefined();

    // The play rows were deleted; the identity cache entry was not, and
    // nothing recorded that, which is exactly the shape this guards against.
    expect(w.playRepository.deleteAllPlaysForUser).toHaveBeenCalled();
    expect(w.cache.delete).not.toHaveBeenCalledWith('user-discord:d1');
  });
});

describe('TimerService — the optional jobs', () => {
  it('skips the abuse scan when the service is not registered', async () => {
    registerAll();
    service.startAsync();
    await expect(run(JOB.abuseScan)?.()).resolves.toBeUndefined();
  });

  it('runs the abuse scan when it is registered', async () => {
    const abuse = { scanAndFlag: vi.fn(async () => undefined) };
    registerAll({ abuse });
    service.startAsync();

    await run(JOB.abuseScan)?.();

    expect(abuse.scanAndFlag).toHaveBeenCalled();
  });

  it('contains an abuse scan that throws', async () => {
    registerAll({ abuse: { scanAndFlag: vi.fn(async () => { throw new Error('db down'); }) } });
    service.startAsync();
    await expect(run(JOB.abuseScan)?.()).resolves.toBeUndefined();
  });

  it('skips the reconcile job when the service is not registered', async () => {
    registerAll();
    service.startAsync();
    await expect(run(JOB.reconcile)?.()).resolves.toBeUndefined();
  });

  it('runs the reconcile job when it is registered', async () => {
    const reconcile = { runAsync: vi.fn(async () => ({ fixed: 0 })) };
    registerAll({ reconcile });
    service.startAsync();

    await run(JOB.reconcile)?.();

    expect(reconcile.runAsync).toHaveBeenCalled();
  });

  it('runs the lyric updater on the owner shard', async () => {
    const w = registerAll();
    container.registerInstance(Client, shardOn([0]) as never);
    service.startAsync();

    await run(JOB.lyrics)?.();

    expect(w.lyricService.updateLyricStatusAsync).toHaveBeenCalled();
  });

  it('resets the shared Last.fm error budget on the statistics tick', async () => {
    const w = registerAll();
    service.startAsync();

    await run(JOB.statistics)?.();

    expect(w.tracker.logAndReset).toHaveBeenCalled();
  });
});

describe('TimerService.stopAsync', () => {
  it('stops every scheduled task', () => {
    service.startAsync();
    const stops = cronMock.schedule.mock.results.map((r) => (r.value as { stop: () => void }).stop);

    service.stopAsync();

    for (const stop of stops) expect(stop).toHaveBeenCalled();
  });

  it('is safe to call on a service that never started, and twice', () => {
    expect(() => new TimerService().stopAsync()).not.toThrow();
    service.startAsync();
    service.stopAsync();
    expect(() => service.stopAsync()).not.toThrow();
  });
});
