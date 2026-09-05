import type {
  IUserUpdateQueue,
  UserUpdateQueueItem,
} from '@domain/interfaces/iuserUpdateQueue';
import type { UpdateService } from '@bot/services/updateService';
import { Logger } from '@domain/logger';

export class UpdateQueueHandler {
  private readonly queue: IUserUpdateQueue;
  private readonly updateService: UpdateService;

  constructor(
    queue: IUserUpdateQueue,
    updateService: UpdateService,
  ) {
    this.queue = queue;
    this.updateService = updateService;
    queue.registerProcessor((items) => this.processBatch(items));
  }

  public async processAsync(): Promise<void> {
    await this.queue.pump();
  }

  private async processBatch(items: UserUpdateQueueItem[]): Promise<void> {
    for (const item of items) {
      try {
        const result = await this.updateService.updateUser(item.userId, { queue: true });
        if (result.newPlays > 0 || result.removedPlays > 0) {
          Logger.info(
            `Queue update for ${item.userNameLastFm}: +${result.newPlays} -${result.removedPlays}`,
          );
        }
      } catch (err) {
        Logger.warn({ err }, `Failed to process user update for ${item.userNameLastFm}`);
      }
    }
  }
}
