import { container } from 'tsyringe';
import cron, { type ScheduledTask } from 'node-cron';
import { Client } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { Statistics } from '@domain/statistics';
import { logMemoryReport } from '@domain/memoryReport';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { UpdateQueueHandler } from '@bot/handlers/updateQueueHandler';
import { UserUpdateQueueService } from '@bot/services/lastfm/userUpdateQueueService';
import { UserIndexQueueService } from '@bot/services/lastfm/userIndexQueueService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { AutopostService } from '@bot/services/charts/autopostService';
import { LyricStatusService } from '@bot/services/music/lyricStatusService';

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
        const { AbuseFilterService } = await import('@bot/services/system/abuseFilterService');
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

    // One sample per hour. Every shard reports its own process, so this is
    // deliberately NOT an onlyOwner job: shard 1's heap is the one nobody else
    // can see. No pre-existing hourly job existed to hook into, so this is its
    // own entry rather than a second firing of statistics-log (which is */10).
    this.registerJob('memory-sample', '0 * * * *', () => {
      logMemoryReport();
    });

    this.registerJob('reconcile-index', '0 9 * * *', this.onlyOwner(async () => {
      try {
        const { ReconcileService } = await import('@bot/services/lastfm/reconcileService');
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
    const { CacheService } = await import('@bot/services/system/cacheService');
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
        // CORRECT AS IS: the catch is UNREACHABLE — `CacheService.set` and
        // `delete` catch their own Redis errors and return, having already
        // written memory. Nothing can fail here that has not already been
        // reported by CacheService, and the play rows above are deleted
        // regardless, so a stale cache key costs at most one re-fetch.
        await cache.delete(`user-${userId}-topartists-alltime`).catch(() => undefined);
        // NOT swallowed. This is the only read standing between a privacy-hidden
        // user and their `user-discord:` cache key: a failure returned `null`,
        // skipped the delete below, and still counted the user as `cleaned` — so
        // the purge reported success while another reader could keep resolving
        // that user until the key's TTL. Letting the throw reach the catch below
        // makes the purge log and retry next sweep instead, and every write above
        // it is idempotent.
        const user = await repository.getUserById(userId);
        if (user) {
          // CORRECT AS IS: same unreachable catch as the first delete.
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

  /** Jobs currently executing — a slow run must not overlap the next tick. */
  private readonly running = new Set<string>();

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
      // node-cron fires unconditionally. The index-queue pump runs every 2
      // minutes and walks up to 10k users; on a slow database a run easily
      // outlasts its interval, so a second, then third, then fourth concurrent
      // pump started — each hammering Postgres and the shared Last.fm token
      // bucket. The `draining` flag inside one pump does not help across
      // firings.
      if (this.running.has(name)) {
        Logger.warn({ job: name }, 'Scheduled job still running from a previous tick — skipping this one');
        return;
      }
      this.running.add(name);
      try {
        await job();
      } catch (err) {
        Logger.error({ err }, `Scheduled job ${name} failed`);
      } finally {
        this.running.delete(name);
      }
    });
    this.tasks.set(name, task);
    Logger.debug(`Registered scheduled job ${name} (${cronExpression})`);
  }
}
