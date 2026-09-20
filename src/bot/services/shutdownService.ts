import { container } from 'tsyringe';
import { Client } from 'discord.js';
import { Logger } from '@domain/logger';
import { prisma } from '@persistence/prismaClient';
import { TimerService } from './timerService';
import { CacheService } from './cacheService';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { HealthServer } from './healthServer';
import { MoonlinkManager } from './music/moonlinkManager';
import { UserUpdateQueueService } from './userUpdateQueueService';
import { UserIndexQueueService } from './userIndexQueueService';

const DRAIN_TIMEOUT_MS = 30000;

export class ShutdownService {
  private static shuttingDown = false;

  private static async withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<void> {
    try {
      await Promise.race([
        fn(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
      ]);
    } catch (err) {
      Logger.warn({ err }, `Shutdown step skipped: ${label}`);
    }
  }

  public static async shutdown(signal: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    Logger.info(`Received ${signal}. Draining up to ${DRAIN_TIMEOUT_MS / 1000}s...`);

    const forceExitTimer = setTimeout(() => {
      Logger.warn(`Graceful shutdown timed out after ${DRAIN_TIMEOUT_MS / 1000}s — forcing exit`);
      process.exit(exitCode);
    }, DRAIN_TIMEOUT_MS);
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    try {
      // 0. Fail readiness first so no new traffic/deploys route here mid-drain
      try {
        container.resolve(HealthServer).setDraining();
      } catch {
        // ignore
      }

      // 1. Stop scheduled timers and cron jobs (no new work enqueued)
      try {
        container.resolve(TimerService).stopAsync();
        Logger.info('Timer service stopped');
      } catch (err) {
        Logger.warn({ err }, 'Error stopping timer service');
      }

      // 2. One last queue drain so in-memory items aren't lost (Redis mirrors
      // cover the rest on next boot)
      await ShutdownService.withTimeout('queue drain', 8000, async () => {
        const tasks: Array<Promise<unknown>> = [];
        try {
          tasks.push(container.resolve(UserUpdateQueueService).pump());
        } catch { /* ignore */ }
        try {
          tasks.push(container.resolve(UserIndexQueueService).pump());
        } catch { /* ignore */ }
        await Promise.allSettled(tasks);
      });

      // 3. Leave voice channels cleanly before the socket dies
      await ShutdownService.withTimeout('player teardown', 8000, async () => {
        const manager = container.resolve(MoonlinkManager).getManager();
        const players = manager.players?.all ?? [];
        await Promise.allSettled(
          players.map((p) => p.destroy('Process shutting down').catch(() => undefined)),
        );
        container.resolve(MoonlinkManager).stop();
      });

      // 4. Disconnect Discord client to immediately mark bot as offline
      try {
        const client = container.resolve(Client);
        client.destroy();
        Logger.info('Discord client destroyed');
      } catch (err) {
        Logger.warn({ err }, 'Error destroying Discord client');
      }

      // 5. Close Puppeteer browser instance
      await ShutdownService.withTimeout('puppeteer close', 5000, async () => {
        await container.resolve(PuppeteerService).close();
        Logger.info('Puppeteer browser closed');
      });

      // 6. Disconnect CacheService (Redis & eviction timers)
      try {
        const cacheService = container.resolve(CacheService);
        await cacheService.disconnect();
        Logger.info('Cache service disconnected');
      } catch (err) {
        Logger.warn({ err }, 'Error disconnecting cache service');
      }

      // 7. Stop health probe HTTP server
      try {
        const healthServer = container.resolve(HealthServer);
        await healthServer.stop();
        Logger.info('Health server stopped');
      } catch (err) {
        Logger.warn({ err }, 'Error stopping health server');
      }

      // 8. Disconnect Prisma database pool
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
