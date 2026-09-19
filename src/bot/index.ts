import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'reflect-metadata';
import { Logger } from '@domain/logger';
import { shouldShard } from './shardManager';

process.on('unhandledRejection', (reason) => {
  Logger.error({ err: reason }, 'Unhandled promise rejection intercepted in process');
});

process.on('uncaughtException', (error) => {
  Logger.fatal({ err: error }, 'Uncaught exception intercepted in process');
});

async function bootstrap(): Promise<void> {
  try {
    // Manager mode only when explicitly enabled; default is the single worker
    // (identical behavior to before sharding existed).
    if (shouldShard()) {
      const { runShardManager } = await import('./shardManager');
      await runShardManager();
    } else {
      await import('./shardWorker');
    }
  } catch (err) {
    Logger.fatal({ err }, 'Fatal error during bootstrap import');
    process.exit(1);
  }
}

void bootstrap();
