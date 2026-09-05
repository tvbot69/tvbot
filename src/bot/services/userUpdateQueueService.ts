import type {
  IUserUpdateQueue,
  UserUpdateQueueItem,
} from '@domain/interfaces/iuserUpdateQueue';
import { Logger } from '@domain/logger';

const BATCH_SIZE = 25;

export class UserUpdateQueueService implements IUserUpdateQueue {
  private items: UserUpdateQueueItem[] = [];
  private readonly queuedIds: Set<number> = new Set();
  private processor: ((items: UserUpdateQueueItem[]) => Promise<void>) | null = null;
  private draining: boolean = false;
  public readonly maxCapacity = 10000;

  public enqueue(item: UserUpdateQueueItem): boolean {
    if (this.queuedIds.has(item.userId) || this.items.length >= this.maxCapacity) {
      return false;
    }
    this.queuedIds.add(item.userId);
    this.items.push(item);
    return true;
  }

  public size(): number {
    return this.items.length;
  }

  public registerProcessor(processor: (items: UserUpdateQueueItem[]) => Promise<void>): void {
    this.processor = processor;
  }

  public async pump(): Promise<void> {
    if (this.draining || !this.processor || this.items.length === 0) {
      return;
    }
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const batch = this.items.splice(0, BATCH_SIZE);
        for (const item of batch) {
          this.queuedIds.delete(item.userId);
        }
        try {
          await this.processor(batch);
        } catch (err) {
          Logger.error({ err, batchSize: batch.length }, 'Error processing user update queue batch');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
