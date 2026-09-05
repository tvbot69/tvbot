import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IFriendsRepository } from '@domain/interfaces/ifriendsRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { ProfileStats, ProfileHistoryStats, MonthHistoryEntry, YearHistoryEntry } from '@bot/builders/profileBuilders';
import { prisma } from '@persistence/prismaClient';

function formatListeningTime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

@injectable()
export class ProfileService {
  constructor(
    @inject('ILastfmRepository') private readonly lastfmRepo: ILastfmRepository,
    @inject('IFriendsRepository') private readonly friendsRepo?: IFriendsRepository,
  ) {}

  public async getProfileStats(
    userDisplayName: string,
    targetUser: User,
    accentColor?: number | null,
  ): Promise<ProfileStats | null> {
    const lastFmUser = await this.lastfmRepo.getUserInfo(targetUser.userNameLastFm);
    if (!lastFmUser) {
      return null;
    }

    let top10ArtistsScrobbles = 0;
    try {
      const topArtists = await this.lastfmRepo.getTopArtists(
        targetUser.userNameLastFm,
        TimePeriod.AllTime,
        10,
      );
      if (topArtists && topArtists.length > 0) {
        top10ArtistsScrobbles = topArtists.reduce((acc, a) => acc + (a.playcount ?? 0), 0);
      }
    } catch {
      top10ArtistsScrobbles = 0;
    }

    let friendsCount: number | undefined;
    if (this.friendsRepo && targetUser.userId > 0) {
      try {
        friendsCount = await this.friendsRepo.getTotalFriendCount(targetUser.userId);
      } catch {
        friendsCount = undefined;
      }
    }

    return {
      userDisplayName,
      lastFmUser,
      user: targetUser,
      top10ArtistsScrobbles,
      friendsCount,
      accentColor,
    };
  }

  public async getProfileHistory(
    userDisplayName: string,
    targetUser: User,
    accentColor?: number | null,
  ): Promise<ProfileHistoryStats | null> {
    const lastFmUser = await this.lastfmRepo.getUserInfo(targetUser.userNameLastFm);
    if (!lastFmUser) {
      return null;
    }

    const registeredUnix = lastFmUser.registeredAt
      ? Math.floor(lastFmUser.registeredAt.getTime() / 1000)
      : 0;

    const months: MonthHistoryEntry[] = [];
    const years: YearHistoryEntry[] = [];

    if (targetUser.userId > 0) {
      try {
        const monthRows = await prisma.$queryRaw<Array<{ month_date: Date; play_count: number; total_ms: bigint }>>`
          SELECT 
            DATE_TRUNC('month', time_played) AS month_date,
            COUNT(*)::int AS play_count,
            COALESCE(SUM(ms_played), 0)::bigint AS total_ms
          FROM public.user_plays
          WHERE user_id = ${targetUser.userId}
          GROUP BY month_date
          ORDER BY month_date DESC
          LIMIT 6
        `;

        const monthNames = [
          'January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'
        ];

        for (const row of monthRows) {
          const d = new Date(row.month_date);
          const monthName = `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
          const count = Number(row.play_count);
          const totalSeconds = row.total_ms > 0n ? Number(row.total_ms / 1000n) : count * 210;
          months.push({
            monthName,
            playCount: count,
            timeString: formatListeningTime(totalSeconds),
          });
        }

        const yearRows = await prisma.$queryRaw<Array<{ year_date: Date; play_count: number; total_ms: bigint }>>`
          SELECT 
            DATE_TRUNC('year', time_played) AS year_date,
            COUNT(*)::int AS play_count,
            COALESCE(SUM(ms_played), 0)::bigint AS total_ms
          FROM public.user_plays
          WHERE user_id = ${targetUser.userId}
          GROUP BY year_date
          ORDER BY year_date DESC
        `;

        for (const row of yearRows) {
          const d = new Date(row.year_date);
          const year = d.getUTCFullYear().toString();
          const count = Number(row.play_count);
          const totalSeconds = row.total_ms > 0n ? Number(row.total_ms / 1000n) : count * 210;
          years.push({
            year,
            playCount: count,
            timeString: formatListeningTime(totalSeconds),
          });
        }
      } catch {
        // Ignored, fallback to empty history
      }
    }

    return {
      userDisplayName,
      lastFmUser,
      registeredUnix,
      user: targetUser,
      accentColor,
      months,
      years,
    };
  }
}
