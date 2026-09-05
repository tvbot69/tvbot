import { injectable, inject } from 'tsyringe';
import { PrismaClient, Prisma } from '@prisma/client';

export enum OrderType {
  Listeners = 0,
  Playcount = 1,
}

export interface GuildRankingItem {
  name: string;
  secondaryName?: string; // artist for album / track
  totalPlaycount: number;
  listenerCount: number;
  id?: number;
}

export interface GuildRankingSettings {
  chartTimePeriod: string; // 'weekly' | 'monthly' | 'alltime' | custom
  timeDescription: string;
  orderType: OrderType;
  amountOfDays?: number;
  startDateTime: Date;
  endDateTime: Date | null;
  billboardStartDateTime: Date | null;
  billboardEndDateTime: Date | null;
  billboardTimeDescription: string | null;
  newSearchValue?: string | null;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_DISPLAY = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function parseGuildRankingSettings(
  optionsStr?: string | null,
  defaultOrder: OrderType = OrderType.Listeners,
): GuildRankingSettings {
  const now = new Date();
  let orderType = defaultOrder;
  let chartTimePeriod = 'weekly';
  let timeDescription = 'weekly';
  let amountOfDays = 7;
  let startDateTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let endDateTime: Date | null = null;
  let billboardStartDateTime: Date | null = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  let billboardEndDateTime: Date | null = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let billboardTimeDescription: string | null = 'last week';

  if (!optionsStr || !optionsStr.trim()) {
    return {
      chartTimePeriod,
      timeDescription,
      orderType,
      amountOfDays,
      startDateTime,
      endDateTime,
      billboardStartDateTime,
      billboardEndDateTime,
      billboardTimeDescription,
      newSearchValue: null,
    };
  }

  const rawTokens = optionsStr.trim().split(/\s+/);
  const remainingTokens: string[] = [];

  const playKeywords = new Set(['p', 'pc', 'playcount', 'plays', 'scrobbles']);
  const listenerKeywords = new Set(['l', 'lc', 'listenercount', 'listeners']);
  const allTimeKeywords = new Set(['overall', 'alltime', 'all-time', 'all', 'a', 'o', 'at']);
  const monthlyKeywords = new Set(['monthly', 'month', 'm', '1m', '30d']);
  const weeklyKeywords = new Set(['weekly', 'week', 'w', '7d']);

  let monthFound: number | null = null;
  let yearFound: number | null = null;

  for (const token of rawTokens) {
    const lower = token.toLowerCase();

    if (playKeywords.has(lower)) {
      orderType = OrderType.Playcount;
      continue;
    }
    if (listenerKeywords.has(lower)) {
      orderType = OrderType.Listeners;
      continue;
    }

    if (allTimeKeywords.has(lower)) {
      chartTimePeriod = 'alltime';
      timeDescription = 'all-time';
      amountOfDays = 0;
      startDateTime = new Date(0);
      endDateTime = null;
      billboardStartDateTime = null;
      billboardEndDateTime = null;
      billboardTimeDescription = null;
      continue;
    }

    if (monthlyKeywords.has(lower)) {
      chartTimePeriod = 'monthly';
      timeDescription = 'monthly';
      amountOfDays = 30;
      startDateTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      endDateTime = null;
      billboardStartDateTime = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      billboardEndDateTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      billboardTimeDescription = 'last month';
      continue;
    }

    if (weeklyKeywords.has(lower)) {
      chartTimePeriod = 'weekly';
      timeDescription = 'weekly';
      amountOfDays = 7;
      startDateTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      endDateTime = null;
      billboardStartDateTime = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      billboardEndDateTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      billboardTimeDescription = 'last week';
      continue;
    }

    if (MONTH_NAMES[lower] !== undefined && monthFound === null) {
      monthFound = MONTH_NAMES[lower]!;
      continue;
    }

    const yr = parseInt(token, 10);
    if (!isNaN(yr) && yr >= 1970 && yr <= 2100 && yearFound === null) {
      yearFound = yr;
      continue;
    }

    remainingTokens.push(token);
  }

  // Handle month/year customization
  if (monthFound !== null || yearFound !== null) {
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();

    if (monthFound !== null && yearFound !== null) {
      const start = new Date(Date.UTC(yearFound, monthFound, 1));
      const end = new Date(Date.UTC(yearFound, monthFound + 1, 1));
      const bbStart = new Date(Date.UTC(yearFound, monthFound - 1, 1));
      const bbEnd = start;

      chartTimePeriod = `${MONTH_DISPLAY[monthFound]} ${yearFound}`;
      timeDescription = `${MONTH_DISPLAY[monthFound]} ${yearFound}`;
      startDateTime = start;
      endDateTime = end;
      billboardStartDateTime = bbStart;
      billboardEndDateTime = bbEnd;
      billboardTimeDescription = `${MONTH_DISPLAY[(monthFound + 11) % 12]}`;
    } else if (monthFound !== null) {
      let resolvedYear = currentYear;
      if (monthFound > currentMonth) {
        resolvedYear -= 1;
      }
      const start = new Date(Date.UTC(resolvedYear, monthFound, 1));
      const end = new Date(Date.UTC(resolvedYear, monthFound + 1, 1));
      const bbStart = new Date(Date.UTC(resolvedYear, monthFound - 1, 1));
      const bbEnd = start;

      chartTimePeriod = `${MONTH_DISPLAY[monthFound]}`;
      timeDescription = `${MONTH_DISPLAY[monthFound]}`;
      startDateTime = start;
      endDateTime = end;
      billboardStartDateTime = bbStart;
      billboardEndDateTime = bbEnd;
      billboardTimeDescription = `${MONTH_DISPLAY[(monthFound + 11) % 12]}`;
    } else if (yearFound !== null) {
      const start = new Date(Date.UTC(yearFound, 0, 1));
      const end = new Date(Date.UTC(yearFound + 1, 0, 1));
      const bbStart = new Date(Date.UTC(yearFound - 1, 0, 1));
      const bbEnd = start;

      chartTimePeriod = `${yearFound}`;
      timeDescription = `${yearFound}`;
      startDateTime = start;
      endDateTime = end;
      billboardStartDateTime = bbStart;
      billboardEndDateTime = bbEnd;
      billboardTimeDescription = `${yearFound - 1}`;
    }
  }

  const newSearchValue = remainingTokens.length > 0 ? remainingTokens.join(' ').trim() : null;

  return {
    chartTimePeriod,
    timeDescription,
    orderType,
    amountOfDays,
    startDateTime,
    endDateTime,
    billboardStartDateTime,
    billboardEndDateTime,
    billboardTimeDescription,
    newSearchValue,
  };
}

@injectable()
export class GuildRankingService {
  private readonly cache = new Map<string, CacheEntry<GuildRankingItem[]>>();

  constructor(@inject(PrismaClient) private readonly prisma: PrismaClient) {}

  private getCached(key: string): GuildRankingItem[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCached(key: string, data: GuildRankingItem[], ttlMs = 5 * 60 * 1000): void {
    if (this.cache.size > 500) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (v.expiresAt < now) this.cache.delete(k);
      }
    }
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  public async getGuildTopArtists(
    guildId: string,
    settings: GuildRankingSettings,
  ): Promise<GuildRankingItem[]> {
    const cacheKey = `guild:artists:${guildId}:${settings.startDateTime.getTime()}:${settings.endDateTime?.getTime() ?? 0}:${settings.orderType}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const gId = BigInt(guildId);
    let items: GuildRankingItem[] = [];

    if (settings.chartTimePeriod === 'alltime') {
      const orderBy =
        settings.orderType === OrderType.Playcount
          ? Prisma.sql`"totalPlaycount" DESC, "listenerCount" DESC`
          : Prisma.sql`"listenerCount" DESC, "totalPlaycount" DESC`;

      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          artistId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               agg.artist_id AS "artistId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT ua.artist_id,
                   SUM(ua.playcount)::int AS "totalPlaycount",
                   COUNT(DISTINCT ua.user_id)::int AS "listenerCount"
            FROM user_artists ua
            INNER JOIN guild_users gu ON gu.user_id = ua.user_id
            WHERE gu.guild_id = ${gId}
              AND ua.artist_id IS NOT NULL
              AND NOT gu.who_knows_banned
            GROUP BY ua.artist_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN artists a ON a.artist_id = agg.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.artistId),
      }));
    } else {
      const orderBy =
        settings.orderType === OrderType.Playcount
          ? Prisma.sql`"totalPlaycount" DESC, "listenerCount" DESC`
          : Prisma.sql`"listenerCount" DESC, "totalPlaycount" DESC`;

      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          artistId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               agg.artist_id AS "artistId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT up.artist_id,
                   COUNT(*)::int AS "totalPlaycount",
                   COUNT(DISTINCT up.user_id)::int AS "listenerCount"
            FROM user_plays up
            INNER JOIN guild_users gu ON gu.user_id = up.user_id
            WHERE gu.guild_id = ${gId}
              AND up.time_played >= ${settings.startDateTime}
              ${settings.endDateTime ? Prisma.sql`AND up.time_played < ${settings.endDateTime}` : Prisma.empty}
              AND up.artist_id IS NOT NULL
              AND NOT gu.who_knows_banned
            GROUP BY up.artist_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN artists a ON a.artist_id = agg.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.artistId),
      }));
    }

    this.setCached(cacheKey, items);
    return items;
  }

  public async getGuildTopAlbums(
    guildId: string,
    settings: GuildRankingSettings,
    artistSearch?: string | null,
  ): Promise<GuildRankingItem[]> {
    const filter = artistSearch?.trim() || null;
    const cacheKey = `guild:albums:${guildId}:${settings.startDateTime.getTime()}:${settings.endDateTime?.getTime() ?? 0}:${settings.orderType}:${filter ?? ''}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const gId = BigInt(guildId);
    let items: GuildRankingItem[] = [];

    const orderBy =
      settings.orderType === OrderType.Playcount
        ? Prisma.sql`"totalPlaycount" DESC, "listenerCount" DESC`
        : Prisma.sql`"listenerCount" DESC, "totalPlaycount" DESC`;

    if (settings.chartTimePeriod === 'alltime') {
      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          albumName: string;
          albumId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               al.name AS "albumName",
               agg.album_id AS "albumId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT ub.album_id,
                   SUM(ub.playcount)::int AS "totalPlaycount",
                   COUNT(DISTINCT ub.user_id)::int AS "listenerCount"
            FROM user_albums ub
            INNER JOIN guild_users gu ON gu.user_id = ub.user_id
            ${filter ? Prisma.sql`INNER JOIN albums al_f ON al_f.album_id = ub.album_id INNER JOIN artists a_f ON a_f.artist_id = al_f.artist_id AND LOWER(a_f.name) = LOWER(${filter})` : Prisma.empty}
            WHERE gu.guild_id = ${gId}
              AND ub.album_id IS NOT NULL
              AND NOT gu.who_knows_banned
            GROUP BY ub.album_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN albums al ON al.album_id = agg.album_id
        INNER JOIN artists a ON a.artist_id = al.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.albumName,
        secondaryName: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.albumId),
      }));
    } else {
      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          albumName: string;
          albumId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               al.name AS "albumName",
               agg.album_id AS "albumId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT up.album_id,
                   COUNT(*)::int AS "totalPlaycount",
                   COUNT(DISTINCT up.user_id)::int AS "listenerCount"
            FROM user_plays up
            INNER JOIN guild_users gu ON gu.user_id = up.user_id
            WHERE gu.guild_id = ${gId}
              AND up.time_played >= ${settings.startDateTime}
              ${settings.endDateTime ? Prisma.sql`AND up.time_played < ${settings.endDateTime}` : Prisma.empty}
              AND up.album_id IS NOT NULL
              AND NOT gu.who_knows_banned
              ${filter ? Prisma.sql`AND LOWER(up.artist_name) = LOWER(${filter})` : Prisma.empty}
            GROUP BY up.album_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN albums al ON al.album_id = agg.album_id
        INNER JOIN artists a ON a.artist_id = al.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.albumName,
        secondaryName: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.albumId),
      }));
    }

    this.setCached(cacheKey, items);
    return items;
  }

  public async getGuildTopTracks(
    guildId: string,
    settings: GuildRankingSettings,
    artistSearch?: string | null,
  ): Promise<GuildRankingItem[]> {
    const filter = artistSearch?.trim() || null;
    const cacheKey = `guild:tracks:${guildId}:${settings.startDateTime.getTime()}:${settings.endDateTime?.getTime() ?? 0}:${settings.orderType}:${filter ?? ''}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const gId = BigInt(guildId);
    let items: GuildRankingItem[] = [];

    const orderBy =
      settings.orderType === OrderType.Playcount
        ? Prisma.sql`"totalPlaycount" DESC, "listenerCount" DESC`
        : Prisma.sql`"listenerCount" DESC, "totalPlaycount" DESC`;

    if (settings.chartTimePeriod === 'alltime') {
      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          trackName: string;
          trackId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               t.name AS "trackName",
               agg.track_id AS "trackId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT ut.track_id,
                   SUM(ut.playcount)::int AS "totalPlaycount",
                   COUNT(DISTINCT ut.user_id)::int AS "listenerCount"
            FROM user_tracks ut
            INNER JOIN guild_users gu ON gu.user_id = ut.user_id
            ${filter ? Prisma.sql`INNER JOIN tracks t_f ON t_f.track_id = ut.track_id INNER JOIN artists a_f ON a_f.artist_id = t_f.artist_id AND LOWER(a_f.name) = LOWER(${filter})` : Prisma.empty}
            WHERE gu.guild_id = ${gId}
              AND ut.track_id IS NOT NULL
              AND NOT gu.who_knows_banned
            GROUP BY ut.track_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN tracks t ON t.track_id = agg.track_id
        INNER JOIN artists a ON a.artist_id = t.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.trackName,
        secondaryName: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.trackId),
      }));
    } else {
      const raw = await this.prisma.$queryRaw<
        Array<{
          artistName: string;
          trackName: string;
          trackId: number;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT a.name AS "artistName",
               t.name AS "trackName",
               agg.track_id AS "trackId",
               agg."totalPlaycount",
               agg."listenerCount"
        FROM (
            SELECT up.track_id,
                   COUNT(*)::int AS "totalPlaycount",
                   COUNT(DISTINCT up.user_id)::int AS "listenerCount"
            FROM user_plays up
            INNER JOIN guild_users gu ON gu.user_id = up.user_id
            WHERE gu.guild_id = ${gId}
              AND up.time_played >= ${settings.startDateTime}
              ${settings.endDateTime ? Prisma.sql`AND up.time_played < ${settings.endDateTime}` : Prisma.empty}
              AND up.track_id IS NOT NULL
              AND NOT gu.who_knows_banned
              ${filter ? Prisma.sql`AND LOWER(up.artist_name) = LOWER(${filter})` : Prisma.empty}
            GROUP BY up.track_id
            ORDER BY ${orderBy}
            LIMIT 120
        ) agg
        INNER JOIN tracks t ON t.track_id = agg.track_id
        INNER JOIN artists a ON a.artist_id = t.artist_id
        ORDER BY ${orderBy};
      `;

      items = raw.map((r) => ({
        name: r.trackName,
        secondaryName: r.artistName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
        id: Number(r.trackId),
      }));
    }

    this.setCached(cacheKey, items);
    return items;
  }

  public async getGuildTopGenres(
    guildId: string,
    settings: GuildRankingSettings,
  ): Promise<GuildRankingItem[]> {
    const cacheKey = `guild:genres:${guildId}:${settings.startDateTime.getTime()}:${settings.endDateTime?.getTime() ?? 0}:${settings.orderType}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const gId = BigInt(guildId);
    let items: GuildRankingItem[] = [];

    const orderBy =
      settings.orderType === OrderType.Playcount
        ? Prisma.sql`"totalPlaycount" DESC, "listenerCount" DESC`
        : Prisma.sql`"listenerCount" DESC, "totalPlaycount" DESC`;

    if (settings.chartTimePeriod === 'alltime') {
      const raw = await this.prisma.$queryRaw<
        Array<{
          genreName: string;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT ag.name AS "genreName",
               SUM(ua.playcount)::int AS "totalPlaycount",
               COUNT(DISTINCT ua.user_id)::int AS "listenerCount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artist_genres ag ON ag.artist_id = ua.artist_id
        WHERE gu.guild_id = ${gId}
          AND ua.artist_id IS NOT NULL
          AND NOT gu.who_knows_banned
        GROUP BY ag.name
        ORDER BY ${orderBy}
        LIMIT 120;
      `;

      items = raw.map((r) => ({
        name: r.genreName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
      }));
    } else {
      const raw = await this.prisma.$queryRaw<
        Array<{
          genreName: string;
          totalPlaycount: number;
          listenerCount: number;
        }>
      >`
        SELECT genre_name AS "genreName",
               SUM(user_plays)::int AS "totalPlaycount",
               COUNT(*)::int AS "listenerCount"
        FROM (
            SELECT ag.name AS genre_name, agg.user_id, SUM(agg.plays) AS user_plays
            FROM (
                SELECT up.artist_id, up.user_id, COUNT(*) AS plays
                FROM user_plays up
                INNER JOIN guild_users gu ON gu.user_id = up.user_id
                WHERE gu.guild_id = ${gId}
                  AND up.time_played >= ${settings.startDateTime}
                  ${settings.endDateTime ? Prisma.sql`AND up.time_played < ${settings.endDateTime}` : Prisma.empty}
                  AND up.artist_id IS NOT NULL
                  AND NOT gu.who_knows_banned
                GROUP BY up.artist_id, up.user_id
            ) agg
            INNER JOIN artist_genres ag ON ag.artist_id = agg.artist_id
            GROUP BY ag.name, agg.user_id
        ) genre_users
        GROUP BY genre_name
        ORDER BY ${orderBy}
        LIMIT 120;
      `;

      items = raw.map((r) => ({
        name: r.genreName,
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
      }));
    }

    this.setCached(cacheKey, items);
    return items;
  }
}
