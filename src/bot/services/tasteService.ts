import { injectable, inject } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { GenreService } from './genreService';
import { CountryService } from './countryService';
import { CacheService } from './cacheService';
import type { TopArtist } from '@domain/models/topLists';

export interface TasteItem {
  name: string;
  playcount: number;
}

export interface TasteComparisonItem {
  name: string;
  ownPlaycount: number;
  otherPlaycount: number;
}

export interface TasteCategoryResult {
  tabName: string;
  title: string;
  typeColumn: string;
  matchesCount: number;
  totalCount: number;
  matchPercentage: number;
  tableText: string;
}

export interface TasteData {
  cacheKey: string;
  user1DiscordId: string;
  user2DiscordId: string;
  user1DisplayName: string;
  user2DisplayName: string;
  user1UserNameLastFm: string;
  user2UserNameLastFm: string;
  url: string;
  timePeriodDescription: string;
  amount: number;
  artists: {
    items: TasteComparisonItem[];
    totalCount: number;
  };
  genres: {
    items: TasteComparisonItem[];
    totalCount: number;
  };
  countries: {
    items: TasteComparisonItem[];
    totalCount: number;
  };
}

function truncateName(name: string, maxLen: number = 16): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 2) + '..';
}

export function formatTasteTable(
  typeColumn: string,
  user1Name: string,
  user2Name: string,
  items: TasteComparisonItem[],
  amount: number,
  totalCount: number,
  _timePeriod: string,
): { tableText: string; matchesCount: number; matchPercentage: number } {
  const matchesCount = items.length;
  const matchPercentage = totalCount > 0 ? (matchesCount / totalCount) * 100 : 0;

  if (matchesCount === 0) {
    return {
      tableText: `\nNo ${typeColumn.toLowerCase()} matches found.`,
      matchesCount: 0,
      matchPercentage: 0,
    };
  }

  // Filter down according to amount threshold (like fmbot)
  let filterThreshold = 0;
  for (let i = 0; i < 100; i++) {
    if (items.filter(w => w.ownPlaycount >= i && w.otherPlaycount >= i).length <= amount) {
      filterThreshold = i;
      break;
    }
  }

  let filtered = items.filter(w => w.ownPlaycount >= filterThreshold && w.otherPlaycount >= filterThreshold);
  if (filtered.length === 0) {
    filtered = items.slice(0, amount);
  } else {
    filtered = filtered.slice(0, amount);
  }

  const col0Header = typeColumn;
  const col1Header = user1Name;
  const col2Header = user2Name;

  const rows = filtered.map(item => {
    const symbol = item.ownPlaycount === item.otherPlaycount ? ' = ' : item.ownPlaycount > item.otherPlaycount ? ' > ' : ' < ';
    return {
      name: truncateName(item.name, 16),
      p1: String(item.ownPlaycount),
      sym: symbol,
      p2: String(item.otherPlaycount),
    };
  });

  const maxCol0 = Math.max(col0Header.length, ...rows.map(r => r.name.length)) + 2;
  const maxCol1 = Math.max(col1Header.length, ...rows.map(r => r.p1.length)) + 1;

  let out = `${col0Header.padEnd(maxCol0)}${col1Header.padStart(maxCol1)}   ${col2Header}\n`;
  const totalWidth = maxCol0 + maxCol1 + 3 + col2Header.length + 2;
  out += '-'.repeat(Math.max(28, totalWidth)) + '\n';

  for (const r of rows) {
    out += `${r.name.padEnd(maxCol0)}${r.p1.padStart(maxCol1)}${r.sym}${r.p2}\n`;
  }

  return {
    tableText: out,
    matchesCount,
    matchPercentage,
  };
}

@injectable()
export class TasteService {
  constructor(
    @inject('ILastfmRepository') private readonly lastfmRepo: ILastfmRepository,
    @inject(GenreService) private readonly genreService: GenreService,
    @inject(CountryService) private readonly countryService: CountryService,
    @inject(CacheService) private readonly cache: CacheService,
  ) {}

  public async getTasteData(
    user1: { discordUserId: string; displayName: string; userNameLastFm: string },
    user2: { discordUserId: string; displayName: string; userNameLastFm: string },
    timePeriod: string = 'two-year',
  ): Promise<TasteData> {
    const cacheKey = `taste:${user1.userNameLastFm.toLowerCase()}:${user2.userNameLastFm.toLowerCase()}:${timePeriod}`;
    const cached = await this.cache.get<TasteData>(cacheKey);
    if (cached) return cached;

    // Fetch top artists for both users (overall / 2-year)
    // For 2-year preset, Last.fm overall or top 1000 artists
    const [u1ArtistsRaw, u2ArtistsRaw] = await Promise.all([
      this.lastfmRepo.getTopArtists(user1.userNameLastFm, 'overall' as any, 1000).catch(() => [] as TopArtist[]),
      this.lastfmRepo.getTopArtists(user2.userNameLastFm, 'overall' as any, 1000).catch(() => [] as TopArtist[]),
    ]);

    const u1Map = new Map<string, number>();
    for (const a of u1ArtistsRaw) {
      if (a.name) u1Map.set(a.name.toLowerCase(), a.playcount);
    }

    const u2Map = new Map<string, number>();
    for (const a of u2ArtistsRaw) {
      if (a.name) u2Map.set(a.name.toLowerCase(), a.playcount);
    }

    // 1) Matching Artists
    const matchingArtists: TasteComparisonItem[] = [];
    for (const a of u1ArtistsRaw) {
      const otherPlays = u2Map.get(a.name.toLowerCase());
      if (otherPlays !== undefined && otherPlays > 0 && a.playcount > 0) {
        matchingArtists.push({
          name: a.name,
          ownPlaycount: a.playcount,
          otherPlaycount: otherPlays,
        });
      }
    }
    matchingArtists.sort((a, b) => (b.ownPlaycount + b.otherPlaycount) - (a.ownPlaycount + a.otherPlaycount));

    // 2) Top Genres
    const topU1ArtistsSlice = u1ArtistsRaw.slice(0, 150);
    const topU2ArtistsSlice = u2ArtistsRaw.slice(0, 150);
    const [u1GenresMap, u2GenresMap] = await Promise.all([
      this.genreService.getGenresForArtistNames(topU1ArtistsSlice.map((a: TopArtist) => a.name)),
      this.genreService.getGenresForArtistNames(topU2ArtistsSlice.map((a: TopArtist) => a.name)),
    ]);

    const u1GenrePlays = new Map<string, number>();
    for (const a of topU1ArtistsSlice) {
      const genres = u1GenresMap.get(a.name) ?? [];
      for (const g of genres) {
        u1GenrePlays.set(g, (u1GenrePlays.get(g) ?? 0) + a.playcount);
      }
    }

    const u2GenrePlays = new Map<string, number>();
    for (const a of topU2ArtistsSlice) {
      const genres = u2GenresMap.get(a.name) ?? [];
      for (const g of genres) {
        u2GenrePlays.set(g, (u2GenrePlays.get(g) ?? 0) + a.playcount);
      }
    }

    const matchingGenres: TasteComparisonItem[] = [];
    for (const [genre, plays1] of u1GenrePlays.entries()) {
      const plays2 = u2GenrePlays.get(genre);
      if (plays2 !== undefined && plays2 > 0) {
        matchingGenres.push({
          name: genre,
          ownPlaycount: plays1,
          otherPlaycount: plays2,
        });
      }
    }
    matchingGenres.sort((a, b) => (b.ownPlaycount + b.otherPlaycount) - (a.ownPlaycount + a.otherPlaycount));

    // 3) Top Countries
    const [u1Countries, u2Countries] = await Promise.all([
      this.countryService.getTopCountriesForTopArtists(topU1ArtistsSlice.map((a: TopArtist) => ({ name: a.name, playcount: a.playcount }))),
      this.countryService.getTopCountriesForTopArtists(topU2ArtistsSlice.map((a: TopArtist) => ({ name: a.name, playcount: a.playcount }))),
    ]);

    const u2CountryMap = new Map<string, number>();
    for (const c of u2Countries) {
      u2CountryMap.set(c.countryName.toLowerCase(), c.playcount);
    }

    const matchingCountries: TasteComparisonItem[] = [];
    for (const c of u1Countries) {
      const plays2 = u2CountryMap.get(c.countryName.toLowerCase());
      if (plays2 !== undefined && plays2 > 0) {
        matchingCountries.push({
          name: c.countryName,
          ownPlaycount: c.playcount,
          otherPlaycount: plays2,
        });
      }
    }
    matchingCountries.sort((a, b) => (b.ownPlaycount + b.otherPlaycount) - (a.ownPlaycount + a.otherPlaycount));

    const now = new Date();
    const twoYearsAgo = new Date(now.getTime() - 730 * 86400 * 1000);
    const fromDateStr = `${twoYearsAgo.getFullYear()}-${twoYearsAgo.getMonth() + 1}-${twoYearsAgo.getDate()}`;
    const url = `https://last.fm/user/${encodeURIComponent(user2.userNameLastFm)}/library/artists?from=${fromDateStr}`;

    const shortKey = Math.random().toString(36).slice(2, 10);

    const tasteData: TasteData = {
      cacheKey: shortKey,
      user1DiscordId: user1.discordUserId,
      user2DiscordId: user2.discordUserId,
      user1DisplayName: user1.displayName,
      user2DisplayName: user2.displayName,
      user1UserNameLastFm: user1.userNameLastFm,
      user2UserNameLastFm: user2.userNameLastFm,
      url,
      timePeriodDescription: 'two-year',
      amount: 14,
      artists: {
        items: matchingArtists,
        totalCount: Math.min(1000, u1ArtistsRaw.length),
      },
      genres: {
        items: matchingGenres,
        totalCount: Math.max(1, u1GenrePlays.size),
      },
      countries: {
        items: matchingCountries,
        totalCount: Math.max(1, u1Countries.length),
      },
    };

    // Cache with both the full key and shortKey for button interactions
    await this.cache.set(cacheKey, tasteData, 600);
    await this.cache.set(`taste-session:${shortKey}`, tasteData, 600);

    return tasteData;
  }

  public async getCachedTasteSession(shortKey: string): Promise<TasteData | null> {
    return this.cache.get<TasteData>(`taste-session:${shortKey}`);
  }
}
