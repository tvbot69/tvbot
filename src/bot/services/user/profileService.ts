import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { IFriendsRepository } from '@domain/interfaces/ports/ifriendsRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { ProfileStats, ProfileHistoryStats, MonthHistoryEntry, YearHistoryEntry } from '@bot/builders/user/profileBuilders';
import { prisma } from '@persistence/prismaClient';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import { Logger } from '@domain/logging/logger';

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
    // CORRECT AS IS: the `0` set here is not the rendered value. `getTopArtists`
    // raises `LastFmUnavailableError` on anything but a genuine not-found, and
    // the branch below re-derives this same number from `userArtist`, which is
    // our own copy of the same rows. The 0 is a sentinel for "ask the database",
    // not an answer the card ever shows, so the raise is contained rather than
    // laundered. `profileBuilders` additionally guards the line on `> 0`, so a
    // genuine zero omits the clause rather than printing "0%".
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

    if (top10ArtistsScrobbles === 0 && targetUser.userId > 0) {
      // CORRECT AS IS, and the non-obvious half: this catch is the END of the
      // chain, not its middle. If BOTH the Last.fm read above and this indexed
      // read fail, `top10ArtistsScrobbles` is 0 - and because the builder guards
      // on `> 0`, that OMITS the "Top 10 artists make up X% of scrobbles" line
      // rather than printing "0%". An omitted clause is an honest absence; a
      // printed 0% would be the confident wrong number the phase exists to
      // remove. There is no third source to fall back to, and the alternative to
      // omitting is failing the whole profile over a footer line, so WARN is the
      // honest weight for a lost capability.
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
      } catch (err) {
        top10ArtistsScrobbles = 0;
        Logger.warn(
          { err: (err as Error)?.message ?? String(err), userId: targetUser.userId },
          'Could not read indexed top-artist playcounts; the profile will omit the top-10 concentration line',
        );
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
      } catch (err) {
        // CORRECT AS IS, and the contrast with `getProfileHistory` below is the
        // whole point of this comment.
        //
        // A failure here leaves the three counts on their Last.fm values, which
        // are REAL numbers from a real source: `profileBuilders` renders
        // `stats.differentTracksCount ?? lastFmUser.trackCount`, so the user sees
        // Last.fm's own count instead of ours. Nothing is invented and no clause
        // disappears, which is why a raise here would cost a real number and buy
        // nothing. Same trade as `albumService`'s server/user stats block.
        //
        // What IS worth saying out loud: this is a read of OUR index, and on
        // failure the card quietly stops being able to say "different from the
        // ones Last.fm counts", which for a user with partial indexing is the
        // number they most wanted. A dropped connection is therefore invisible
        // here - hence the WARN, which is what a lost capability weighs - and
        // `getProfileHistory`, which has no fallback at all, is the site that was
        // actually lying.
        Logger.warn(
          { err: (err as Error)?.message ?? String(err), userId: targetUser.userId },
          'Could not read indexed variety counts; the profile will show Last.fm counts instead',
        );
      }
    }

    let friendsCount: number | undefined;
    if (this.friendsRepo && targetUser.userId > 0) {
      try {
        friendsCount = await this.friendsRepo.getTotalFriendCount(targetUser.userId);
      } catch (err) {
        // CORRECT AS IS, and the reason is the builder's guard, not the type.
        // `undefined` here renders as NOTHING: `profileBuilders` prints the
        // friends line only under `stats.friendsCount && > 0`. A genuine zero
        // and a failed query therefore produce the same card - which is honest,
        // because the card is claiming a number in neither case. The failed read
        // is still a lost capability and is still logged, because "this user has
        // no friends" and "we could not count their friends" are very different
        // facts even when the picture is the same.
        friendsCount = undefined;
        Logger.warn(
          { err: (err as Error)?.message ?? String(err), userId: targetUser.userId },
          'Could not count friends; the profile will omit the friends line',
        );
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
      // THE ONE THAT WAS ACTUALLY LYING, and the reason it is worse than every
      // other catch in this file.
      //
      // `months` and `years` come from two `GROUP BY` rollups over
      // `user_plays` and there is NO fallback source: unlike the variety counts
      // above there is no Last.fm value to keep, so a failed query is
      // indistinguishable from "this user has no plays" at the call site. And
      // `profileBuilders` does not just omit a clause for an empty history - it
      // PRINTS A SENTENCE: `if (!hasHistory)` renders
      // "Sorry, it seems like there is no stored data in tvbot for this user."
      // So a dropped connection told a user with 40 million indexed plays that
      // the bot has never heard of them. A confident falsehood about a real
      // person, produced entirely by an outage - which is the exact shape of the
      // crown bug this phase was opened for.
      //
      // The honest empty is preserved and is the half worth stating: a query
      // that RAN and matched no rows succeeds with `[]`, so a genuine new user
      // still gets that sentence. Only a query that could not run raises.
      // `getProfileStats` shows what "raise" buys here - `interactionHandler`'s
      // boundary answers "Could not reach the database. Please try again in a
      // moment", which is a true sentence about a true state.
      try {
        const monthRows = await prisma.$queryRaw<Array<{ month_date: Date; play_count: number; total_ms: bigint }>>`
          SELECT 
            DATE_TRUNC('month', time_played) AS month_date,
            COUNT(*)::int AS play_count,
            COALESCE(SUM(ms_played), 0)::bigint AS total_ms
          FROM user_plays
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
          FROM user_plays
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
      } catch (err) {
        // Raised, not returned as an empty history. The builder turns an empty
        // history into a statement ABOUT THE USER, so returning one here is
        // exactly the fabricated claim this phase is about. Logger.error because
        // the raise is deliberate and the operator should be able to tell this
        // apart from a defect - the message names the query.
        Logger.error(
          { query: 'profileService.getProfileHistory:userPlaysByMonthAndYear', err: (err as Error)?.message ?? String(err), userId: targetUser.userId },
          'Database unavailable while building the profile history; refusing to render it as "no stored data"',
        );
        throw new SourceUnavailableError(
          'profileService.getProfileHistory:userPlaysByMonthAndYear',
          err,
          'Database unavailable',
        );
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
