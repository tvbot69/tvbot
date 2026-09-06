import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { GenreService } from './genreService';
import { CountryService } from './countryService';

export type GapEntityType = 'artist' | 'album' | 'track';

export interface ListeningGapItem {
  name: string;
  artistName?: string;
  resumeDate: Date;
  prevPlayed: Date;
  gapDays: number;
  totalPlays: number;
}

export interface DiscoveryItem {
  artistName: string;
  firstPlay: Date;
  playcount: number;
}

export interface IcebergTier {
  tierNumber: number;
  name: string;
  emoji: string;
  description: string;
  artists: Array<{ name: string; playcount: number; popularity?: number }>;
}

export interface IcebergData {
  displayName: string;
  userNameLastFm: string;
  timePeriodDescription: string;
  tiers: IcebergTier[];
  totalArtists: number;
}

export interface AffinityNeighbor {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  displayName?: string;
  totalPercentage: number;
  artistPercentage: number;
  genrePercentage: number;
  countryPercentage: number;
  sharedArtists: string[];
}

export interface AffinityData {
  userDisplayName: string;
  userNameLastFm: string;
  guildName: string;
  neighbors: AffinityNeighbor[];
  totalGuildUsers: number;
}

@injectable()
export class MusicIntelligenceService {
  constructor(
    @inject('ILastfmRepository') private readonly lastfmRepository: ILastfmRepository,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
    @inject(GenreService) private readonly genreService?: GenreService,
    @inject(CountryService) private readonly countryService?: CountryService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getListeningGaps(
    userId: number,
    entityType: GapEntityType,
    minGapDays: number = 90,
  ): Promise<ListeningGapItem[]> {
    if (entityType === 'artist') {
      const rows = await this.db.$queryRawUnsafe<Array<{
        name: string;
        resume_date: Date;
        prev_played: Date;
        gap_days: number;
        total_plays: bigint;
      }>>(`
        WITH ordered_plays AS (
          SELECT artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1
        ),
        gaps AS (
          SELECT artist_name AS name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays).catch(() => []);

      return rows.map((r) => ({
        name: r.name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    } else if (entityType === 'album') {
      const rows = await this.db.$queryRawUnsafe<Array<{
        name: string;
        artist_name: string;
        resume_date: Date;
        prev_played: Date;
        gap_days: number;
        total_plays: bigint;
      }>>(`
        WITH ordered_plays AS (
          SELECT album_name, artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name), LOWER(album_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name), LOWER(album_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
        ),
        gaps AS (
          SELECT album_name AS name,
                 artist_name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name), LOWER(album_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, artist_name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays).catch(() => []);

      return rows.map((r) => ({
        name: r.name,
        artistName: r.artist_name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    } else {
      const rows = await this.db.$queryRawUnsafe<Array<{
        name: string;
        artist_name: string;
        resume_date: Date;
        prev_played: Date;
        gap_days: number;
        total_plays: bigint;
      }>>(`
        WITH ordered_plays AS (
          SELECT track_name, artist_name, time_played,
                 LAG(time_played) OVER (PARTITION BY LOWER(artist_name), LOWER(track_name) ORDER BY time_played ASC) AS prev_played,
                 COUNT(*) OVER (PARTITION BY LOWER(artist_name), LOWER(track_name)) AS total_plays
          FROM user_plays
          WHERE user_id = $1 AND track_name IS NOT NULL AND track_name != ''
        ),
        gaps AS (
          SELECT track_name AS name,
                 artist_name,
                 time_played AS resume_date,
                 prev_played,
                 ROUND((EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400)::numeric, 1) AS gap_days,
                 total_plays,
                 ROW_NUMBER() OVER (PARTITION BY LOWER(artist_name), LOWER(track_name) ORDER BY (time_played - prev_played) DESC) AS rn
          FROM ordered_plays
          WHERE prev_played IS NOT NULL
            AND (EXTRACT(EPOCH FROM (time_played - prev_played)) / 86400) >= $2
        )
        SELECT name, artist_name, resume_date, prev_played, gap_days::float AS gap_days, total_plays::bigint AS total_plays
        FROM gaps
        WHERE rn = 1
        ORDER BY gap_days DESC
        LIMIT 50;
      `, userId, minGapDays).catch(() => []);

      return rows.map((r) => ({
        name: r.name,
        artistName: r.artist_name,
        resumeDate: new Date(r.resume_date),
        prevPlayed: new Date(r.prev_played),
        gapDays: Math.round(Number(r.gap_days)),
        totalPlays: Number(r.total_plays),
      }));
    }
  }

  public async getDiscoveries(
    userId: number,
    startDateTime: Date,
    endDateTime: Date,
  ): Promise<DiscoveryItem[]> {
    const rows = await this.db.$queryRawUnsafe<Array<{
      artist_name: string;
      first_play: Date;
      playcount: bigint;
    }>>(`
      WITH artist_first_plays AS (
        SELECT artist_name, MIN(time_played) AS first_play
        FROM user_plays
        WHERE user_id = $1
        GROUP BY artist_name
      ),
      period_plays AS (
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND time_played <= $3
        GROUP BY artist_name
      )
      SELECT a.artist_name, a.first_play, p.playcount
      FROM artist_first_plays a
      JOIN period_plays p ON LOWER(a.artist_name) = LOWER(p.artist_name)
      WHERE a.first_play >= $2 AND a.first_play <= $3
      ORDER BY p.playcount DESC
      LIMIT 100;
    `, userId, startDateTime, endDateTime).catch(() => []);

    return rows.map((r) => ({
      artistName: r.artist_name,
      firstPlay: new Date(r.first_play),
      playcount: Number(r.playcount),
    }));
  }

  public async getIceberg(
    _userId: number,
    topArtists: Array<{ name: string; playcount: number }>,
    displayName: string,
    userNameLastFm: string,
    timePeriodDescription: string,
  ): Promise<IcebergData> {
    const artistNames = topArtists.map((a) => a.name);

    const dbArtists = await this.db.artist.findMany({
      where: {
        name: { in: artistNames, mode: 'insensitive' },
      },
      select: {
        name: true,
        popularity: true,
      },
    }).catch(() => []);

    const popMap = new Map<string, number>();
    for (const a of dbArtists) {
      if (a.popularity !== null && a.popularity !== undefined) {
        popMap.set(a.name.toLowerCase(), a.popularity);
      }
    }

    const tierDefinitions = [
      { tierNumber: 1, name: 'The Tip', emoji: '🏔️', description: 'Mainstream Giants (Pop 80-100)', minPop: 80, maxPop: 100 },
      { tierNumber: 2, name: 'Waterline', emoji: '🌊', description: 'Popular & Well-Known (Pop 60-79)', minPop: 60, maxPop: 79 },
      { tierNumber: 3, name: 'The Depths', emoji: '⚓', description: 'Indie & Sub-mainstream (Pop 40-59)', minPop: 40, maxPop: 59 },
      { tierNumber: 4, name: 'Twilight Zone', emoji: '🪨', description: 'Underground & Niche (Pop 20-39)', minPop: 20, maxPop: 39 },
      { tierNumber: 5, name: 'The Abyss', emoji: '🐙', description: 'Ultra-Obscure & Rare (Pop 0-19)', minPop: 0, maxPop: 19 },
    ];

    const tiers: IcebergTier[] = tierDefinitions.map((def) => ({
      tierNumber: def.tierNumber,
      name: def.name,
      emoji: def.emoji,
      description: def.description,
      artists: [],
    }));

    let hasDbPopularity = false;
    for (const [_, pop] of popMap) {
      if (pop > 0) {
        hasDbPopularity = true;
        break;
      }
    }

    topArtists.forEach((artist, index) => {
      let pop = popMap.get(artist.name.toLowerCase());
      if (pop === undefined) {
        if (hasDbPopularity) {
          pop = 15;
        } else {
          const rankRatio = topArtists.length > 1 ? index / topArtists.length : 0;
          pop = Math.max(0, Math.round(95 - rankRatio * 90));
        }
      }

      let tierIndex = 4;
      if (pop >= 80) tierIndex = 0;
      else if (pop >= 60) tierIndex = 1;
      else if (pop >= 40) tierIndex = 2;
      else if (pop >= 20) tierIndex = 3;
      else tierIndex = 4;

      tiers[tierIndex]!.artists.push({
        name: artist.name,
        playcount: artist.playcount,
        popularity: pop,
      });
    });

    return {
      displayName,
      userNameLastFm,
      timePeriodDescription,
      tiers,
      totalArtists: topArtists.length,
    };
  }

  public async getGuildAffinity(
    guildId: string,
    targetUserId: number,
    targetDisplayName: string,
    targetUserNameLastFm: string,
    guildName: string,
  ): Promise<AffinityData> {
    const guildIdBigInt = BigInt(guildId);

    const guildUsers = await this.db.guildUser.findMany({
      where: {
        guildId: guildIdBigInt,
        userId: { not: targetUserId },
        whoKnowsBanned: false,
      },
      include: {
        user: {
          select: {
            userId: true,
            discordUserId: true,
            userNameLastFm: true,
          },
        },
      },
    }).catch(() => []);

    if (guildUsers.length === 0) {
      return {
        userDisplayName: targetDisplayName,
        userNameLastFm: targetUserNameLastFm,
        guildName,
        neighbors: [],
        totalGuildUsers: 0,
      };
    }

    const targetArtistsRaw = await this.db.userArtist.findMany({
      where: { userId: targetUserId },
      orderBy: { playcount: 'desc' },
      take: 100,
      select: { name: true, playcount: true },
    }).catch(() => []);

    const targetArtistMap = new Map<string, number>();
    for (const a of targetArtistsRaw) {
      targetArtistMap.set(a.name.toLowerCase(), a.playcount);
    }

    let targetGenres: string[] = [];
    if (this.genreService && targetArtistsRaw.length > 0) {
      const topG = await this.genreService.getTopGenresForTopArtists(
        targetArtistsRaw.map((a) => ({ name: a.name, playcount: a.playcount })),
      ).catch(() => []);
      targetGenres = topG.map((g) => g.genreName.toLowerCase());
    }

    let targetCountries: string[] = [];
    if (this.countryService && targetArtistsRaw.length > 0) {
      const topC = await this.countryService.getTopCountriesForTopArtists(
        targetArtistsRaw.map((a) => ({ name: a.name, playcount: a.playcount })),
      ).catch(() => []);
      targetCountries = topC.map((c) => c.countryCode.toLowerCase());
    }

    const otherUserIds = guildUsers.map((gu) => gu.userId);
    const otherArtistsRaw = await this.db.userArtist.findMany({
      where: {
        userId: { in: otherUserIds },
      },
      orderBy: { playcount: 'desc' },
      select: { userId: true, name: true, playcount: true },
    }).catch(() => []);

    const userArtistsByUser = new Map<number, Array<{ name: string; playcount: number }>>();
    for (const a of otherArtistsRaw) {
      let list = userArtistsByUser.get(a.userId);
      if (!list) {
        list = [];
        userArtistsByUser.set(a.userId, list);
      }
      if (list.length < 100) {
        list.push({ name: a.name, playcount: a.playcount });
      }
    }

    const neighbors: AffinityNeighbor[] = [];

    for (const gu of guildUsers) {
      const uArtists = userArtistsByUser.get(gu.userId) ?? [];
      if (uArtists.length === 0) continue;

      const sharedArtists: string[] = [];
      for (const a of uArtists) {
        const lower = a.name.toLowerCase();
        if (targetArtistMap.has(lower)) {
          sharedArtists.push(a.name);
        }
      }

      const denominator = Math.max(1, Math.min(targetArtistMap.size, uArtists.length));
      const artistScore = targetArtistMap.size > 0
        ? Math.min(100, Math.round((sharedArtists.length / denominator) * 100))
        : 0;

      let genreScore = 0;
      if (this.genreService && uArtists.length > 0 && targetGenres.length > 0) {
        const uG = await this.genreService.getTopGenresForTopArtists(uArtists).catch(() => []);
        const uGenreNames = uG.map((g) => g.genreName.toLowerCase());
        const commonGenres = uGenreNames.filter((g) => targetGenres.includes(g));
        genreScore = Math.min(
          100,
          Math.round((commonGenres.length / Math.max(1, Math.min(targetGenres.length, uGenreNames.length))) * 100),
        );
      }

      let countryScore = 0;
      if (this.countryService && uArtists.length > 0 && targetCountries.length > 0) {
        const uC = await this.countryService.getTopCountriesForTopArtists(uArtists).catch(() => []);
        const uCountryCodes = uC.map((c) => c.countryCode.toLowerCase());
        const commonCountries = uCountryCodes.filter((c) => targetCountries.includes(c));
        countryScore = Math.min(
          100,
          Math.round((commonCountries.length / Math.max(1, Math.min(targetCountries.length, uCountryCodes.length))) * 100),
        );
      }

      const totalPercentage = Math.round(artistScore * 0.5 + genreScore * 0.3 + countryScore * 0.2);

      neighbors.push({
        userId: gu.userId,
        discordUserId: gu.user.discordUserId.toString(),
        userNameLastFm: gu.user.userNameLastFm,
        totalPercentage,
        artistPercentage: artistScore,
        genrePercentage: genreScore,
        countryPercentage: countryScore,
        sharedArtists: sharedArtists.slice(0, 5),
      });
    }

    neighbors.sort((a, b) => b.totalPercentage - a.totalPercentage);

    return {
      userDisplayName: targetDisplayName,
      userNameLastFm: targetUserNameLastFm,
      guildName,
      neighbors,
      totalGuildUsers: guildUsers.length,
    };
  }

  public async loveTrack(sessionKey: string, artist: string, track: string): Promise<boolean> {
    return this.lastfmRepository.loveTrack(artist, track, sessionKey);
  }

  public async unloveTrack(sessionKey: string, artist: string, track: string): Promise<boolean> {
    return this.lastfmRepository.unloveTrack(artist, track, sessionKey);
  }

  public async getLovedTracks(
    userNameLastFm: string,
    limit: number = 20,
    page: number = 1,
    sessionKey?: string,
  ) {
    return this.lastfmRepository.getLovedTracks(userNameLastFm, limit, page, sessionKey);
  }

  public async scrobbleTrack(
    sessionKey: string,
    artist: string,
    track: string,
    album?: string,
    timestamp?: number,
  ): Promise<boolean> {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    return this.lastfmRepository.scrobbleTrack(artist, track, ts, sessionKey, album);
  }
}
