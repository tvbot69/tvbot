import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { EspnFootballProvider } from '@bot/services/football/espnFootballProvider';
import { EgyptianFootballProvider } from '@bot/services/football/egyptianFootballProvider';
import { ApiFootballProvider } from '@bot/services/football/apiFootballProvider';
import { FootballBadgeService, normalizeTeamSlug } from '@bot/services/football/footballBadgeService';
import { FootballService } from '@bot/services/football/footballService';
import { FootballBuilders } from '@bot/builders/footballBuilders';
import { SUPPORTED_LEAGUES, getLeagueById, findLeagueByQuery } from '@domain/models/football/footballModels';

describe('Football System Tests', () => {
  const espn = new EspnFootballProvider();
  const egyptian = new EgyptianFootballProvider();
  const apiFb = new ApiFootballProvider();
  const badges = new FootballBadgeService();
  const service = new FootballService(espn, egyptian, apiFb, badges);

  it('should find leagues by query aliases', () => {
    expect(findLeagueByQuery('epl')?.id).toBe('eng.1');
    expect(findLeagueByQuery('laliga')?.id).toBe('esp.1');
    expect(findLeagueByQuery('ucl')?.id).toBe('uefa.champions');
    expect(findLeagueByQuery('turkey')?.id).toBe('tur.1');
    expect(findLeagueByQuery('egypt')?.id).toBe('egy.1');
    expect(findLeagueByQuery('saudi')?.id).toBe('ksa.1');
  });

  it('should fetch Premier League matches via ESPN', async () => {
    const schedule = await service.getScheduleAsync('eng.1', 0);
    expect(schedule.leagueId).toBe('eng.1');
    expect(schedule.leagueName).toBe('Premier League');
    expect(Array.isArray(schedule.matches)).toBe(true);
  }, 10000);

  it('should fetch Turkish Super Lig matches via ESPN', async () => {
    const schedule = await service.getScheduleAsync('tur.1', 0);
    expect(schedule.leagueId).toBe('tur.1');
    expect(Array.isArray(schedule.matches)).toBe(true);
  }, 10000);

  it('should fetch Egyptian League / African matches via Egyptian Provider', async () => {
    const schedule = await service.getScheduleAsync('egy.1', 0);
    expect(schedule.leagueId).toBe('egy.1');
    expect(Array.isArray(schedule.matches)).toBe(true);
  }, 10000);

  it('should never return African matches under UEFA Champions League', async () => {
    const schedule = await service.getScheduleAsync('uefa.champions', 2);
    expect(schedule.leagueId).toBe('uefa.champions');
    for (const m of schedule.matches) {
      expect(m.homeTeam.name).not.toContain('بيراميدز');
      expect(m.homeTeam.name).not.toContain('الزمالك');
      expect(m.homeTeam.name).not.toContain('الأهلي');
    }
  });

  it('should correctly normalize team names to valid Discord emoji slugs', () => {
    expect(normalizeTeamSlug('1. FC Union Berlin')).toBe('fb_union_berlin');
    expect(normalizeTeamSlug('Schalke 04')).toBe('fb_schalke_04');
    expect(normalizeTeamSlug('FC Barcelona')).toBe('fb_barcelona');
    expect(normalizeTeamSlug('Bayern München')).toBe('fb_bayern_munchen');
    expect(normalizeTeamSlug('Paris Saint-Germain')).toBe('fb_paris_saint_germain');
    expect(normalizeTeamSlug('الأهلي')).toMatch(/^fb_team_[a-z0-9]+$/);
  });

  it('should correctly build a Discord Components V2 Container response with league logo and badges', async () => {
    const schedule = await service.getScheduleAsync('eng.1', 0);
    const response = FootballBuilders.buildMatchesResponse(schedule);

    expect(response.isComponentsV2).toBe(true);
    expect(response.componentsV2Container).toBeDefined();

    const payload = response.toMessagePayload();
    expect(payload.components).toBeDefined();
    expect(payload.flags).toBeDefined();
  });
});
