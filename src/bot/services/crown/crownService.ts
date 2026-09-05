import { injectable, inject } from 'tsyringe';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/domain/models/guild';
import type { UserCrownDto, CrownModel, CrownViewType, CrownLeaderboardEntry } from '@domain/models/crownModels';
import { UserService } from '@bot/services/userService';

@injectable()
export class CrownService {
  constructor(
    @inject(CrownRepository) private readonly crownRepository: CrownRepository,
    @inject(UserService) private readonly userService: UserService,
  ) {}

  public async getAndUpdateCrownForArtist(
    users: WhoKnowsUser[],
    guildUsers: Map<number, FullGuildUserDetails>,
    guild: Guild | null,
    artistName: string,
    resolvedArtistName?: string,
  ): Promise<CrownModel | null> {
    if (!guild || (guild as any).crownsDisabled) {
      return null;
    }

    const guildIdStr = guild.guildId.toString();
    const minPlaycount = (guild as any).crownsMinimumPlaycountThreshold ?? 30;
    const activityDays = (guild as any).crownsActivityThresholdDays;

    // 1. Filter eligible users
    const now = Date.now();
    const eligibleUsers = users.filter((u) => {
      const gu = guildUsers.get(u.userId);
      if (gu?.whoKnowsBanned) return false;
      if ((gu as any)?.blockedFromCrowns) return false;

      if (activityDays && activityDays > 0) {
        if (!u.lastUsed) return false;
        const lastUsedMs = u.lastUsed.getTime();
        const cutoffMs = now - activityDays * 24 * 60 * 60 * 1000;
        if (lastUsedMs < cutoffMs) return false;
      }

      return true;
    });

    const topUser = eligibleUsers[0];
    const currentCrown = await this.crownRepository.getCurrentCrown(guildIdStr, artistName);

    if (!topUser) {
      return currentCrown ? { crown: currentCrown } : null;
    }

    const effectiveName = resolvedArtistName ?? artistName;

    // 2. Eligible top user has enough plays for crown
    if (topUser.playcount >= minPlaycount) {
      if (currentCrown) {
        if (currentCrown.userId === topUser.userId) {
          // Same owner, update playcount if increased
          if (topUser.playcount > currentCrown.currentPlaycount) {
            await this.crownRepository.updateCrownPlaycount(currentCrown.crownId, topUser.playcount);
            currentCrown.currentPlaycount = topUser.playcount;
          }
          return { crown: currentCrown };
        } else {
          // Different owner - did topUser overtake?
          if (topUser.playcount > currentCrown.currentPlaycount) {
            await this.crownRepository.deactivateCrown(currentCrown.crownId);
            const newCrown = await this.crownRepository.createCrown({
              guildId: guildIdStr,
              userId: topUser.userId,
              artistName: effectiveName,
              startPlaycount: topUser.playcount,
              currentPlaycount: topUser.playcount,
            });

            return {
              crown: newCrown,
              previousCrown: currentCrown,
              stolen: true,
              crownResult: `👑 Crown stolen by **${topUser.discordName}** with ${topUser.playcount.toLocaleString()} plays! Previous owner: **${currentCrown.userNameLastFm ?? 'user'}** (${currentCrown.currentPlaycount.toLocaleString()} plays)`,
            };
          } else {
            // Did not overtake
            return { crown: currentCrown };
          }
        }
      } else {
        // No current crown holder, claim it!
        const newCrown = await this.crownRepository.createCrown({
          guildId: guildIdStr,
          userId: topUser.userId,
          artistName: effectiveName,
          startPlaycount: topUser.playcount,
          currentPlaycount: topUser.playcount,
        });

        return {
          crown: newCrown,
          claimed: true,
          crownResult: `👑 Crown claimed by **${topUser.discordName}** with ${topUser.playcount.toLocaleString()} plays!`,
        };
      }
    } else {
      // Not enough plays for crown
      if (currentCrown) {
        return { crown: currentCrown };
      }

      if (topUser.playcount >= Math.floor(minPlaycount / 3)) {
        const remaining = minPlaycount - topUser.playcount;
        return {
          crown: {
            crownId: 0,
            guildId: guildIdStr,
            userId: topUser.userId,
            artistName: effectiveName,
            currentPlaycount: topUser.playcount,
            startPlaycount: topUser.playcount,
            created: new Date(),
            modified: new Date(),
            active: false,
            seededCrown: false,
          },
          crownResult: `👑 **${topUser.discordName}** needs ${remaining.toLocaleString()} more play${remaining === 1 ? '' : 's'} to claim the crown for **${effectiveName}**`,
        };
      }

      return null;
    }
  }

  public async getCurrentCrown(guildId: string, artistName: string): Promise<UserCrownDto | null> {
    return this.crownRepository.getCurrentCrown(guildId, artistName);
  }

  public async getCrownHistory(guildId: string, artistName: string, limit: number = 10): Promise<UserCrownDto[]> {
    return this.crownRepository.getCrownHistoryForArtist(guildId, artistName, limit);
  }

  public async getUserCrowns(
    guildId: string,
    userId: number,
    viewType: CrownViewType = 'Playcount',
  ): Promise<UserCrownDto[]> {
    return this.crownRepository.getUserCrowns(guildId, userId, viewType);
  }

  public async getGuildLeaderboard(guildId: string): Promise<{
    entries: CrownLeaderboardEntry[];
    totalActiveCrowns: number;
  }> {
    const [rawHolders, totalActiveCrowns] = await Promise.all([
      this.crownRepository.getTopCrownHoldersInGuild(guildId),
      this.crownRepository.getTotalActiveCrownsInGuild(guildId),
    ]);

    const entries: CrownLeaderboardEntry[] = [];
    for (const h of rawHolders) {
      const user = await this.userService.getUserById(h.userId);
      if (user) {
        entries.push({
          userId: h.userId,
          discordUserId: user.discordUserId,
          userNameLastFm: user.userNameLastFm,
          displayName: user.userNameLastFm,
          crownCount: h.crownCount,
        });
      }
    }

    return { entries, totalActiveCrowns };
  }

  public async seedCrowns(guildId: string, minPlaycount: number = 30): Promise<number> {
    return this.crownRepository.seedCrownsForGuild(guildId, minPlaycount);
  }
}
