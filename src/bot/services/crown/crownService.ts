import { injectable, inject } from 'tsyringe';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/domain/models/guild';
import type { UserCrownDto, CrownModel, CrownViewType, CrownLeaderboardEntry } from '@domain/models/crownModels';
import { UserService } from '@bot/services/userService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { Logger } from '@domain/logger';

@injectable()
export class CrownService {
  constructor(
    @inject(CrownRepository) private readonly crownRepository: CrownRepository,
    @inject(UserService) private readonly userService: UserService,
    @inject(LastFmRepository) private readonly lastfmRepository?: ILastfmRepository,
    @inject(LastfmErrorRateTracker) private readonly errorRateTracker?: LastfmErrorRateTracker,
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

    // 1. Filter eligible users (privacy opt-outs can never hold crowns)
    const now = Date.now();
    const eligibleUsers = users.filter((u) => {
      const gu = guildUsers.get(u.userId);
      if (gu?.whoKnowsBanned) return false;
      if (gu?.blockedFromCrowns) return false;
      if (gu?.selfBlockFromWhoKnows) return false;
      if (gu?.privacyLevel === 'Hide') return false;

      if (activityDays && activityDays > 0) {
        if (!u.lastUsed) return false;
        const lastUsedMs = u.lastUsed.getTime();
        const cutoffMs = now - activityDays * 24 * 60 * 60 * 1000;
        if (lastUsedMs < cutoffMs) return false;
      }

      if (guild && (guild as any).crownRoles && (guild as any).crownRoles.length > 0) {
        const requiredRoles = new Set((guild as any).crownRoles.map((r: any) => r.toString()));
        const userRoles = u.roles ?? [];
        const hasRole = userRoles.some((r) => requiredRoles.has(r));
        if (!hasRole) return false;
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
            // Kill switch: never dethrone on possibly-stale data mid-outage.
            if (this.errorRateTracker?.isElevated()) {
              Logger.warn(
                { guildId: guildIdStr, artist: effectiveName },
                'Crown steal skipped — Last.fm error rate elevated',
              );
              return { crown: currentCrown };
            }
            // Live recheck: the holder may have scrobbled past the challenger
            // since their last index. Fail-open (proceed) when Last.fm is
            // unreachable — the atomic replace below still guards double-steals.
            const holderLive = await this.getHolderLivePlaycount(
              effectiveName,
              currentCrown.userNameLastFm,
            );
            if (holderLive !== null && holderLive >= topUser.playcount) {
              await this.crownRepository.updateCrownPlaycount(currentCrown.crownId, holderLive);
              currentCrown.currentPlaycount = holderLive;
              return { crown: currentCrown };
            }
            const newCrown = await this.crownRepository.replaceCrown(currentCrown.crownId, {
              guildId: guildIdStr,
              userId: topUser.userId,
              artistName: effectiveName,
              startPlaycount: topUser.playcount,
              currentPlaycount: topUser.playcount,
            });
            if (!newCrown) {
              // Lost the race — re-read whoever won instead of double-creating.
              const winner = await this.crownRepository.getCurrentCrown(guildIdStr, artistName);
              return { crown: winner ?? currentCrown };
            }

            return {
              crown: newCrown,
              previousCrown: currentCrown,
              stolen: true,
              crownResult: `Crown stolen by ${topUser.discordName ?? topUser.lastFmUsername} with \`${topUser.playcount}\` plays! \n*Previous owner: ${currentCrown.userNameLastFm ?? 'user'} with \`${currentCrown.currentPlaycount}\` plays*.`,
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
          crownResult: `Crown claimed by ${topUser.discordName ?? topUser.lastFmUsername}!`,
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
          crownResult: `${topUser.discordName ?? topUser.lastFmUsername} needs ${remaining} more ${remaining === 1 ? 'play' : 'plays'} to claim the crown.`,
        };
      }

      return null;
    }
  }

  /**
   * Live holder playcount from Last.fm (artist.getInfo with username carries
   * userplaycount). Null when unreachable or unknown — callers fail open.
   */
  private async getHolderLivePlaycount(
    artistName: string,
    holderLastFmUsername?: string | null,
  ): Promise<number | null> {
    if (!this.lastfmRepository || !holderLastFmUsername) return null;
    try {
      const info = await this.lastfmRepository.getArtistInfo(artistName, holderLastFmUsername);
      const plays = (info as unknown as { userPlayCount?: unknown })?.userPlayCount;
      return typeof plays === 'number' && Number.isFinite(plays) ? plays : null;
    } catch {
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

    const entries: CrownLeaderboardEntry[] = rawHolders.map((h) => ({
      userId: h.userId,
      discordUserId: h.discordUserId,
      userNameLastFm: h.userNameLastFm,
      displayName: h.userNameLastFm,
      crownCount: h.crownCount,
    }));

    return { entries, totalActiveCrowns };
  }

  public async seedCrowns(guildId: string, minPlaycount: number = 30): Promise<number> {
    return this.crownRepository.seedCrownsForGuild(guildId, minPlaycount);
  }

  public async killCrown(guildId: string, artistName: string): Promise<boolean> {
    return this.crownRepository.killCrown(guildId, artistName);
  }

  public async removeUserCrowns(guildId: string, userId: number): Promise<number> {
    return this.crownRepository.removeUserCrowns(guildId, userId);
  }

  public async setCrownBlock(guildId: string, userId: number, blocked: boolean): Promise<void> {
    return this.crownRepository.setCrownBlock(guildId, userId, blocked);
  }

  public async getBlockedCrownUsers(guildId: string): Promise<{ userId: number; userNameLastFm: string; discordUserId: string }[]> {
    return this.crownRepository.getBlockedCrownUsers(guildId);
  }

  public async setCrownRole(guildId: string, roleId: string | null): Promise<void> {
    return this.crownRepository.setCrownRole(guildId, roleId);
  }

  public async getCrownRoles(guildId: string): Promise<string[]> {
    return this.crownRepository.getCrownRoles(guildId);
  }

  public async killAllCrowns(guildId: string): Promise<number> {
    return this.crownRepository.killAllCrowns(guildId);
  }
}
