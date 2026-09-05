import { GenreService } from './genreService';
import { prisma } from '@persistence/prismaClient';

export interface DailyBlock {
  date: Date;
  epochSeconds: number;
  playCount: number;
  durationMs: number;
  topArtist: string | null;
  topAlbum: string | null;
  topTrack: string | null;
  genres: string[];
  trackKeys: string[];
}

export interface OverviewResult {
  dailyBlocks: DailyBlock[];
}

/**
 * Calculates the dayKey (YYYY-MM-DD) in the specified timezone,
 * and the exact UTC epoch timestamp of midnight (00:00:00) in that timezone.
 * Mirrors fmbot TimeZoneInfo.ConvertTimeToUtc(day.Date, timeZone).ToUnixEpochDate()
 */
function getDayInfo(date: Date, timeZone: string): { dayKey: string; epochSeconds: number } {
  let dayKey: string;
  try {
    dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  const [year, month, day] = dayKey.split('-').map(Number);
  const utcTest = new Date(Date.UTC(year!, month! - 1, day!, 12, 0, 0));
  let diffMs = 0;
  try {
    const invDate = new Date(utcTest.toLocaleString('en-US', { timeZone: 'UTC' }));
    const targetDate = new Date(utcTest.toLocaleString('en-US', { timeZone }));
    diffMs = invDate.getTime() - targetDate.getTime();
  } catch {
    const invDate = new Date(utcTest.toLocaleString('en-US', { timeZone: 'UTC' }));
    const targetDate = new Date(utcTest.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    diffMs = invDate.getTime() - targetDate.getTime();
  }

  const midnightUtc = new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0) + diffMs);
  const epochSeconds = Math.floor(midnightUtc.getTime() / 1000);

  return { dayKey, epochSeconds };
}

export class OverviewService {
  constructor(
    private readonly genreService?: GenreService,
  ) {}

  public async getOverview(userNameLastFm: string, _sessionKey?: string): Promise<OverviewResult> {
    const user = await prisma.user.findFirst({ where: { userNameLastFm } });
    if (!user) return { dailyBlocks: [] };

    // Default timezone to America/New_York (Eastern Standard Time) matching fmbot PlayBuilders.cs line 1522
    const timeZone = user.timeZone || 'America/New_York';

    // Fetch up to 10000 plays covering the last 33 days (up to 8 pages of 4 days)
    const thirtyThreeDaysAgo = new Date(Date.now() - 34 * 24 * 3600 * 1000);
    const plays = await prisma.userPlay.findMany({
      where: {
        userId: user.userId,
        timePlayed: { gte: thirtyThreeDaysAgo },
      },
      orderBy: { timePlayed: 'asc' },
      take: 10000,
      select: {
        artistName: true,
        albumName: true,
        trackName: true,
        timePlayed: true,
        msPlayed: true,
      },
    });
    if (!plays || plays.length === 0) return { dailyBlocks: [] };

    // Group by calendar day in user's timezone
    const byDay = new Map<string, { plays: typeof plays; epochSeconds: number }>();
    for (const p of plays) {
      if (!p.timePlayed) continue;
      const { dayKey, epochSeconds } = getDayInfo(p.timePlayed, timeZone);
      if (!byDay.has(dayKey)) {
        byDay.set(dayKey, { plays: [], epochSeconds });
      }
      byDay.get(dayKey)!.plays.push(p);
    }

    const dailyBlocks: DailyBlock[] = [];
    const sortedDays = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 32);

    // Batch fetch genres for all artists in the overview in ONE single DB query (fmbot PlayService.cs lines 89-96)
    let genreMap = new Map<string, string[]>();
    if (this.genreService) {
      const allArtistNames = [...new Set(plays.map(p => p.artistName).filter(Boolean))];
      try {
        genreMap = await this.genreService.getGenresForArtistNames(allArtistNames);
      } catch { /* ignore */ }
    }

    for (const [dayKey, { plays: dayPlays, epochSeconds }] of sortedDays) {
      const date = new Date(dayKey + 'T00:00:00Z');
      const playCount = dayPlays.length;

      // Calculate duration: msPlayed if available, else delta to next play (if 30s-10m), else 180s fallback
      let durationMs = 0;
      const trackKeys: string[] = [];
      const artistCounts = new Map<string, number>();
      const albumCounts = new Map<string, { artist: string; album: string; count: number }>();
      const trackCounts = new Map<string, { artist: string; track: string; count: number }>();

      for (let i = 0; i < dayPlays.length; i++) {
        const p = dayPlays[i]!;
        const artist = p.artistName || 'Unknown Artist';
        const track = p.trackName || 'Unknown Track';
        const album = p.albumName || '';

        if (p.msPlayed && p.msPlayed > 0) {
          durationMs += p.msPlayed;
        } else if (i + 1 < dayPlays.length && dayPlays[i + 1]?.timePlayed && p.timePlayed) {
          const gapMs = dayPlays[i + 1]!.timePlayed.getTime() - p.timePlayed.getTime();
          if (gapMs >= 30000 && gapMs <= 600000) {
            durationMs += gapMs;
          } else {
            durationMs += 180 * 1000;
          }
        } else {
          durationMs += 180 * 1000;
        }

        trackKeys.push(`${artist}|${track}`.toLowerCase());
        artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);

        if (album) {
          const ak = `${artist}|${album}`.toLowerCase();
          const cur = albumCounts.get(ak);
          if (cur) cur.count++;
          else albumCounts.set(ak, { artist, album, count: 1 });
        }

        const tk = `${artist}|${track}`.toLowerCase();
        const curT = trackCounts.get(tk);
        if (curT) curT.count++;
        else trackCounts.set(tk, { artist, track, count: 1 });
      }

      // Top Artist, Top Album, Top Track formatted matching fmbot PlayService.cs lines 225-268
      const topArtistEntry = [...artistCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topAlbumEntry = [...albumCounts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
      const topTrackEntry = [...trackCounts.values()].sort((a, b) => b.count - a.count)[0] ?? null;

      const topArtist = topArtistEntry
        ? `${topArtistEntry[0]} — *${topArtistEntry[1]} ${topArtistEntry[1] === 1 ? 'play' : 'plays'}*`
        : null;

      const topAlbum = topAlbumEntry
        ? `${topAlbumEntry.artist} - ${topAlbumEntry.album} — *${topAlbumEntry.count} ${topAlbumEntry.count === 1 ? 'play' : 'plays'}*`
        : null;

      const topTrack = topTrackEntry
        ? `${topTrackEntry.artist} - ${topTrackEntry.track} — *${topTrackEntry.count} ${topTrackEntry.count === 1 ? 'play' : 'plays'}*`
        : null;

      // Top genres aggregated across all played artists weighted by playcount (fmbot GenreService.GetTopGenresFromPlays)
      const genreWeighted = new Map<string, number>();
      for (const [artist, count] of artistCounts.entries()) {
        const artistGenres = genreMap.get(artist.toLowerCase()) ?? [];
        for (const g of artistGenres) {
          genreWeighted.set(g, (genreWeighted.get(g) ?? 0) + count);
        }
      }
      const genres = [...genreWeighted.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(e => e[0]);

      dailyBlocks.push({
        date,
        epochSeconds,
        playCount,
        durationMs,
        topArtist,
        topAlbum,
        topTrack,
        genres,
        trackKeys,
      });
    }

    return { dailyBlocks };
  }
}

