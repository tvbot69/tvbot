import { inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { prisma } from '@persistence/prismaClient';

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

  public async getCurrentStreak(userId: number, userNameLastFm: string): Promise<StreakModel | null> {
    const recentTracks = await this.lastfmRepo.getUserRecentTracks(userNameLastFm, 50, 1);
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
    if (artistPlaycount === 50 && userId > 0) {
      try {
        const dbPlays = await prisma.userPlay.findMany({
          where: { userId },
          orderBy: { timePlayed: 'desc' },
          take: 500,
        });
        artistPlaycount = 0;
        for (const p of dbPlays) {
          if (p.artistName.toLowerCase() === lastPlay.artistName.toLowerCase()) {
            artistPlaycount++;
            if (p.timePlayed < streakStarted) {
              streakStarted = p.timePlayed;
            }
          } else {
            break;
          }
        }
      } catch {
        // ignore DB error
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
    } catch {
      // ignore
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

  public streakExists(streak: StreakModel): boolean {
    return streak.artistPlaycount > 1 || streak.albumPlaycount > 1 || streak.trackPlaycount > 1;
  }
}
