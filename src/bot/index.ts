import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'reflect-metadata';
import { Logger } from '@domain/logging/logger';
import { shouldShard } from '@bot/shardManager';
import { reportFatalToDiscord } from '@domain/logging/errorFeed';

process.on('unhandledRejection', (reason) => {
  Logger.error({ err: reason }, 'Unhandled promise rejection intercepted in process');
  reportFatalToDiscord('unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  Logger.fatal({ err: error }, 'Uncaught exception intercepted in process');
  reportFatalToDiscord('uncaughtException', error);
  // Log lines are buffered; a hard exit must not lose the tail that
  // explains WHY the process died.
  Logger.flushLogFile();
});

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
