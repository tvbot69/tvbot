import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';
import type { FootballMatch, FootballMatchStatus, FootballTeam, LeagueOption } from '@domain/models/football/footballModels';

@injectable()
export class ApiFootballProvider {
  private readonly apiKey = process.env.API_FOOTBALL_KEY || '';
  private readonly baseUrl = 'https://v3.football.api-sports.io';

  /**
   * League mapping in API-Football
   */
  private readonly leagueIdMap: Record<string, number> = {
    'eng.1': 39, // Premier League
    'esp.1': 140, // La Liga
    'ita.1': 135, // Serie A
    'ger.1': 78, // Bundesliga
    'fra.1': 61, // Ligue 1
    'uefa.champions': 2, // UCL
    'uefa.europa': 3, // UEL
    'tur.1': 203, // Süper Lig
    'egy.1': 233, // Egyptian Premier League
    'ksa.1': 307, // Saudi Pro League
    'caf.champions': 12, // CAF Champions League
  };

  public isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.trim().length > 0;
  }

  /**
   * Fetches matches from API-Football for a given league and date (YYYY-MM-DD)
   */
  public async getMatchesAsync(league: LeagueOption, dateStringYYYYMMDD: string): Promise<FootballMatch[]> {
    if (!this.isConfigured()) return [];

    const apiLeagueId = this.leagueIdMap[league.id];
    if (!apiLeagueId) return [];

    const formattedDate = dateStringYYYYMMDD.length === 8
      ? `${dateStringYYYYMMDD.substring(0, 4)}-${dateStringYYYYMMDD.substring(4, 6)}-${dateStringYYYYMMDD.substring(6, 8)}`
      : dateStringYYYYMMDD;

    const url = `${this.baseUrl}/fixtures?league=${apiLeagueId}&date=${formattedDate}`;
    try {
      const response = await fetch(url, {
        headers: {
          'x-apisports-key': this.apiKey,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        Logger.warn(`[ApiFootballProvider] HTTP ${response.status} from API-Football`);
        return [];
      }

      const data = await response.json();
      const fixtures: any[] = data.response || [];
      const results: FootballMatch[] = [];

      for (const item of fixtures) {
        const fixture = item.fixture;
        const teams = item.teams;
        const goals = item.goals;
        if (!fixture || !teams) continue;

        const homeTeam: FootballTeam = {
          name: teams.home?.name || 'Home',
          logo: teams.home?.logo,
          score: goals.home !== null ? goals.home : undefined,
        };

        const awayTeam: FootballTeam = {
          name: teams.away?.name || 'Away',
          logo: teams.away?.logo,
          score: goals.away !== null ? goals.away : undefined,
        };

        const statusShort = fixture.status?.short || '';
        let status: FootballMatchStatus = 'SCHEDULED';
        let statusDetail = fixture.status?.elapsed ? `${fixture.status.elapsed}'` : fixture.status?.long;

        if (['1H', '2H', 'ET', 'LIVE'].includes(statusShort)) {
          status = 'LIVE';
          statusDetail = `${fixture.status?.elapsed || 'LIVE'}'`;
        } else if (statusShort === 'HT') {
          status = 'HALFTIME';
          statusDetail = 'HT';
        } else if (['FT', 'AET', 'PEN'].includes(statusShort)) {
          status = 'FINISHED';
          statusDetail = statusShort;
        } else if (['PST', 'CANC', 'ABD'].includes(statusShort)) {
          status = 'POSTPONED';
          statusDetail = 'Postponed';
        }

        let kickoffTimestamp: number | undefined;
        if (fixture.timestamp) {
          kickoffTimestamp = fixture.timestamp;
        } else if (fixture.date) {
          const d = new Date(fixture.date);
          if (!isNaN(d.getTime())) {
            kickoffTimestamp = Math.floor(d.getTime() / 1000);
          }
        }

        results.push({
          id: `apifb_${fixture.id}`,
          leagueId: league.id,
          leagueName: item.league?.name || league.name,
          homeTeam,
          awayTeam,
          status,
          statusDetail,
          kickoffTimestamp,
          venue: fixture.venue?.name || fixture.venue?.city,
        });
      }

      return results;
    } catch (err: any) {
      Logger.error(`[ApiFootballProvider] Error fetching fixtures: ${err.message}`);
      return [];
    }
  }
}
