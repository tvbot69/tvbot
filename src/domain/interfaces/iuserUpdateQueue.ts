import type { User } from '@persistence/domain/models/user';

export interface UserUpdateQueueItem {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
}

export interface IUserUpdateQueue {
  enqueue(item: UserUpdateQueueItem): boolean;
  size(): number;
  registerProcessor(processor: (items: UserUpdateQueueItem[]) => Promise<void>): void;
  pump(): Promise<void>;
}

export type { User };
