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
  Unicode: string;
  Image: string;
  Aliases?: string[];
}

export interface TopCountryItem {
  countryName: string;
  countryCode: string;
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

  public getCountryByCode(code: string): CountryInfo | undefined {
    return this.countryCodeMap.get(code.toUpperCase());
  }

  public countryCodeToCountryName(code: string): string {
    return this.getCountryByCode(code)?.Name ?? code;
  }

  public async getTopCountriesForTopArtists(
    topArtists: { name: string; playcount: number }[],
  ): Promise<TopCountryItem[]> {
    if (!topArtists || topArtists.length === 0) return [];

    const artistNames = [...new Set(topArtists.map(a => a.name))];
    if (artistNames.length === 0) return [];

    const artistCountryMap = new Map<string, string>();

    // 1) First check our curated in-memory seed map (instant, no DB/network)
    for (const name of artistNames) {
      const code = this.seedArtistCountryMap.get(name.toLowerCase());
      if (code) {
        artistCountryMap.set(name.toLowerCase(), code);
      }
    }

    // 2) For missing artists, query DB
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

    // 3) For remaining top artists missing country, check MusicBrainz safely
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

    // Aggregate playcounts by country
    const countryPlaycounts = new Map<string, number>();
    for (const item of topArtists) {
      const code = artistCountryMap.get(item.name.toLowerCase());
      if (code) {
        const current = countryPlaycounts.get(code) ?? 0;
        countryPlaycounts.set(code, current + item.playcount);
      }
    }

    const results: TopCountryItem[] = [];
    for (const [code, playcount] of countryPlaycounts.entries()) {
      const countryInfo = this.getCountryByCode(code);
      const countryName = countryInfo?.Name ?? code;
      results.push({
        countryName,
        countryCode: code,
        playcount,
      });
    }

    // Sort by playcount descending
    results.sort((a, b) => b.playcount - a.playcount);
    return results;
  }
}
