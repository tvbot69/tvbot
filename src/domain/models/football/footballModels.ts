export type FootballMatchStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'HALFTIME'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED';

export interface FootballTeam {
  name: string;
  shortName?: string;
  logo?: string;
  badge?: string; // Discord emoji string e.g. "<:fb_arsenal:123456789>"
  score?: number;
}

export interface FootballMatch {
  id: string;
  leagueId: string;
  leagueName: string;
  homeTeam: FootballTeam;
  awayTeam: FootballTeam;
  status: FootballMatchStatus;
  statusDetail?: string; // e.g. "67'", "HT", "FT", "19:00", "Postponed"
  kickoffTimestamp?: number; // Unix timestamp in seconds for Discord <t:...>
  venue?: string;
}

export interface FootballDaySchedule {
  leagueId: string;
  leagueName: string;
  leagueEmoji: string;
  leagueLogo?: string;
  date: Date;
  dateString: string; // YYYY-MM-DD
  dateOffset: number; // -1 for yesterday, 0 for today, 1 for tomorrow
  matches: FootballMatch[];
}

export interface LeagueOption {
  id: string;
  name: string;
  shortName: string;
  emoji: string;
  country: string;
  espnCode?: string;
  yallakoraKeyword?: string;
  logo?: string;
}

export const SUPPORTED_LEAGUES: LeagueOption[] = [
  {
    id: 'eng.1',
    name: 'Premier League',
    shortName: 'EPL',
    emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    country: 'England',
    espnCode: 'eng.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  },
  {
    id: 'esp.1',
    name: 'LaLiga',
    shortName: 'LaLiga',
    emoji: '🇪🇸',
    country: 'Spain',
    espnCode: 'esp.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
  },
  {
    id: 'uefa.champions',
    name: 'UEFA Champions League',
    shortName: 'UCL',
    emoji: '🏆',
    country: 'Europe',
    espnCode: 'uefa.champions',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
  },
  {
    id: 'ita.1',
    name: 'Serie A',
    shortName: 'Serie A',
    emoji: '🇮🇹',
    country: 'Italy',
    espnCode: 'ita.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/12.png',
  },
  {
    id: 'ger.1',
    name: 'Bundesliga',
    shortName: 'Bundesliga',
    emoji: '🇩🇪',
    country: 'Germany',
    espnCode: 'ger.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/10.png',
  },
  {
    id: 'fra.1',
    name: 'Ligue 1',
    shortName: 'Ligue 1',
    emoji: '🇫🇷',
    country: 'France',
    espnCode: 'fra.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/9.png',
  },
  {
    id: 'tur.1',
    name: 'Süper Lig',
    shortName: 'Süper Lig',
    emoji: '🇹🇷',
    country: 'Turkey',
    espnCode: 'tur.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/18.png',
  },
  {
    id: 'egy.1',
    name: 'Egyptian Premier League',
    shortName: 'الدوري المصري',
    emoji: '🇪🇬',
    country: 'Egypt',
    espnCode: undefined,
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/ORA_League.png/500px-ORA_League.png',
  },
  {
    id: 'ksa.1',
    name: 'Saudi Pro League',
    shortName: 'دوري روشن',
    emoji: '🇸🇦',
    country: 'Saudi Arabia',
    espnCode: 'ksa.1',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/2488.png',
  },
  {
    id: 'uefa.europa',
    name: 'UEFA Europa League',
    shortName: 'UEL',
    emoji: '🥈',
    country: 'Europe',
    espnCode: 'uefa.europa',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png',
  },
  {
    id: 'caf.champions',
    name: 'CAF Champions League',
    shortName: 'دوري أبطال أفريقيا',
    emoji: '🌍',
    country: 'Africa',
    espnCode: 'caf.champions',
    logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/2391.png',
  },
];

export function getLeagueById(id: string): LeagueOption {
  return SUPPORTED_LEAGUES.find((l) => l.id === id) ?? SUPPORTED_LEAGUES[0]!;
}

export function findLeagueByQuery(query: string): LeagueOption | undefined {
  const clean = query.trim().toLowerCase();
  return SUPPORTED_LEAGUES.find((l) =>
    l.id.toLowerCase() === clean ||
    l.name.toLowerCase().includes(clean) ||
    l.shortName.toLowerCase().includes(clean) ||
    l.country.toLowerCase().includes(clean) ||
    (clean === 'epl' && l.id === 'eng.1') ||
    (clean === 'laliga' && l.id === 'esp.1') ||
    (clean === 'ucl' && l.id === 'uefa.champions') ||
    (clean === 'uel' && l.id === 'uefa.europa') ||
    (clean === 'egypt' && l.id === 'egy.1') ||
    (clean === 'turkey' && l.id === 'tur.1') ||
    (clean === 'saudi' && l.id === 'ksa.1') ||
    (clean === 'caf' && l.id === 'caf.champions')
  );
}
