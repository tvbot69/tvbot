import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { IUserRepository } from '@domain/interfaces/iuserRepository';
import { GuildService } from './guild/guildService';

export interface GuildMemberOverviewItem {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  totalPlayCount: number;
  crownsCount: number;
  lastUsed?: Date;
  whoKnowsBanned: boolean;
}

export interface RefreshResult {
  indexedCount: number;
  totalServerMembers: number;
  newlyAddedCount: number;
}

@injectable()
export class GuildAdminService {
  constructor(
    @inject('IGuildUserRepository') private readonly guildUserRepository: IGuildUserRepository,
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
    @inject(GuildService) private readonly guildService: GuildService,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getMembersOverview(guildId: string): Promise<GuildMemberOverviewItem[]> {
    const guildUsers = await this.guildUserRepository.getGuildUsers(guildId);
    if (guildUsers.length === 0) return [];

    const userIds = guildUsers.map((gu) => gu.userId);

    // Fetch user play counts
    const users = await this.db.user.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, totalPlayCount: true },
    }).catch(() => []);

    const playCountMap = new Map<number, number>();
    for (const u of users) {
      playCountMap.set(u.userId, u.totalPlayCount ?? 0);
    }

    // Fetch crowns counts for this guild
    const crowns = await this.db.userCrown.groupBy({
      by: ['userId'],
      where: {
        guildId: BigInt(guildId),
        active: true,
      },
      _count: { crownId: true },
    }).catch(() => []);

    const crownCountMap = new Map<number, number>();
    for (const c of crowns) {
      crownCountMap.set(c.userId, c._count.crownId);
    }

    const items: GuildMemberOverviewItem[] = guildUsers.map((gu) => ({
      userId: gu.userId,
      discordUserId: gu.discordUserId,
      userNameLastFm: gu.userNameLastFm,
      totalPlayCount: playCountMap.get(gu.userId) ?? 0,
      crownsCount: crownCountMap.get(gu.userId) ?? 0,
      lastUsed: gu.lastUsed,
      whoKnowsBanned: gu.whoKnowsBanned,
    }));

    // Sort by total scrobbles descending
    items.sort((a, b) => b.totalPlayCount - a.totalPlayCount);
    return items;
  }

  public async refreshGuildMembers(
    guildId: string,
    discordMemberIds: string[],
  ): Promise<RefreshResult> {
    if (discordMemberIds.length === 0) {
      return { indexedCount: 0, totalServerMembers: 0, newlyAddedCount: 0 };
    }

    const existingInGuild = new Set(await this.guildUserRepository.getUserIdsForGuild(guildId));

    const matchedUsersMap = await this.userRepository.getUsersByDiscordIds(discordMemberIds);
    const matchedUsers = Array.from(matchedUsersMap.values());

    const userIdsToUpsert = matchedUsers.map((u) => u.userId);
    let newlyAdded = 0;
    for (const uid of userIdsToUpsert) {
      if (!existingInGuild.has(uid)) {
        newlyAdded++;
      }
    }

    await this.guildUserRepository.upsertMany(guildId, userIdsToUpsert);

    return {
      indexedCount: userIdsToUpsert.length,
      totalServerMembers: discordMemberIds.length,
      newlyAddedCount: newlyAdded,
    };
  }

  public async setBlockUser(guildId: string, userId: number, blocked: boolean): Promise<void> {
    await this.guildUserRepository.setBlockStatus(guildId, userId, blocked);
  }

  public async getBlockedUsers(guildId: string): Promise<FullGuildUserDetails[]> {
    const all = await this.guildUserRepository.getGuildUsers(guildId);
    return all.filter((u) => u.whoKnowsBanned);
  }

  public async setCrownThreshold(guildId: string, threshold: number): Promise<void> {
    await this.guildService.setCrownsThreshold(guildId, threshold);
  }

  public async setCrownActivityThreshold(guildId: string, days: number | null): Promise<void> {
    await this.guildService.setCrownsActivityThreshold(guildId, days);
  }

  public async toggleCrowns(guildId: string, disabled: boolean): Promise<void> {
    await this.guildService.setCrownsDisabled(guildId, disabled);
  }
}
