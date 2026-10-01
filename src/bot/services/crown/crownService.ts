import { injectable, inject } from 'tsyringe';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { crownRoleVerdict } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { Guild } from '@persistence/models/guild';
import type { UserCrownDto, CrownModel, CrownViewType, CrownLeaderboardEntry } from '@domain/models/crownModels';
import { UserService } from '@bot/services/user/userService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';
import { AbuseFilterService } from '@bot/services/system/abuseFilterService';

@injectable()
export class CrownService {
  constructor(
    @inject(CrownRepository) private readonly crownRepository: CrownRepository,
    @inject(UserService) private readonly userService: UserService,
    @inject(LastFmRepository) private readonly lastfmRepository?: ILastfmRepository,
    @inject(LastfmErrorRateTracker) private readonly errorRateTracker?: LastfmErrorRateTracker,
    @inject(AbuseFilterService) private readonly abuseFilter?: AbuseFilterService,
  ) {}

  public async getAndUpdateCrownForArtist(
    users: WhoKnowsUser[],
    guildUsers: Map<number, FullGuildUserDetails>,
    guild: Guild | null,
    artistName: string,
    resolvedArtistName?: string,
  ): Promise<CrownModel | null> {
    if (!guild || guild.crownsDisabled) {
      return null;
    }

    const guildIdStr = guild.guildId.toString();
    const minPlaycount = guild.crownsMinimumPlaycountThreshold ?? 30;
    const activityDays = guild.crownsActivityThresholdDays;

    // A `crownRoles` guild can only rank people whose roles we actually read.
    //
    // KNOWN LIMIT, recorded rather than fixed: this gate is all-or-nothing per
    // artist. If ONE listener's roles are unread, no crown moves for anyone in
    // that guild - including listeners whose roles WERE read and who are far
    // ahead. Narrowing it to "block only when the unread row could have won"
    // needs a playcount comparison against the unknown row, and a wrong version
    // of that comparison is exactly the bug being fixed here: a crown named
    // from a partial read. Writing nothing is recoverable by re-running; the
    // wrong crown is not.
    // This used to be `const userRoles = u.roles ?? []` inside the eligibility
    // filter, which silently collapsed "this member holds none of the required
    // roles" and "we could not ask Discord what roles they hold" into the same
    // answer. The second one is a lie with teeth: the user was dropped from
    // contention and `replaceCrown` then wrote a crown naming the person below
    // them, from a role list that was never read. `WhoKnowsRoleRead` keeps the
    // two apart, and this is the only place that acts on the difference.
    //
    // The gate is guild-wide and up-front rather than per-user, and that is
    // deliberate: a crown names ONE person, and if any row is unresolved we
    // cannot prove that person is the top ELIGIBLE one, so no write happens at
    // all. Not raising is a considered choice, not an oversight - the answer
    // here is not silence. The standing crown is re-read and returned, so the
    // card still shows a crown that WAS verified, and the skill is lost with a
    // WARN rather than swallowed. Raising would blank the crown marker on every
    // who-knows card in every guild for the duration of a Discord hiccup, which
    // is the trade the who-knows leaderboard boundary already refused to make.
    const crownRoleIds =
      guild.crownRoles && guild.crownRoles.length > 0
        ? new Set(guild.crownRoles.map((r) => r.toString()))
        : null;
    if (crownRoleIds) {
      const unresolved = users.filter((u) => crownRoleVerdict(u.roles, crownRoleIds) === 'unknown');
      if (unresolved.length > 0) {
        Logger.warn(
          { guildId: guildIdStr, artist: artistName, unresolved: unresolved.length },
          'Crown evaluation skipped — could not read guild roles for at least one listener; ' +
            'no crown written rather than one naming an unverified holder',
        );
        const standing = await this.crownRepository.getCurrentCrown(guildIdStr, artistName);
        return standing ? { crown: standing } : null;
      }
    }

    // 1. Filter eligible users (privacy opt-outs and abuse-flagged farmers
    // can never hold crowns)
    const now = Date.now();
    const eligibleUsers = users.filter((u) => {
      const gu = guildUsers.get(u.userId);
      if (gu?.whoKnowsBanned) return false;
      if (gu?.blockedFromCrowns) return false;
      if (gu?.selfBlockFromWhoKnows) return false;
      if (gu?.privacyLevel === 'Hide') return false;
      if (this.abuseFilter?.isFlagged(u.userId)) return false;

      if (activityDays && activityDays > 0) {
        if (!u.lastUsed) return false;
        const lastUsedMs = u.lastUsed.getTime();
        const cutoffMs = now - activityDays * 24 * 60 * 60 * 1000;
        if (lastUsedMs < cutoffMs) return false;
      }

      if (crownRoleIds) {
        // Unchanged in effect: after the gate above there are no `unknown` rows
        // left, and both `ineligible` answers (a member we read and they hold
        // no required role; a member Discord says is not in the guild) drop the
        // user exactly as `u.roles ?? []` used to.
        if (crownRoleVerdict(u.roles, crownRoleIds) !== 'eligible') return false;
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
   * userplaycount). Null when Last.fm ANSWERED and there is no playcount to be
   * had - that is a real empty and the caller fails open on it.
   *
   * A Last.fm that did not answer is not an empty: `getArtistInfo` raises
   * `LastFmUnavailableError` for that, and swallowing it here returned the same
   * `null` - so an outage read as "the holder is not ahead" and the steal below
   * was written to the crown store. That is a permanent claim, naming the
   * challenger as the holder and the real holder as dethroned, made on data the
   * bot never managed to read. Re-thrown, so the throw lands on the who-knows
   * boundary and the card shows no crown rather than a wrong one.
   *
   * The `errorRateTracker` kill switch above still covers the *global* outage
   * case. It is not a substitute: it needs 20+ tracked calls and 25% errors, so
   * a single scoped `artist.getinfo` failure sails straight past it.
   */
  private async getHolderLivePlaycount(
    artistName: string,
    holderLastFmUsername?: string | null,
  ): Promise<number | null> {
    if (!this.lastfmRepository || !holderLastFmUsername) return null;
    try {
      const info = await this.lastfmRepository.getArtistInfo(artistName, holderLastFmUsername);
      const plays = info?.userPlayCount;
      return typeof plays === 'number' && Number.isFinite(plays) ? plays : null;
    } catch (err) {
      if (isSourceUnavailable(err)) {
        throw err;
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
