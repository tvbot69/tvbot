import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { SettingService } from '@bot/services/system/settingService';
import { TimePeriod } from '@domain/enums/timePeriod';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';

const service = new SettingService();

describe('SettingService.getTimePeriod', () => {
  it('defaults to alltime with untouched search value', () => {
    const s = service.getTimePeriod('radiohead');
    expect(s.timePeriod).toBe(TimePeriod.AllTime);
    expect(s.description).toBe('Alltime');
    expect(s.searchValue).toBe('radiohead');
    expect(s.startDateTime).toBeUndefined();
  });

  it('handles null input', () => {
    const s = service.getTimePeriod(null);
    expect(s.timePeriod).toBe(TimePeriod.AllTime);
    expect(s.searchValue).toBe('');
  });

  const cases: Array<[string, TimePeriod]> = [
    ['weekly', TimePeriod.Weekly],
    ['week', TimePeriod.Weekly],
    ['w', TimePeriod.Weekly],
    ['monthly', TimePeriod.Monthly],
    ['m', TimePeriod.Monthly],
    ['quarterly', TimePeriod.Quarterly],
    ['q', TimePeriod.Quarterly],
    ['halfyearly', TimePeriod.HalfYearly],
    ['6m', TimePeriod.HalfYearly],
    ['yearly', TimePeriod.Yearly],
    ['y', TimePeriod.Yearly],
    ['2y', TimePeriod.TwoYear],
    ['overall', TimePeriod.AllTime],
    ['alltime', TimePeriod.AllTime],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}"`, () => {
      const s = service.getTimePeriod(input);
      expect(s.timePeriod).toBe(expected);
      expect(s.searchValue).toBe('');
    });
  }

  it('removes period token from search value', () => {
    const s = service.getTimePeriod('daft punk weekly');
    expect(s.timePeriod).toBe(TimePeriod.Weekly);
    expect(s.searchValue).toBe('daft punk');
  });

  it('sets start/end date range for weekly', () => {
    const s = service.getTimePeriod('weekly');
    expect(s.startDateTime).toBeDefined();
    expect(s.endDateTime).toBeDefined();
    expect(Math.round(s.days!)).toBe(7);
  });

  it('today starts at midnight', () => {
    const s = service.getTimePeriod('today');
    expect(s.timePeriod).toBe(TimePeriod.Daily);
    expect(s.description).toBe('Today');
    const start = s.startDateTime!;
    expect(start.getHours()).toBe(0);
  });
});

/**
 * The rest of the `getTimePeriod` grammar.
 *
 * The parser is a cascade of word-boundary token lists, then a custom-span
 * grammar, then a year/month grammar, then the spelled-out day words. Order is
 * load-bearing at every step, and several tokens are shadowed by an earlier
 * stage. The tests below are mostly the ones a naive regex would get wrong:
 *
 *  - `2d` is **not** "two days"; the custom day-span branch claims it first and
 *    returns `TimePeriod.Custom` with the description "2 days". The spelled
 *    `twodays` is the only way to reach the `Daily` two-day window, and the two
 *    even compute their start from different clocks. Same for `3d`, `6d`, `1d`
 *    and friends - the `dayAmounts` numeric entries are unreachable.
 *  - `2w` is **not** weekly. The named-period list has `w` but not `2w`, so it
 *    falls through to the custom week-span branch.
 *  - A month name must not be read inside a longer word: `mayhem` is a band,
 *    not May.
 */

const svc = service;
const at = (d: Date | undefined) => d ?? new Date(NaN);

// The complete token list from the parser, written out so a token added to (or
// dropped from) production shows up as a failing test rather than silent drift.
const PERIOD_TOKENS: Array<[string, TimePeriod, string, number | null]> = [
  ['weekly', TimePeriod.Weekly, 'Weekly', 7],
  ['week', TimePeriod.Weekly, 'Weekly', 7],
  ['w', TimePeriod.Weekly, 'Weekly', 7],
  ['7d', TimePeriod.Weekly, 'Weekly', 7],

  ['quarterly', TimePeriod.Quarterly, 'Quarterly', 90],
  ['quarter', TimePeriod.Quarterly, 'Quarterly', 90],
  ['q', TimePeriod.Quarterly, 'Quarterly', 90],
  ['3m', TimePeriod.Quarterly, 'Quarterly', 90],
  ['90d', TimePeriod.Quarterly, 'Quarterly', 90],

  ['halfyearly', TimePeriod.HalfYearly, 'Half yearly', 180],
  ['half-yearly', TimePeriod.HalfYearly, 'Half yearly', 180],
  ['hy', TimePeriod.HalfYearly, 'Half yearly', 180],
  ['6m', TimePeriod.HalfYearly, 'Half yearly', 180],
  ['180d', TimePeriod.HalfYearly, 'Half yearly', 180],

  ['monthly', TimePeriod.Monthly, 'Monthly', 30],
  ['month', TimePeriod.Monthly, 'Monthly', 30],
  ['m', TimePeriod.Monthly, 'Monthly', 30],
  ['1m', TimePeriod.Monthly, 'Monthly', 30],
  ['30d', TimePeriod.Monthly, 'Monthly', 30],

  ['twoyears', TimePeriod.TwoYear, 'Two years', 730],
  ['2y', TimePeriod.TwoYear, 'Two years', 730],
  ['730d', TimePeriod.TwoYear, 'Two years', 730],

  ['yearly', TimePeriod.Yearly, 'Yearly', 365],
  ['year', TimePeriod.Yearly, 'Yearly', 365],
  ['y', TimePeriod.Yearly, 'Yearly', 365],
  ['12m', TimePeriod.Yearly, 'Yearly', 365],
  ['365d', TimePeriod.Yearly, 'Yearly', 365],
  ['1y', TimePeriod.Yearly, 'Yearly', 365],

  // All-time sets no date range at all, so `days` stays null.
  ['overall', TimePeriod.AllTime, 'Alltime', null],
  ['alltime', TimePeriod.AllTime, 'Alltime', null],
  ['all-time', TimePeriod.AllTime, 'Alltime', null],
  ['all', TimePeriod.AllTime, 'Alltime', null],
  ['a', TimePeriod.AllTime, 'Alltime', null],
  ['o', TimePeriod.AllTime, 'Alltime', null],
  ['at', TimePeriod.AllTime, 'Alltime', null],
];

describe('SettingService.getTimePeriod - every named-period token', () => {
  for (const [token, period, description, days] of PERIOD_TOKENS) {
    it(`reads "${token}" as ${period}`, () => {
      const s = svc.getTimePeriod(token);
      expect(s.timePeriod).toBe(period);
      expect(s.description).toBe(description);
      expect(s.searchValue).toBe('');
      if (days === null) {
        expect(s.startDateTime).toBeUndefined();
        expect(s.days).toBeNull();
      } else {
        expect(Math.round(s.days!)).toBe(days);
        expect(s.endDateTime).toBeDefined();
      }
    });
  }

  it('reads a token embedded in a longer query and strips only the token', () => {
    const s = svc.getTimePeriod('radiohead monthly');
    expect(s.timePeriod).toBe(TimePeriod.Monthly);
    expect(s.searchValue).toBe('radiohead');
  });

  it('does not match a token glued to a longer word', () => {
    // Word boundaries are what stop `week` from eating "weekend".
    for (const input of ['weekend', 'monthlyish', 'yonder', 'ally', 'qbert']) {
      const s = svc.getTimePeriod(input);
      expect(s.timePeriod, input).toBe(TimePeriod.AllTime);
      expect(s.searchValue, input).toBe(input);
    }
  });

  it('tolerates surrounding whitespace and casing', () => {
    for (const input of ['  WEEKLY  ', '\tYearly\n', 'MoNtHlY']) {
      expect(svc.getTimePeriod(input).timePeriod).not.toBe(TimePeriod.AllTime);
    }
  });

  it('lowercases the search value, even when nothing was consumed', () => {
    expect(svc.getTimePeriod('Daft Punk').searchValue).toBe('daft punk');
    expect(svc.getTimePeriod('Daft Punk weekly').searchValue).toBe('daft punk');
  });
});

describe('SettingService.getTimePeriod - which stage wins', () => {
  // Each of these is a pair a naive "first match wins" parse gets wrong.
  const precedence: Array<[string, TimePeriod, string]> = [
    ['3m', TimePeriod.Quarterly, 'Quarterly'],
    ['6m', TimePeriod.HalfYearly, 'Half yearly'],
    ['12m', TimePeriod.Yearly, 'Yearly'],
    ['1m', TimePeriod.Monthly, 'Monthly'],
    ['m', TimePeriod.Monthly, 'Monthly'],
    ['q', TimePeriod.Quarterly, 'Quarterly'],
    ['hy', TimePeriod.HalfYearly, 'Half yearly'],
    ['2y', TimePeriod.TwoYear, 'Two years'],
    ['1y', TimePeriod.Yearly, 'Yearly'],
    ['y', TimePeriod.Yearly, 'Yearly'],
    ['2w', TimePeriod.Custom, '2 weeks'],
    ['1w', TimePeriod.Custom, '1 weeks'],
    ['45d', TimePeriod.Custom, '45 days'],
    ['14days', TimePeriod.Custom, '14 days'],
    ['2d', TimePeriod.Custom, '2 days'],
    ['3d', TimePeriod.Custom, '3 days'],
    ['6d', TimePeriod.Custom, '6 days'],
    ['1d', TimePeriod.Custom, '1 days'],
  ];

  for (const [input, period, description] of precedence) {
    it(`routes "${input}" to ${description} (${period})`, () => {
      const s = svc.getTimePeriod(input);
      expect(s.timePeriod).toBe(period);
      expect(s.description).toBe(description);
      expect(s.searchValue).toBe('');
    });
  }

  it('treats the spelled and numeric two-day forms as different periods', () => {
    // `twodays` is the only way into the Daily two-day window, and it counts
    // back from midnight. `2d` is a custom span counted back from now. Same
    // apparent request, different window, different description.
    const spelled = svc.getTimePeriod('twodays');
    const numeric = svc.getTimePeriod('2d');

    expect(spelled.timePeriod).toBe(TimePeriod.Daily);
    expect(spelled.description).toBe('Two days');
    expect(numeric.timePeriod).toBe(TimePeriod.Custom);
    expect(numeric.description).toBe('2 days');
  });

  it('computes a custom week span in days', () => {
    const s = svc.getTimePeriod('2w');
    expect(Math.round(s.days!)).toBe(14);
  });

  it('lets a year beat the spelled day words', () => {
    // The year/month grammar runs before the day words, so an explicit year is
    // never quietly re-interpreted as a rolling window.
    const s = svc.getTimePeriod('today 2022');
    expect(s.timePeriod).toBe(TimePeriod.Custom);
    expect(s.description).toBe('2022');
    expect(s.searchValue).toBe('today');
  });

  it('lets a month beat the spelled day words', () => {
    const s = svc.getTimePeriod('daily october 2022');
    expect(s.timePeriod).toBe(TimePeriod.Custom);
    expect(s.description).toBe('October 2022');
  });

  it('rejects a custom day span of zero and falls through to alltime', () => {
    for (const input of ['0d', '0days', '0w', '0weeks']) {
      const s = svc.getTimePeriod(input);
      expect(s.timePeriod, input).toBe(TimePeriod.AllTime);
      expect(s.searchValue, input).toBe(input);
    }
  });

  it('rejects a custom day span beyond ten years', () => {
    const s = svc.getTimePeriod('3651d');
    expect(s.timePeriod).toBe(TimePeriod.AllTime);
    expect(s.searchValue).toBe('3651d');
  });

  it('accepts a custom day span of exactly ten years', () => {
    const s = svc.getTimePeriod('3650d');
    expect(s.timePeriod).toBe(TimePeriod.Custom);
    expect(s.description).toBe('3650 days');
  });

  it('rejects a custom week span beyond ten years', () => {
    expect(svc.getTimePeriod('521w').timePeriod).toBe(TimePeriod.AllTime);
    const ok = svc.getTimePeriod('520w');
    expect(ok.timePeriod).toBe(TimePeriod.Custom);
    expect(ok.description).toBe('520 weeks');
  });

  it('leaves a bare number as part of the search value', () => {
    const s = svc.getTimePeriod('45');
    expect(s.timePeriod).toBe(TimePeriod.AllTime);
    expect(s.searchValue).toBe('45');
  });
});

describe('SettingService.getTimePeriod - year grammar', () => {
  it('reads a four-digit year as a whole calendar year in UTC', () => {
    const s = svc.getTimePeriod('2022');
    expect(s.timePeriod).toBe(TimePeriod.Custom);
    expect(s.description).toBe('2022');
    expect(s.startDateTime!.toISOString()).toBe(new Date(Date.UTC(2022, 0, 1)).toISOString());
    expect(s.endDateTime!.toISOString()).toBe(new Date(Date.UTC(2022, 11, 31, 23, 59, 59)).toISOString());
  });

  it('keeps the search value around a year', () => {
    const s = svc.getTimePeriod('radiohead 1997');
    expect(s.description).toBe('1997');
    expect(s.searchValue).toBe('radiohead');
  });

  it('accepts the 1970 floor', () => {
    expect(svc.getTimePeriod('1970').description).toBe('1970');
  });

  it('ignores years the grammar cannot express', () => {
    for (const input of ['1969', '2050', '1234', '3000']) {
      const s = svc.getTimePeriod(input);
      expect(s.timePeriod, input).toBe(TimePeriod.AllTime);
      expect(s.searchValue, input).toBe(input);
    }
  });

  it('ignores a year beyond next year even though the shape matches', () => {
    // The regex admits 2030-2039; the range check then rejects it. Without the
    // range check a typo would pin the command to the far future.
    const tooFar = String(new Date().getFullYear() + 5);
    if (/^203\d$/.test(tooFar)) {
      expect(svc.getTimePeriod(tooFar).timePeriod).toBe(TimePeriod.AllTime);
    } else {
      expect(svc.getTimePeriod('2035').timePeriod).toBe(TimePeriod.AllTime);
    }
  });

  it('does not read a number glued to a word as a year', () => {
    const s = svc.getTimePeriod('bl1997');
    expect(s.timePeriod).toBe(TimePeriod.AllTime);
  });
});

describe('SettingService.getTimePeriod - month grammar', () => {
  const months: Array<[string, string, number]> = [
    ['january', 'January', 0], ['jan', 'January', 0],
    ['february', 'February', 1], ['feb', 'February', 1],
    ['march', 'March', 2], ['mar', 'March', 2],
    ['april', 'April', 3], ['apr', 'April', 3],
    ['may', 'May', 4],
    ['june', 'June', 5], ['jun', 'June', 5],
    ['july', 'July', 6], ['jul', 'July', 6],
    ['august', 'August', 7], ['aug', 'August', 7],
    ['september', 'September', 8], ['sep', 'September', 8], ['sept', 'September', 8],
    ['october', 'October', 9], ['oct', 'October', 9],
    ['november', 'November', 10], ['nov', 'November', 10],
    ['december', 'December', 11], ['dec', 'December', 11],
  ];

  for (const [token, name, num] of months) {
    it(`reads "${token}" as ${name}`, () => {
      const s = svc.getTimePeriod(token);
      expect(s.timePeriod).toBe(TimePeriod.Custom);
      expect(s.description).toBe(name);
      expect(s.startDateTime!.getUTCMonth()).toBe(num);
      expect(s.startDateTime!.getUTCDate()).toBe(1);
      expect(s.startDateTime!.getUTCHours()).toBe(0);
      expect(s.searchValue).toBe('');
    });
  }

  it('assumes the previous year for a month that has not happened yet', () => {
    const nowMonth = new Date().getUTCMonth();
    const future = 11 > nowMonth ? 11 : nowMonth + 1 <= 11 ? nowMonth + 1 : 11;
    if (future === nowMonth) {
      return;
    }
    const expectedYear = new Date().getUTCFullYear() - (future > nowMonth ? 1 : 0);
    const token = future === 11 ? 'december' : future === 0 ? 'january' : 'september';

    const s = svc.getTimePeriod(token);
    expect(s.startDateTime!.getUTCMonth()).toBe(future);
    expect(s.startDateTime!.getUTCFullYear()).toBe(expectedYear);
  });

  it('spans the whole month in UTC, last day included', () => {
    const s = svc.getTimePeriod('february 2020');
    // 2020 was a leap year; a 29-day window proves the end is the last day and
    // not "the 28th plus a day".
    expect(s.startDateTime!.toISOString()).toBe(new Date(Date.UTC(2020, 1, 1)).toISOString());
    expect(s.endDateTime!.toISOString()).toBe(new Date(Date.UTC(2020, 1, 29, 23, 59, 59)).toISOString());
  });

  it('does not read a month name inside a longer word', () => {
    // `mayhem` and `marchioness` are band names, not dates. The word-boundary
    // check is the only thing standing between a search and a silent month.
    for (const input of ['mayhem', 'septwolves', 'janelle', 'decaffeinated']) {
      const s = svc.getTimePeriod(input);
      expect(s.timePeriod, input).toBe(TimePeriod.AllTime);
      expect(s.searchValue, input).toBe(input);
    }
  });

  it('accepts the month before the year', () => {
    const a = svc.getTimePeriod('october 2022');
    const b = svc.getTimePeriod('2022 october');

    expect(b.timePeriod).toBe(TimePeriod.Custom);
    expect(b.description).toBe('October 2022');
    expect(b.startDateTime!.toISOString()).toBe(a.startDateTime!.toISOString());
    expect(b.endDateTime!.toISOString()).toBe(a.endDateTime!.toISOString());
    expect(b.searchValue).toBe('');
  });

  it('keeps the search value when a month and year are extracted', () => {
    const s = svc.getTimePeriod('bohemian october 2022 rhapsody');
    expect(s.description).toBe('October 2022');
    expect(s.searchValue).toBe('bohemian rhapsody');
  });

  it('uses the first month when several are present', () => {
    const s = svc.getTimePeriod('january february 2022');
    expect(s.description).toBe('January 2022');
  });

  it('prefers the full month name over its abbreviation', () => {
    const s = svc.getTimePeriod('sept 2022');
    expect(s.description).toBe('September 2022');
  });
});

describe('SettingService.getTimePeriod - spelled day words', () => {
  const words: Array<[string, string, number]> = [
    ['sixdays', 'Six days', 6],
    ['fivedays', 'Five days', 5],
    ['fourdays', 'Four days', 4],
    ['threedays', 'Three days', 3],
    ['twodays', 'Two days', 2],
    ['yesterday', 'Yesterday', 1],
    ['today', 'Today', 0],
    ['oneday', 'One day', 1],
    ['daily', 'One day', 1],
    ['day', 'One day', 1],
  ];

  for (const [token, description] of words) {
    it(`reads "${token}" as ${description}`, () => {
      const s = svc.getTimePeriod(token);
      expect(s.timePeriod).toBe(TimePeriod.Daily);
      expect(s.description).toBe(description);
      expect(s.searchValue).toBe('');
      expect(s.startDateTime).toBeDefined();
    });
  }

  it('anchors today at local midnight and ends now', () => {
    const s = svc.getTimePeriod('today');
    expect(s.startDateTime!.getHours()).toBe(0);
    expect(s.startDateTime!.getMinutes()).toBe(0);
  });

  it('anchors yesterday to the previous midnight, ending at this one', () => {
    const s = svc.getTimePeriod('yesterday');
    const today = svc.getTimePeriod('today');
    const gapMs = at(today.startDateTime).getTime() - at(s.startDateTime).getTime();
    expect(gapMs).toBe(86400000);
    expect(at(s.endDateTime).getTime()).toBe(at(today.startDateTime).getTime());
  });

  it('measures "one day" back from now rather than from midnight', () => {
    // Today/yesterday are calendar days; daily/day/oneday are a rolling 24h.
    // A test that only checks `days` cannot tell the two apart, so this pins
    // the width of the window instead: a rolling day is always exactly 24h
    // wide, and it necessarily begins at or before this morning's midnight.
    const daily = svc.getTimePeriod('daily');
    const today = svc.getTimePeriod('today');

    const spanMs = at(daily.endDateTime).getTime() - at(daily.startDateTime).getTime();
    expect(spanMs).toBe(86400000);
    expect(at(daily.startDateTime).getTime()).toBeLessThanOrEqual(at(today.startDateTime).getTime());
  });

  it('counts multi-day windows back from midnight, inclusive of today', () => {
    const s = svc.getTimePeriod('threedays');
    const today = svc.getTimePeriod('today');
    const gapDays = (at(today.startDateTime).getTime() - at(s.startDateTime).getTime()) / 86400000;
    expect(gapDays).toBe(2);
  });
});

describe('SettingService.getTimePeriod - url parameters', () => {
  // Note what the parameter is derived from: the *width* of the resolved range,
  // not how far back it reaches. A fixed calendar range therefore reports the
  // Last.fm window that matches its length rather than its dates - "2022" is
  // 365 days wide, so it reports LAST_365_DAYS even though those dates are
  // years in the past. Recorded here because it is surprising, and because a
  // builder that trusts the parameter instead of startDateTime/endDateTime
  // would quietly serve the wrong data.
  const cases: Array<[string, string | undefined]> = [
    ['weekly', 'LAST_7_DAYS'],
    ['quarterly', 'LAST_90_DAYS'],
    ['6m', 'LAST_180_DAYS'],
    ['monthly', 'LAST_30_DAYS'],
    ['yearly', 'LAST_365_DAYS'],
    // Wider than any named Last.fm window, so it degrades to the full history.
    ['2y', 'ALL'],
    ['45d', 'LAST_90_DAYS'],
    ['700d', 'ALL'],
    ['2022', 'LAST_365_DAYS'],
    ['october 2022', 'LAST_30_DAYS'],
    ['february 2020', 'LAST_30_DAYS'],
    // Alltime sets no range, and the parameter follows the range.
    ['overall', undefined],
    ['radiohead', undefined],
  ];

  for (const [input, expected] of cases) {
    it(`maps "${input}" to ${expected}`, () => {
      expect(svc.getTimePeriod(input).urlParameter).toBe(expected);
    });
  }
});

describe('SettingService.setWhoKnowsSettings', () => {
  it('returns the raw query untouched with the default mode', () => {
    const r = svc.setWhoKnowsSettings('radiohead');
    expect(r).toEqual({
      newSearchValue: 'radiohead',
      responseMode: WhoKnowsMode.Default,
      qualityFilterDisabled: false,
      redirectsEnabled: true,
    });
  });

  it('honours an explicit default mode', () => {
    expect(svc.setWhoKnowsSettings('radiohead', WhoKnowsMode.Pagination).responseMode)
      .toBe(WhoKnowsMode.Pagination);
  });

  it('switches to image mode for img or image', () => {
    for (const token of ['img', 'image']) {
      const r = svc.setWhoKnowsSettings(`radiohead ${token}`);
      expect(r.responseMode, token).toBe(WhoKnowsMode.Image);
      expect(r.newSearchValue, token).toBe('radiohead');
    }
  });

  it('switches to pagination for every pagination token', () => {
    for (const token of ['pages', 'page', 'p', 'pp', 'pagination']) {
      const r = svc.setWhoKnowsSettings(`radiohead ${token}`);
      expect(r.responseMode, token).toBe(WhoKnowsMode.Pagination);
      expect(r.newSearchValue, token).toBe('radiohead');
    }
  });

  it('returns to text mode for embed, text or txt', () => {
    for (const token of ['embed', 'text', 'txt']) {
      expect(svc.setWhoKnowsSettings(`radiohead ${token}`).responseMode, token).toBe(WhoKnowsMode.Default);
    }
  });

  it('lets the last mode token win, so img followed by pages paginates', () => {
    const r = svc.setWhoKnowsSettings('radiohead img pages');
    expect(r.responseMode).toBe(WhoKnowsMode.Pagination);
    expect(r.newSearchValue).toBe('radiohead');
  });

  it('disables the quality filter for nf or nofilter', () => {
    for (const token of ['nf', 'nofilter']) {
      const r = svc.setWhoKnowsSettings(`radiohead ${token}`);
      expect(r.qualityFilterDisabled, token).toBe(true);
      expect(r.newSearchValue, token).toBe('radiohead');
    }
  });

  it('disables redirects for nr or noredirect', () => {
    for (const token of ['nr', 'noredirect']) {
      const r = svc.setWhoKnowsSettings(`radiohead ${token}`);
      expect(r.redirectsEnabled, token).toBe(false);
      expect(r.newSearchValue, token).toBe('radiohead');
    }
  });

  it('combines every modifier into one call', () => {
    const r = svc.setWhoKnowsSettings('  Daft Punk   img   nf   nr  ');

    expect(r).toEqual({
      newSearchValue: 'daft punk',
      responseMode: WhoKnowsMode.Image,
      qualityFilterDisabled: true,
      redirectsEnabled: false,
    });
  });

  it('does not strip a modifier glued to a word', () => {
    const r = svc.setWhoKnowsSettings('img radiohead');
    expect(r.newSearchValue).toBe('radiohead');
    expect(svc.setWhoKnowsSettings('imagine').newSearchValue).toBe('imagine');
  });
});

describe('SettingService.getGoalAmount', () => {
  it('falls back to the lowest breakpoint for a new listener', () => {
    expect(SettingService.getGoalAmount(null, 0)).toBe(50);
  });

  it('climbs the breakpoints as the playcount grows', () => {
    expect(SettingService.getGoalAmount(null, 49)).toBe(50);
    expect(SettingService.getGoalAmount(null, 50)).toBe(100);
    expect(SettingService.getGoalAmount(null, 100)).toBe(250);
    expect(SettingService.getGoalAmount(null, 999)).toBe(1000);
    expect(SettingService.getGoalAmount(null, 1000)).toBe(1337);
  });

  it('accepts a plain number above the current playcount', () => {
    expect(SettingService.getGoalAmount('750', 100)).toBe(750);
  });

  it('accepts a k-suffixed number', () => {
    expect(SettingService.getGoalAmount('5k', 100)).toBe(5000);
  });

  it('ignores a goal the user has already passed', () => {
    // Asking for a milestone behind yourself is not a goal; the breakpoint
    // ladder takes over instead.
    expect(SettingService.getGoalAmount('50', 500)).toBe(1000);
    expect(SettingService.getGoalAmount('2k', 5000)).toBe(10000);
  });

  it('strips punctuation from the option', () => {
    expect(SettingService.getGoalAmount('(750)', 100)).toBe(750);
    expect(SettingService.getGoalAmount('1,000', 100)).toBe(1000);
  });

  it('ignores unparseable options', () => {
    expect(SettingService.getGoalAmount('a lot', 0)).toBe(50);
  });

  it('caps the goal at ten million', () => {
    expect(SettingService.getGoalAmount('20000000', 100)).toBe(10000000);
  });

  it('takes the first usable option and stops', () => {
    expect(SettingService.getGoalAmount('nonsense 300 900', 100)).toBe(300);
  });
});

describe('SettingService.getMilestoneAmount', () => {
  it('counts down the breakpoints, so a milestone is always behind you', () => {
    expect(SettingService.getMilestoneAmount(null, 0)).toEqual({ amount: 100, isRandom: false });
    expect(SettingService.getMilestoneAmount(null, 100)).toEqual({ amount: 50, isRandom: false });
    expect(SettingService.getMilestoneAmount(null, 1000)).toEqual({ amount: 500, isRandom: false });
  });

  it('accepts a number below the current playcount', () => {
    expect(SettingService.getMilestoneAmount('300', 900)).toEqual({ amount: 300, isRandom: false });
  });

  it('ignores a milestone the user has already passed', () => {
    expect(SettingService.getMilestoneAmount('1200', 900)).toEqual({ amount: 500, isRandom: false });
  });

  it('accepts a k-suffixed number below the playcount', () => {
    expect(SettingService.getMilestoneAmount('2k', 9000)).toEqual({ amount: 2000, isRandom: false });
  });

  it('always lands at or above one', () => {
    expect(SettingService.getMilestoneAmount('0', 100).amount).toBe(1);
  });

  it('produces a random milestone strictly inside the playcount', () => {
    for (const token of ['random', 'rnd']) {
      for (let i = 0; i < 50; i++) {
        const { amount, isRandom } = SettingService.getMilestoneAmount(token, 1000);
        expect(isRandom, token).toBe(true);
        expect(amount, token).toBeGreaterThanOrEqual(1);
        expect(amount, token).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('still returns a usable milestone for a random request at zero plays', () => {
    const { amount, isRandom } = SettingService.getMilestoneAmount('random', 0);
    expect(isRandom).toBe(true);
    expect(amount).toBe(1);
  });
});
