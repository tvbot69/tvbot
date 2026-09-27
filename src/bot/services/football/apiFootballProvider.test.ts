import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiFootballProvider } from './apiFootballProvider';
import type { LeagueOption } from '@domain/models/football/footballModels';

/**
 * A crash the type annotations surfaced.
 *
 * API-Football's fixture list was read as `any[]`, so nothing checked the
 * shape. Typing it as ApiFootballFixturesResponse immediately produced
 * "'goals' is possibly 'undefined'" at `goals.home !== null`.
 *
 * The code already guarded the two fields INSIDE goals - `goals.home !== null`
 * and `goals.away !== null` - which shows the author knew the values could be
 * null. What nobody guarded was goals itself. API-Football omits the object for
 * some pre-match fixture states, so `goals.home` on an absent goals threw a
 * TypeError, and because it threw inside the loop over a single fetch, it took
 * down the whole day's schedule rather than skipping one fixture.
 *
 * So this asserts the degradation: a fixture missing `goals` is skipped, and
 * the surrounding fixtures still come back. Before the fix the call rejected.
 */

// A full LeagueOption, since the provider reads leagueIdMap[league.id] and a
// partial object sent it to `undefined` - which is what the first run of this
// file did, so the shape is spelled out rather than cast.
const LEAGUE: LeagueOption = {
  id: 'premier-league',
  name: 'Premier League',
  shortName: 'PL',
  emoji: ':england:',
  country: 'England',
};

const makeProvider = () => {
  const provider = Object.create(ApiFootballProvider.prototype) as ApiFootballProvider;
  (provider as unknown as { apiKey: string }).apiKey = 'test-key';
  (provider as unknown as { baseUrl: string }).baseUrl = 'https://v3.football.api-sports.io';
  (provider as unknown as { leagueIdMap: Record<string, number> }).leagueIdMap = { 'premier-league': 39 };
  return provider;
};

const withFetch = (body: unknown, status = 200) => {
  const fetchSpy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
};

describe('ApiFootballProvider.getMatchesAsync', () => {
  beforeEach(() => { vi.stubEnv('API_FOOTBALL_KEY', 'test-key'); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('returns fixtures that carry a goals object', async () => {
    withFetch({
      response: [{
        fixture: { id: 1, date: '2026-09-27T15:00:00+00:00', status: { short: 'FT' } },
        teams: { home: { name: 'Arsenal', logo: 'h.png' }, away: { name: 'Chelsea', logo: 'a.png' } },
        goals: { home: 2, away: 1 },
      }],
    });

    const matches = await makeProvider().getMatchesAsync(LEAGUE, '2026-09-27');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.homeTeam.score).toBe(2);
    expect(matches[0]?.awayTeam.score).toBe(1);
  });

  it('skips a fixture with no goals object instead of throwing', async () => {
    // The regression. `goals.home` on an absent goals is a TypeError, and it
    // escaped the whole call rather than skipping one row.
    withFetch({
      response: [{
        fixture: { id: 1, date: '2026-09-27T15:00:00+00:00', status: { short: 'NS' } },
        teams: { home: { name: 'Arsenal' }, away: { name: 'Chelsea' } },
        // no `goals` key at all
      }],
    });

    const matches = await makeProvider().getMatchesAsync(LEAGUE, '2026-09-27');
    expect(matches).toEqual([]);
  });

  it('keeps the good fixtures when a bad one is interleaved', async () => {
    // The important part: one malformed row must not lose the rest of the day.
    withFetch({
      response: [
        {
          fixture: { id: 1, date: '2026-09-27T15:00:00+00:00' },
          teams: { home: { name: 'A' }, away: { name: 'B' } },
          goals: { home: 1, away: 0 },
        },
        {
          fixture: { id: 2, date: '2026-09-27T17:00:00+00:00' },
          teams: { home: { name: 'C' }, away: { name: 'D' } },
          // goals missing
        },
        {
          fixture: { id: 3, date: '2026-09-27T19:00:00+00:00' },
          teams: { home: { name: 'E' }, away: { name: 'F' } },
          goals: { home: null, away: null },
        },
      ],
    });

    const matches = await makeProvider().getMatchesAsync(LEAGUE, '2026-09-27');
    // Row 3 has a goals object with null values, which is the documented
    // "not started" state and is kept - with undefined scores, not 0.
    expect(matches).toHaveLength(2);
    // Ids are namespaced `apifb_<id>` so they cannot collide with the other
    // providers' `espn_<id>` / `yallakora` schemes once results are merged.
    expect(matches.map((m) => m.id)).toEqual(['apifb_1', 'apifb_3']);
    expect(matches[1]?.homeTeam.score).toBeUndefined();
  });

  it('treats a null score as not-started, not as zero', async () => {
    // Guards the distinction the fixture above depends on: `null` means
    // "no goals recorded yet" and must not render as 0-0.
    withFetch({
      response: [{
        fixture: { id: 9, date: '2026-09-27T15:00:00+00:00' },
        teams: { home: { name: 'A' }, away: { name: 'B' } },
        goals: { home: null, away: null },
      }],
    });

    const [match] = await makeProvider().getMatchesAsync(LEAGUE, '2026-09-27');
    expect(match?.homeTeam.score).toBeUndefined();
    expect(match?.awayTeam.score).toBeUndefined();
  });

  it('returns an empty list for an error body with no response array', async () => {
    // API-Football answers a bad key with `{ errors: {...} }`. Previously
    // `data.response || []` handled that via the `any`; keep it held.
    withFetch({ errors: { 'apikey': 'Invalid API key' } });

    await expect(makeProvider().getMatchesAsync(LEAGUE, '2026-09-27')).resolves.toEqual([]);
  });

  it('returns an empty list on a non-2xx response', async () => {
    withFetch({}, 429);
    await expect(makeProvider().getMatchesAsync(LEAGUE, '2026-09-27')).resolves.toEqual([]);
  });
});
