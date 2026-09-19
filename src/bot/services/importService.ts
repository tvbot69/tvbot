import { container, inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { Logger } from '@domain/logger';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { IndexService } from './indexService';
import type { PlayInsert } from '@domain/interfaces/iplayRepository';

export type ImportPlaySource = 'SpotifyImport' | 'AppleMusicImport';

export interface ImportSummary {
  totalScrobblesImported: number;
  /** Rows actually stored (deduped) — re-uploads add zero. */
  newRowsInserted: number;
  uniqueArtistsCount: number;
  dateRange: { from: Date; to: Date } | null;
  topArtists: Array<{ name: string; count: number }>;
}

export interface ParsedScrobble {
  artist: string;
  track: string;
  album?: string;
  timePlayed: Date;
}

@injectable()
export class ImportService {
  constructor(@inject(PrismaClient) private readonly prisma?: PrismaClient) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public getInstructions(source: 'spotify' | 'apple' | 'all'): string {
    if (source === 'spotify') {
      return (
        `### 📥 How to Import Your Spotify History\n\n` +
        `**1. Request your data from Spotify:**\n` +
        `> • Go to [Spotify Privacy Settings](https://www.spotify.com/account/privacy/)\n` +
        `> • Scroll down to **Download your data**\n` +
        `> • Request **Extended streaming history** (lifetime data)\n` +
        `> • Spotify will email you a ZIP file when it is ready (typically takes 1-3 days)\n\n` +
        `**2. Upload your data:**\n` +
        `> • Extract the ZIP file and look for files named \`endsong_*.json\` or \`StreamingHistory_*.json\`\n` +
        `> • Simply attach one of the JSON files to a message and run \`.import\`!`
      );
    }

    if (source === 'apple') {
      return (
        `### 🍏 How to Import Your Apple Music History\n\n` +
        `**1. Request your data from Apple:**\n` +
        `> • Visit [Apple Data & Privacy](https://privacy.apple.com/)\n` +
        `> • Select **Request a copy of your data**\n` +
        `> • Check **Apple Media Services information** and submit your request\n` +
        `> • Apple will prepare your archive within a few days\n\n` +
        `**2. Upload your data:**\n` +
        `> • Locate \`Apple_Music_Play_Activity.csv\` inside your download archive\n` +
        `> • Convert or attach the play activity file and send with \`.import\`!`
      );
    }

    return (
      `### 📥 Universal Music History Import\n\n` +
      `TVBot allows you to import your complete Spotify and Apple Music streaming history into your library with **zero paywalls**!\n\n` +
      `**Supported Formats:**\n` +
      `> • **Spotify Extended Streaming History**: files named \`endsong_0.json\`, \`endsong_1.json\`, etc.\n` +
      `> • **Spotify Standard History**: files named \`StreamingHistory0.json\`\n\n` +
      `**How to import:**\n` +
      `Attach your JSON file directly to Discord and type \`.import\` or \`/import\`!`
    );
  }

  public async parseAndImport(
    userId: number,
    fileContent: string,
    source: ImportPlaySource = 'SpotifyImport',
  ): Promise<ImportSummary> {
    let raw: unknown;
    try {
      raw = JSON.parse(fileContent);
    } catch {
      throw new Error('Invalid JSON file format. Please ensure you upload an untouched JSON streaming history file.');
    }

    if (!Array.isArray(raw)) {
      throw new Error('Expected JSON array of play records, but received an object. Please check your file.');
    }

    const scrobbles: ParsedScrobble[] = [];

    for (const item of raw) {
      if (typeof item !== 'object' || !item) continue;

      // Check Spotify endsong.json format
      if ('ts' in item && 'master_metadata_track_name' in item) {
        const track = (item.master_metadata_track_name as string) || '';
        const artist = (item.master_metadata_album_artist_name as string) || '';
        const album = (item.master_metadata_album_album_name as string) || undefined;
        const msPlayed = typeof item.ms_played === 'number' ? item.ms_played : 0;

        // Last.fm rule: only count plays longer than 30 seconds
        if (track && artist && msPlayed >= 30000) {
          const date = new Date(item.ts as string);
          if (!isNaN(date.getTime())) {
            scrobbles.push({ artist, track, album, timePlayed: date });
          }
        }
        continue;
      }

      // Check legacy StreamingHistory.json format
      if ('endTime' in item && 'artistName' in item && 'trackName' in item) {
        const track = (item.trackName as string) || '';
        const artist = (item.artistName as string) || '';
        const msPlayed = typeof item.msPlayed === 'number' ? item.msPlayed : 0;

        if (track && artist && msPlayed >= 30000) {
          const date = new Date(item.endTime as string);
          if (!isNaN(date.getTime())) {
            scrobbles.push({ artist, track, timePlayed: date });
          }
        }
        continue;
      }

      // Check generic { artist, track, timePlayed } format
      if ('artist' in item && 'track' in item) {
        const track = (item.track as string) || '';
        const artist = (item.artist as string) || '';
        const album = (item.album as string) || undefined;
        const date = item.timePlayed || item.timestamp ? new Date((item.timePlayed || item.timestamp) as string) : new Date();

        if (track && artist && !isNaN(date.getTime())) {
          scrobbles.push({ artist, track, album, timePlayed: date });
        }
      }
    }

    if (scrobbles.length === 0) {
      throw new Error(
        'No valid scrobbles (with playback duration > 30 seconds) found in this file.',
      );
    }

    // Sort chronologically
    scrobbles.sort((a, b) => a.timePlayed.getTime() - b.timePlayed.getTime());

    const minDate = scrobbles[0]!.timePlayed;
    const maxDate = scrobbles[scrobbles.length - 1]!.timePlayed;

    // Track artist frequencies
    const artistCounts = new Map<string, number>();
    for (const s of scrobbles) {
      artistCounts.set(s.artist, (artistCounts.get(s.artist) ?? 0) + 1);
    }

    const topArtists = Array.from(artistCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Persist rows (deduplicated — re-uploading the same file is a no-op),
    // then rebuild aggregates so wk/at/top see imports immediately. The
    // counter only moves by actually-inserted rows, never by re-uploads.
    const reposWired = container.isRegistered(PlayRepository);
    const inserted = reposWired ? await this.persistScrobbles(userId, scrobbles, source) : 0;
    if (inserted > 0) {
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: { increment: inserted } },
      }).catch(() => undefined);
      try {
        if (container.isRegistered(IndexService)) {
          await container.resolve(IndexService).recalculateTopLists(userId);
        }
      } catch (err) {
        Logger.warn({ err, userId }, '[ImportService] aggregate rebuild failed after import');
      }
    } else if (!reposWired) {
      // No repos wired (unit-test context) — preserve legacy counter behavior.
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: { increment: scrobbles.length } },
      }).catch(() => undefined);
    }

    Logger.info(
      `[ImportService] User ${userId} successfully imported ${scrobbles.length} scrobbles across ${artistCounts.size} unique artists.`,
    );

    return {
      totalScrobblesImported: scrobbles.length,
      newRowsInserted: reposWired ? inserted : scrobbles.length,
      uniqueArtistsCount: artistCounts.size,
      dateRange: { from: minDate, to: maxDate },
      topArtists,
    };
  }

  private async persistScrobbles(
    userId: number,
    scrobbles: ParsedScrobble[],
    source: ImportPlaySource,
  ): Promise<number> {
    try {
      if (!container.isRegistered(PlayRepository)) return 0;
      const repo = container.resolve(PlayRepository);
      const existing = await repo
        .findExistingPlayKeys(
          userId,
          scrobbles[0]!.timePlayed,
          scrobbles[scrobbles.length - 1]!.timePlayed,
        )
        .catch(() => new Set<string>());
      const seen = new Set<string>();
      const fresh: PlayInsert[] = [];
      for (const s of scrobbles) {
        const key = PlayRepository.playKey(s.timePlayed, s.artist, s.track);
        if (seen.has(key) || existing.has(key)) continue;
        seen.add(key);
        fresh.push({
          userId,
          artistName: s.artist,
          albumName: s.album,
          trackName: s.track,
          timePlayed: s.timePlayed,
          playSource: source,
        });
      }
      if (fresh.length === 0) return 0;
      return await repo.batchInsertPlays(fresh).catch(() => 0);
    } catch {
      return 0;
    }
  }

  public async resetImport(userId: number): Promise<boolean> {
    try {
      await this.db.userPlay.deleteMany({
        where: { userId, playSource: { in: ['SpotifyImport', 'AppleMusicImport'] } },
      });
      try {
        if (container.isRegistered(IndexService)) {
          await container.resolve(IndexService).recalculateTopLists(userId);
        }
      } catch {
        // ignore — counter reset below still applies
      }
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: 0 },
      });
      return true;
    } catch {
      return false;
    }
  }
}
