import type { IndexUserQueueItem, IUserIndexQueue } from '@domain/interfaces/iuserIndexQueue';
import { Logger } from '@domain/logger';

export class UserIndexQueueService implements IUserIndexQueue {
  private items: IndexUserQueueItem[] = [];
  private readonly queuedIds: Set<number> = new Set();
  private processor: ((item: IndexUserQueueItem) => Promise<void>) | null = null;
  private draining: boolean = false;
  public readonly maxCapacity = 10000;

  public enqueue(item: IndexUserQueueItem): boolean {
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

  public registerProcessor(processor: (item: IndexUserQueueItem) => Promise<void>): void {
    this.processor = processor;
  }

  public async pump(): Promise<void> {
    if (this.draining || !this.processor || this.items.length === 0) {
      return;
    }
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (!item) {
          break;
        }
        this.queuedIds.delete(item.userId);
        try {
          await this.processor(item);
        } catch (err) {
          Logger.error({ err, userId: item.userId }, 'Error processing user index queue item');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
