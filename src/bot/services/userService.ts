import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IUserUpdateQueue } from '@domain/interfaces/iuserUpdateQueue';
import { UpdateType } from '@domain/enums/updateType';
// The Prisma enum types, so writing these columns is checked rather than cast.
import type { Prisma, data_source, privacy_level } from '@prisma/client';
import type { ReferencedMusic } from '@domain/models/referencedMusic';
import { CommandDispatcher } from '@bot/handlers/commandDispatcher';
import { CacheService } from './cacheService';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';
import type { PrismaClient } from '@prisma/client';

const USER_CACHE_TTL_SECONDS = 300;

/**
 * A settings write that could not run is not a settings write.
 *
 * Six methods below ended in `.catch(() => null)` on `db.user.update`, so a
 * dropped connection produced the one answer a user has no way to check: the
 * command still replied "Timezone updated to `Europe/London`" or "Your default
 * WhoKnows mode has been set to **Image**" over a row that was never written.
 *
 * It is worse than a wrong number, because it is a wrong number about the user's
 * OWN settings, and it also goes stale: the cache entry is keyed on the row the
 * write would have RETURNED, so a swallowed failure skips the eviction and leaves
 * the previous value live for the full five-minute TTL while the user has been
 * told the new one is in effect. Nothing errors, nothing is logged, and the two
 * disagree.
 *
 * Same rule as `orDatabaseUnavailable` in `playHistoryService`, `genreService`,
 * `countryService` and `albumService`: a query that runs and finds nothing is a
 * real answer, and a query that never ran is a failure.
 */
const orDatabaseUnavailable = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: method, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${method}; refusing to report the setting as saved`,
    );
    throw new SourceUnavailableError(`userService.${method}`, err, 'Database unavailable');
  }
};

export interface MilestoneProgress {
  currentMilestone: number;
  nextMilestone: number;
  percentage: number;
  percentageText: string;
  playsRemaining: number;
  estimatedDaysLeft: number;
}

export class UserService {
  private readonly userRepository: IUserRepository;
  private readonly cache: CacheService;
  private readonly updateQueue: IUserUpdateQueue;
  private readonly blockedUsers = new Set<string>();
  private readonly prisma?: PrismaClient;

  constructor(
    userRepository: IUserRepository,
    cache: CacheService,
    updateQueue: IUserUpdateQueue,
    prisma?: PrismaClient,
  ) {
    this.userRepository = userRepository;
    this.cache = cache;
    this.updateQueue = updateQueue;
    this.prisma = prisma;
  }

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  /**
   * The one shape shared by all seven settings writers, so the next one cannot
   * grow its own `.catch`.
   *
   * They differ in exactly two ways: the column they write, and the value they
   * echo back to the caller. The part that matters is identical in all seven -
   * write, then evict the cache entry for the row the write RETURNED (not the
   * requested `userId`, which is a different number and cannot find the key).
   *
   * The eviction sits deliberately OUTSIDE the guarded write and is not itself
   * guarded: `CacheService.delete` clears memory first and swallows its own Redis
   * error, so it cannot reject. Wrapping it would only relabel a write that
   * landed as a failure, which is the same lie from the other direction.
   */
  private async writeUserSetting(
    method: string,
    userId: number,
    data: Prisma.UserUncheckedUpdateInput,
  ): Promise<void> {
    const updated = await orDatabaseUnavailable(method, () =>
      this.db.user.update({ where: { userId }, data }),
    );
    await this.cache.delete(`user-discord:${updated.discordUserId}`);
  }

  public async getUserByDiscordId(discordUserId: string): Promise<User | null> {
    const cacheKey = `user-discord:${discordUserId}`;
    const cached = await this.cache.get<User>(cacheKey);
    if (cached) {
      return cached;
    }
    const user = await this.userRepository.getUserByDiscordUserId(discordUserId);
    if (user) {
      await this.cache.set(cacheKey, user, USER_CACHE_TTL_SECONDS);
    }
    return user;
  }

  public async getUserByLastFmName(userNameLastFm: string): Promise<User | null> {
    return this.userRepository.getUserByLastFmName(userNameLastFm);
  }

  public async getUserById(userId: number): Promise<User | null> {
    return this.userRepository.getUserById(userId);
  }

  public async setUserLastFm(discordUserId: string, userNameLastFm: string): Promise<User> {
    const user = await this.userRepository.addUser(userNameLastFm, discordUserId);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return user;
  }

  public async removeUser(discordUserId: string): Promise<boolean> {
    const user = await this.getUserByDiscordId(discordUserId);
    if (!user) {
      return false;
    }
    const removed = await this.userRepository.removeUser(user.userId);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return removed;
  }

  public enqueueUserUpdate(user: User, _updateType: UpdateType): void {
    const enqueued = this.updateQueue.enqueue({
      userId: user.userId,
      discordUserId: user.discordUserId,
      userNameLastFm: user.userNameLastFm,
    });
    if (enqueued) {
      void this.updateQueue.pump();
    }
  }

  public async updateSessionKey(
    discordUserId: string,
    sessionKey: string | null,
  ): Promise<boolean> {
    const user = await this.getUserByDiscordId(discordUserId);
    if (!user) {
      return false;
    }
    await this.userRepository.setSessionKey(user.userId, sessionKey);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return true;
  }

  public async isUserBlocked(discordUserId: string): Promise<boolean> {
    return this.blockedUsers.has(discordUserId);
  }

  public blockUser(discordUserId: string): void {
    this.blockedUsers.add(discordUserId);
  }

  public unblockUser(discordUserId: string): void {
    this.blockedUsers.delete(discordUserId);
  }

  public updateInteractionContext(messageId: string, referencedMusic: ReferencedMusic): void {
    CommandDispatcher.setReferencedMusic(messageId, referencedMusic);
  }

  public getReferencedMusic(lookupId: string): ReferencedMusic | undefined {
    return CommandDispatcher.getReferencedMusic(lookupId);
  }

  public async getMultipleUsers(discordUserIds: string[]): Promise<Map<string, User>> {
    return this.userRepository.getUsersByDiscordIds(discordUserIds);
  }

  /**
   * Milestone projection engine: calculates user's next milestone threshold,
   * progress percentage, plays remaining, and estimated days remaining.
   */
  public calculateMilestone(totalScrobbles: number, dailyAveragePlays: number = 40): MilestoneProgress {
    let baseMilestone = 0;
    let nextMilestone = 1000;
    if (totalScrobbles >= 500000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 100000) * 100000;
      baseMilestone = nextMilestone - 100000;
    } else if (totalScrobbles >= 100000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 50000) * 50000;
      baseMilestone = nextMilestone - 50000;
    } else if (totalScrobbles >= 10000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 10000) * 10000;
      baseMilestone = nextMilestone - 10000;
    } else if (totalScrobbles >= 5000) {
      nextMilestone = 10000;
      baseMilestone = 5000;
    } else if (totalScrobbles >= 1000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 1000) * 1000;
      baseMilestone = nextMilestone - 1000;
    }

    const interval = Math.max(1, nextMilestone - baseMilestone);
    const progressInInterval = Math.max(0, totalScrobbles - baseMilestone);
    const percentage = Math.min(100, (progressInInterval / interval) * 100);
    const playsRemaining = Math.max(0, nextMilestone - totalScrobbles);
    const avg = dailyAveragePlays > 0 ? dailyAveragePlays : 40;
    const estimatedDaysLeft = Math.max(1, Math.ceil(playsRemaining / avg));

    return {
      currentMilestone: baseMilestone,
      nextMilestone,
      percentage,
      percentageText: `${percentage.toFixed(1)}%`,
      playsRemaining,
      estimatedDaysLeft,
    };
  }

  /**
   * Timezone validator & resolver using Intl
   */
  public resolveTimeZone(timeZone?: string | null): string {
    if (!timeZone || typeof timeZone !== 'string' || timeZone.trim().length === 0) {
      return 'UTC';
    }
    const cleanTz = timeZone.trim();
    try {
      // Validates against IANA database
      Intl.DateTimeFormat(undefined, { timeZone: cleanTz });
      return cleanTz;
    } catch {
      // CORRECT AS IS. This is not a query and not a source failure: `Intl`
      // rejecting a zone is `setTimeZone` validating the STRING the user typed,
      // and `UTC` is the value that gets written AND the value the command then
      // echoes back ("Timezone updated to `UTC`"). The reply is therefore true
      // and the user can see exactly what was stored. Raising would turn a typo
      // into an exception; the failure direction here is already an honest
      // absence with a visible value attached.
      return 'UTC';
    }
  }

  /**
   * Session analytics matching C# CalculateBotStats
   */
  public calculateBotStats(interactions: Array<{
    commandName?: string | null;
    timestamp: Date;
    artist?: string | null;
    album?: string | null;
    track?: string | null;
    discordGuildId?: bigint | string | null;
    errorReferenceId?: string | null;
  }>): {
    totalCommands: number;
    commandUsage: Record<string, number>;
    uniqueArtistsSearched: number;
    uniqueAlbumsSearched: number;
    uniqueTracksSearched: number;
    topSearchedArtists: Record<string, number>;
    serversUsedIn: number;
    errorRate: number;
  } {
    if (!interactions || interactions.length === 0) {
      return {
        totalCommands: 0,
        commandUsage: {},
        uniqueArtistsSearched: 0,
        uniqueAlbumsSearched: 0,
        uniqueTracksSearched: 0,
        topSearchedArtists: {},
        serversUsedIn: 0,
        errorRate: 0,
      };
    }

    const commandUsage: Record<string, number> = {};
    const artistCounts: Record<string, number> = {};
    const servers = new Set<string>();
    const artists = new Set<string>();
    const albums = new Set<string>();
    const tracks = new Set<string>();
    let errorCount = 0;

    for (const item of interactions) {
      if (item.commandName) {
        commandUsage[item.commandName] = (commandUsage[item.commandName] ?? 0) + 1;
      }
      if (item.artist) {
        const a = item.artist.toLowerCase();
        artists.add(a);
        artistCounts[item.artist] = (artistCounts[item.artist] ?? 0) + 1;
      }
      if (item.album) albums.add(item.album.toLowerCase());
      if (item.track) tracks.add(item.track.toLowerCase());
      if (item.discordGuildId) servers.add(String(item.discordGuildId));
      if (item.errorReferenceId) errorCount++;
    }

    return {
      totalCommands: interactions.length,
      commandUsage,
      uniqueArtistsSearched: artists.size,
      uniqueAlbumsSearched: albums.size,
      uniqueTracksSearched: tracks.size,
      topSearchedArtists: artistCounts,
      serversUsedIn: servers.size,
      errorRate: +((errorCount / interactions.length) * 100).toFixed(1),
    };
  }

  /**
   * Presentation & footer engine matching C# GetFooterAsync
   */
  public getFooterAsync(
    options: string[] = [],
    genres?: string,
    milestone?: MilestoneProgress,
    streak?: string,
  ): string {
    const parts: string[] = [...options];

    if (milestone) {
      parts.push(`Progress: ${milestone.percentageText} (${milestone.playsRemaining.toLocaleString('en-US')} to ${milestone.nextMilestone.toLocaleString('en-US')})`);
    }

    if (streak) {
      parts.push(streak);
    }

    if (genres) {
      parts.push(genres);
    }

    return parts.filter(Boolean).join(' • ');
  }

  public async getAccentColor(_user?: unknown, _guild?: unknown): Promise<number> {
    return 0xb90000; // LastFmRed fallback
  }

  public async getRankAsync(user?: User | null): Promise<string> {
    if (!user) return 'User';
    return user.userType ?? 'User';
  }

  public async getUserTitleAsync(_guild: unknown, user: User): Promise<string> {
    return user.userNameLastFm;
  }

  // --- Settings & User lifecycle ---
  public async setTimeZone(userId: number, timeZone: string): Promise<string> {
    const resolved = this.resolveTimeZone(timeZone);
    await this.writeUserSetting('setTimeZone', userId, { timeZone: resolved });
    return resolved;
  }

  public async setPrivacyLevel(userId: number, privacyLevel: string): Promise<string> {
    const pLevel = privacyLevel.toLowerCase() === 'hide' || privacyLevel.toLowerCase() === 'server' ? 'Hide' : 'Default';
    await this.writeUserSetting('setPrivacyLevel', userId, { privacyLevel: pLevel as privacy_level });
    return pLevel === 'Hide' ? 'Server' : 'Global';
  }

  public async setDataSource(userId: number, dataSource: string): Promise<string> {
    await this.writeUserSetting('setDataSource', userId, { dataSource: dataSource as data_source });
    return dataSource;
  }

  public async setWhoKnowsMode(userId: number, mode: number): Promise<number> {
    await this.writeUserSetting('setWhoKnowsMode', userId, { whoKnowsMode: mode });
    return mode;
  }

  public async setResponseMode(userId: number, mode: number): Promise<number> {
    await this.writeUserSetting('setResponseMode', userId, { mode });
    return mode;
  }

  public async setCoverType(userId: number, coverType: number): Promise<number> {
    await this.writeUserSetting('setCoverType', userId, { coverType });
    return coverType;
  }

  public async deleteUser(userId: number): Promise<boolean> {
    return this.userRepository.removeUser(userId);
  }

  public async toggleBotScrobblingAsync(_userId: number, _disabled?: boolean): Promise<boolean> {
    return true;
  }

  public async getTotalUserCountAsync(): Promise<number> {
    return this.db.user.count();
  }

  public async getTotalActiveUserCountAsync(daysToGoBack: number = 30): Promise<number> {
    const cutoff = new Date(Date.now() - daysToGoBack * 24 * 3600 * 1000);
    return this.db.user.count({
      where: { lastUsed: { gte: cutoff } },
    });
  }
}
