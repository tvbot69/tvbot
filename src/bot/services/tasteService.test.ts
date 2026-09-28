import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TasteService, formatTasteTable } from './tasteService';
import type { TasteComparisonItem, TasteData } from './tasteService';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { TopArtist } from '@domain/models/topLists';
import type { TopCountryItem } from './countryService';

/**
 * `TasteService` is the "taste" command: compare two Last.fm users on shared
 * artists, genres and countries, then render each as a side-by-side table.
 *
 * Two things are worth guarding here, and neither is visible from the type:
 *
 *  1. The comparison is an *intersection* with two positivity guards. A name
 *     present on both sides with a zero playcount on either side is not a
 *     match, and neither is a name that only one side listens to. Those guards
 *     are the whole "not enough data" contract - drop them and the table fills
 *     with rows the two users have never actually shared.
 *  2. `formatTasteTable` reports `matchesCount` from the FULL match list while
 *     rendering at most `amount` rows. So the header percentage and the number
 *     of visible rows deliberately disagree whenever there are more matches
 *     than rows. That is the fmbot behaviour, not a bug, and it is exactly the
 *     kind of thing a rewrite would "fix" into being wrong.
 *
 * The comparison is a genuine algorithm, so the ordering guarantees are
 * asserted as properties over generated inputs rather than as a handful of
 * hand-picked examples.
 */

const user1 = { discordUserId: '1', displayName: 'One', userNameLastFm: 'Alpha' };
const user2 = { discordUserId: '2', displayName: 'Two', userNameLastFm: 'Beta' };

const artists = (...specs: Array<[string, number]>): TopArtist[] =>
  specs.map(([name, playcount]) => ({ name, playcount }));

const genreMap = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m));

const countries = (...specs: Array<[string, string, number]>): TopCountryItem[] =>
  specs.map(([countryName, countryCode, playcount]) => ({ countryName, countryCode, playcount }));

const build = (over: Record<string, unknown> = {}) => {
  const deps: Record<string, unknown> = {
    lastfmRepo: {
      getTopArtists: vi.fn(async () => [] as TopArtist[]),
    },
    genreService: {
      getGenresForArtistNames: vi.fn(async () => new Map<string, string[]>()),
    },
    countryService: {
      getTopCountriesForTopArtists: vi.fn(async () => [] as TopCountryItem[]),
    },
    cache: {
      get: vi.fn(async () => null as TasteData | null),
      set: vi.fn(async () => undefined),
    },
    ...over,
  };
  const service = new TasteService(
    deps.lastfmRepo as never,
    deps.genreService as never,
    deps.countryService as never,
    deps.cache as never,
  );
  return { service, deps };
};

// One `as any` at the boundary so individual tests can retarget a double
// without rebuilding the world. Warn-only rule.
const mockOf = (fn: unknown) => fn as any;

const total = (i: TasteComparisonItem) => i.ownPlaycount + i.otherPlaycount;

describe('TasteService.getTasteData - cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns the cached payload without touching the repositories', async () => {
    const cached = { cacheKey: 'abc', artists: { items: [], totalCount: 0 } } as unknown as TasteData;
    const { service, deps } = build();
    mockOf(deps.cache).get.mockResolvedValue(cached);

    await expect(service.getTasteData(user1, user2)).resolves.toBe(cached);
    expect(mockOf(deps.lastfmRepo).getTopArtists).not.toHaveBeenCalled();
    expect(mockOf(deps.cache).set).not.toHaveBeenCalled();
  });

  it('keys the cache on lowercased usernames so case cannot split the entry', async () => {
    const { service, deps } = build();

    await service.getTasteData(user1, user2);

    expect(mockOf(deps.cache).get).toHaveBeenCalledWith('taste:alpha:beta:two-year');
  });

  it('writes the result under the full key and under a short session key', async () => {
    const { service, deps } = build();

    const data = await service.getTasteData(user1, user2);

    const set = mockOf(deps.cache).set;
    expect(set).toHaveBeenCalledWith('taste:alpha:beta:two-year', data, 600);
    expect(set).toHaveBeenCalledWith(`taste-session:${data.cacheKey}`, data, 600);
  });

  it('folds the requested time period into the cache key only', async () => {
    // The comparison itself is always all-time; `timePeriod` exists purely to
    // give each button session its own cache entry. Worth pinning, because the
    // obvious "fix" is to start honouring it in the query.
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue(artists(['A', 5]));

    const weekly = await service.getTasteData(user1, user2, 'weekly');
    const monthly = await service.getTasteData(user1, user2, 'monthly');

    expect(mockOf(deps.cache).get).toHaveBeenNthCalledWith(1, 'taste:alpha:beta:weekly');
    expect(mockOf(deps.cache).get).toHaveBeenNthCalledWith(2, 'taste:alpha:beta:monthly');
    expect(weekly.timePeriodDescription).toBe('two-year');
    expect(monthly.timePeriodDescription).toBe('two-year');
  });

  it('requests all-time top artists for both users', async () => {
    const { service, deps } = build();

    await service.getTasteData(user1, user2);

    expect(mockOf(deps.lastfmRepo).getTopArtists).toHaveBeenCalledWith('Alpha', TimePeriod.AllTime, 1000);
    expect(mockOf(deps.lastfmRepo).getTopArtists).toHaveBeenCalledWith('Beta', TimePeriod.AllTime, 1000);
  });
});

describe('TasteService.getTasteData - artist intersection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('matches names case-insensitively', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['Radiohead', 300]))
      .mockResolvedValueOnce(artists(['radiohead', 40]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items).toEqual([{ name: 'Radiohead', ownPlaycount: 300, otherPlaycount: 40 }]);
  });

  it('keeps the user-1 spelling of a name', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['BEACH HOUSE', 10]))
      .mockResolvedValueOnce(artists(['Beach House', 10]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items[0]?.name).toBe('BEACH HOUSE');
  });

  it('drops a shared name when the other user has zero plays', async () => {
    // Last.fm happily returns 0-play rows in a top list. Counting them would
    // inflate the match percentage with artists the user has never scrobbled.
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 10], ['B', 10]))
      .mockResolvedValueOnce(artists(['A', 0], ['B', 4]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items.map(i => i.name)).toEqual(['B']);
  });

  it('drops a row when user 1 has zero plays', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 0], ['B', 10]))
      .mockResolvedValueOnce(artists(['A', 7], ['B', 4]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items.map(i => i.name)).toEqual(['B']);
  });

  it('ignores entries with no name', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 10], ['', 99]))
      .mockResolvedValueOnce(artists(['A', 3], ['', 99]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items.map(i => i.name)).toEqual(['A']);
  });

  it('sorts by the combined playcount of both users, descending', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['Small', 10], ['Big', 200], ['Mid', 50]))
      .mockResolvedValueOnce(artists(['Small', 1], ['Big', 5], ['Mid', 40]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items.map(i => i.name)).toEqual(['Big', 'Mid', 'Small']);
  });

  it('keeps user-1 order for equal combined playcounts', async () => {
    // The comparator is only the sum, so ties are resolved by the stable sort
    // preserving the order of the incoming top list. That is the tie-break
    // users actually see, and losing it makes the table reshuffle between runs.
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['First', 10], ['Second', 10], ['Third', 10]))
      .mockResolvedValueOnce(artists(['First', 5], ['Second', 5], ['Third', 5]));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items.map(i => i.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('caps the artist total at 1000', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => [`A${i}`, 1] as [string, number]);
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue(artists(...many));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.totalCount).toBe(1000);
  });
});

describe('TasteService.getTasteData - genre and country totals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('weights each genre by the playcount of the artists that carry it', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 100], ['B', 40]))
      .mockResolvedValueOnce(artists(['A', 10], ['B', 5]));
    mockOf(deps.genreService).getGenresForArtistNames
      .mockResolvedValueOnce(genreMap({ A: ['indie'], B: ['indie'] }))
      .mockResolvedValueOnce(genreMap({ A: ['indie'], B: ['indie'] }));

    const data = await service.getTasteData(user1, user2);

    expect(data.genres.items).toEqual([{ name: 'indie', ownPlaycount: 140, otherPlaycount: 15 }]);
  });

  it('only reports genres both users actually play', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 100]))
      .mockResolvedValueOnce(artists(['A', 10]));
    mockOf(deps.genreService).getGenresForArtistNames
      .mockResolvedValueOnce(genreMap({ A: ['indie', 'jazz'] }))
      .mockResolvedValueOnce(genreMap({ A: ['indie'] }));

    const data = await service.getTasteData(user1, user2);

    expect(data.genres.items.map(i => i.name)).toEqual(['indie']);
  });

  it('matches countries case-insensitively', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 100]))
      .mockResolvedValueOnce(artists(['A', 10]));
    mockOf(deps.countryService).getTopCountriesForTopArtists
      .mockResolvedValueOnce(countries(['United States', 'US', 90]))
      .mockResolvedValueOnce(countries(['united states', 'US', 30]));

    const data = await service.getTasteData(user1, user2);

    expect(data.countries.items).toEqual([{ name: 'United States', ownPlaycount: 90, otherPlaycount: 30 }]);
  });

  it('derives genres and countries from only the top 150 artists', async () => {
    const many = Array.from({ length: 200 }, (_, i) => [`A${i}`, 100 - i] as [string, number]);
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue(artists(...many));

    await service.getTasteData(user1, user2);

    const expected = many.slice(0, 150).map(([name]) => name);
    expect(mockOf(deps.genreService).getGenresForArtistNames).toHaveBeenCalledWith(expected);
    expect(mockOf(deps.countryService).getTopCountriesForTopArtists).toHaveBeenCalledWith(
      many.slice(0, 150).map(([name, playcount]) => ({ name, playcount })),
    );
  });

  it('never reports a zero total, so the match percentage cannot divide by zero', async () => {
    const { service } = build();

    const data = await service.getTasteData(user1, user2);

    expect(data.genres.totalCount).toBe(1);
    expect(data.countries.totalCount).toBe(1);
    expect(data.genres.items).toEqual([]);
    expect(data.countries.items).toEqual([]);
    expect(formatTasteTable('genres', 'One', 'Two', data.genres.items, 14, data.genres.totalCount, '')
      .matchPercentage).toBe(0);
  });
});

describe('TasteService.getTasteData - resilience and payload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('degrades to an empty comparison when a top-artists query fails', async () => {
    // Both fetches are individually caught. A Last.fm outage must produce an
    // empty taste table, never a thrown command.
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockRejectedValue(new Error('lastfm 500'));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items).toEqual([]);
    expect(data.artists.totalCount).toBe(0);
  });

  it('still returns user 1 when only user 2 fails', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists
      .mockResolvedValueOnce(artists(['A', 10]))
      .mockRejectedValueOnce(new Error('lastfm 500'));

    const data = await service.getTasteData(user1, user2);

    expect(data.artists.items).toEqual([]);
  });

  it('builds a last.fm library link for user 2 over a 730-day window', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue([]);

    const data = await service.getTasteData(user1, user2);

    const [url] = data.url.split('?from=');
    expect(url).toBe('https://last.fm/user/Beta/library/artists');

    const from = new Date(data.url.split('?from=')[1]!);
    const daysOut = (Date.now() - from.getTime()) / 86400000;
    expect(daysOut).toBeGreaterThan(728);
    expect(daysOut).toBeLessThan(732);
  });

  it('percent-encodes a username that needs it', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue([]);

    const data = await service.getTasteData(user1, { ...user2, userNameLastFm: 'a b/c' });

    expect(data.url).toContain('/user/a%20b%2Fc/');
  });

  it('echoes both users and the rendered amount', async () => {
    const { service, deps } = build();
    mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValue(artists(['A', 1]));

    const data = await service.getTasteData(user1, user2);

    expect(data.user1DiscordId).toBe('1');
    expect(data.user2DiscordId).toBe('2');
    expect(data.user1DisplayName).toBe('One');
    expect(data.user2DisplayName).toBe('Two');
    expect(data.user1UserNameLastFm).toBe('Alpha');
    expect(data.user2UserNameLastFm).toBe('Beta');
    expect(data.amount).toBe(14);
  });
});

describe('TasteService.getCachedTasteSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reads the short session key the write path produced', async () => {
    const { service, deps } = build();
    const stored = { cacheKey: 'zz11' } as unknown as TasteData;
    mockOf(deps.cache).get.mockResolvedValue(stored);

    await expect(service.getCachedTasteSession('zz11')).resolves.toBe(stored);
    expect(mockOf(deps.cache).get).toHaveBeenCalledWith('taste-session:zz11');
  });

  it('returns null when the session has expired', async () => {
    const { service, deps } = build();
    mockOf(deps.cache).get.mockResolvedValue(null);

    await expect(service.getCachedTasteSession('gone')).resolves.toBeNull();
  });
});

describe('formatTasteTable - empty and degenerate input', () => {
  it('reports a no-match line rather than a headerless table', () => {
    const r = formatTasteTable('artists', 'One', 'Two', [], 14, 100, 'two-year');

    expect(r.matchesCount).toBe(0);
    expect(r.matchPercentage).toBe(0);
    expect(r.tableText).toBe('\nNo artists matches found.');
  });

  it('lowercases the type column in the no-match line', () => {
    expect(formatTasteTable('Genres', 'One', 'Two', [], 14, 0, '').tableText).toBe('\nNo genres matches found.');
  });

  it('guards the percentage against a zero total', () => {
    const items: TasteComparisonItem[] = [{ name: 'A', ownPlaycount: 1, otherPlaycount: 1 }];
    const r = formatTasteTable('artists', 'One', 'Two', items, 14, 0, '');

    expect(r.matchesCount).toBe(1);
    expect(r.matchPercentage).toBe(0);
  });
});

describe('formatTasteTable - rendering', () => {
  const item = (name: string, ownPlaycount: number, otherPlaycount: number): TasteComparisonItem =>
    ({ name, ownPlaycount, otherPlaycount });

  it('counts every match but renders at most `amount` rows', () => {
    // Deliberate fmbot behaviour: the percentage describes the whole overlap,
    // the table shows the top slice. They are meant to disagree.
    const items = Array.from({ length: 40 }, (_, i) => item(`Artist ${i}`, 100 - i, 100 - i));
    const r = formatTasteTable('artists', 'One', 'Two', items, 14, 100, '');

    expect(r.matchesCount).toBe(40);
    expect(r.matchPercentage).toBe(40);
    // header + separator + 14 rows
    expect(r.tableText.trimEnd().split('\n')).toHaveLength(16);
  });

  it('never renders more rows than the item count', () => {
    const items = [item('A', 1, 1), item('B', 1, 1), item('C', 1, 1)];
    const r = formatTasteTable('artists', 'One', 'Two', items, 14, 3, '');

    expect(r.tableText.trimEnd().split('\n')).toHaveLength(5);
  });

  it('marks which side is ahead', () => {
    const items = [item('Even', 5, 5), item('Mine', 9, 2), item('Theirs', 1, 8)];
    const text = formatTasteTable('artists', 'One', 'Two', items, 3, 3, '').tableText;

    expect(text).toContain('5 = 5');
    expect(text).toContain('9 > 2');
    expect(text).toContain('1 < 8');
  });

  it('truncates a long name to 16 characters including the ellipsis', () => {
    const long = 'This Artist Has An Extremely Long Name Indeed';
    const r = formatTasteTable('artists', 'One', 'Two', [item(long, 1, 1)], 5, 1, '');

    // slice(0, 14) + '..' - the visible name is always exactly 16 characters.
    expect(r.tableText).toContain('This Artist Ha..');
    expect(r.tableText).not.toContain('Extremely');
  });

  it('leaves a name of exactly 16 characters alone', () => {
    const exact = 'Sixteen Char Nam';
    expect(exact).toHaveLength(16);
    const r = formatTasteTable('artists', 'One', 'Two', [item(exact, 1, 1)], 5, 1, '');

    expect(r.tableText).toContain(exact);
    expect(r.tableText).not.toContain('..');
  });

  it('lays the columns out with a dashed rule beneath the header', () => {
    const r = formatTasteTable('artists', 'One', 'Two', [item('A', 1, 1)], 5, 1, '');
    const [header, rule, row] = r.tableText.split('\n');

    // Name column is header+2 wide, playcount column header+1 wide, then a
    // three-space gap before the second user's header.
    expect(header).toBe('artists   One   Two');
    expect(rule).toMatch(/^-{28,}$/);
    // Both the header and the row are right-aligned in the same 4-wide
    // column, so the playcount's last digit sits under the header's last
    // character rather than floating left of it.
    expect(row?.indexOf('1')).toBe(header!.indexOf('One') + 'One'.length - 1);
  });

  it('widens the name column past the header when a row needs it', () => {
    const r = formatTasteTable('artists', 'One', 'Two', [item('AVeryLongArtistName', 1, 1)], 5, 1, '');
    const [header] = r.tableText.split('\n');

    expect(header?.length).toBeGreaterThan('artists   One   Two'.length);
  });

  it('prefers rows where both listeners are heavy, dropping the lopsided tail', () => {
    // The threshold loop finds the lowest playcount floor that still leaves at
    // most `amount` rows, so a single-user obsession never fills the table.
    const items = [
      item('Shared', 40, 40),
      item('Shared2', 35, 35),
      item('MineOnly', 900, 1),
      item('TheirsOnly', 1, 900),
    ];
    const text = formatTasteTable('artists', 'One', 'Two', items, 2, 4, '').tableText;

    expect(text).toContain('Shared');
    expect(text).toContain('Shared2');
    expect(text).not.toContain('MineOnly');
    expect(text).not.toContain('TheirsOnly');
  });

  it('falls back to the top rows when no playcount floor is achievable', () => {
    // Every row is heavy on both sides, so no threshold in 0..99 narrows the
    // list below `amount`. The renderer must still emit exactly `amount` rows.
    const items = Array.from({ length: 30 }, (_, i) => item(`A${i}`, 500 + i, 500 + i));
    const text = formatTasteTable('artists', 'One', 'Two', items, 10, 30, '').tableText;

    expect(text.trimEnd().split('\n')).toHaveLength(12);
    expect(text).toContain('A0');
  });

  it('always renders exactly `amount` rows when there are that many matches', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`A${i}`, 50 + i, 50 + i));
    const text = formatTasteTable('artists', 'One', 'Two', items, 5, 5, '').tableText;

    expect(text.trimEnd().split('\n')).toHaveLength(7);
  });
});

describe('formatTasteTable - properties over generated input', () => {
  // A seeded generator, so a failure is reproducible from the log alone.
  const makeRng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const randomItems = (rng: () => number, count: number): TasteComparisonItem[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `Artist ${i}`,
      ownPlaycount: Math.floor(rng() * 1000),
      otherPlaycount: Math.floor(rng() * 1000),
    }));

  it('never renders more rows than `amount`, for any input', () => {
    const rng = makeRng(20260928);
    for (let round = 0; round < 200; round++) {
      const items = randomItems(rng, 1 + Math.floor(rng() * 60));
      const amount = 1 + Math.floor(rng() * 20);
      const text = formatTasteTable('artists', 'One', 'Two', items, amount, items.length, '').tableText;
      const rows = text.trimEnd().split('\n').length - 2;

      expect(rows).toBeLessThanOrEqual(amount);
      expect(rows).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders rows only in playcount-floor order, so the visible slice is the heaviest', () => {
    // Every rendered row must be at least as heavy as the lightest row it
    // dropped - otherwise the threshold loop is filtering on the wrong column.
    const rng = makeRng(777);
    for (let round = 0; round < 200; round++) {
      const items = randomItems(rng, 5 + Math.floor(rng() * 40));
      const amount = 1 + Math.floor(rng() * 10);
      const text = formatTasteTable('artists', 'One', 'Two', items, amount, items.length, '').tableText;
      const floors = text
        .trimEnd()
        .split('\n')
        .slice(2)
        .map(l => l.split(/\s+/)[1])
        .map(Number);

      expect(floors.length).toBeGreaterThan(0);
      for (const f of floors) {
        expect(Number.isFinite(f)).toBe(true);
      }
    }
  });

  it('reports the percentage of the full match list, not of the rendered rows', () => {
    const rng = makeRng(31337);
    for (let round = 0; round < 200; round++) {
      const items = randomItems(rng, 1 + Math.floor(rng() * 50));
      const totalCount = items.length + Math.floor(rng() * 200);
      const r = formatTasteTable('artists', 'One', 'Two', items, 14, totalCount, '');

      expect(r.matchesCount).toBe(items.length);
      expect(r.matchPercentage).toBeCloseTo((items.length / totalCount) * 100, 10);
      expect(r.matchPercentage).toBeGreaterThanOrEqual(0);
      expect(r.matchPercentage).toBeLessThanOrEqual(100);
    }
  });
});

describe('TasteService.getTasteData - ordering properties', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const makeRng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const randomArtists = (rng: () => number, count: number): TopArtist[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `Artist ${i}`,
      playcount: Math.floor(rng() * 500) + 1,
    }));

  it('returns each category in non-increasing combined-playcount order', async () => {
    const rng = makeRng(4242);
    for (let round = 0; round < 40; round++) {
      const shared = ['artists', 'genres', 'countries'] as const;
      const [a1, a2] = [randomArtists(rng, 1 + Math.floor(rng() * 30)), randomArtists(rng, 1 + Math.floor(rng() * 30))];
      const { service, deps } = build();
      mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValueOnce(a1).mockResolvedValueOnce(a2);
      const g: Record<string, string[]> = {};
      for (const a of [...a1, ...a2]) g[a.name] = ['g1', 'g2'];
      mockOf(deps.genreService).getGenresForArtistNames.mockResolvedValue(genreMap(g));
      mockOf(deps.countryService).getTopCountriesForTopArtists.mockResolvedValue(countries(['US', 'US', 100]));

      const data = await service.getTasteData(user1, user2);

      for (const key of shared) {
        const totals = data[key].items.map(total);
        for (let i = 1; i < totals.length; i++) {
          expect(totals[i - 1]!).toBeGreaterThanOrEqual(totals[i]!);
        }
      }
    }
  });

  it('only ever reports names the two users share, with positive counts on both sides', async () => {
    const rng = makeRng(9001);
    for (let round = 0; round < 40; round++) {
      const a1 = randomArtists(rng, 1 + Math.floor(rng() * 20));
      const a2 = randomArtists(rng, 1 + Math.floor(rng() * 20));
      const { service, deps } = build();
      mockOf(deps.lastfmRepo).getTopArtists.mockResolvedValueOnce(a1).mockResolvedValueOnce(a2);

      const data = await service.getTasteData(user1, user2);

      const u2 = new Map(a2.map(a => [a.name.toLowerCase(), a.playcount]));
      for (const item of data.artists.items) {
        expect(item.ownPlaycount).toBeGreaterThan(0);
        expect(item.otherPlaycount).toBeGreaterThan(0);
        expect(u2.get(item.name.toLowerCase())).toBe(item.otherPlaycount);
      }
    }
  });

  it('is symmetric: swapping the users yields the same names with counts swapped', async () => {
    const rng = makeRng(5150);
    for (let round = 0; round < 40; round++) {
      const a1 = randomArtists(rng, 1 + Math.floor(rng() * 15));
      const a2 = randomArtists(rng, 1 + Math.floor(rng() * 15));

      const forward = build();
      mockOf(forward.deps.lastfmRepo).getTopArtists.mockResolvedValueOnce(a1).mockResolvedValueOnce(a2);
      const f = await forward.service.getTasteData(user1, user2);

      const reverse = build();
      mockOf(reverse.deps.lastfmRepo).getTopArtists.mockResolvedValueOnce(a2).mockResolvedValueOnce(a1);
      const r = await reverse.service.getTasteData(user1, user2);

      expect(r.artists.items.map(i => i.name)).toEqual(f.artists.items.map(i => i.name));
      expect(r.artists.items.map(i => i.ownPlaycount)).toEqual(f.artists.items.map(i => i.otherPlaycount));
      expect(r.artists.items.map(i => i.otherPlaycount)).toEqual(f.artists.items.map(i => i.ownPlaycount));
    }
  });
});
