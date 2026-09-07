import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IUserUpdateQueue } from '@domain/interfaces/iuserUpdateQueue';
import { UpdateType } from '@domain/enums/updateType';
import type { ReferencedMusic } from '@domain/models/referencedMusic';
import { CommandDispatcher } from '@bot/handlers/commandDispatcher';
import { CacheService } from './cacheService';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { PrismaClient } from '@prisma/client';

const USER_CACHE_TTL_SECONDS = 300;

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
   * Number formatting matching user settings (comma, space, or period)
   */
  public formatNumber(value: number, format?: string | null): string {
    if (!Number.isFinite(value)) return '0';
    switch (format?.toLowerCase()) {
      case 'space':
        return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      case 'period':
      case 'dot':
        return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      case 'comma':
      default:
        return value.toLocaleString('en-US');
    }
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

  public async getAccentColor(_user?: any, _guild?: any): Promise<number> {
    return 0xb90000; // LastFmRed fallback
  }

  public async getRankAsync(user?: User | null): Promise<string> {
    if (!user) return 'User';
    return (user as any).userType || 'User';
  }

  public async getUserTitleAsync(_guild: any, user: User): Promise<string> {
    return user.userNameLastFm;
  }

  // --- Settings & User lifecycle ---
  public async setTimeZone(userId: number, timeZone: string): Promise<string> {
    const resolved = this.resolveTimeZone(timeZone);
    await this.db.user.update({
      where: { userId },
      data: { timeZone: resolved },
    }).catch(() => null);
    return resolved;
  }

  public async setNumberFormat(userId: number, format: string): Promise<string> {
    await this.db.user.update({
      where: { userId },
      data: { numberFormat: format },
    }).catch(() => null);
    return format;
  }

  public async setPrivacyLevel(userId: number, privacyLevel: string): Promise<string> {
    await this.db.user.update({
      where: { userId },
      data: { userType: privacyLevel as any },
    }).catch(() => null);
    return privacyLevel;
  }

  public async setDataSource(userId: number, dataSource: string): Promise<string> {
    await this.db.user.update({
      where: { userId },
      data: { dataSource: dataSource as any },
    }).catch(() => null);
    return dataSource;
  }

  public async setWhoKnowsMode(userId: number, mode: string): Promise<string> {
    await this.db.userFmSetting.upsert({
      where: { userId },
      update: { embedType: Number(mode) || 0 },
      create: { userId, embedType: Number(mode) || 0 },
    }).catch(() => null);
    return mode;
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
