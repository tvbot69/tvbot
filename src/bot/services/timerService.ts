import { container } from 'tsyringe';
import cron, { type ScheduledTask } from 'node-cron';
import { Client } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { Statistics } from '@domain/statistics';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { UpdateQueueHandler } from '@bot/handlers/updateQueueHandler';
import { UserUpdateQueueService } from './userUpdateQueueService';
import { UserIndexQueueService } from './userIndexQueueService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { AutopostService } from './autopostService';
import { LyricStatusService } from './lyricStatusService';

export class TimerService {
  private readonly tasks: Map<string, ScheduledTask> = new Map();

  /**
   * True when this process owns global jobs: unsharded single process, or
   * shard 0 under a ShardingManager. Non-zero shards skip fan-out jobs
   * (autoposts, queue seeding, purges) so they run exactly once.
   */
  private isGlobalJobOwner(): boolean {
    try {
      if (!container.isRegistered(Client)) return true;
      const ids = container.resolve(Client).shard?.ids;
      if (!ids || ids.length === 0) return true;
      return ids[0] === 0;
    } catch {
      return true;
    }
  }

  private onlyOwner(job: () => void | Promise<void>): () => void | Promise<void> {
    return () => {
      if (!this.isGlobalJobOwner()) return;
      return job();
    };
  }

  public startAsync(): void {
    this.registerJob('user-update-queue', '*/5 * * * *', () =>
      container.resolve(UpdateQueueHandler).processAsync(),
    );

    this.registerJob('index-queue-pump', '*/2 * * * *', () =>
      container.resolve(UserIndexQueueService).pump(),
    );

    this.registerJob('add-users-to-update-queue', '0 6,14 * * *', this.onlyOwner(() =>
      this.enqueueOutdatedUsers(),
    ));

    this.registerJob('add-users-to-index-queue', '0 8 * * *', this.onlyOwner(() =>
      this.enqueueStaleIndexedUsers(),
    ));

    this.registerJob('remove-hidden-user-plays', '0 4 * * *', this.onlyOwner(() =>
      this.removePrivacyHiddenPlays(),
    ));

    this.registerJob('abuse-scan', '0 5 * * *', this.onlyOwner(async () => {
      try {
        const { AbuseFilterService } = await import('./abuseFilterService');
        if (container.isRegistered(AbuseFilterService)) {
          await container.resolve(AbuseFilterService).scanAndFlag();
        }
      } catch (err) {
        Logger.error({ err }, 'Abuse scan job failed');
      }
    }));

    this.registerJob('statistics-log', '*/10 * * * *', () => {
      const snapshot = Statistics.snapshot();
      Logger.info({ stats: snapshot }, 'Statistics snapshot');
      container.resolve(LastfmErrorRateTracker).logAndReset();
    });

    this.registerJob('reconcile-index', '0 9 * * *', this.onlyOwner(async () => {
      try {
        const { ReconcileService } = await import('./reconcileService');
        if (container.isRegistered(ReconcileService)) {
          const report = await container.resolve(ReconcileService).runAsync();
          Logger.info({ report }, 'Index reconcile complete');
        }
      } catch (err) {
        Logger.error({ err }, 'Reconcile job failed');
      }
    }));

    this.registerJob('autopost-runner', '*/15 * * * *', this.onlyOwner(async () => {
      try {
        if (container.isRegistered(Client)) {
          const client = container.resolve(Client);
          await container.resolve(AutopostService).runScheduledAutoposts(client);
        }
      } catch (err) {
        Logger.error({ err }, 'Autopost runner job failed');
      }
    }));

    this.registerJob('lyric-status-updater', '*/10 * * * *', this.onlyOwner(async () => {
      try {
        if (container.isRegistered(LyricStatusService)) {
          await container.resolve(LyricStatusService).updateLyricStatusAsync();
        }
      } catch (err) {
        Logger.error({ err }, 'Lyric status updater scheduled job failed');
      }
    }));

    Logger.info('Timer service started');
  }

  public stopAsync(): void {
    for (const [name, task] of this.tasks) {
      task.stop();
      Logger.info(`Stopped scheduled job ${name}`);
    }
    this.tasks.clear();
  }

  private async enqueueOutdatedUsers(): Promise<void> {
    const frequencyHours = ConfigData.Data.lastFm.userUpdateFrequencyInHours;
    const cutoff = new Date(Date.now() - frequencyHours * 3600 * 1000);
    const outdated = await container.resolve(UserRepository).getOutdatedUsers(cutoff);
    const queue = container.resolve(UserUpdateQueueService);
    let enqueued = 0;
    for (const user of outdated) {
      if (
        queue.enqueue({
          userId: user.userId,
          discordUserId: user.discordUserId,
          userNameLastFm: user.userNameLastFm,
        })
      ) {
        enqueued++;
      }
    }
    Logger.info(`Queued ${enqueued}/${outdated.length} outdated users for update`);
    await queue.pump();
  }

  private async enqueueStaleIndexedUsers(): Promise<void> {
    const frequencyDays = ConfigData.Data.lastFm.userIndexFrequencyInDays;
    const cutoff = new Date(Date.now() - frequencyDays * 24 * 3600 * 1000);
    const users = await container.resolve(UserRepository).getUsersWithStaleIndex(cutoff, 5000);
    const indexQueue = container.resolve(UserIndexQueueService);
    let enqueued = 0;
    for (const user of users) {
      if (indexQueue.enqueue({ userId: user.userId, indexQueue: true })) {
        enqueued++;
      }
    }
    Logger.info(`Queued ${enqueued} users for indexing`);
  }

  private async removePrivacyHiddenPlays(): Promise<void> {
    const repository = container.resolve(UserRepository);
    const playRepository = container.resolve(PlayRepository);
    const { CrownRepository } = await import('@persistence/repositories/crownRepository');
    const { CacheService } = await import('./cacheService');
    const hiddenIds = await repository.getPrivacyHiddenUserIds();
    let cleaned = 0;
    for (const userId of hiddenIds) {
      try {
        // Plays + all derived aggregates + crowns + cached rollups. Read-path
        // filters (wk/crowns/rankings) already hide these users instantly; the
        // purge removes the underlying rows so nothing resurfaces.
        await playRepository.deleteAllPlaysForUser(userId);
        await this.prismaDeleteUserAggregates(userId);
        await container.resolve(CrownRepository).deactivateCrownsForUser(userId);
        const cache = container.resolve(CacheService);
        await cache.delete(`user-${userId}-topartists-alltime`).catch(() => undefined);
        const user = await repository.getUserById(userId).catch(() => null);
        if (user) {
          await cache.delete(`user-discord:${user.discordUserId}`).catch(() => undefined);
        }
        cleaned++;
      } catch (err) {
        Logger.warn({ err, userId }, 'Privacy purge failed for user, will retry next sweep');
      }
    }
    if (cleaned > 0) {
      Logger.info(`Removed stored plays for ${cleaned} privacy-hidden users`);
    }
  }

  private async prismaDeleteUserAggregates(userId: number): Promise<void> {
    const { prisma } = await import('@persistence/prismaClient');
    await prisma.$transaction([
      prisma.userArtist.deleteMany({ where: { userId } }),
      prisma.userAlbum.deleteMany({ where: { userId } }),
      prisma.userTrack.deleteMany({ where: { userId } }),
    ]);
  }

  private registerJob(
    name: string,
    cronExpression: string,
    job: () => void | Promise<void>,
  ): void {
    if (this.tasks.has(name)) {
      return;
    }
    if (!cron.validate(cronExpression)) {
      Logger.error(`Invalid cron expression for job ${name}: ${cronExpression}`);
      return;
    }
    const task = cron.schedule(cronExpression, async () => {
      try {
        await job();
      } catch (err) {
        Logger.error({ err }, `Scheduled job ${name} failed`);
      }
    });
    this.tasks.set(name, task);
    Logger.debug(`Registered scheduled job ${name} (${cronExpression})`);
  }
}
