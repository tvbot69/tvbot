import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { IPlayRepository } from '@domain/interfaces/iplayRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { GenreService } from './genreService';
import { CountryService } from './countryService';
import { StreakService, type StreakModel, getEmojiForStreakCount } from './streakService';

export interface DayOverview {
  date: string; // YYYY-MM-DD
  playcount: number;
  listeningTimeMinutes: number;
  topArtist?: { name: string; playcount: number };
  topAlbum?: { name: string; artist: string; playcount: number };
  topTrack?: { name: string; artist: string; playcount: number };
  topGenres: Array<{ name: string; playcount: number }>;
}

export interface DailyOverview {
  days: DayOverview[];
  totalPlays: number;
  totalListeningTimeMinutes: number;
  averagePlaysPerDay: number;
}

export interface ListeningGap {
  startDate: Date;
  endDate: Date;
  durationDays: number;
  durationHours: number;
  beforeTrack?: { name: string; artist: string };
  afterTrack?: { name: string; artist: string };
}

export interface PaceOverview {
  dailyAverage: number;
  weeklyAverage: number;
  monthlyAverage: number;
  projectedYearEndPlays: number;
  daysToNextMilestone: number;
  nextMilestone: number;
  daysActive: number;
}

@injectable()
export class PlayService {
  constructor(
    @inject('IPlayRepository') private readonly playRepository: IPlayRepository,
    @inject('ILastfmRepository') private readonly lastfmRepository: ILastfmRepository,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
    @inject(GenreService) private readonly genreService?: GenreService,
    @inject(CountryService) private readonly countryService?: CountryService,
    @inject(StreakService) private readonly streakService?: StreakService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  // --- Playcount lookups ---
  public async getRecentArtistPlaycounts(userId: number, artistName: string): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName);
  }

  public async getRecentAlbumPlaycounts(userId: number, artistName: string, albumName: string): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName, albumName);
  }

  public async getRecentTrackPlaycounts(userId: number, artistName: string, trackName: string): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName, null, trackName);
  }

  public async getArtistTotalPlays(userId: number, artistName: string): Promise<number> {
    return this.playRepository.getEntityTotalPlaycount(userId, artistName);
  }

  public async getAlbumTotalPlays(userId: number, artistName: string, albumName: string): Promise<number> {
    return this.playRepository.getEntityTotalPlaycount(userId, artistName, albumName);
  }

  public async getTrackTotalPlays(userId: number, artistName: string, trackName: string): Promise<number> {
    return this.playRepository.getEntityTotalPlaycount(userId, artistName, null, trackName);
  }

  // --- Discovery dates (First & Last Listen) ---
  public async getArtistFirstPlayDate(userId: number, artistName: string): Promise<Date | null> {
    return this.playRepository.getEntityFirstPlayDate(userId, artistName);
  }

  public async getArtistLastPlayDate(userId: number, artistName: string, cutoff: Date = new Date(Date.now() - 30 * 60 * 1000)): Promise<Date | null> {
    return this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff);
  }

  public async getAlbumFirstPlayDate(userId: number, artistName: string, albumName: string): Promise<Date | null> {
    return this.playRepository.getEntityFirstPlayDate(userId, artistName, albumName);
  }

  public async getAlbumLastPlayDate(userId: number, artistName: string, albumName: string, cutoff: Date = new Date(Date.now() - 30 * 60 * 1000)): Promise<Date | null> {
    return this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, albumName);
  }

  public async getTrackFirstPlayDate(userId: number, artistName: string, trackName: string): Promise<Date | null> {
    return this.playRepository.getEntityFirstPlayDate(userId, artistName, null, trackName);
  }

  public async getTrackLastPlayDate(userId: number, artistName: string, trackName: string, cutoff: Date = new Date(Date.now() - 30 * 60 * 1000)): Promise<Date | null> {
    return this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, null, trackName);
  }

  // --- Streaks ---
  public async getCurrentStreak(userId: number, userNameLastFm: string, sessionKey?: string | null): Promise<StreakModel | null> {
    if (this.streakService) {
      return this.streakService.getCurrentStreak(userId, userNameLastFm, sessionKey);
    }
    return null;
  }

  // --- Daily Overview grouped by user timezone ---
  public async getDailyOverview(userId: number, timeZone: string = 'UTC', amountOfDays: number = 7): Promise<DailyOverview> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - amountOfDays);

    const plays = await this.db.userPlay.findMany({
      where: {
        userId,
        timePlayed: { gte: startDate },
      },
      orderBy: { timePlayed: 'asc' },
    });

    const dayMap = new Map<string, Array<{ artistName: string; albumName?: string | null; trackName: string; duration: number }>>();

    for (const play of plays) {
      const dateKey = this.formatDateInTimeZone(play.timePlayed, timeZone);
      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, []);
      }
      dayMap.get(dateKey)!.push({
        artistName: play.artistName,
        albumName: play.albumName,
        trackName: play.trackName ?? 'Unknown Track',
        duration: play.msPlayed ? Math.round(play.msPlayed / 1000) : 210, // default 3.5 minutes if unset
      });
    }

    const days: DayOverview[] = [];
    let totalPlays = 0;
    let totalListeningTimeMinutes = 0;

    for (const [date, dayPlays] of dayMap.entries()) {
      const playcount = dayPlays.length;
      totalPlays += playcount;

      const durationSeconds = dayPlays.reduce((acc, p) => acc + p.duration, 0);
      const listeningTimeMinutes = Math.round(durationSeconds / 60);
      totalListeningTimeMinutes += listeningTimeMinutes;

      // Top Artist
      const artistCounts = new Map<string, number>();
      for (const p of dayPlays) artistCounts.set(p.artistName, (artistCounts.get(p.artistName) ?? 0) + 1);
      let topArtist: { name: string; playcount: number } | undefined;
      for (const [name, count] of artistCounts) {
        if (!topArtist || count > topArtist.playcount) topArtist = { name, playcount: count };
      }

      // Top Album
      const albumCounts = new Map<string, { artist: string; count: number }>();
      for (const p of dayPlays) {
        if (p.albumName) {
          const key = `${p.artistName}:::${p.albumName}`;
          const current = albumCounts.get(key) ?? { artist: p.artistName, count: 0 };
          current.count++;
          albumCounts.set(key, current);
        }
      }
      let topAlbum: { name: string; artist: string; playcount: number } | undefined;
      for (const [key, val] of albumCounts) {
        const albumName = key.split(':::')[1]!;
        if (!topAlbum || val.count > topAlbum.playcount) {
          topAlbum = { name: albumName, artist: val.artist, playcount: val.count };
        }
      }

      // Top Track
      const trackCounts = new Map<string, { artist: string; count: number }>();
      for (const p of dayPlays) {
        const key = `${p.artistName}:::${p.trackName}`;
        const current = trackCounts.get(key) ?? { artist: p.artistName, count: 0 };
        current.count++;
        trackCounts.set(key, current);
      }
      let topTrack: { name: string; artist: string; playcount: number } | undefined;
      for (const [key, val] of trackCounts) {
        const trackName = key.split(':::')[1]!;
        if (!topTrack || val.count > topTrack.playcount) {
          topTrack = { name: trackName, artist: val.artist, playcount: val.count };
        }
      }

      days.push({
        date,
        playcount,
        listeningTimeMinutes,
        topArtist,
        topAlbum,
        topTrack,
        topGenres: [],
      });
    }

    const averagePlaysPerDay = days.length > 0 ? Math.round(totalPlays / days.length) : 0;

    return {
      days,
      totalPlays,
      totalListeningTimeMinutes,
      averagePlaysPerDay,
    };
  }

  // --- Listening Gaps ---
  public async getListeningGaps(userId: number, minimumGapHours: number = 24, limit: number = 10): Promise<ListeningGap[]> {
    const plays = await this.db.userPlay.findMany({
      where: { userId },
      select: { timePlayed: true, trackName: true, artistName: true },
      orderBy: { timePlayed: 'asc' },
    });

    if (plays.length < 2) {
      return [];
    }

    const gaps: ListeningGap[] = [];
    const minGapMs = minimumGapHours * 60 * 60 * 1000;

    for (let i = 0; i < plays.length - 1; i++) {
      const current = plays[i]!;
      const next = plays[i + 1]!;
      const diffMs = next.timePlayed.getTime() - current.timePlayed.getTime();

      if (diffMs >= minGapMs) {
        const durationHours = Math.round(diffMs / (1000 * 60 * 60));
        const durationDays = +(diffMs / (1000 * 60 * 60 * 24)).toFixed(1);

        gaps.push({
          startDate: current.timePlayed,
          endDate: next.timePlayed,
          durationDays,
          durationHours,
          beforeTrack: { name: current.trackName ?? 'Unknown Track', artist: current.artistName },
          afterTrack: { name: next.trackName ?? 'Unknown Track', artist: next.artistName },
        });
      }
    }

    // Sort descending by duration
    return gaps.sort((a, b) => b.durationHours - a.durationHours).slice(0, limit);
  }

  // --- Pace & Velocity Projections ---
  public async getPace(userId: number, totalScrobbles: number, registeredDate?: Date | null): Promise<PaceOverview> {
    const regDate = registeredDate ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const totalDays = Math.max(1, Math.ceil((Date.now() - regDate.getTime()) / (1000 * 60 * 60 * 24)));

    const dailyAverage = +(totalScrobbles / totalDays).toFixed(1);
    const weeklyAverage = +(dailyAverage * 7).toFixed(1);
    const monthlyAverage = +(dailyAverage * 30.4).toFixed(1);

    // Projected year-end plays (scrobbles by Dec 31)
    const now = new Date();
    const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
    const daysLeftInYear = Math.max(0, Math.ceil((endOfYear.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const projectedYearEndPlays = Math.round(totalScrobbles + daysLeftInYear * dailyAverage);

    // Next milestone
    let nextMilestone = 1000;
    if (totalScrobbles >= 100000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 50000) * 50000;
    } else if (totalScrobbles >= 10000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 10000) * 10000;
    } else if (totalScrobbles >= 1000) {
      nextMilestone = Math.ceil((totalScrobbles + 1) / 1000) * 1000;
    }
    const playsRemaining = Math.max(0, nextMilestone - totalScrobbles);
    const daysToNextMilestone = dailyAverage > 0 ? Math.ceil(playsRemaining / dailyAverage) : 0;

    return {
      dailyAverage,
      weeklyAverage,
      monthlyAverage,
      projectedYearEndPlays,
      daysToNextMilestone,
      nextMilestone,
      daysActive: totalDays,
    };
  }

  // --- Streak candidate engine matching C# SeedGenreStreakCandidates & WalkGenreStreak ---
  public static seedGenreStreakCandidates(seedGenres: string[], streakStarted: Date): Array<{
    genreName: string;
    playcount: number;
    alive: boolean;
    streakStarted: Date;
  }> {
    if (!seedGenres || seedGenres.length === 0) return [];
    return Array.from(new Set(seedGenres)).map((genreName) => ({
      genreName,
      playcount: 1,
      alive: true,
      streakStarted,
    }));
  }

  public static walkGenreStreak(
    plays: Array<{ artistId?: number | null; timePlayed: Date }>,
    candidates: Array<{ genreName: string; playcount: number; alive: boolean; streakStarted: Date }>,
    genreMap: Map<number, string[]>,
  ): boolean {
    if (candidates.length === 0) return false;

    for (const play of plays) {
      const genres = play.artistId ? genreMap.get(play.artistId) : null;
      const playGenres = genres ? new Set(genres.map((g) => g.toLowerCase())) : null;

      let anyAlive = false;
      for (const candidate of candidates) {
        if (!candidate.alive) continue;

        if (playGenres && playGenres.has(candidate.genreName.toLowerCase())) {
          candidate.playcount++;
          if (play.timePlayed < candidate.streakStarted) {
            candidate.streakStarted = play.timePlayed;
          }
          anyAlive = true;
        } else {
          candidate.alive = false;
        }
      }

      if (!anyAlive) return false;
    }

    return true;
  }

  public async applyGenreStreaks(
    streak: StreakModel,
    lastPlay: RecentTrack,
    lastPlays: Array<{ artistId?: number | null; artistName: string; timePlayed: Date }>,
  ): Promise<void> {
    if (!streak || !lastPlay?.artistName || lastPlays.length === 0 || !this.genreService) {
      return;
    }

    try {
      const seedGenres = await this.genreService.getGenresForArtist(lastPlay.artistName);
      const candidates = PlayService.seedGenreStreakCandidates(
        seedGenres,
        lastPlay.timePlayed ?? new Date(),
      );
      if (candidates.length === 0) return;

      const genreMap = new Map<number, string[]>();
      PlayService.walkGenreStreak(lastPlays, candidates, genreMap);

      const qualifying = candidates
        .filter((c) => c.playcount >= 2)
        .sort((a, b) => b.playcount - a.playcount);

      if (qualifying.length > 0) {
        const topGenre = qualifying[0]!;
        streak.genreName = topGenre.genreName;
        streak.genrePlaycount = topGenre.playcount;
      }
    } catch {
      // ignore
    }
  }

  public static streakExists(streak: StreakModel | null): boolean {
    if (!streak) return false;
    return streak.artistPlaycount > 1 || streak.albumPlaycount > 1 || streak.trackPlaycount > 1 || (streak.genrePlaycount ?? 0) > 1;
  }

  public static shouldSaveStreak(streak: StreakModel): boolean {
    if (!PlayService.streakExists(streak)) return false;
    return streak.artistPlaycount >= 10 || streak.albumPlaycount >= 5 || streak.trackPlaycount >= 3 || (streak.genrePlaycount ?? 0) >= 15;
  }

  public static streakToText(streak: StreakModel, _includeStart: boolean = true): string {
    const lines: string[] = [];
    if (streak.artistPlaycount > 1) {
      lines.push(`${streak.emoji ? streak.emoji + ' ' : ''}**${streak.artistName}** (${streak.artistPlaycount} plays in a row)`);
    }
    if (streak.albumPlaycount > 1 && streak.albumName) {
      lines.push(`💿 **${streak.albumName}** (${streak.albumPlaycount} plays in a row)`);
    }
    if (streak.trackPlaycount > 1) {
      lines.push(`🎵 **${streak.trackName}** (${streak.trackPlaycount} plays in a row)`);
    }
    if (streak.genreName && (streak.genrePlaycount ?? 0) > 1) {
      lines.push(`🎸 **${streak.genreName}** (${streak.genrePlaycount} plays in a row)`);
    }
    return lines.join('\n') || 'No active streak';
  }

  // --- Year Review & Stats ---
  public static getUniqueCount(plays: Array<{ artistName: string; trackName?: string | null }>): number {
    const set = new Set(plays.map((p) => `${p.artistName.toLowerCase()}|${(p.trackName ?? '').toLowerCase()}`));
    return set.size;
  }

  public static getAvgPerDayCount(days: DayOverview[]): number {
    return days.length !== 0 ? +(days.reduce((a, b) => a + b.playcount, 0) / days.length).toFixed(1) : 0;
  }

  public static getTopTrackForPlays(plays: Array<{ artistName: string; trackName?: string | null }>): string {
    const counts = new Map<string, number>();
    for (const p of plays) {
      if (p.trackName) {
        const key = `${p.artistName} - ${p.trackName}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let top = 'No top track';
    let max = 0;
    for (const [k, v] of counts) {
      if (v > max) {
        max = v;
        top = `${k} — *${v} plays*`;
      }
    }
    return top;
  }

  public static getTopAlbumForPlays(plays: Array<{ artistName: string; albumName?: string | null }>): string {
    const counts = new Map<string, number>();
    for (const p of plays) {
      if (p.albumName) {
        const key = `${p.artistName} - ${p.albumName}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let top = 'No top album';
    let max = 0;
    for (const [k, v] of counts) {
      if (v > max) {
        max = v;
        top = `${k} — *${v} plays*`;
      }
    }
    return top;
  }

  public static getTopArtistForPlays(plays: Array<{ artistName: string }>): string {
    const counts = new Map<string, number>();
    for (const p of plays) {
      counts.set(p.artistName, (counts.get(p.artistName) ?? 0) + 1);
    }
    let top = 'No top artist';
    let max = 0;
    for (const [k, v] of counts) {
      if (v > max) {
        max = v;
        top = `${k} — *${v} plays*`;
      }
    }
    return top;
  }

  public async getYear(userId: number, year: number): Promise<{
    year: number;
    totalPlays: number;
    totalArtists: number;
    topArtists: Array<{ name: string; playcount: number }>;
    topTracks: Array<{ trackName: string; artistName: string; playcount: number }>;
    topAlbums: Array<{ albumName: string; artistName: string; playcount: number }>;
  }> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));

    const [artistsRaw, tracksRaw, albumsRaw, totalsRaw] = await Promise.all([
      this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
        GROUP BY artist_name
        ORDER BY playcount DESC
        LIMIT 10
      `, userId, start, end).catch(() => []),
      this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT COALESCE(track_name, 'Unknown Track') AS track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT 10
      `, userId, start, end).catch(() => []),
      this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != '' AND time_played >= $2 AND time_played < $3
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT 10
      `, userId, start, end).catch(() => []),
      this.db.$queryRawUnsafe<Array<{ total_plays: bigint; total_artists: bigint }>>(`
        SELECT COUNT(*)::bigint AS total_plays, COUNT(DISTINCT LOWER(artist_name))::bigint AS total_artists
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
      `, userId, start, end).catch(() => []),
    ]);

    return {
      year,
      totalPlays: totalsRaw[0] ? Number(totalsRaw[0].total_plays) : 0,
      totalArtists: totalsRaw[0] ? Number(totalsRaw[0].total_artists) : 0,
      topArtists: artistsRaw.map((a) => ({ name: a.artist_name, playcount: Number(a.playcount) })),
      topTracks: tracksRaw.map((t) => ({ trackName: t.track_name, artistName: t.artist_name, playcount: Number(t.playcount) })),
      topAlbums: albumsRaw.map((al) => ({ albumName: al.album_name, artistName: al.artist_name, playcount: Number(al.playcount) })),
    };
  }

  // --- Guild aggregation methods ---
  public async getGuildUsersPlays(guildId: string, amountOfDays: number = 7): Promise<any[]> {
    const cutoff = new Date(Date.now() - amountOfDays * 24 * 3600 * 1000);
    try {
      return await this.db.userPlay.findMany({
        where: {
          timePlayed: { gte: cutoff },
          user: {
            guildUsers: {
              some: { guildId: BigInt(guildId) },
            },
          },
        },
        take: 5000,
      });
    } catch {
      return [];
    }
  }

  public async getGuildTopTracksPlays(guildId: string, startDateTime: Date, endDateTime: Date): Promise<Array<{ trackName: string; artistName: string; playcount: number; listeners: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{
        track_name: string;
        artist_name: string;
        playcount: bigint;
        listeners: bigint;
      }>>(`
        SELECT up.track_name, up.artist_name, COUNT(*)::bigint AS playcount, COUNT(DISTINCT up.user_id)::bigint AS listeners
        FROM user_plays up
        INNER JOIN guild_users gu ON up.user_id = gu.user_id
        INNER JOIN users u ON u.user_id = up.user_id AND u.privacy_level <> 'Hide'
        WHERE gu.guild_id = $1 AND up.time_played >= $2 AND up.time_played <= $3 AND up.track_name IS NOT NULL
          AND NOT gu.who_knows_banned AND NOT gu.self_block_from_who_knows
        GROUP BY up.track_name, up.artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, BigInt(guildId), startDateTime, endDateTime);

      return rows.map((r) => ({
        trackName: r.track_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
        listeners: Number(r.listeners),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildTopArtistsPlays(guildId: string, startDateTime: Date, endDateTime: Date): Promise<Array<{ artistName: string; playcount: number; listeners: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{
        artist_name: string;
        playcount: bigint;
        listeners: bigint;
      }>>(`
        SELECT up.artist_name, COUNT(*)::bigint AS playcount, COUNT(DISTINCT up.user_id)::bigint AS listeners
        FROM user_plays up
        INNER JOIN guild_users gu ON up.user_id = gu.user_id
        INNER JOIN users u ON u.user_id = up.user_id AND u.privacy_level <> 'Hide'
        WHERE gu.guild_id = $1 AND up.time_played >= $2 AND up.time_played <= $3
          AND NOT gu.who_knows_banned AND NOT gu.self_block_from_who_knows
        GROUP BY up.artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, BigInt(guildId), startDateTime, endDateTime);

      return rows.map((r) => ({
        artistName: r.artist_name,
        playcount: Number(r.playcount),
        listeners: Number(r.listeners),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildTopAlbumsPlays(guildId: string, startDateTime: Date, endDateTime: Date): Promise<Array<{ albumName: string; artistName: string; playcount: number; listeners: number }>> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{
        album_name: string;
        artist_name: string;
        playcount: bigint;
        listeners: bigint;
      }>>(`
        SELECT up.album_name, up.artist_name, COUNT(*)::bigint AS playcount, COUNT(DISTINCT up.user_id)::bigint AS listeners
        FROM user_plays up
        INNER JOIN guild_users gu ON up.user_id = gu.user_id
        INNER JOIN users u ON u.user_id = up.user_id AND u.privacy_level <> 'Hide'
        WHERE gu.guild_id = $1 AND up.time_played >= $2 AND up.time_played <= $3 AND up.album_name IS NOT NULL AND up.album_name != ''
          AND NOT gu.who_knows_banned AND NOT gu.self_block_from_who_knows
        GROUP BY up.album_name, up.artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, BigInt(guildId), startDateTime, endDateTime);

      return rows.map((r) => ({
        albumName: r.album_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
        listeners: Number(r.listeners),
      }));
    } catch {
      return [];
    }
  }

  public async getArtistFirstPlay(userId: number, artistName: string): Promise<{ timePlayed: Date; albumName?: string | null; trackName?: string | null } | null> {
    try {
      const play = await this.db.userPlay.findFirst({
        where: {
          userId,
          artistName: { equals: artistName, mode: 'insensitive' },
        },
        orderBy: { timePlayed: 'asc' },
        select: { timePlayed: true, albumName: true, trackName: true },
      });
      return play ?? null;
    } catch {
      return null;
    }
  }

  public async getArtistLastPlay(userId: number, artistName: string): Promise<{ timePlayed: Date; albumName?: string | null; trackName?: string | null } | null> {
    try {
      const play = await this.db.userPlay.findFirst({
        where: {
          userId,
          artistName: { equals: artistName, mode: 'insensitive' },
        },
        orderBy: { timePlayed: 'desc' },
        select: { timePlayed: true, albumName: true, trackName: true },
      });
      return play ?? null;
    } catch {
      return null;
    }
  }

  public async hasPlayNearTimestamp(userId: number, timestamp: Date, secondsRange: number = 30): Promise<boolean> {
    try {
      const start = new Date(timestamp.getTime() - secondsRange * 1000);
      const end = new Date(timestamp.getTime() + secondsRange * 1000);
      const count = await this.db.userPlay.count({
        where: {
          userId,
          timePlayed: { gte: start, lte: end },
        },
      });
      return count > 0;
    } catch {
      return false;
    }
  }

  public async getCachedPlaysForUser(userId: number, limit: number = 120): Promise<any[]> {
    try {
      return await this.db.userPlay.findMany({
        where: { userId },
        orderBy: { timePlayed: 'desc' },
        take: limit,
      });
    } catch {
      return [];
    }
  }

  public async moveData(oldUserId: number, newUserId: number): Promise<void> {
    try {
      await this.db.userPlay.updateMany({
        where: { userId: oldUserId },
        data: { userId: newUserId },
      });
    } catch {
      // ignore
    }
  }

  private formatDateInTimeZone(date: Date, timeZone: string): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(date); // outputs YYYY-MM-DD
    } catch {
      return date.toISOString().split('T')[0]!;
    }
  }
}

// Backwards compatibility alias
export { PlayService as PlayHistoryService };
