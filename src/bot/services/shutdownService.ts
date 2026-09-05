import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { prisma } from '@persistence/prismaClient';
import { TimerService } from './timerService';
import { CacheService } from './cacheService';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { HealthServer } from './healthServer';

export class ShutdownService {
  private static shuttingDown = false;

  public static async shutdown(signal: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    Logger.info(`Received ${signal}. Initiating graceful shutdown...`);

    // Safety fallback: force exit after 5 seconds if teardown hangs
    const forceExitTimer = setTimeout(() => {
      Logger.warn('Graceful shutdown timed out after 5s — forcing exit');
      process.exit(exitCode);
    }, 5000);
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    try {
      // 1. Stop scheduled timers and cron jobs
      try {
        const timerService = container.resolve(TimerService);
        timerService.stopAsync();
        Logger.info('Timer service stopped');
      } catch (err) {
        Logger.warn({ err }, 'Error stopping timer service');
      }

      // 2. Disconnect Discord client to immediately mark bot as offline
      try {
        const client = container.resolve(Client);
        client.destroy();
        Logger.info('Discord client destroyed');
      } catch (err) {
        Logger.warn({ err }, 'Error destroying Discord client');
      }

      // 3. Close Puppeteer browser instance
      try {
        const puppeteerService = container.resolve(PuppeteerService);
        await Promise.race([
          puppeteerService.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Puppeteer close timeout')), 3000)),
        ]).catch(() => undefined);
        Logger.info('Puppeteer browser closed');
      } catch (err) {
        Logger.warn({ err }, 'Error closing Puppeteer browser');
      }

      // 4. Disconnect CacheService (Redis & eviction timers)
      try {
        const cacheService = container.resolve(CacheService);
        await cacheService.disconnect();
        Logger.info('Cache service disconnected');
      } catch (err) {
        Logger.warn({ err }, 'Error disconnecting cache service');
      }

      // 5. Stop health probe HTTP server
      try {
        const healthServer = container.resolve(HealthServer);
        await healthServer.stop();
        Logger.info('Health server stopped');
      } catch (err) {
        Logger.warn({ err }, 'Error stopping health server');
      }

      // 6. Disconnect Prisma database pool
      try {
        await prisma.$disconnect();
        Logger.info('Database connection closed');
      } catch (err) {
        Logger.warn({ err }, 'Error disconnecting Prisma client');
      }
    } catch (err) {
      Logger.error({ err }, 'Unexpected error during shutdown sequence');
    } finally {
      clearTimeout(forceExitTimer);
      Logger.info('Graceful shutdown complete. Exiting.');
      process.exit(exitCode);
    }
  }
}
