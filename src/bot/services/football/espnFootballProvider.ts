import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';
import type { FootballMatch, FootballMatchStatus, FootballTeam, LeagueOption } from '@domain/models/football/footballModels';

@injectable()
export class EspnFootballProvider {
  private readonly baseUrl = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

  /**
   * Fetches matches for a given league and date (formatted as YYYYMMDD)
   */
  public async getMatchesAsync(league: LeagueOption, dateStringYYYYMMDD: string): Promise<FootballMatch[]> {
    if (!league.espnCode) return [];

    const url = `${this.baseUrl}/${league.espnCode}/scoreboard?dates=${dateStringYYYYMMDD}`;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        Logger.warn(`[EspnFootballProvider] HTTP ${response.status} fetching ${url}`);
        return [];
      }

      const data = await response.json();
      const events: any[] = data.events || [];
      const results: FootballMatch[] = [];

      for (const event of events) {
        const competition = event.competitions?.[0];
        if (!competition) continue;

        const competitors: any[] = competition.competitors || [];
        const home = competitors.find((c) => c.homeAway === 'home');
        const away = competitors.find((c) => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeTeam: FootballTeam = {
          name: home.team?.displayName || home.team?.name || 'Home Team',
          shortName: home.team?.shortDisplayName || home.team?.abbreviation,
          logo: home.team?.logo,
          score: home.score !== undefined && home.score !== null ? parseInt(home.score, 10) : undefined,
        };

        const awayTeam: FootballTeam = {
          name: away.team?.displayName || away.team?.name || 'Away Team',
          shortName: away.team?.shortDisplayName || away.team?.abbreviation,
          logo: away.team?.logo,
          score: away.score !== undefined && away.score !== null ? parseInt(away.score, 10) : undefined,
        };

        const statusRaw = event.status?.type?.name || '';
        const stateRaw = event.status?.type?.state || ''; // pre, in, post
        let status: FootballMatchStatus = 'SCHEDULED';
        let statusDetail: string | undefined = event.status?.type?.shortDetail || event.status?.type?.detail;

        if (stateRaw === 'in') {
          if (statusRaw.includes('HALFTIME') || statusRaw === 'STATUS_HALFTIME') {
            status = 'HALFTIME';
            statusDetail = 'HT';
          } else {
            status = 'LIVE';
            statusDetail = event.status?.displayClock ? `${event.status.displayClock}` : 'LIVE';
          }
        } else if (stateRaw === 'post') {
          status = 'FINISHED';
          statusDetail = statusRaw.includes('PEN') ? 'FT (PEN)' : statusRaw.includes('AET') ? 'AET' : 'FT';
        } else if (statusRaw.includes('POSTPONED') || statusRaw.includes('CANCEL')) {
          status = 'POSTPONED';
          statusDetail = 'Postponed';
        }

        // Parse UTC Kickoff
        let kickoffTimestamp: number | undefined;
        if (event.date) {
          const d = new Date(event.date);
          if (!isNaN(d.getTime())) {
            kickoffTimestamp = Math.floor(d.getTime() / 1000);
          }
        }

        results.push({
          id: `espn_${event.id || Math.random().toString(36).substring(7)}`,
          leagueId: league.id,
          leagueName: league.name,
          homeTeam,
          awayTeam,
          status,
          statusDetail,
          kickoffTimestamp,
          venue: competition.venue?.fullName || competition.venue?.address?.city,
        });
      }

      return results;
    } catch (err: any) {
      Logger.error(`[EspnFootballProvider] Failed to fetch matches for ${league.name}: ${err.message}`);
      return [];
    }
  }
}
