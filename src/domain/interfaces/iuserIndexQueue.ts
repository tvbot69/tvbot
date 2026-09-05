export interface IndexUserQueueItem {
  userId: number;
  indexQueue: boolean;
}

export interface IUserIndexQueue {
  enqueue(item: IndexUserQueueItem): boolean;
  size(): number;
  registerProcessor(processor: (item: IndexUserQueueItem) => Promise<void>): void;
  pump(): Promise<void>;
}
