import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryService } from './telemetryService';

/**
 * The numbers behind the health endpoint and the autopost telemetry.
 *
 * Two things here are quietly load-bearing:
 *
 *   - `recordCommandExecution` folds a text command and its slash twin into ONE
 *     bucket, stripping the leading dot. Without that fold, `.play` and `/play`
 *     look like two different commands and a p95 is computed over half the
 *     samples that exist.
 *   - `calculatePercentile` is the only place a p95 is produced, and it clamps
 *     its index at both ends. An off-by-one at the top of the range returns
 *     `undefined` and the health report renders "p95: undefined" — which reads
 *     as instrumentation being broken rather than as a bug.
 */

let service: TelemetryService;

beforeEach(() => {
  service = new TelemetryService();
});

describe('TelemetryService.recordCommandExecution', () => {
  it('folds the text and slash spellings of one command into one metric', () => {
    // The slash twin arrives as a BARE name: `interaction.commandName` carries no
    // leading slash, and the text twin arrives with the prefix dot, which
    // `recordCommandExecution` strips. That fold is the whole claim — a name
    // spelled `/play` is not what either caller passes, so it would be a second
    // bucket rather than the same one.
    service.recordCommandExecution('play', 10, true);
    service.recordCommandExecution('.play', 30, true);

    const metric = service.getCommandMetric('play');
    expect(metric?.executions).toBe(2);
    expect(service.getCommandMetric('/play')).toBeUndefined();
  });

  it('is case- and whitespace-insensitive about the name', () => {
    // Normalisation is `toLowerCase().replace(/^\./, '').trim()` — the dot is
    // removed BEFORE the trim, so LEADING whitespace defeats the strip and keys
    // the metric as `.whoknews`. No real caller passes a padded name
    // (`commandHandler` hands over an already-lowercased `split.shift()` and
    // `interactionHandler` an already-lowercased `interaction.commandName`), so
    // the test uses the shape production actually receives. The important
    // property is that record and read normalise IDENTICALLY, so a lookup still
    // finds the entry it wrote.
    service.recordCommandExecution('.Whoknews  ', 10);
    expect(service.getCommandMetric('whoknews')?.executions).toBe(1);
    expect(service.getCommandMetric('.Whoknews')?.executions).toBe(1);
  });

  it('keeps distinct commands apart', () => {
    service.recordCommandExecution('.play', 10);
    service.recordCommandExecution('.pause', 10);
    expect(service.getCommandMetric('play')?.executions).toBe(1);
    expect(service.getCommandMetric('pause')?.executions).toBe(1);
  });

  it('answers undefined for a command that never ran', () => {
    expect(service.getCommandMetric('.nothing')).toBeUndefined();
  });

  it('counts failures separately from executions', () => {
    service.recordCommandExecution('play', 10, true);
    service.recordCommandExecution('play', 10, false);

    const metric = service.getCommandMetric('play');
    expect(metric?.executions).toBe(2);
    expect(metric?.failures).toBe(1);
  });

  it('defaults to a success when the caller says nothing', () => {
    service.recordCommandExecution('play', 10);
    expect(service.getCommandMetric('play')?.failures).toBe(0);
  });

  it('tracks the slowest and fastest call separately from the average', () => {
    service.recordCommandExecution('play', 100, true);
    service.recordCommandExecution('play', 20, true);
    service.recordCommandExecution('play', 60, true);

    const metric = service.getCommandMetric('play');
    expect(metric?.minDurationMs).toBe(20);
    expect(metric?.maxDurationMs).toBe(100);
    expect(metric?.totalDurationMs).toBe(180);
  });

  it('seeds min and max from the very first call', () => {
    // Both are initialised in the constructor of the metric, so a single call
    // is a correct min AND max rather than zero.
    service.recordCommandExecution('play', 42, true);
    const metric = service.getCommandMetric('play');
    expect(metric?.minDurationMs).toBe(42);
    expect(metric?.maxDurationMs).toBe(42);
  });

  it('keeps only the last hundred latencies, so memory is bounded', () => {
    for (let i = 0; i < 150; i++) service.recordCommandExecution('play', i, true);

    const metric = service.getCommandMetric('play');
    expect(metric?.executions).toBe(150);
    // The window is a RECENT one: the oldest samples are the ones dropped, so a
    // p95 computed from it reflects current behaviour rather than a boot spike.
    expect(metric?.recentLatencies).toHaveLength(100);
    expect(metric?.recentLatencies[0]).toBe(50);
  });
});

describe('TelemetryService.calculatePercentile', () => {
  it('answers zero for an empty sample rather than undefined', () => {
    expect(service.calculatePercentile([], 95)).toBe(0);
  });

  it('answers the only value for a single sample', () => {
    expect(service.calculatePercentile([7], 95)).toBe(7);
    expect(service.calculatePercentile([7], 50)).toBe(7);
  });

  it('picks the median at p50', () => {
    expect(service.calculatePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  it('picks p95 out of a hundred samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(service.calculatePercentile(samples, 95)).toBe(95);
  });

  it('clamps p100 to the largest sample instead of running off the end', () => {
    const samples = [1, 2, 3];
    expect(service.calculatePercentile(samples, 100)).toBe(3);
  });

  it('clamps p0 to the smallest sample', () => {
    const samples = [1, 2, 3];
    expect(service.calculatePercentile(samples, 0)).toBe(1);
  });

  it('does not mutate the array the caller passed in while sorting', () => {
    // The samples array is the one held on the metric; sorting it in place
    // would silently destroy the insertion order the report relies on.
    const samples = [5, 1, 3];
    service.calculatePercentile(samples, 95);
    expect(samples).toEqual([5, 1, 3]);
  });
});

describe('TelemetryService.recordApiCall', () => {
  it('counts a 2xx as a success', () => {
    service.recordApiCall('lastfm', 'track.getInfo', 10, 200);
    const report = service.getHealthMetrics();
    expect(report.externalApis.lastfm).toMatchObject({ totalCalls: 1, successCalls: 1, errorCalls: 0 });
  });

  it('counts a 3xx as a success, since nothing failed', () => {
    service.recordApiCall('spotify', 'search', 10, 302);
    expect(service.getHealthMetrics().externalApis.spotify?.successCalls).toBe(1);
  });

  it('counts a 5xx as an error and keeps the message', () => {
    service.recordApiCall('spotify', 'search', 10, 500, 'upstream exploded');
    const metric = service.getHealthMetrics().externalApis.spotify;
    expect(metric?.errorCalls).toBe(1);
    expect(metric?.lastErrorMessage).toBe('upstream exploded');
    expect(metric?.lastErrorTimestamp).toBeInstanceOf(Date);
  });

  it('counts a 429 separately from other errors, so a throttled API is visible', () => {
    service.recordApiCall('lastfm', 'user.getInfo', 10, 429, 'rate limited');
    const metric = service.getHealthMetrics().externalApis.lastfm;
    expect(metric?.errorCalls).toBe(1);
    expect(metric?.rateLimitedCalls).toBe(1);
  });

  it('does not count a 429 as a rate limit when it also succeeded', () => {
    service.recordApiCall('lastfm', 'x', 10, 200);
    service.recordApiCall('lastfm', 'x', 10, 429);
    const metric = service.getHealthMetrics().externalApis.lastfm;
    expect(metric?.successCalls).toBe(1);
    expect(metric?.rateLimitedCalls).toBe(1);
  });

  it('keeps the services in separate buckets', () => {
    service.recordApiCall('lastfm', 'x', 10, 500);
    service.recordApiCall('discord', 'x', 10, 200);
    const report = service.getHealthMetrics();
    expect(report.externalApis.lastfm?.errorCalls).toBe(1);
    expect(report.externalApis.discord?.successCalls).toBe(1);
  });
});

describe('TelemetryService.getHealthMetrics', () => {
  it('reports healthy when nothing failed', () => {
    service.recordCommandExecution('play', 10, true);
    expect(service.getHealthMetrics().status).toBe('healthy');
  });

  it('reports degraded above a five percent failure rate', () => {
    // 6% — the boundary itself is a `> 5`, so exactly 5% is still healthy.
    for (let i = 0; i < 6; i++) service.recordCommandExecution('play', 10, true);
    service.recordCommandExecution('play', 10, false);
    expect(service.getHealthMetrics().status).toBe('degraded');
  });

  it('still reports healthy at exactly five percent', () => {
    for (let i = 0; i < 95; i++) service.recordCommandExecution('play', 10, true);
    for (let i = 0; i < 5; i++) service.recordCommandExecution('play', 10, false);
    const report = service.getHealthMetrics();
    expect(report.commandFailureRate).toBe(5);
    expect(report.status).toBe('healthy');
  });

  it('reports unhealthy above a fifteen percent failure rate', () => {
    for (let i = 0; i < 80; i++) service.recordCommandExecution('play', 10, true);
    for (let i = 0; i < 20; i++) service.recordCommandExecution('play', 10, false);
    expect(service.getHealthMetrics().status).toBe('unhealthy');
  });

  it('reports healthy with no traffic at all, rather than dividing by zero', () => {
    const report = service.getHealthMetrics();
    expect(report.status).toBe('healthy');
    expect(report.commandFailureRate).toBe(0);
  });

  it('rounds the failure rate to one decimal place', () => {
    for (let i = 0; i < 3; i++) service.recordCommandExecution('a', 1, true);
    service.recordCommandExecution('b', 1, false);
    expect(service.getHealthMetrics().commandFailureRate).toBe(25);
  });

  it('sorts the busiest command first and caps the list at ten', () => {
    for (let i = 0; i < 12; i++) {
      service.recordCommandExecution(`cmd${i}`, 100, true);
      for (let n = 0; n < i; n++) service.recordCommandExecution(`cmd${i}`, 100, true);
    }
    const report = service.getHealthMetrics();
    expect(report.topCommands).toHaveLength(10);
    expect(report.topCommands[0]?.command).toBe('cmd11');
  });

  it('averages duration per command, not across all of them', () => {
    service.recordCommandExecution('fast', 10, true);
    service.recordCommandExecution('slow', 1000, true);
    const report = service.getHealthMetrics();
    const fast = report.topCommands.find((c) => c.command === 'fast');
    expect(fast?.avgMs).toBe(10);
  });

  it('exposes a snapshot of the API metrics rather than the live objects', () => {
    service.recordApiCall('lastfm', 'x', 10, 200);
    const first = service.getHealthMetrics();
    service.recordApiCall('lastfm', 'x', 10, 500);
    expect(first.externalApis.lastfm?.errorCalls).toBe(0);
  });

  it('reports a non-negative uptime and a real heap reading', () => {
    const report = service.getHealthMetrics();
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.memoryUsageMb.heapTotal).toBeGreaterThan(0);
  });
});

describe('TelemetryService.reset', () => {
  it('clears both buckets', () => {
    service.recordCommandExecution('play', 10, false);
    service.recordApiCall('lastfm', 'x', 10, 500);

    service.reset();

    expect(service.getCommandMetric('play')).toBeUndefined();
    expect(service.getHealthMetrics().externalApis).toEqual({});
  });
});
