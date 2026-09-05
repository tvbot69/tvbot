import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IFriendsRepository } from '@domain/interfaces/ifriendsRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { ProfileStats, ProfileHistoryStats, MonthHistoryEntry, YearHistoryEntry } from '@bot/builders/profileBuilders';
import { prisma } from '@persistence/prismaClient';

function formatLongListeningTime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days >= 1) {
    const dayStr = days === 1 ? '1 day' : `${days} days`;
    if (hours > 0) {
      const hourStr = hours === 1 ? '1 hour' : `${hours} hours`;
      return `${dayStr}, ${hourStr}`;
    }
    return dayStr;
  }

  if (hours >= 1) {
    const hourStr = hours === 1 ? '1 hour' : `${hours} hours`;
    if (minutes > 0) {
      const minStr = minutes === 1 ? '1 minute' : `${minutes} minutes`;
      return `${hourStr}, ${minStr}`;
    }
    return hourStr;
  }

  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
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
    if (targetUser.userId > 0) {
      try {
        const dbTop = await prisma.userArtist.findMany({
          where: { userId: targetUser.userId },
          orderBy: { playcount: 'desc' },
          take: 10,
          select: { playcount: true },
        });
        if (dbTop && dbTop.length > 0) {
          top10ArtistsScrobbles = dbTop.reduce((acc, a) => acc + (a.playcount ?? 0), 0);
        }
      } catch {
        top10ArtistsScrobbles = 0;
      }
    }

    if (top10ArtistsScrobbles === 0) {
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
    }

    let differentTracksCount = lastFmUser.trackCount;
    let differentAlbumsCount = lastFmUser.albumCount;
    let differentArtistsCount = lastFmUser.artistCount;

    if (targetUser.userId > 0 && (!differentTracksCount || !differentAlbumsCount || !differentArtistsCount)) {
      try {
        const [arCount, alCount, trCount] = await Promise.all([
          differentArtistsCount ? Promise.resolve(differentArtistsCount) : prisma.userArtist.count({ where: { userId: targetUser.userId } }),
          differentAlbumsCount ? Promise.resolve(differentAlbumsCount) : prisma.userAlbum.count({ where: { userId: targetUser.userId } }),
          differentTracksCount ? Promise.resolve(differentTracksCount) : prisma.userTrack.count({ where: { userId: targetUser.userId } }),
        ]);
        differentArtistsCount = arCount || undefined;
        differentAlbumsCount = alCount || undefined;
        differentTracksCount = trCount || undefined;
      } catch {
        // Fallback to Last.fm counts
      }
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
      differentTracksCount,
      differentAlbumsCount,
      differentArtistsCount,
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
          const monthName = monthNames[d.getUTCMonth()] ?? '';
          const count = Number(row.play_count);
          const totalSeconds = row.total_ms > 0n ? Number(row.total_ms / 1000n) : count * 210;
          months.push({
            monthName,
            playCount: count,
            timeString: formatLongListeningTime(totalSeconds),
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

        if (yearRows.length > 0) {
          const totalPlays = yearRows.reduce((acc, r) => acc + Number(r.play_count), 0);
          const totalMs = yearRows.reduce(
            (acc, r) => acc + (r.total_ms > 0n ? r.total_ms : BigInt(Number(r.play_count) * 210 * 1000)),
            0n,
          );
          const totalSeconds = Number(totalMs / 1000n);
          if (totalPlays > 0) {
            years.push({
              year: ' All',
              playCount: totalPlays,
              timeString: formatLongListeningTime(totalSeconds),
            });
          }

          for (const row of yearRows) {
            const d = new Date(row.year_date);
            const year = d.getUTCFullYear().toString();
            const count = Number(row.play_count);
            const totalSeconds = row.total_ms > 0n ? Number(row.total_ms / 1000n) : count * 210;
            years.push({
              year,
              playCount: count,
              timeString: formatLongListeningTime(totalSeconds),
            });
          }
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
