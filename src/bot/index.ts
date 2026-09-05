import 'reflect-metadata';
import { Logger } from '@domain/logger';

process.on('unhandledRejection', (reason) => {
  Logger.error({ err: reason }, 'Unhandled promise rejection intercepted in process');
});

process.on('uncaughtException', (error) => {
  Logger.fatal({ err: error }, 'Uncaught exception intercepted in process');
});

async function bootstrap(): Promise<void> {
  try {
    await import('./startup');
  } catch (err) {
    Logger.fatal({ err }, 'Fatal error during bootstrap import');
    process.exit(1);
  }
}

void bootstrap();
