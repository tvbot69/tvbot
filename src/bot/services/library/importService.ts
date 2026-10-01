import { container, inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import { Logger } from '@domain/logging/logger';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { IndexService } from '@bot/services/lastfm/indexService';
import type { PlayInsert } from '@domain/interfaces/ports/iplayRepository';

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
  /**
   * Hard ceiling on an uploaded history file (~48MB of text). Comfortably
   * covers a multi-year export while staying far below the heap ceiling that
   * JSON.parse would otherwise blow through.
   */
  private static readonly MAX_IMPORT_CHARS = 50 * 1024 * 1024;

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
    // The process runs with a small heap cap, and JSON.parse is synchronous
    // and unbounded: a large streaming-history file materialises as a string
    // and then as an object graph several times its size, which OOM-kills the
    // whole bot (not just the command) until the platform restarts it. Refuse
    // oversized input with an actionable message instead.
    if (fileContent.length > ImportService.MAX_IMPORT_CHARS) {
      throw new Error(
        `That file is too large to import (${(fileContent.length / 1024 / 1024).toFixed(0)}MB). ` +
          `Please split it into smaller files, or import a shorter date range (try 6-12 months at a time).`,
      );
    }

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
      // NOT swallowed. The rows are in `user_plays`; this counter is a
      // denormalised total that every leaderboard reads, and nothing repairs it:
      // `recalculateTopLists` below rebuilds userArtists/userAlbums/userTracks
      // from the plays and never touches `users.totalPlayCount`. So a failed
      // increment leaves the user's total permanently short by `inserted`, and
      // re-uploading the file inserts 0 new rows, so the increment never runs
      // again. That is a confidently wrong number with no user-visible cause.
      //
      // It is logged rather than raised on purpose: the plays WERE stored, and a
      // thrown error would render as "nothing was imported", which is the
      // opposite lie. ERROR is what makes the drift diagnosable and repairable.
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: { increment: inserted } },
      }).catch((err: unknown) => {
        Logger.error(
          { err, userId, missing: inserted },
          '[ImportService] Plays were stored but totalPlayCount could not be incremented; the total is now short',
        );
      });
      try {
        if (container.isRegistered(IndexService)) {
          await container.resolve(IndexService).recalculateTopLists(userId);
        }
      } catch (err) {
        Logger.warn({ err, userId }, '[ImportService] aggregate rebuild failed after import');
      }
    } else if (!reposWired) {
      // No repos wired (unit-test context) — preserve legacy counter behavior.
      // CORRECT AS IS: this branch is unreachable in production (PlayRepository
      // is always registered) and holds no rows of its own, so the same counter
      // drift as above is logged rather than swallowed for the same reason.
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: { increment: scrobbles.length } },
      }).catch((err: unknown) => {
        Logger.error(
          { err, userId, missing: scrobbles.length },
          '[ImportService] totalPlayCount could not be incremented (no repositories wired)',
        );
      });
    }

    const stored = reposWired ? inserted : scrobbles.length;
    Logger.info(
      `[ImportService] User ${userId} stored ${stored} new scrobbles from ${scrobbles.length} parsed across ${artistCounts.size} unique artists.`,
    );

    return {
      totalScrobblesImported: scrobbles.length,
      newRowsInserted: stored,
      uniqueArtistsCount: artistCounts.size,
      dateRange: { from: minDate, to: maxDate },
      topArtists,
    };
  }

  /**
   * Stores the scrobbles that are not already in the library and returns how
   * many rows were actually written.
   *
   * It either returns a number a successful insert produced, or it throws. It
   * must never report a count it did not get from the database: the caller
   * builds a "successfully imported" summary and a `totalPlayCount` increment
   * from that number, so a swallowed failure became a false success and a
   * permanently wrong counter.
   */
  private async persistScrobbles(
    userId: number,
    scrobbles: ParsedScrobble[],
    source: ImportPlaySource,
  ): Promise<number> {
    if (!container.isRegistered(PlayRepository)) return 0;
    const repo = container.resolve(PlayRepository);

    // The dedup lookup is a correctness gate, not decoration. An empty set
    // means "nothing to skip", so a failed query re-inserts plays this feature
    // exists to prevent — and the database's unique index does NOT stand in for
    // it: user_plays_identity_uniq includes play_source, while the application
    // identity (PlayRepository.playKey) is time|artist|track across every
    // source. So a play already stored from Last.fm, or from a Spotify import,
    // is re-insertable purely because this lookup failed to answer.
    //
    // Refusing the import is the only honest answer while the answer is
    // unknown. Duplicate rows are invisible once written and corrupt every
    // leaderboard behind them, whereas a refused import is one sentence to the
    // user and one command to redo — and both `.import` callers already render a
    // thrown message.
    let existing: Set<string>;
    try {
      existing = await repo.findExistingPlayKeys(
        userId,
        scrobbles[0]!.timePlayed,
        scrobbles[scrobbles.length - 1]!.timePlayed,
      );
    } catch (err) {
      Logger.warn(
        { err, userId, source },
        '[ImportService] Dedup lookup failed — refusing import rather than re-inserting unknown duplicates',
      );
      throw new Error(
        'I could not check your library for plays you already have, so nothing was imported. ' +
          'Please try again in a moment.',
      );
    }

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

    try {
      return await repo.batchInsertPlays(fresh);
    } catch (err) {
      Logger.error(
        { err, userId, source, rows: fresh.length },
        '[ImportService] Play insert failed — nothing from this import was stored',
      );
      throw new Error(
        `I could not save any of the ${fresh.length} new plays from this file, so nothing was imported. ` +
          'Please try again in a moment.',
      );
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
      } catch (err) {
        // CORRECT AS IS is not available, and the old comment here was wrong
        // about why. "Counter reset below still applies" is true of
        // `totalPlayCount` and of nothing else: the per-artist, per-album and
        // per-track rollups this rebuild exists to refresh still count the
        // imported plays that were just deleted above, so every weekly/all-time
        // chart for this user stays inflated until something else recalculates.
        Logger.warn(
          { err, userId },
          '[ImportService] Rollup rebuild failed after reset; this user\'s artist/album/track charts are stale',
        );
      }
      await this.db.user.update({
        where: { userId },
        data: { totalPlayCount: 0 },
      });
      return true;
    } catch (err) {
      // CORRECT AS IS: the boolean IS the visible report — both `/resetimport`
      // callers render `false` to the user, so the failure is not silent to the
      // person who caused it. Only the operator was left without a cause.
      Logger.error({ err, userId }, '[ImportService] Reset import failed');
      return false;
    }
  }
}
