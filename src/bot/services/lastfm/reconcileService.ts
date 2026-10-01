import { prisma } from '@persistence/prismaClient';
import { Logger } from '@domain/logger';
import type { IndexService } from './indexService';

export interface ReconcileUserResult {
  userId: number;
  action: 'healthy' | 'healed-aggregates' | 'escalated-full-index';
  artistDrift: number;
  historyGap: number;
}

export interface ReconcileReport {
  checkedUsers: number;
  healedUsers: number;
  escalatedUsers: number;
  entityDupes: { artists: number; albums: number; tracks: number };
  details: ReconcileUserResult[];
}

/**
 * Nightly data-integrity sweep. Aggregates (user_artists/albums/tracks) are
 * derived state maintained by several writers — every historical playcount
 * bug in this codebase was silent divergence between layers, never a crash.
 * This job compares the layers per user and heals:
 *  - aggregate-vs-raw drift (SUM aggregates vs COUNT plays) → rebuild via
 *    recalculateTopLists (idempotent, same repair as the manual heal).
 *  - missing history (local rows far below the Last.fm total) → enqueue a
 *    full index (deltas can't invent plays that were never imported).
 * Locally-imported plays (Spotify/Apple) legitimately exceed Last.fm totals
 * and are left alone. Entity duplicates reappearing mean a write-path
 * regression — logged loud, never auto-merged (merges rewrite history).
 */
export class ReconcileService {
  private static readonly ABS_TOLERANCE = 10;
  private static readonly REL_TOLERANCE = 0.02;

  constructor(private readonly indexService: IndexService) {}

  private static exceeds(actual: number, expected: number): boolean {
    return Math.abs(actual - expected) > Math.max(ReconcileService.ABS_TOLERANCE, expected * ReconcileService.REL_TOLERANCE);
  }

  public async runAsync(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checkedUsers: 0,
      healedUsers: 0,
      escalatedUsers: 0,
      entityDupes: { artists: 0, albums: 0, tracks: 0 },
      details: [],
    };

    try {
      const dupes = await prisma.$queryRaw<Array<{ artists: bigint; albums: bigint; tracks: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM (SELECT 1 FROM artists GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1) a) AS artists,
          (SELECT COUNT(*) FROM (SELECT 1 FROM albums GROUP BY artist_id, LOWER(TRIM(name)) HAVING COUNT(*) > 1) b) AS albums,
          (SELECT COUNT(*) FROM (SELECT 1 FROM tracks GROUP BY artist_id, LOWER(TRIM(name)) HAVING COUNT(*) > 1) c) AS tracks`;
      report.entityDupes = {
        artists: Number(dupes[0]?.artists ?? 0),
        albums: Number(dupes[0]?.albums ?? 0),
        tracks: Number(dupes[0]?.tracks ?? 0),
      };
      if (report.entityDupes.artists + report.entityDupes.albums + report.entityDupes.tracks > 0) {
        Logger.warn(
          { dupes: report.entityDupes },
          '[Reconcile] Duplicate entities reappearing — write-path regression, run merge-dupes',
        );
      }
    } catch (err) {
      Logger.warn({ err }, '[Reconcile] Entity-duplicate check failed');
    }

    let users: Array<{ userId: number; totalPlayCount: number | null }>;
    try {
      users = await prisma.user.findMany({ select: { userId: true, totalPlayCount: true } });
    } catch (err) {
      Logger.error({ err }, '[Reconcile] Cannot list users, aborting run');
      return report;
    }

    for (const user of users) {
      try {
        // Each aggregate is checked against its own countable base: plays
        // without an album (or track) name legitimately contribute to the
        // raw total but to no album/track aggregate.
        const [artistSum, albumSum, trackSum, rawPlays, rawAlbumPlays, rawTrackPlays] = await Promise.all([
          prisma.userArtist.aggregate({ _sum: { playcount: true }, where: { userId: user.userId } }),
          prisma.userAlbum.aggregate({ _sum: { playcount: true }, where: { userId: user.userId } }),
          prisma.userTrack.aggregate({ _sum: { playcount: true }, where: { userId: user.userId } }),
          prisma.userPlay.count({ where: { userId: user.userId } }),
          prisma.userPlay.count({ where: { userId: user.userId, albumName: { not: null } } }),
          prisma.userPlay.count({ where: { userId: user.userId, trackName: { not: null } } }),
        ]);
        if (rawPlays === 0) continue;
        report.checkedUsers++;

        const artistTotal = artistSum._sum.playcount ?? 0;
        const detail: ReconcileUserResult = {
          userId: user.userId,
          action: 'healthy',
          artistDrift: rawPlays - artistTotal,
          historyGap:
            user.totalPlayCount != null && user.totalPlayCount > rawPlays
              ? user.totalPlayCount - rawPlays
              : 0,
        };

        const albumTotal = albumSum._sum.playcount ?? 0;
        const trackTotal = trackSum._sum.playcount ?? 0;
        if (
          ReconcileService.exceeds(artistTotal, rawPlays) ||
          ReconcileService.exceeds(albumTotal, rawAlbumPlays) ||
          ReconcileService.exceeds(trackTotal, rawTrackPlays)
        ) {
          await this.indexService.recalculateTopLists(user.userId);
          detail.action = 'healed-aggregates';
          report.healedUsers++;
          Logger.warn(
            { userId: user.userId, artistTotal, albumTotal, trackTotal, rawPlays },
            '[Reconcile] Aggregate drift — rebuilt top lists',
          );
        } else if (
          user.totalPlayCount != null &&
          rawPlays < user.totalPlayCount - Math.max(20, user.totalPlayCount * 0.02)
        ) {
          const queued = this.indexService.enqueueUser(user.userId);
          detail.action = 'escalated-full-index';
          report.escalatedUsers++;
          Logger.warn(
            { userId: user.userId, rawPlays, lastfmTotal: user.totalPlayCount, queued },
            '[Reconcile] History gap vs Last.fm — enqueued full index',
          );
        }
        report.details.push(detail);
      } catch (err) {
        Logger.warn({ err, userId: user.userId }, '[Reconcile] Per-user check failed');
      }
    }

    return report;
  }
}
