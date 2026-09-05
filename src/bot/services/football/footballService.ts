import { injectable, inject } from 'tsyringe';
import { Logger } from '@domain/logger';
import {
  type FootballDaySchedule,
  type FootballMatch,
  type LeagueOption,
  getLeagueById,
  SUPPORTED_LEAGUES,
} from '@domain/models/football/footballModels';
import { EspnFootballProvider } from './espnFootballProvider';
import { EgyptianFootballProvider } from './egyptianFootballProvider';
import { ApiFootballProvider } from './apiFootballProvider';
import { FootballBadgeService } from './footballBadgeService';

interface CacheEntry {
  schedule: FootballDaySchedule;
  expiresAt: number;
}

@injectable()
export class FootballService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @inject(EspnFootballProvider) private readonly espnProvider: EspnFootballProvider,
    @inject(EgyptianFootballProvider) private readonly egyptianProvider: EgyptianFootballProvider,
    @inject(ApiFootballProvider) private readonly apiFootballProvider: ApiFootballProvider,
    @inject(FootballBadgeService) private readonly badgeService: FootballBadgeService,
  ) {}

  /**
   * Retrieves matches for a given league and date offset (-1 = yesterday, 0 = today, 1 = tomorrow, etc.)
   */
  public async getScheduleAsync(leagueId: string, dateOffset = 0, forceRefresh = false): Promise<FootballDaySchedule> {
    const league = getLeagueById(leagueId);
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + dateOffset);

    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    const dateStringYYYYMMDD = `${year}${month}${day}`;
    const dateStringISO = `${year}-${month}-${day}`;

    const cacheKey = `${league.id}_${dateStringYYYYMMDD}`;
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.schedule;
      }
    }

    let matches: FootballMatch[] = [];

    // Routing strategy based on league
    if (league.id === 'egy.1') {
      // 1. Primary for Egyptian league: EgyptianFootballProvider (YallaKora)
      try {
        matches = await this.egyptianProvider.getMatchesAsync(league, targetDate);
      } catch (err: any) {
        Logger.warn(`[FootballService] EgyptianProvider failed for ${league.name}: ${err.message}`);
      }

      // 2. Fallback: API-Football if configured
      if (matches.length === 0 && this.apiFootballProvider.isConfigured()) {
        try {
          matches = await this.apiFootballProvider.getMatchesAsync(league, dateStringYYYYMMDD);
        } catch (err: any) {
          Logger.warn(`[FootballService] ApiFootballProvider failed: ${err.message}`);
        }
      }
    } else if (league.id === 'caf.champions') {
      // 1. Primary for CAF: ESPN
      if (league.espnCode) {
        try {
          matches = await this.espnProvider.getMatchesAsync(league, dateStringYYYYMMDD);
        } catch (err: any) {
          Logger.warn(`[FootballService] EspnProvider failed for ${league.name}: ${err.message}`);
        }
      }

      // 2. Fallback: Egyptian / African provider (YallaKora)
      if (matches.length === 0) {
        try {
          matches = await this.egyptianProvider.getMatchesAsync(league, targetDate);
        } catch (err: any) {
          Logger.warn(`[FootballService] EgyptianProvider fallback failed for ${league.name}: ${err.message}`);
        }
      }
    } else {
      // For Top European Leagues, Turkish Süper Lig, Saudi Pro League:
      // Exclusively authoritative via ESPN (no cross-contamination from regional scrapers)
      if (league.espnCode) {
        try {
          matches = await this.espnProvider.getMatchesAsync(league, dateStringYYYYMMDD);
        } catch (err: any) {
          Logger.warn(`[FootballService] EspnProvider failed for ${league.name}: ${err.message}`);
        }
      }
    }

    // Sort matches: Live first, then Scheduled by kickoff time, then Finished
    matches.sort((a, b) => {
      const statusWeight = (m: FootballMatch) => {
        if (m.status === 'LIVE' || m.status === 'HALFTIME') return 0;
        if (m.status === 'SCHEDULED') return 1;
        if (m.status === 'FINISHED') return 2;
        return 3;
      };

      const weightA = statusWeight(a);
      const weightB = statusWeight(b);
      if (weightA !== weightB) return weightA - weightB;

      if (a.kickoffTimestamp && b.kickoffTimestamp) {
        return a.kickoffTimestamp - b.kickoffTimestamp;
      }
      return 0;
    });

    const schedule: FootballDaySchedule = {
      leagueId: league.id,
      leagueName: league.name,
      leagueEmoji: league.emoji,
      leagueLogo: league.logo,
      date: targetDate,
      dateString: dateStringISO,
      dateOffset,
      matches,
    };

    // Enrich teams with Discord application emoji club badges
    try {
      await this.badgeService.resolveScheduleBadgesAsync(schedule);
    } catch (err: any) {
      Logger.warn(`[FootballService] Error resolving team badges: ${err.message}`);
    }

    // Cache TTL: 2 minutes if any match is LIVE, otherwise 15 minutes
    const hasLiveMatch = matches.some((m) => m.status === 'LIVE' || m.status === 'HALFTIME');
    const ttlMs = hasLiveMatch ? 2 * 60 * 1000 : 15 * 60 * 1000;
    this.cache.set(cacheKey, {
      schedule,
      expiresAt: now + ttlMs,
    });

    return schedule;
  }

  public getSupportedLeagues(): LeagueOption[] {
    return SUPPORTED_LEAGUES;
  }
}
