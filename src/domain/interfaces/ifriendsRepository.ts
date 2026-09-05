import type { Friend } from '@persistence/domain/models/user';
import type { FriendType } from '@domain/enums/friendType';

export interface IFriendsRepository {
  getFriends(discordUserId: string): Promise<Friend[]>;
  getFriendsByUserId(userId: number): Promise<Friend[]>;
  getFriended(userId: number): Promise<Friend[]>;
  getFriend(friendId: number): Promise<Friend | null>;
  addFriend(
    userId: number,
    lastFmUserName: string,
    friendUserId?: number | null,
    friendType?: FriendType,
  ): Promise<number>;
  setFriendType(friendId: number, friendType: FriendType): Promise<void>;
  removeFriend(friendId: number): Promise<boolean>;
  removeFriendByLfm(userId: number, lastFmUserName: string): Promise<boolean>;
  removeAllFriends(userId: number): Promise<number>;
  getCloseFriendUserIds(userId: number): Promise<number[]>;
  getTotalFriendCount(userId: number): Promise<number>;
}
