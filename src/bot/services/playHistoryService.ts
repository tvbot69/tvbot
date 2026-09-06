import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { IPlayRepository } from '@domain/interfaces/iplayRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { GenreService } from './genreService';
import { CountryService } from './countryService';

const LAST_LISTENED_EXCLUSION_MS = 30 * 60 * 1000; // 30 minutes

export interface DiscoveryDateResult {
  artistFirstPlay: { timePlayed: Date; albumName: string | null; trackName: string | null } | null;
  albumFirstPlayDate: Date | null;
  trackFirstPlayDate: Date | null;
}

export interface LastListenedDateResult {
  artistLastPlay: { timePlayed: Date; albumName: string | null; trackName: string | null } | null;
  albumLastPlayDate: Date | null;
  trackLastPlayDate: Date | null;
}

export interface YearOverviewData {
  year: number;
  totalPlays: number;
  totalArtists: number;
  topArtists: Array<{ name: string; playcount: number }>;
  topTracks: Array<{ trackName: string; artistName: string; playcount: number }>;
  topAlbums: Array<{ albumName: string; artistName: string; playcount: number }>;
  topGenres: Array<{ name: string; playcount: number }>;
  topCountries: Array<{ countryName: string; countryCode: string; playcount: number }>;
  monthlyPlays: number[];
  previousTotalPlays?: number;
}

export interface GuildLeaderboardEntry {
  discordUserId: string;
  userNameLastFm: string;
  displayName?: string;
  value: number;
}

@injectable()
export class PlayHistoryService {
  constructor(
    @inject('IPlayRepository') private readonly playRepository: IPlayRepository,
    @inject('ILastfmRepository') private readonly lastfmRepository: ILastfmRepository,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
    @inject(GenreService) private readonly genreService?: GenreService,
    @inject(CountryService) private readonly countryService?: CountryService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getRecentArtistPlaycounts(
    userId: number,
    artistName: string,
  ): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName);
  }

  public async getRecentAlbumPlaycounts(
    userId: number,
    artistName: string,
    albumName: string,
  ): Promise<{ week: number; month: number }> {
    return this.playRepository.getRecentEntityPlaycounts(userId, artistName, albumName);
  }

  public async getRecentTrackPlaycounts(
    userId: number,
    artistName: string,
    trackName: string,
  ): Promise<{ week: number; month: number }> {
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

  public async getDiscoveryDates(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<DiscoveryDateResult> {
    const artistFirstPlay = await this.playRepository.getEntityFirstPlay(userId, artistName);

    let effectiveAlbum = albumName ?? null;
    let effectiveTrack = trackName ?? null;

    if (artistFirstPlay) {
      if (!effectiveAlbum && artistFirstPlay.albumName) {
        effectiveAlbum = artistFirstPlay.albumName;
      }
      if (!effectiveTrack && artistFirstPlay.trackName) {
        effectiveTrack = artistFirstPlay.trackName;
      }
    }

    const albumFirstPlayDate = effectiveAlbum
      ? await this.playRepository.getEntityFirstPlayDate(userId, artistName, effectiveAlbum, null)
      : null;

    const trackFirstPlayDate = effectiveTrack
      ? await this.playRepository.getEntityFirstPlayDate(userId, artistName, null, effectiveTrack)
      : null;

    return {
      artistFirstPlay,
      albumFirstPlayDate,
      trackFirstPlayDate,
    };
  }

  public async getLastListenedDates(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<LastListenedDateResult> {
    const cutoff = new Date(Date.now() - LAST_LISTENED_EXCLUSION_MS);

    const artistLastPlay = await this.playRepository.getEntityLastPlay(userId, artistName, cutoff);

    let effectiveAlbum = albumName ?? null;
    let effectiveTrack = trackName ?? null;

    if (artistLastPlay) {
      if (!effectiveAlbum && artistLastPlay.albumName) {
        effectiveAlbum = artistLastPlay.albumName;
      }
      if (!effectiveTrack && artistLastPlay.trackName) {
        effectiveTrack = artistLastPlay.trackName;
      }
    }

    const albumLastPlayDate = effectiveAlbum
      ? await this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, effectiveAlbum, null)
      : null;

    const trackLastPlayDate = effectiveTrack
      ? await this.playRepository.getEntityLastPlayDate(userId, artistName, cutoff, null, effectiveTrack)
      : null;

    return {
      artistLastPlay,
      albumLastPlayDate,
      trackLastPlayDate,
    };
  }

  public async getScrobbleCountFromDate(
    userName: string,
    from?: number | null,
    sessionKey?: string | null,
    to?: number | null,
  ): Promise<number | null> {
    return this.lastfmRepository.getScrobbleCountFromDate(userName, from, sessionKey, to);
  }

  public async getMilestoneScrobble(
    userName: string,
    sessionKey: string | null,
    totalScrobbles: number,
    milestone: number,
  ): Promise<RecentTrack | null> {
    return this.lastfmRepository.getMilestoneScrobble(userName, sessionKey, totalScrobbles, milestone);
  }

  public async getArtistPlaycountForDays(
    userId: number,
    artistName: string,
    days: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86400 * 1000);
    try {
      return await this.db.userPlay.count({
        where: {
          userId,
          timePlayed: { gte: cutoff },
          artistName: { equals: artistName, mode: 'insensitive' },
        },
      });
    } catch {
      return 0;
    }
  }

  public async getYearOverview(userId: number, year: number): Promise<YearOverviewData> {
    const startDate = new Date(Date.UTC(year, 0, 1));
    const endDate = new Date(Date.UTC(year + 1, 0, 1));
    const prevStartDate = new Date(Date.UTC(year - 1, 0, 1));

    // Top Artists
    const artistsRaw = await this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
      SELECT artist_name, COUNT(*)::bigint AS playcount
      FROM user_plays
      WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
      GROUP BY artist_name
      ORDER BY playcount DESC
      LIMIT 10
    `, userId, startDate, endDate).catch(() => []);

    // Top Tracks
    const tracksRaw = await this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
      SELECT COALESCE(track_name, 'Unknown Track') AS track_name, artist_name, COUNT(*)::bigint AS playcount
      FROM user_plays
      WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
      GROUP BY track_name, artist_name
      ORDER BY playcount DESC
      LIMIT 10
    `, userId, startDate, endDate).catch(() => []);

    // Top Albums
    const albumsRaw = await this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
      SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
      FROM user_plays
      WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
        AND time_played >= $2 AND time_played < $3
      GROUP BY album_name, artist_name
      ORDER BY playcount DESC
      LIMIT 10
    `, userId, startDate, endDate).catch(() => []);

    // Total plays & distinct artists
    const totalsRaw = await this.db.$queryRawUnsafe<Array<{ total_plays: bigint; total_artists: bigint }>>(`
      SELECT COUNT(*)::bigint AS total_plays, COUNT(DISTINCT LOWER(artist_name))::bigint AS total_artists
      FROM user_plays
      WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
    `, userId, startDate, endDate).catch(() => []);

    // Previous year total
    const prevTotalsRaw = await this.db.$queryRawUnsafe<Array<{ total_plays: bigint }>>(`
      SELECT COUNT(*)::bigint AS total_plays
      FROM user_plays
      WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
    `, userId, prevStartDate, startDate).catch(() => []);

    // Monthly breakdown (1-12)
    const monthlyRaw = await this.db.$queryRawUnsafe<Array<{ month: number; count: bigint }>>(`
      SELECT EXTRACT(MONTH FROM time_played)::int AS month, COUNT(*)::bigint AS count
      FROM user_plays
      WHERE user_id = $1 AND time_played >= $2 AND time_played < $3
      GROUP BY month
      ORDER BY month ASC
    `, userId, startDate, endDate).catch(() => []);

    const monthlyPlays = new Array(12).fill(0);
    for (const m of monthlyRaw) {
      if (m.month >= 1 && m.month <= 12) {
        monthlyPlays[m.month - 1] = Number(m.count);
      }
    }

    const topArtists = artistsRaw.map(a => ({ name: a.artist_name, playcount: Number(a.playcount) }));
    const topTracks = tracksRaw.map(t => ({ trackName: t.track_name, artistName: t.artist_name, playcount: Number(t.playcount) }));
    const topAlbums = albumsRaw.map(al => ({ albumName: al.album_name, artistName: al.artist_name, playcount: Number(al.playcount) }));
    const totalPlays = Number(totalsRaw[0]?.total_plays ?? 0);
    const totalArtists = Number(totalsRaw[0]?.total_artists ?? 0);
    const previousTotalPlays = Number(prevTotalsRaw[0]?.total_plays ?? 0);

    let topGenres: Array<{ name: string; playcount: number }> = [];
    if (this.genreService && topArtists.length > 0) {
      const genreItems = await this.genreService.getTopGenresForTopArtists(topArtists);
      topGenres = genreItems.slice(0, 8).map(g => ({ name: g.genreName, playcount: g.userPlaycount }));
    }

    let topCountries: Array<{ countryName: string; countryCode: string; playcount: number }> = [];
    if (this.countryService && topArtists.length > 0) {
      const countryItems = await this.countryService.getTopCountriesForTopArtists(topArtists);
      topCountries = countryItems.slice(0, 8).map(c => ({
        countryName: c.countryName,
        countryCode: c.countryCode,
        playcount: c.playcount,
      }));
    }

    return {
      year,
      totalPlays,
      totalArtists,
      topArtists,
      topTracks,
      topAlbums,
      topGenres,
      topCountries,
      monthlyPlays,
      previousTotalPlays,
    };
  }

  public async getGuildPlayLeaderboard(guildId: string): Promise<GuildLeaderboardEntry[]> {
    const raw = await this.db.$queryRawUnsafe<Array<{
      discord_user_id: bigint;
      user_name_last_fm: string;
      display_name: string | null;
      playcount: bigint;
    }>>(`
      SELECT u.discord_user_id, u.user_name_last_fm, u.user_name_last_fm AS display_name, COUNT(p.user_play_id)::bigint AS playcount
      FROM guild_users gu
      JOIN users u ON u.user_id = gu.user_id
      JOIN user_plays p ON p.user_id = u.user_id
      WHERE gu.guild_id = $1::bigint
      GROUP BY u.discord_user_id, u.user_name_last_fm
      ORDER BY playcount DESC
      LIMIT 100
    `, guildId).catch(() => []);

    return raw.map(r => ({
      discordUserId: r.discord_user_id.toString(),
      userNameLastFm: r.user_name_last_fm,
      displayName: r.display_name ?? r.user_name_last_fm,
      value: Number(r.playcount),
    }));
  }

  public async getGuildTimeLeaderboard(guildId: string): Promise<GuildLeaderboardEntry[]> {
    const raw = await this.db.$queryRawUnsafe<Array<{
      discord_user_id: bigint;
      user_name_last_fm: string;
      display_name: string | null;
      total_minutes: bigint;
    }>>(`
      SELECT u.discord_user_id, u.user_name_last_fm, u.user_name_last_fm AS display_name,
        ROUND(SUM(COALESCE(p.ms_played, 210000)) / 60000)::bigint AS total_minutes
      FROM guild_users gu
      JOIN users u ON u.user_id = gu.user_id
      JOIN user_plays p ON p.user_id = u.user_id
      WHERE gu.guild_id = $1::bigint
      GROUP BY u.discord_user_id, u.user_name_last_fm
      ORDER BY total_minutes DESC
      LIMIT 100
    `, guildId).catch(() => []);

    return raw.map(r => ({
      discordUserId: r.discord_user_id.toString(),
      userNameLastFm: r.user_name_last_fm,
      displayName: r.display_name ?? r.user_name_last_fm,
      value: Number(r.total_minutes),
    }));
  }
}
