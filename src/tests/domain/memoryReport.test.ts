import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildMemoryReport,
  formatUptime,
  logMemoryReport,
  HEAP_CAP_MB,
} from '@domain/memoryReport';
import { Logger } from '@domain/logger';

const MB = 1024 * 1024;

function sample(overrides: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 300 * MB,
    heapTotal: 200 * MB,
    heapUsed: 100 * MB,
    external: 20 * MB,
    arrayBuffers: 8 * MB,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildMemoryReport', () => {
  it('reports every field of process.memoryUsage() as a finite number', () => {
    const report = buildMemoryReport(sample(), 4242);
    for (const [key, value] of Object.entries(report)) {
      if (key === 'uptime') continue;
      expect(typeof value, `${key} must be a number`).toBe('number');
      expect(Number.isFinite(value as number), `${key} must be finite`).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('converts each byte field to MB', () => {
    const report = buildMemoryReport(sample({ rss: 268435456 }), 0);
    expect(report.rssMb).toBe(256);
    expect(report.heapTotalMb).toBe(200);
    expect(report.heapUsedMb).toBe(100);
    expect(report.externalMb).toBe(20);
    expect(report.arrayBuffersMb).toBe(8);
  });

  it('expresses heapUsed as a percentage of the 384MB heap cap', () => {
    const half = buildMemoryReport(sample({ heapUsed: 192 * MB }));
    expect(half.heapUsedPctOfCap).toBe(50);
    expect(half.heapCapMb).toBe(384);

    expect(buildMemoryReport(sample({ heapUsed: 96 * MB })).heapUsedPctOfCap).toBe(25);
    expect(buildMemoryReport(sample({ heapUsed: 288 * MB })).heapUsedPctOfCap).toBe(75);
    expect(buildMemoryReport(sample({ heapUsed: 384 * MB })).heapUsedPctOfCap).toBe(100);
  });

  it('keeps the percentage above 100 visible when the heap exceeds the cap', () => {
    const over = buildMemoryReport(sample({ heapUsed: 384 * MB + 4 * MB }));
    expect(over.heapUsedPctOfCap).toBeGreaterThan(100);
  });

  it('reads the live process by default', () => {
    const report = buildMemoryReport();
    expect(report.heapUsedMb).toBeGreaterThan(0);
    expect(report.uptimeSeconds).toBeCloseTo(process.uptime(), 1);
    expect(report.heapCapMb).toBe(HEAP_CAP_MB);
  });

  it('handles a zero or absent uptime without NaN', () => {
    const zero = buildMemoryReport(sample(), 0);
    expect(zero.uptimeSeconds).toBe(0);
    expect(zero.uptime).toBe('0s');

    const negative = buildMemoryReport(sample(), -1);
    expect(negative.uptimeSeconds).toBe(0);
    expect(negative.uptime).toBe('0s');
  });

  it('coerces non-numeric memory figures to 0 rather than logging NaN', () => {
    const report = buildMemoryReport(
      sample({ rss: Number.NaN, heapUsed: -5, external: Number.POSITIVE_INFINITY }),
      60,
    );
    expect(report.rssMb).toBe(0);
    expect(report.heapUsedMb).toBe(0);
    expect(report.heapUsedPctOfCap).toBe(0);
    expect(report.externalMb).toBe(0);
  });
});

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [60, '1m00s'],
    [3661, '1h01m'],
    [90061, '1d1h1m'],
    [864000, '10d0h0m'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });

  it('treats a negative or absent uptime as zero', () => {
    expect(formatUptime(-30)).toBe('0s');
    expect(formatUptime(Number.NaN)).toBe('0s');
  });
});

describe('logMemoryReport', () => {
  it('logs one INFO line carrying the whole report', () => {
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);

    logMemoryReport();

    expect(info).toHaveBeenCalledTimes(1);
    const [payload, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('Memory sample');
    expect(payload.heapCapMb).toBe(384);
    expect(typeof payload.rssMb).toBe('number');
    expect(typeof payload.heapUsedPctOfCap).toBe('number');
    expect(typeof payload.uptime).toBe('string');
  });

  it('never throws when the memory probe fails', () => {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('probe exploded');
    });
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);

    expect(() => logMemoryReport()).not.toThrow();
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('never rethrows when the logger itself fails', () => {
    vi.spyOn(Logger, 'info').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    vi.spyOn(Logger, 'debug').mockImplementation(() => {
      throw new Error('stdout closed too');
    });

    expect(() => logMemoryReport()).not.toThrow();
  });
});
