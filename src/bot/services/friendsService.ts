import type { IFriendsRepository } from '@domain/interfaces/ifriendsRepository';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { Friend } from '@persistence/domain/models/user';
import { FriendType } from '@domain/enums/friendType';

export class FriendsService {
  private readonly friendsRepository: IFriendsRepository;
  private readonly userRepository: IUserRepository;

  constructor(
    friendsRepository: IFriendsRepository,
    userRepository: IUserRepository,
  ) {
    this.friendsRepository = friendsRepository;
    this.userRepository = userRepository;
  }

  public async getFriends(discordUserId: string): Promise<Friend[]> {
    return this.friendsRepository.getFriends(discordUserId);
  }

  public async getFriendsByUserId(userId: number): Promise<Friend[]> {
    return this.friendsRepository.getFriendsByUserId(userId);
  }

  public async getFriended(userId: number): Promise<Friend[]> {
    return this.friendsRepository.getFriended(userId);
  }

  public async getFriend(friendId: number): Promise<Friend | null> {
    return this.friendsRepository.getFriend(friendId);
  }

  public async addFriend(
    user: User,
    friendUsername: string,
    friendUserId?: number | null,
    friendType: FriendType = FriendType.VisibleInNowPlaying,
  ): Promise<number> {
    let resolvedFriendUserId = friendUserId;
    if (resolvedFriendUserId === undefined || resolvedFriendUserId === null) {
      const existingUser = await this.userRepository.getUserByLastFmName(friendUsername);
      if (existingUser) {
        resolvedFriendUserId = existingUser.userId;
      }
    }

    return this.friendsRepository.addFriend(
      user.userId,
      friendUsername,
      resolvedFriendUserId,
      friendType,
    );
  }

  public async setFriendType(friendId: number, friendType: FriendType): Promise<void> {
    await this.friendsRepository.setFriendType(friendId, friendType);
  }

  public async removeFriend(friendId: number): Promise<boolean> {
    return this.friendsRepository.removeFriend(friendId);
  }

  public async removeFriendByLfm(userId: number, friendUsername: string): Promise<boolean> {
    return this.friendsRepository.removeFriendByLfm(userId, friendUsername);
  }

  public async removeAllFriends(userId: number): Promise<number> {
    return this.friendsRepository.removeAllFriends(userId);
  }

  public async getCloseFriendUserIds(userId: number): Promise<Set<number>> {
    const list = await this.friendsRepository.getCloseFriendUserIds(userId);
    return new Set(list);
  }

  public async getTotalFriendCount(userId: number): Promise<number> {
    return this.friendsRepository.getTotalFriendCount(userId);
  }
}
