import { injectable, inject } from 'tsyringe';
import { Client, ActivityType } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { LyricsService } from './music/lyricsService';
import { Logger } from '@domain/logger';

export interface CandidateTrack {
  artist: string;
  title: string;
}

@injectable()
export class LyricStatusService {
  private static readonly MAX_CANDIDATE_ATTEMPTS = 4;
  private static readonly MAX_DISCORD_STATUS_LENGTH = 120;
  private static readonly MIN_ROTATION_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes minimum between updates

  private lastUpdatedAt = 0;

  constructor(
    @inject(Client) private readonly client: Client,
    @inject(LyricsService) private readonly lyricsService: LyricsService,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  /**
   * Fetches candidate tracks from members' listening history.
   * Looks at recent plays from registered users, or top user tracks.
   */
  public async getCandidateTracks(): Promise<CandidateTrack[]> {
    try {
      // 1. Get recent plays from userPlay table
      const recentPlays = await this.db.userPlay.findMany({
        where: {
          trackName: { not: null },
          artistName: { not: '' },
        },
        orderBy: {
          timePlayed: 'desc',
        },
        take: 150,
        select: {
          artistName: true,
          trackName: true,
        },
      });

      if (recentPlays.length > 0) {
        const unique = new Map<string, CandidateTrack>();
        for (const p of recentPlays) {
          if (p.trackName && p.artistName) {
            const key = `${p.artistName.toLowerCase()}:${p.trackName.toLowerCase()}`;
            if (!unique.has(key)) {
              unique.set(key, { artist: p.artistName, title: p.trackName });
            }
          }
        }
        return Array.from(unique.values());
      }

      // 2. Fallback to userTrack
      const topTracks = await this.db.userTrack.findMany({
        take: 100,
        select: {
          name: true,
          track: {
            select: {
              artist: { select: { name: true } },
            },
          },
        },
      });

      if (topTracks.length > 0) {
        return topTracks
          .filter((t) => t.name && t.track?.artist?.name)
          .map((t) => ({ artist: t.track.artist.name, title: t.name }));
      }
    } catch (err) {
      Logger.warn({ err }, '[LyricStatus] Failed to query tracks from database');
    }

    return [];
  }

  /**
   * Extracts a punchy, clean lyric line suitable for Discord status.
   */
  public static extractPunchyLyricLine(plainLyrics: string): string | null {
    if (!plainLyrics || typeof plainLyrics !== 'string') return null;

    const lines = plainLyrics
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        // Skip bracketed headers: [Chorus], (Verse 1), [Hook: Drake], etc.
        if (/^[\[(].*?[\])]$/.test(l)) return false;
        // Skip metadata lines
        if (/^\d+\s*contributors?/i.test(l)) return false;
        if (/embed$/i.test(l)) return false;
        if (/lyrics$/i.test(l)) return false;
        if (/^produced by/i.test(l)) return false;
        if (/^written by/i.test(l)) return false;
        if (/^instrumental$/i.test(l)) return false;
        // Length constraints: between 15 and 80 chars
        return l.length >= 15 && l.length <= 80;
      });

    if (lines.length === 0) return null;

    // Pick random line
    const idx = Math.floor(Math.random() * lines.length);
    const selectedLine = lines[idx];
    if (!selectedLine) return null;

    // Clean any leading/trailing quotes
    return selectedLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  }

  /**
   * Formats the status line to ensure it fits comfortably within Discord's limit.
   */
  public static formatStatus(lyricLine: string, artist: string): string {
    const cleanArtist = artist.trim();
    const targetMax = LyricStatusService.MAX_DISCORD_STATUS_LENGTH;
    const suffix = ` — ${cleanArtist}`;

    if (lyricLine.length + suffix.length + 2 <= targetMax) {
      return `"${lyricLine}"${suffix}`;
    }

    // Need truncation
    const availableForLyric = targetMax - suffix.length - 3;
    if (availableForLyric > 10) {
      return `"${lyricLine.slice(0, availableForLyric)}…"${suffix}`;
    }

    return `"${lyricLine.slice(0, targetMax - 3)}…"`;
  }

  /**
   * Updates the bot presence with a random lyric from connected members' songs.
   */
  public async updateLyricStatusAsync(force: boolean = false): Promise<boolean> {
    if (!force && Date.now() - this.lastUpdatedAt < LyricStatusService.MIN_ROTATION_INTERVAL_MS) {
      Logger.debug('[LyricStatus] Skipping rotation, minimum interval has not elapsed yet');
      return false;
    }

    try {
      const candidates = await this.getCandidateTracks();
      if (candidates.length === 0) {
        Logger.debug('[LyricStatus] No candidate tracks available for lyric status');
        return false;
      }

      // Shuffle candidate indices
      const shuffled = [...candidates].sort(() => 0.5 - Math.random());
      const toTry = shuffled.slice(0, LyricStatusService.MAX_CANDIDATE_ATTEMPTS);

      for (const track of toTry) {
        const lyrics = await this.lyricsService.getLyrics(track.title, track.artist);
        if (!lyrics || lyrics.instrumental || !lyrics.plainLyrics) {
          continue;
        }

        const lyricLine = LyricStatusService.extractPunchyLyricLine(lyrics.plainLyrics);
        if (!lyricLine) {
          continue;
        }

        const statusText = LyricStatusService.formatStatus(lyricLine, track.artist);

        this.client.user?.setPresence({
          activities: [
            {
              name: statusText,
              type: ActivityType.Listening,
            },
          ],
          status: 'online',
        });

        this.lastUpdatedAt = Date.now();

        Logger.info(
          { track: `${track.artist} - ${track.title}`, status: statusText },
          '[LyricStatus] Updated bot status with lyric',
        );
        return true;
      }

      Logger.debug('[LyricStatus] Could not find suitable lyrics in candidate batch');
      return false;
    } catch (err) {
      Logger.warn({ err }, '[LyricStatus] Error updating lyric status');
      return false;
    }
  }
}
