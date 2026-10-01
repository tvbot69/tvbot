import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { prisma } from '@persistence/prismaClient';
import { Logger } from '@domain/logging/logger';

export interface StreakModel {
  artistName: string;
  artistPlaycount: number;
  albumName: string | null;
  albumPlaycount: number;
  trackName: string;
  trackPlaycount: number;
  genreName: string | null;
  genrePlaycount: number;
  streakStarted: Date;
  streakEnded: Date;
  emoji: string | null;
}

export function getEmojiForStreakCount(count: number): string | null {
  if (count > 25000) return '🌌';
  if (count > 15000) return '🌠';
  if (count > 10000) return '🪐';
  if (count > 7500) return '🌚';
  if (count > 5000) return '🚀';
  if (count > 2500) return '😵';
  if (count === 1337) return '🦹';
  if (count === 1234) return '🔢';
  if (count > 1000) return '😲';
  if (count === 666) return '😈';
  if (count === 420) return '🍃';
  if (count === 100) return '💯';
  if (count === 69) return '😎';
  if (count > 50) return '🔥';
  return null;
}

@injectable()
export class StreakService {
  constructor(
    @inject('ILastfmRepository') private readonly lastfmRepo: ILastfmRepository,
  ) {}

  public async getCurrentStreak(
    userId: number,
    userNameLastFm: string,
    sessionKey?: string | null,
  ): Promise<StreakModel | null> {
    const recentTracks = await this.lastfmRepo.getUserRecentTracks(
      userNameLastFm,
      50,
      1,
      undefined,
      sessionKey ?? undefined,
    );
    if (!recentTracks || recentTracks.length === 0) {
      return null;
    }

    const lastPlay = recentTracks[0]!;
    let streakStarted = lastPlay.timePlayed ?? new Date();
    const streakEnded = lastPlay.timePlayed ?? new Date();

    // 1. Consecutive Artist plays
    let artistPlaycount = 0;
    for (const play of recentTracks) {
      if (play.artistName.toLowerCase() === lastPlay.artistName.toLowerCase()) {
        artistPlaycount++;
        if (play.timePlayed && play.timePlayed < streakStarted) {
          streakStarted = play.timePlayed;
        }
      } else {
        break;
      }
    }

    // If 50 reached and user has DB plays, check deeper
    //
    // The 50 from Last.fm is a real count, but a CAPPED one - which is why this
    // deeper lookup exists. That distinction decides what a failure must do.
    //
    // The old code did `artistPlaycount = 0` BEFORE the loop and swallowed any
    // error, so a dropped connection did not merely lose the deeper count: it
    // DESTROYED the 50 that had already been measured and rendered "No active
    // streak found." to someone with a 500-play streak. Two bugs in three lines -
    // the reset placement, and treating a real lower bound as a default to throw
    // away.
    //
    // A failure now leaves the Last.fm count intact and logs at WARN. That is
    // NOT "log and return a default": the 50 is a genuine measurement from a
    // different source, and it is a true lower bound, where 0 would be a false
    // claim. Raising instead would take the whole streak command down over an
    // enrichment that was optional to begin with.
    if (artistPlaycount === 50 && userId > 0) {
      try {
        const dbPlays = await prisma.userPlay.findMany({
          where: { userId },
          orderBy: { timePlayed: 'desc' },
          take: 500,
        });
        let deeperCount = 0;
        let deeperStart = streakStarted;
        for (const p of dbPlays) {
          if (p.artistName.toLowerCase() === lastPlay.artistName.toLowerCase()) {
            deeperCount++;
            if (p.timePlayed < deeperStart) {
              deeperStart = p.timePlayed;
            }
          } else {
            break;
          }
        }
        // Only replace the measured value once the deeper lookup actually ran.
        artistPlaycount = deeperCount;
        streakStarted = deeperStart;
      } catch (err) {
        Logger.warn(
          { err: (err as Error)?.message ?? String(err), userId },
          'Streak: deeper playcount lookup failed; keeping the Last.fm count, which is a real lower bound',
        );
      }
    }

    // 2. Consecutive Album plays
    let albumPlaycount = 0;
    if (lastPlay.albumName) {
      for (const play of recentTracks) {
        if (play.albumName && play.albumName.toLowerCase() === lastPlay.albumName.toLowerCase()) {
          albumPlaycount++;
        } else {
          break;
        }
      }
    }

    // 3. Consecutive Track plays
    let trackPlaycount = 0;
    for (const play of recentTracks) {
      if (
        play.name.toLowerCase() === lastPlay.name.toLowerCase() &&
        play.artistName.toLowerCase() === lastPlay.artistName.toLowerCase()
      ) {
        trackPlaycount++;
      } else {
        break;
      }
    }

    // 4. Genre streak check
    let genreName: string | null = null;
    let genrePlaycount = 0;
    try {
      const artistWithGenre = await prisma.artist.findFirst({
        where: { name: { equals: lastPlay.artistName, mode: 'insensitive' } },
        include: { genres: { take: 1 } },
      });
      if (artistWithGenre?.genres?.[0]) {
        genreName = artistWithGenre.genres[0].name;
        genrePlaycount = artistPlaycount;
      }
    } catch (err) {
      // Genre is a pure ENRICHMENT: the streak itself is already counted above,
      // and `genrePlaycount` only mirrors artistPlaycount when a genre was found.
      // So a failure here costs one optional line in the embed, not the streak,
      // and `genreName` stays null which the builder already treats as "omit".
      // Logged rather than silently swallowed, because a user who suddenly has
      // no genre line has no way to tell that from never having had one.
      Logger.debug(
        { err: (err as Error)?.message ?? String(err) },
        'Streak: genre lookup failed; the genre line will be omitted',
      );
    }

    const emoji = getEmojiForStreakCount(artistPlaycount);

    return {
      artistName: lastPlay.artistName,
      artistPlaycount,
      albumName: lastPlay.albumName ?? null,
      albumPlaycount,
      trackName: lastPlay.name,
      trackPlaycount,
      genreName,
      genrePlaycount,
      streakStarted,
      streakEnded,
      emoji,
    };
  }
}
