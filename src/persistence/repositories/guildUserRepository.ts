import { PrismaClient } from '@prisma/client';
import type { FullGuildUserDetails, IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';

export class GuildUserRepository implements IGuildUserRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async upsert(guildId: string, userId: number): Promise<void> {
    await this.prisma.guildUser.upsert({
      where: {
        guildId_userId: { guildId: BigInt(guildId), userId: userId },
      },
      update: {},
      create: { guildId: BigInt(guildId), userId: userId },
    });
  }

  public async upsertMany(guildId: string, userIds: number[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await this.prisma.guildUser.createMany({
      data: userIds.map((userId) => ({ guildId: BigInt(guildId), userId: userId })),
      skipDuplicates: true,
    });
  }

  public async remove(guildId: string, userId: number): Promise<void> {
    await this.prisma.guildUser.deleteMany({
      where: { guildId: BigInt(guildId), userId: userId },
    });
  }

  public async getUserIdsForGuild(guildId: string): Promise<number[]> {
    const rows = await this.prisma.guildUser.findMany({
      where: { guildId: BigInt(guildId) },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  public async getGuildUsers(guildId: string): Promise<FullGuildUserDetails[]> {
    const rows = await this.prisma.guildUser.findMany({
      where: { guildId: BigInt(guildId) },
      include: {
        user: {
          select: {
            discordUserId: true,
            userNameLastFm: true,
            lastUsed: true,
          },
        },
      },
    });

    return rows.map((r) => ({
      userId: r.userId,
      discordUserId: r.user.discordUserId.toString(),
      userNameLastFm: r.user.userNameLastFm,
      lastUsed: r.user.lastUsed ?? undefined,
      whoKnowsWhitelisted: r.whoKnowsWhitelisted,
      whoKnowsBanned: r.whoKnowsBanned,
    }));
  }

  public async setBlockStatus(guildId: string, userId: number, blocked: boolean): Promise<void> {
    await this.prisma.guildUser.updateMany({
      where: {
        guildId: BigInt(guildId),
        userId: userId,
      },
      data: {
        whoKnowsBanned: blocked,
        blockedFromCrowns: blocked,
      },
    });
  }
}

