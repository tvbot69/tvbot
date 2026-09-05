import { PrismaClient, User as UserEntity } from '@prisma/client';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { Friend } from '@persistence/domain/models/user';
import { UserType, DataSource } from '@persistence/domain/models/user';

function userTypeFromEntity(value: string): UserType {
  if (value === 'Contributor') return UserType.Contributor;
  if (value === 'Admin') return UserType.Admin;
  if (value === 'Owner') return UserType.Owner;
  return UserType.User;
}
export class UserRepository implements IUserRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getUserByDiscordUserId(discordUserId: string): Promise<User | null> {
    const entity = await this.prisma.user.findUnique({
      where: { discordUserId: BigInt(discordUserId) },
    });
    return entity ? this.map(entity) : null;
  }

  public async getUserByLastFmName(userNameLastFm: string): Promise<User | null> {
    const entity = await this.prisma.user.findUnique({
      where: { userNameLastFm: userNameLastFm },
    });
    return entity ? this.map(entity) : null;
  }

  public async getUserById(userId: number): Promise<User | null> {
    const entity = await this.prisma.user.findUnique({ where: { userId: userId } });
    return entity ? this.map(entity) : null;
  }

  public async addUser(userNameLastFm: string, discordUserId: string): Promise<User> {
    const existing = await this.getUserByDiscordUserId(discordUserId);
    if (existing) {
      await this.updateUserLastFmName(existing.userId, userNameLastFm);
      const updated = await this.getUserById(existing.userId);
      return updated!;
    }
    const entity = await this.prisma.user.create({
      data: {
        userNameLastFm: userNameLastFm,
        discordUserId: BigInt(discordUserId),
      },
    });
    return this.map(entity);
  }

  public async updateUserLastFmName(userId: number, userNameLastFm: string): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { userNameLastFm: userNameLastFm },
    });
  }

  public async updateUserStats(
    userId: number,
    totalPlayCount: number,
    lastUpdate: Date,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { totalPlayCount: totalPlayCount, lastUpdate: lastUpdate },
    });
  }

  public async updateLastIndexed(userId: number, lastIndexed: Date): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { lastIndexed: lastIndexed },
    });
  }

  public async setUserRegisteredLfm(userId: number, date: Date): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { registeredLastFm: date },
    });
  }

  public async setSessionKey(userId: number, sessionKey: string | null): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { sessionKey: sessionKey },
    });
  }

  public async removeUser(userId: number): Promise<boolean> {
    try {
      await this.prisma.user.delete({ where: { userId: userId } });
      return true;
    } catch {
      return false;
    }
  }

  public async getOutdatedUsers(cutoff: Date, limit: number = 2000): Promise<User[]> {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    const entities = await this.prisma.user.findMany({
      where: {
        AND: [
          { OR: [{ lastUpdate: null }, { lastUpdate: { lt: cutoff } }] },
          { OR: [{ lastUsed: null }, { lastUsed: { gt: twoMonthsAgo } }] },
        ],
      },
      take: limit,
      orderBy: { lastUpdate: 'asc' },
    });
    return entities.map((e) => this.map(e));
  }

  public async getUsersWithStaleIndex(cutoff: Date, limit: number = 2000): Promise<User[]> {
    const entities = await this.prisma.user.findMany({
      where: {
        OR: [{ lastIndexed: null }, { lastIndexed: { lt: cutoff } }],
      },
      take: limit,
      orderBy: { lastIndexed: 'asc' },
    });
    return entities.map((e) => this.map(e));
  }

  public async getPrivacyHiddenUserIds(limit: number = 5000): Promise<number[]> {
    const entities = await this.prisma.user.findMany({
      where: { privacyLevel: 'Hide' },
      select: { userId: true },
      take: limit,
    });
    return entities.map((e) => e.userId);
  }

  public async getUsersByDiscordIds(discordUserIds: string[]): Promise<Map<string, User>> {
    if (discordUserIds.length === 0) {
      return new Map();
    }
    const entities = await this.prisma.user.findMany({
      where: {
        discordUserId: {
          in: discordUserIds.map((id) => BigInt(id)),
        },
      },
    });
    const map = new Map<string, User>();
    for (const entity of entities) {
      map.set(entity.discordUserId.toString(), this.map(entity));
    }
    return map;
  }

  public async setLastScrobbleUpdate(userId: number, date: Date): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { lastScrobbleUpdate: date },
    });
  }

  public async setLastUpdate(userId: number, date: Date): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { lastUpdate: date },
    });
  }

  public async incrementTotalPlayCount(userId: number, delta: number): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { totalPlayCount: { increment: delta } },
    });
  }

  public async touchLastUsed(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { userId: userId },
      data: { lastUsed: new Date() },
    });
  }

  private map(entity: UserEntity): User & { friends?: Friend[] } {
    return {
      userId: entity.userId,
      userNameLastFm: entity.userNameLastFm,
      discordUserId: entity.discordUserId.toString(),
      registeredOn: entity.registeredOn,
      privacyLevel:
        entity.privacyLevel === 'Hide' ? PrivacyLevel.Hide : PrivacyLevel.Default,
      registeredLastFm: entity.registeredLastFm ?? undefined,
      sessionKey: entity.sessionKey ?? undefined,
      userType: userTypeFromEntity(entity.userType),
      dataSource: entity.dataSource === 'SpotifyImport' ? DataSource.SpotifyImport : entity.dataSource === 'AppleMusicImport' ? DataSource.AppleMusicImport : DataSource.LastFm,
      timeZone: entity.timeZone ?? undefined,
      numberFormat: entity.numberFormat ?? undefined,
      lastUsed: entity.lastUsed ?? undefined,
      lastUpdate: entity.lastUpdate ?? undefined,
      lastIndexed: entity.lastIndexed ?? undefined,
      totalPlayCount: entity.totalPlayCount ?? undefined,
      lastScrobbleUpdate: entity.lastScrobbleUpdate ?? undefined,
    };
  }
}
