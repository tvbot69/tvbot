import { container } from 'tsyringe';
import cron, { type ScheduledTask } from 'node-cron';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { Statistics } from '@domain/statistics';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { UpdateQueueHandler } from '@bot/handlers/updateQueueHandler';
import { UserUpdateQueueService } from './userUpdateQueueService';
import { UserIndexQueueService } from './userIndexQueueService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';

export class TimerService {
  private readonly tasks: Map<string, ScheduledTask> = new Map();

  public startAsync(): void {
    this.registerJob('user-update-queue', '*/5 * * * *', () =>
      container.resolve(UpdateQueueHandler).processAsync(),
    );

    this.registerJob('index-queue-pump', '*/2 * * * *', () =>
      container.resolve(UserIndexQueueService).pump(),
    );

    this.registerJob('add-users-to-update-queue', '0 6,14 * * *', () =>
      this.enqueueOutdatedUsers(),
    );

    this.registerJob('add-users-to-index-queue', '0 8 * * *', () =>
      this.enqueueStaleIndexedUsers(),
    );

    this.registerJob('remove-hidden-user-plays', '0 4 * * *', () =>
      this.removePrivacyHiddenPlays(),
    );

    this.registerJob('statistics-log', '*/10 * * * *', () => {
      const snapshot = Statistics.snapshot();
      Logger.info({ stats: snapshot }, 'Statistics snapshot');
      container.resolve(LastfmErrorRateTracker).logAndReset();
    });

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
    const hiddenIds = await repository.getPrivacyHiddenUserIds();
    let cleaned = 0;
    for (const userId of hiddenIds) {
      await playRepository.deleteAllPlaysForUser(userId);
      cleaned++;
    }
    if (cleaned > 0) {
      Logger.info(`Removed stored plays for ${cleaned} privacy-hidden users`);
    }
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
