import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';
import type { FootballMatch, FootballMatchStatus, FootballTeam, LeagueOption } from '@domain/models/football/footballModels';

@injectable()
export class EgyptianFootballProvider {
  private readonly baseUrl = 'https://www.yallakora.com/match-center';

  /**
   * Fetches matches for Egyptian Premier League / African tournaments for a specific date
   * @param date Date object
   */
  public async getMatchesAsync(league: LeagueOption, date: Date): Promise<FootballMatch[]> {
    try {
      const m = date.getMonth() + 1;
      const d = date.getDate();
      const y = date.getFullYear();
      const dateParam = `${m}/${d}/${y}`;

      const url = `${this.baseUrl}?date=${dateParam}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(9000),
      });

      if (!response.ok) {
        Logger.warn(`[EgyptianFootballProvider] HTTP ${response.status} from ${url}`);
        return [];
      }

      const html = await response.text();
      const cards = html.split(/class="[^"]*matchCard matchesList"/i);
      const matches: FootballMatch[] = [];

      for (let i = 1; i < cards.length; i++) {
        const card = cards[i];
        if (!card) continue;

        const tourTitleMatch = card.match(/<h2>([\s\S]*?)<\/h2>/i);
        const tourName = tourTitleMatch && tourTitleMatch[1] ? tourTitleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        const enNameMatch = card.match(/enName="([^"]+)"/i);
        const enName = enNameMatch && enNameMatch[1] ? enNameMatch[1].trim() : '';

        // Check if this tournament matches the requested league
        const isTargetTour = this.matchesLeagueFilter(league, tourName, enName);
        if (!isTargetTour) continue;

        // Split by match items
        const items = card.split(/class="[^"]*item\s+[^"]*liItem[^"]*"/i);
        for (let j = 1; j < items.length; j++) {
          const item = items[j];
          if (!item) continue;

          const teamAMatch = item.match(/class="teams teamA"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
          const teamA = teamAMatch && teamAMatch[1] ? teamAMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const teamBMatch = item.match(/class="teams teamB"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
          const teamB = teamBMatch && teamBMatch[1] ? teamBMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          if (!teamA || !teamB) continue;

          const logoAMatch = item.match(/class="teams teamA"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/i);
          const logoA = logoAMatch && logoAMatch[1] ? logoAMatch[1].replace(/\\/g, '/') : undefined;

          const logoBMatch = item.match(/class="teams teamB"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/i);
          const logoB = logoBMatch && logoBMatch[1] ? logoBMatch[1].replace(/\\/g, '/') : undefined;

          const statusMatch = item.match(/class="matchStatus"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i);
          const statusText = statusMatch && statusMatch[1] ? statusMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const timeMatch = item.match(/class="time"[^>]*>([\s\S]*?)<\/span>/i);
          const matchTime = timeMatch && timeMatch[1] ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const channelMatch = item.match(/class="channel[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
          const channel = channelMatch && channelMatch[1] ? channelMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          // Scores
          const scoreMatches = [...item.matchAll(/class="score"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
            m[1] ? m[1].replace(/<[^>]+>/g, '').trim() : ''
          );
          const scoreA =
            scoreMatches[0] !== undefined && scoreMatches[0] !== '-' && !isNaN(parseInt(scoreMatches[0], 10))
              ? parseInt(scoreMatches[0], 10)
              : undefined;
          const scoreB =
            scoreMatches[1] !== undefined && scoreMatches[1] !== '-' && !isNaN(parseInt(scoreMatches[1], 10))
              ? parseInt(scoreMatches[1], 10)
              : undefined;

          // Determine status
          let status: FootballMatchStatus = 'SCHEDULED';
          let statusDetail = matchTime || 'Scheduled';

          const sLower = statusText.toLowerCase();
          if (statusText.includes('انتهت') || sLower.includes('ft') || sLower.includes('finish')) {
            status = 'FINISHED';
            statusDetail = 'FT';
          } else if (
            statusText.includes('الشوط') ||
            statusText.includes('مباشر') ||
            statusText.includes('جارية') ||
            sLower.includes('live')
          ) {
            status = 'LIVE';
            statusDetail = statusText || 'LIVE';
          } else if (statusText.includes('استراحة') || statusText.includes('بين الشوطين')) {
            status = 'HALFTIME';
            statusDetail = 'HT';
          } else if (statusText.includes('تأجلت') || statusText.includes('مؤجلة')) {
            status = 'POSTPONED';
            statusDetail = 'Postponed';
          }

          // Calculate approximate timestamp if time is available (e.g. "20:00" Egypt Time UTC+3 / UTC+2)
          let kickoffTimestamp: number | undefined;
          if (matchTime && matchTime.includes(':')) {
            const [hoursStr, minsStr] = matchTime.split(':');
            if (hoursStr && minsStr) {
              const hours = parseInt(hoursStr, 10);
              const mins = parseInt(minsStr, 10);
              if (!isNaN(hours) && !isNaN(mins)) {
                // Assume Cairo time (UTC+3)
                const matchDate = new Date(Date.UTC(y, m - 1, d, hours - 3, mins));
                if (!isNaN(matchDate.getTime())) {
                  kickoffTimestamp = Math.floor(matchDate.getTime() / 1000);
                }
              }
            }
          }

          const homeTeam: FootballTeam = {
            name: teamA,
            logo: logoA,
            score: scoreA,
          };

          const awayTeam: FootballTeam = {
            name: teamB,
            logo: logoB,
            score: scoreB,
          };

          matches.push({
            id: `yk_${tourName}_${teamA}_${teamB}_${dateParam}`,
            leagueId: league.id,
            leagueName: tourName || league.name,
            homeTeam,
            awayTeam,
            status,
            statusDetail,
            kickoffTimestamp,
            venue: channel ? `Broadcast: ${channel}` : undefined,
          });
        }
      }

      return matches;
    } catch (err: any) {
      Logger.error(`[EgyptianFootballProvider] Error scraping Egyptian matches: ${err.message}`);
      return [];
    }
  }

  private matchesLeagueFilter(league: LeagueOption, tourName: string, enName: string): boolean {
    const combined = `${tourName} ${enName}`.toLowerCase();
    if (league.id === 'egy.1') {
      return (
        (combined.includes('الدوري المصري') ||
          combined.includes('egyptian premier') ||
          tourName === 'الدوري المصري') &&
        !combined.includes('second') &&
        !combined.includes('القسم الثاني') &&
        !combined.includes('المحترفين') &&
        !combined.includes('دوري المحترفين')
      );
    }
    if (league.id === 'caf.champions') {
      return (
        combined.includes('أبطال أفريقيا') ||
        combined.includes('african-champions') ||
        combined.includes('caf-champions')
      );
    }
    return false;
  }
}
