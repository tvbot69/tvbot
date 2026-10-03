import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'reflect-metadata';
import { Logger } from '@domain/logging/logger';
import { shouldShard } from '@bot/shardManager';
import { reportFatalToDiscord } from '@domain/logging/errorFeed';

/**
 * Count of `unhandledRejection`s since boot. `HealthServer` is not touched by
 * this file, so the count is mirrored to `globalThis` where `/health` can read
 * it without importing the entrypoint (importing it would re-run `bootstrap`).
 */
export const processHealth = { unhandledRejectionCount: 0 };
(globalThis as { __tvbotProcessHealth?: typeof processHealth }).__tvbotProcessHealth =
  processHealth;

export const getUnhandledRejectionCount = (): number => processHealth.unhandledRejectionCount;

/** Hard fallback when a corrupt process does not drain on its own. */
export const UNCAUGHT_EXCEPTION_FALLBACK_MS = 5000;

type ShutdownFn = (signal: string, exitCode: number) => Promise<void>;

const defaultShutdown: ShutdownFn = async (signal, exitCode) => {
  // Dynamic import: index.ts is the entrypoint, and a static import would risk
  // a cycle through the services ShutdownService pulls in.
  const { ShutdownService } = await import('@bot/services/system/shutdownService');
  await ShutdownService.shutdown(signal, exitCode);
};

/**
 * Injection seam for tests. Production uses the defaults; tests replace
 * `shutdown`/`exit` so asserting the fate never kills the runner.
 */
export const processFateSeams: { shutdown: ShutdownFn; exit: (code: number) => void } = {
  shutdown: defaultShutdown,
  exit: (code: number): void => {
    process.exit(code);
  },
};

export function handleUnhandledRejection(reason: unknown): void {
  processHealth.unhandledRejectionCount += 1;
  Logger.error({ err: reason }, 'Unhandled promise rejection intercepted in process');
  reportFatalToDiscord('unhandledRejection', reason);
}

export function handleUncaughtException(error: unknown): void {
  Logger.fatal({ err: error }, 'Uncaught exception intercepted in process');
  try {
    reportFatalToDiscord('uncaughtException', error);
  } finally {
    // Log lines are buffered; a hard exit must not lose the tail that
    // explains WHY the process died.
    Logger.flushLogFile();
    const fallback = setTimeout(() => {
      processFateSeams.exit(1);
    }, UNCAUGHT_EXCEPTION_FALLBACK_MS);
    if (typeof fallback.unref === 'function') {
      fallback.unref();
    }
    // ShutdownService drains up to 30s then exits on its own. The fallback
    // above is what caps a corrupt process at 5s. Clear it only on success so
    // a rejected drain still hits the hard exit.
    void processFateSeams.shutdown('uncaughtException', 1).then(
      () => {
        clearTimeout(fallback);
      },
      () => undefined,
    );
  }
}

process.on('unhandledRejection', handleUnhandledRejection);

process.on('uncaughtException', handleUncaughtException);

async function bootstrap(): Promise<void> {
  try {
    // Manager mode only when explicitly enabled; default is the single worker
    // (identical behavior to before sharding existed).
    if (shouldShard()) {
      const { runShardManager } = await import('@bot/shardManager');
      await runShardManager();
    } else {
      await import('@bot/shardWorker');
    }
  } catch (err) {
    Logger.fatal({ err }, 'Fatal error during bootstrap import');
    process.exit(1);
  }
}

void bootstrap();
