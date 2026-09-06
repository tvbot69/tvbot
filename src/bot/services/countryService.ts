import { injectable, inject } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { MusicBrainzService } from './musicBrainzService';
import { CacheService } from './cacheService';

export interface CountryInfo {
  Name: string;
  Code: string;
  Emoji: string;
  Unicode?: string;
  Image?: string;
  Aliases?: string[];
}

export interface TopCountryItem {
  countryName: string;
  countryCode: string;
  playcount: number;
  artistCount?: number;
  artists?: { name: string; playcount: number }[];
}

export interface GuildCountryItem {
  countryName: string;
  countryCode: string;
  totalPlaycount: number;
  listenerCount: number;
}

export interface WhoKnowsCountryItem {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  playcount: number;
}

@injectable()
export class CountryService {
  public readonly countries: CountryInfo[] = [];
  private readonly countryCodeMap = new Map<string, CountryInfo>();
  private readonly seedArtistCountryMap = new Map<string, string>();

  constructor(
    @inject(PrismaClient) private readonly prisma: PrismaClient,
    @inject(MusicBrainzService) private readonly musicBrainzService: MusicBrainzService,
    @inject(CacheService) private readonly cache: CacheService,
  ) {
    try {
      const candidates = [
        path.join(__dirname, '..', 'resources', 'countries.json'),
        path.join(process.cwd(), 'src', 'bot', 'resources', 'countries.json'),
        path.join(process.cwd(), 'dist', 'bot', 'resources', 'countries.json'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          this.countries = JSON.parse(raw);
          break;
        }
      }
    } catch {
      this.countries = [];
    }

    for (const c of this.countries) {
      this.countryCodeMap.set(c.Code.toUpperCase(), c);
    }

    try {
      const seedCandidates = [
        path.join(__dirname, '..', 'resources', 'artist_countries.json'),
        path.join(process.cwd(), 'src', 'bot', 'resources', 'artist_countries.json'),
        path.join(process.cwd(), 'dist', 'bot', 'resources', 'artist_countries.json'),
      ];
      for (const p of seedCandidates) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const data = JSON.parse(raw);
          for (const [k, v] of Object.entries(data)) {
            this.seedArtistCountryMap.set(k.toLowerCase(), (v as string).toUpperCase());
          }
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  public static trimCountry(country: string): string {
    return country.toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
  }

  public getCountryByCode(code: string): CountryInfo | undefined {
    return this.countryCodeMap.get(code.toUpperCase());
  }

  public countryCodeToCountryName(code: string): string {
    return this.getCountryByCode(code)?.Name ?? code;
  }

  public searchCountry(countryValues: string): CountryInfo | undefined {
    if (!countryValues || !countryValues.trim()) return undefined;
    const q = CountryService.trimCountry(countryValues);
    return this.countries.find(c => {
      if (CountryService.trimCountry(c.Name) === q) return true;
      if (c.Code.toLowerCase() === q) return true;
      if (c.Emoji === countryValues.trim()) return true;
      if (c.Aliases?.some(a => CountryService.trimCountry(a) === q)) return true;
      return false;
    });
  }

  public searchCountries(countryValues: string): CountryInfo[] {
    if (!countryValues || !countryValues.trim()) return [];
    const q = CountryService.trimCountry(countryValues);
    return this.countries.filter(c => {
      const trimmedName = CountryService.trimCountry(c.Name);
      if (trimmedName === q || c.Code.toLowerCase() === q) return true;
      if (trimmedName.startsWith(q) || trimmedName.includes(q)) return true;
      if (c.Aliases?.some(a => CountryService.trimCountry(a).includes(q))) return true;
      return false;
    });
  }

  public async getArtistCountry(artistName: string): Promise<CountryInfo | undefined> {
    if (!artistName || !artistName.trim()) return undefined;
    const cleanName = artistName.trim().toLowerCase();

    // 1. Curated in-memory seed map
    const seedCode = this.seedArtistCountryMap.get(cleanName);
    if (seedCode) {
      return this.getCountryByCode(seedCode);
    }

    // 2. Cache check
    const cacheKey = `artist_country:${cleanName}`;
    const cachedCode = await this.cache.get<string>(cacheKey);
    if (cachedCode) {
      return this.getCountryByCode(cachedCode);
    }

    // 3. DB lookup
    try {
      const dbArtist = await this.prisma.artist.findFirst({
        where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
        select: { countryCode: true },
      });
      if (dbArtist?.countryCode) {
        const code = dbArtist.countryCode.toUpperCase();
        await this.cache.set(cacheKey, code, 86400);
        return this.getCountryByCode(code);
      }
    } catch {
      // ignore db error
    }

    // 4. MusicBrainz lookup
    try {
      const mb = await this.musicBrainzService.getArtistData(artistName.trim());
      if (mb?.countryCode) {
        const code = mb.countryCode.toUpperCase();
        await this.cache.set(cacheKey, code, 86400);
        this.prisma.artist.updateMany({
          where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
          data: { countryCode: code },
        }).catch(() => undefined);
        return this.getCountryByCode(code);
      }
    } catch {
      // ignore mb error
    }

    return undefined;
  }

  public async getArtistInfoWithCountry(artistName: string): Promise<{
    country?: CountryInfo;
    spotifyImageUrl?: string;
  }> {
    const country = await this.getArtistCountry(artistName);
    let spotifyImageUrl: string | undefined;

    try {
      const dbArtist = await this.prisma.artist.findFirst({
        where: { name: { equals: artistName.trim(), mode: 'insensitive' } },
        select: { spotifyImageUrl: true },
      });
      if (dbArtist?.spotifyImageUrl) {
        spotifyImageUrl = dbArtist.spotifyImageUrl;
      }
    } catch {
      // ignore
    }

    return { country, spotifyImageUrl };
  }

  public async getTopCountriesForTopArtists(
    topArtists: { name: string; playcount: number }[],
    addArtists = false,
  ): Promise<TopCountryItem[]> {
    if (!topArtists || topArtists.length === 0) return [];

    const artistNames = [...new Set(topArtists.map(a => a.name))];
    if (artistNames.length === 0) return [];

    const artistCountryMap = new Map<string, string>();

    // 1) First check curated in-memory seed map (instant, no DB/network)
    for (const name of artistNames) {
      const code = this.seedArtistCountryMap.get(name.toLowerCase());
      if (code) {
        artistCountryMap.set(name.toLowerCase(), code);
      }
    }

    // 2) Query DB for missing artists
    const missingFromSeed = artistNames.filter(n => !artistCountryMap.has(n.toLowerCase()));
    if (missingFromSeed.length > 0) {
      try {
        const dbArtists = await this.prisma.artist.findMany({
          where: {
            name: { in: missingFromSeed, mode: 'insensitive' },
            countryCode: { not: null },
          },
          select: {
            name: true,
            countryCode: true,
          },
        });
        for (const a of dbArtists) {
          if (a.countryCode) {
            artistCountryMap.set(a.name.toLowerCase(), a.countryCode.toUpperCase());
          }
        }
      } catch {
        // ignore db error
      }
    }

    // 3) MusicBrainz fallback for top missing artists
    const stillMissing = artistNames.filter(n => !artistCountryMap.has(n.toLowerCase())).slice(0, 10);
    if (stillMissing.length > 0) {
      for (const name of stillMissing) {
        try {
          const mb = await this.musicBrainzService.getArtistData(name);
          if (mb?.countryCode) {
            const code = mb.countryCode.toUpperCase();
            artistCountryMap.set(name.toLowerCase(), code);
            this.prisma.artist.updateMany({
              where: { name: { equals: name, mode: 'insensitive' } },
              data: { countryCode: code },
            }).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }
    }

    // Aggregate playcounts and optionally group artists by country
    const countryPlaycounts = new Map<string, number>();
    const countryArtists = new Map<string, { name: string; playcount: number }[]>();

    for (const item of topArtists) {
      const code = artistCountryMap.get(item.name.toLowerCase());
      if (code && item.playcount > 0) {
        const current = countryPlaycounts.get(code) ?? 0;
        countryPlaycounts.set(code, current + item.playcount);

        if (addArtists) {
          if (!countryArtists.has(code)) countryArtists.set(code, []);
          countryArtists.get(code)!.push({ name: item.name, playcount: item.playcount });
        }
      }
    }

    const results: TopCountryItem[] = [];
    for (const [code, playcount] of countryPlaycounts.entries()) {
      const countryInfo = this.getCountryByCode(code);
      const countryName = countryInfo?.Name ?? code;
      const artists = countryArtists.get(code)?.sort((a, b) => b.playcount - a.playcount);

      results.push({
        countryName,
        countryCode: code,
        playcount,
        artistCount: artists ? artists.length : undefined,
        artists: addArtists ? (artists ?? []) : undefined,
      });
    }

    // Sort by artist count descending if addArtists, otherwise playcount descending
    results.sort((a, b) => (addArtists ? (b.artists?.length ?? 0) - (a.artists?.length ?? 0) : b.playcount - a.playcount));
    return results;
  }

  public async getUserTopCountriesAllTime(userId: number, limit = 100): Promise<TopCountryItem[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ countryCode: string; playcount: bigint; artistCount: bigint }>>`
        SELECT a.country_code AS "countryCode",
               SUM(ua.playcount)::bigint AS "playcount",
               COUNT(DISTINCT ua.artist_id)::bigint AS "artistCount"
        FROM user_artists ua
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND a.country_code IS NOT NULL
        GROUP BY a.country_code
        ORDER BY "playcount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        countryName: this.countryCodeToCountryName(r.countryCode),
        countryCode: r.countryCode.toUpperCase(),
        playcount: Number(r.playcount),
        artistCount: Number(r.artistCount),
      }));
    } catch {
      return [];
    }
  }

  public async getUserArtistsForCountry(
    userId: number,
    countryCode: string,
    limit = 100,
  ): Promise<{ name: string; playcount: number }[]> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ name: string; playcount: bigint }>>`
        SELECT ua.name AS "name", ua.playcount::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE ua.user_id = ${userId}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
        ORDER BY ua.playcount DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        name: r.name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildTopCountriesAllTime(guildId: string, limit = 100): Promise<GuildCountryItem[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ countryCode: string; totalPlaycount: bigint; listenerCount: bigint }>>`
        SELECT a.country_code AS "countryCode",
               SUM(ua.playcount)::bigint AS "totalPlaycount",
               COUNT(DISTINCT ua.user_id)::bigint AS "listenerCount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND a.country_code IS NOT NULL
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
        GROUP BY a.country_code
        ORDER BY "listenerCount" DESC, "totalPlaycount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        countryName: this.countryCodeToCountryName(r.countryCode),
        countryCode: r.countryCode.toUpperCase(),
        totalPlaycount: Number(r.totalPlaycount),
        listenerCount: Number(r.listenerCount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildArtistsForCountry(
    guildId: string,
    countryCode: string,
    limit = 50,
  ): Promise<{ name: string; playcount: number }[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ name: string; playcount: bigint }>>`
        SELECT ua.name AS "name", SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
        GROUP BY ua.name
        ORDER BY "playcount" DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        name: r.name,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }

  public async getGuildUsersForCountry(guildId: string, countryCode: string): Promise<WhoKnowsCountryItem[]> {
    try {
      const gIdBigInt = BigInt(guildId);
      const rows = await this.prisma.$queryRaw<Array<{ userId: number; discordUserId: bigint; userNameLastFm: string; playcount: bigint }>>`
        SELECT ua.user_id AS "userId",
               u.discord_user_id AS "discordUserId",
               u.user_name_last_fm AS "userNameLastFm",
               SUM(ua.playcount)::bigint AS "playcount"
        FROM user_artists ua
        INNER JOIN guild_users gu ON gu.user_id = ua.user_id
        INNER JOIN users u ON u.user_id = ua.user_id
        INNER JOIN artists a ON a.artist_id = ua.artist_id
        WHERE gu.guild_id = ${gIdBigInt}
          AND ua.artist_id IS NOT NULL
          AND LOWER(a.country_code) = LOWER(${countryCode.trim()})
          AND (gu.who_knows_whitelisted = true OR gu.who_knows_whitelisted IS NULL)
          AND (gu.who_knows_banned = false OR gu.who_knows_banned IS NULL)
        GROUP BY ua.user_id, u.discord_user_id, u.user_name_last_fm
        ORDER BY "playcount" DESC
        LIMIT 50
      `;

      return rows.map(r => ({
        userId: r.userId,
        discordUserId: r.discordUserId.toString(),
        userNameLastFm: r.userNameLastFm,
        playcount: Number(r.playcount),
      }));
    } catch {
      return [];
    }
  }
}
