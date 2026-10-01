import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Fake cron, so the wiring is asserted without waiting an hour. `schedule` is
 * the only seam the timer really has, and `registerJob` hands it the job body —
 * capturing that pair proves both that the job was registered at the right
 * cadence and that its body emits the sample.
 */
const scheduled = vi.hoisted(
  () => [] as Array<{ expr: string; job: () => void | Promise<void> }>,
);

vi.mock('node-cron', () => ({
  default: {
    validate: () => true,
    schedule: (expr: string, job: () => void | Promise<void>) => {
      scheduled.push({ expr, job });
      return { stop: () => undefined };
    },
  },
}));

import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { TimerService } from '@bot/services/lastfm/timerService';
import { Logger } from '@domain/logging/logger';

const HOURLY = '0 * * * *';

function hourlyJob(): () => void | Promise<void> {
  const matches = scheduled.filter((s) => s.expr === HOURLY);
  expect(matches).toHaveLength(1);
  return matches[0]!.job;
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scheduled.length = 0;
  container.clearInstances();
  info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  container.clearInstances();
  vi.restoreAllMocks();
});

describe('TimerService memory sample', () => {
  it('registers exactly one hourly job alongside the existing sweeps', () => {
    new TimerService().startAsync();

    const exprs = scheduled.map((s) => s.expr);
    expect(exprs.filter((e) => e === HOURLY)).toHaveLength(1);
    // The 10 pre-existing jobs plus this one. A count pins "no second interval",
    // which a cron-expression check alone cannot: */10 and 0 * * * * are both
    // valid and only one of them is once an hour.
    expect(exprs).toHaveLength(11);
    new TimerService().stopAsync();
  });

  it('emits one INFO memory sample when the hourly job fires', async () => {
    new TimerService().startAsync();

    await hourlyJob()();

    const sample = info.mock.calls.filter((c) => c[1] === 'Memory sample');
    expect(sample).toHaveLength(1);
    const payload = sample[0]![0] as Record<string, unknown>;
    expect(payload.heapCapMb).toBe(384);
    expect(typeof payload.rssMb).toBe('number');
    expect(typeof payload.heapUsedPctOfCap).toBe('number');
  });

  it('samples non-zero shards too: each shard has its own heap', async () => {
    container.registerInstance(Client, { shard: { ids: [1] } } as unknown as Client);
    new TimerService().startAsync();

    await hourlyJob()();

    const sample = info.mock.calls.filter((c) => c[1] === 'Memory sample');
    expect(sample).toHaveLength(1);
    // ...while a fan-out job is still suppressed on that shard, so the sample
    // did not simply un-gate everything.
    const reconcile = scheduled.find((s) => s.expr === '0 9 * * *');
    await reconcile!.job();
    expect(info.mock.calls.filter((c) => c[1] === 'Index reconcile complete')).toHaveLength(0);
  });

  it('does not take the timer down when the probe throws', async () => {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('probe exploded');
    });
    new TimerService().startAsync();

    await expect(hourlyJob()()).resolves.toBeUndefined();
    expect(info.mock.calls.filter((c) => c[1] === 'Memory sample')).toHaveLength(0);
  });
});
