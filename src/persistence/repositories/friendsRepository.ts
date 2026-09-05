import type { PrismaClient, Friend as FriendEntity, User as UserEntity } from '@prisma/client';
import type { IFriendsRepository } from '@domain/interfaces/ifriendsRepository';
import type { Friend, User } from '@persistence/domain/models/user';
import { FriendType } from '@domain/enums/friendType';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import { UserType, DataSource } from '@persistence/domain/models/user';

function userTypeFromEntity(value: string): UserType {
  if (value === 'Contributor') return UserType.Contributor;
  if (value === 'Admin') return UserType.Admin;
  if (value === 'Owner') return UserType.Owner;
  return UserType.User;
}

function mapUser(entity: UserEntity): User {
  return {
    userId: entity.userId,
    userNameLastFm: entity.userNameLastFm,
    discordUserId: entity.discordUserId.toString(),
    registeredOn: entity.registeredOn,
    privacyLevel: entity.privacyLevel === 'Hide' ? PrivacyLevel.Hide : PrivacyLevel.Default,
    registeredLastFm: entity.registeredLastFm ?? undefined,
    sessionKey: entity.sessionKey ?? undefined,
    userType: userTypeFromEntity(entity.userType),
    dataSource:
      entity.dataSource === 'SpotifyImport'
        ? DataSource.SpotifyImport
        : entity.dataSource === 'AppleMusicImport'
        ? DataSource.AppleMusicImport
        : DataSource.LastFm,
    timeZone: entity.timeZone ?? undefined,
    numberFormat: entity.numberFormat ?? undefined,
    lastUsed: entity.lastUsed ?? undefined,
    lastUpdate: entity.lastUpdate ?? undefined,
    lastIndexed: entity.lastIndexed ?? undefined,
    totalPlayCount: entity.totalPlayCount ?? undefined,
    lastScrobbleUpdate: entity.lastScrobbleUpdate ?? undefined,
  };
}

export class FriendsRepository implements IFriendsRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getFriends(discordUserId: string): Promise<Friend[]> {
    const user = await this.prisma.user.findUnique({
      where: { discordUserId: BigInt(discordUserId) },
      select: { userId: true },
    });
    if (!user) return [];

    return this.getFriendsByUserId(user.userId);
  }

  public async getFriendsByUserId(userId: number): Promise<Friend[]> {
    const entities = await this.prisma.friend.findMany({
      where: { userId: userId },
      include: { friendUser: true },
      orderBy: [{ friendType: 'desc' }, { lastFmUserName: 'asc' }],
    });

    return entities.map((e) => this.map(e));
  }

  public async getFriended(userId: number): Promise<Friend[]> {
    const entities = await this.prisma.friend.findMany({
      where: { friendUserId: userId },
      include: { user: true },
      orderBy: { created: 'desc' },
    });

    return entities.map((e) => this.map(e));
  }

  public async getFriend(friendId: number): Promise<Friend | null> {
    const entity = await this.prisma.friend.findUnique({
      where: { friendId: friendId },
      include: { friendUser: true },
    });

    return entity ? this.map(entity) : null;
  }

  public async addFriend(
    userId: number,
    lastFmUserName: string,
    friendUserId?: number | null,
    friendType: FriendType = FriendType.Normal,
  ): Promise<number> {
    const created = await this.prisma.friend.upsert({
      where: {
        userId_lastFmUserName: {
          userId,
          lastFmUserName,
        },
      },
      update: {
        friendUserId: friendUserId ?? undefined,
        friendType: Number(friendType),
      },
      create: {
        userId,
        lastFmUserName,
        friendUserId: friendUserId ?? null,
        friendType: Number(friendType),
      },
    });

    return created.friendId;
  }

  public async setFriendType(friendId: number, friendType: FriendType): Promise<void> {
    await this.prisma.friend.update({
      where: { friendId: friendId },
      data: { friendType: Number(friendType) },
    });
  }

  public async removeFriend(friendId: number): Promise<boolean> {
    try {
      await this.prisma.friend.delete({ where: { friendId: friendId } });
      return true;
    } catch {
      return false;
    }
  }

  public async removeFriendByLfm(userId: number, lastFmUserName: string): Promise<boolean> {
    const result = await this.prisma.friend.deleteMany({
      where: {
        userId: userId,
        lastFmUserName: { equals: lastFmUserName, mode: 'insensitive' },
      },
    });
    return result.count > 0;
  }

  public async removeAllFriends(userId: number): Promise<number> {
    const result = await this.prisma.friend.deleteMany({
      where: { userId: userId },
    });
    return result.count;
  }

  public async getCloseFriendUserIds(userId: number): Promise<number[]> {
    const closeFriends = await this.prisma.friend.findMany({
      where: {
        userId: userId,
        friendType: FriendType.CloseFriend,
        friendUserId: { not: null },
      },
      select: { friendUserId: true },
    });

    return closeFriends
      .map((f) => f.friendUserId)
      .filter((id): id is number => id !== null);
  }

  public async getTotalFriendCount(userId: number): Promise<number> {
    return this.prisma.friend.count({
      where: { userId: userId },
    });
  }

  private map(entity: FriendEntity & { friendUser?: UserEntity | null; user?: UserEntity | null }): Friend {
    return {
      friendId: entity.friendId,
      userId: entity.userId,
      lastFmUserName: entity.lastFmUserName,
      friendUserId: entity.friendUserId ?? undefined,
      lastFmFriend: entity.lastFmFriend,
      friendType: entity.friendType as FriendType,
      created: entity.created ?? undefined,
      modified: entity.modified ?? undefined,
      friendUser: entity.friendUser ? mapUser(entity.friendUser) : undefined,
    };
  }
}
