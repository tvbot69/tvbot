import { Logger } from '@domain/logger';

/**
 * The old-space ceiling `npm start` boots with (`node --max-old-space-size=384`
 * in package.json). Every percentage here is measured against it, so this must
 * change in the same commit if the start command does.
 */
export const HEAP_CAP_MB = 384;

const BYTES_PER_MB = 1024 * 1024;

export interface MemoryReport {
  /** Resident set of THIS process. Chromium's child is a separate OS process and is NOT in here. */
  rssMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  heapUsedPctOfCap: number;
  heapCapMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  uptimeSeconds: number;
  /** Human-readable uptime (`2d4h11m`), so a line can be read without arithmetic. */
  uptime: string;
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function toMb(bytes: number): number {
  return round(finite(bytes) / BYTES_PER_MB, 1);
}

/**
 * `process.memoryUsage()` covers this process only. Chromium runs as a child
 * (reachable as `PuppeteerService`'s private `browser.process()?.pid`), so its
 * ~60MB is invisible here — read RSS as the Node floor, never as the whole
 * container. Deliberately no process-tree accounting: one extra `ps` per hour
 * would buy a number that only says Chromium exists.
 *
 * Also note `heapUsedPctOfCap` can exceed 100: `--max-old-space-size` bounds
 * old space only, while heapUsed also covers new space and the code space.
 */
export function buildMemoryReport(
  sample: NodeJS.MemoryUsage = process.memoryUsage(),
  uptimeSeconds: number = process.uptime(),
): MemoryReport {
  const heapUsed = finite(sample.heapUsed);
  return {
    rssMb: toMb(sample.rss),
    heapTotalMb: toMb(sample.heapTotal),
    heapUsedMb: toMb(heapUsed),
    heapUsedPctOfCap: round((heapUsed / (HEAP_CAP_MB * BYTES_PER_MB)) * 100, 2),
    heapCapMb: HEAP_CAP_MB,
    externalMb: toMb(sample.external),
    arrayBuffersMb: toMb(sample.arrayBuffers),
    uptimeSeconds: finite(uptimeSeconds),
    uptime: formatUptime(uptimeSeconds),
  };
}

export function formatUptime(totalSeconds: number): string {
  const seconds = Math.floor(finite(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (days > 0) return `${days}d${hours % 24}h${minutes % 60}m`;
  if (hours > 0) return `${hours}h${pad(minutes % 60)}m`;
  return `${minutes}m${pad(seconds % 60)}s`;
}

/**
 * The periodic sample. Never throws: a memory probe that takes down the timer
 * that called it would trade a log line for an outage, and `process.memoryUsage`
 * plus the logger's own I/O are both capable of throwing.
 */
export function logMemoryReport(): void {
  try {
    Logger.info({ ...buildMemoryReport() }, 'Memory sample');
  } catch (err) {
    try {
      Logger.debug({ err }, 'Memory sample unavailable');
    } catch {
      // A broken logger is reported by every other line already.
    }
  }
}
