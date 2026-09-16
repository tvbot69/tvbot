import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { GenreService } from './genreService';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { Logger } from '@domain/logger';
import type { User } from '@domain/interfaces/iuserRepository';

export interface GuiltyPleasureItem {
  artistName: string;
  trackName?: string;
  playcount: number;
  genres: string[];
  reason: string;
}

export interface ExposedReport {
  user: User;
  displayName: string;
  publicArtists: string[];
  publicGenres: string[];
  guiltyPleasures: GuiltyPleasureItem[];
  roast: string;
  shameScore: number;
}

export const ROAST_QUOTES = [
  'Bro thought Spotify Private Session was turned on 💀',
  'We won’t tell anyone if you delete your scrobbles right now.',
  'You have 1,400 plays on your top artists, but you secretly bumped this. The council is revoking your aux privileges.',
  'Explain yourself. Why was this queued up with zero witnesses?',
  'Bro is fighting demons with headphones on.',
  'Bro’s algorithm is crying for help right now.',
  'From the mosh pit to Disney Channel in 3 business days.',
  'Don’t let the group chat find out about this one.',
  'Your Spotify Wrapped is going to need a lawyer at this rate.',
  'You’re not slick, the database never forgets.',
  'Bro closed the door, looked both ways, and hit play.',
  'This didn’t come from your playlist, this came from your soul.',
  'Bro was listening to this in incognito mode with the brightness at 0%.',
  'Bro was practicing the choreography in the mirror, do not lie.',
];

const POP_AND_GUILTY_GENRES = new Set([
  'pop',
  'dance-pop',
  'teen pop',
  'k-pop',
  'kpop',
  'disney',
  'soundtrack',
  'boy band',
  'eurodance',
  'musical',
  'meme',
  'hyperpop',
  'bubblegum pop',
  'children',
  'nightcore',
  'glitchcore',
  'vocaloid',
]);

@injectable()
export class ExposedService {
  private static readonly GUILD_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours per guild
  private static readonly USER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days per user

  private readonly lastGuildAlarm = new Map<string, number>();
  private readonly lastUserAlarm = new Map<number, number>();

  constructor(
    @inject(GenreService) private readonly genreService: GenreService,
    @inject(PlayRepository) private readonly playRepo: PlayRepository,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  /**
   * Generates a full "Caught in 4K" investigation report for a user.
   */
  public async generateReport(user: User, displayName: string): Promise<ExposedReport | null> {
    try {
      // 1. Establish the user's public persona from top artists & genres
      const topArtists = await this.playRepo.getTopArtists(user.userId, undefined, 10);
      if (!topArtists || topArtists.length === 0) {
        return null;
      }

      const topGenres = await this.genreService.getTopGenresForTopArtists(
        topArtists.map((a) => ({ name: a.name, playcount: a.playcount })),
        5,
      );

      const publicGenreNames = topGenres.map((g) => g.genreName.toLowerCase().trim());
      const publicArtistNames = topArtists.slice(0, 4).map((a) => a.name);

      // 2. Fetch all user artists outside their top 15
      const candidateArtists = await this.db.userArtist.findMany({
        where: {
          userId: user.userId,
          playcount: { gte: 2, lte: 250 }, // Not their main #1 artist, but repeatedly listened to
        },
        orderBy: { playcount: 'desc' },
        take: 60,
      });

      if (candidateArtists.length === 0) {
        return null;
      }

      // Check genre divergence
      const guiltyPleasures: GuiltyPleasureItem[] = [];

      for (const candidate of candidateArtists) {
        // Skip if artist is in top 15
        if (topArtists.some((t) => t.name.toLowerCase() === candidate.name.toLowerCase())) {
          continue;
        }

        const genres = await this.genreService.getGenresForArtist(candidate.name);
        const lowerGenres = genres.map((g) => g.toLowerCase().trim());

        // Check if any genre is explicitly a classic guilty pleasure tag
        const matchedGuiltyTag = lowerGenres.find((g) => POP_AND_GUILTY_GENRES.has(g));

        // Check genre overlap with user's top genres
        const overlap = lowerGenres.some((g) => publicGenreNames.includes(g));

        if (matchedGuiltyTag && !publicGenreNames.includes(matchedGuiltyTag)) {
          guiltyPleasures.push({
            artistName: candidate.name,
            playcount: candidate.playcount,
            genres: genres.slice(0, 3),
            reason: `Secretly enjoying ${matchedGuiltyTag}`,
          });
        } else if (!overlap && lowerGenres.length > 0 && candidate.playcount >= 3) {
          guiltyPleasures.push({
            artistName: candidate.name,
            playcount: candidate.playcount,
            genres: genres.slice(0, 3),
            reason: `Zero overlap with your usual ${publicGenreNames[0] || 'taste'}`,
          });
        }

        if (guiltyPleasures.length >= 3) break;
      }

      // If no extreme divergence found, check recent plays for loop anomalies
      if (guiltyPleasures.length === 0) {
        const recentPlays = await this.db.userPlay.findMany({
          where: { userId: user.userId },
          orderBy: { timePlayed: 'desc' },
          take: 30,
        });

        const counts = new Map<string, { count: number; track: string }>();
        for (const p of recentPlays) {
          if (!p.artistName) continue;
          const key = p.artistName.toLowerCase();
          const entry = counts.get(key) ?? { count: 0, track: p.trackName ?? '' };
          entry.count++;
          counts.set(key, entry);
        }

        for (const [artistLower, data] of counts.entries()) {
          if (data.count >= 3) {
            const genres = await this.genreService.getGenresForArtist(artistLower);
            guiltyPleasures.push({
              artistName: artistLower,
              trackName: data.track,
              playcount: data.count,
              genres: genres.slice(0, 3),
              reason: `Looped ${data.count} times in recent scrobbles`,
            });
            break;
          }
        }
      }

      if (guiltyPleasures.length === 0) {
        return null;
      }

      const roast = ROAST_QUOTES[Math.floor(Math.random() * ROAST_QUOTES.length)]!;
      const highestPlays = Math.max(...guiltyPleasures.map((g) => g.playcount));
      const shameScore = Math.min(99, Math.max(50, 45 + highestPlays * 4));

      return {
        user,
        displayName,
        publicArtists: publicArtistNames,
        publicGenres: publicGenreNames.slice(0, 3),
        guiltyPleasures,
        roast,
        shameScore,
      };
    } catch (err) {
      Logger.warn({ err, userId: user.userId }, '[ExposedService] Failed to generate report');
      return null;
    }
  }

  /**
   * Checks if a live .fm track qualifies as a rare "Caught in 4K" moment.
   * Returns a roast and anomaly data only if it passes all cooldown and divergence thresholds.
   */
  public async checkLiveNowPlayingAnomaly(
    user: User,
    guildId: string | null | undefined,
    currentArtist: string,
    currentTrack: string,
  ): Promise<{ isAnomaly: boolean; roast: string; matchedGenre: string } | null> {
    if (!currentArtist || !guildId) return null;

    const now = Date.now();
    const lastGuild = this.lastGuildAlarm.get(guildId) ?? 0;
    if (now - lastGuild < ExposedService.GUILD_COOLDOWN_MS) {
      return null; // Guild on 24h cooldown
    }

    const lastUser = this.lastUserAlarm.get(user.userId) ?? 0;
    if (now - lastUser < ExposedService.USER_COOLDOWN_MS) {
      return null; // User on 7d cooldown
    }

    try {
      const topArtists = await this.playRepo.getTopArtists(user.userId, undefined, 10);
      if (!topArtists || topArtists.length < 3) return null;

      // Check if current artist is one of their top 15 artists
      if (topArtists.some((a) => a.name.toLowerCase() === currentArtist.toLowerCase())) {
        return null; // Normal listen
      }

      const topGenres = await this.genreService.getTopGenresForTopArtists(
        topArtists.map((a) => ({ name: a.name, playcount: a.playcount })),
        4,
      );
      const publicGenres = topGenres.map((g) => g.genreName.toLowerCase().trim());

      const artistGenres = await this.genreService.getGenresForArtist(currentArtist);
      const lowerArtistGenres = artistGenres.map((g) => g.toLowerCase().trim());

      const matchedGuiltyTag = lowerArtistGenres.find(
        (g) => POP_AND_GUILTY_GENRES.has(g) && !publicGenres.includes(g),
      );

      if (!matchedGuiltyTag) {
        return null;
      }

      // Check if user has played this track or artist multiple times recently
      const recentPlays = await this.db.userPlay.count({
        where: {
          userId: user.userId,
          artistName: { equals: currentArtist, mode: 'insensitive' },
        },
      });

      if (recentPlays < 2) {
        return null; // Needs at least 2 plays to prove it wasn't a 1-off accidental scrobble
      }

      // Mark cooldowns
      this.lastGuildAlarm.set(guildId, now);
      this.lastUserAlarm.set(user.userId, now);

      const roast = ROAST_QUOTES[Math.floor(Math.random() * ROAST_QUOTES.length)]!;
      return {
        isAnomaly: true,
        roast,
        matchedGenre: matchedGuiltyTag,
      };
    } catch (err) {
      Logger.debug({ err }, '[ExposedService] Live anomaly check error');
      return null;
    }
  }
}
