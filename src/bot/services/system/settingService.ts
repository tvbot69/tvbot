import { TimePeriod } from '@domain/enums/timePeriod';
import {
  TimeSettingsModel,
  timePeriodUrlParameter,
} from '@domain/models/timeSettings';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { WhoKnowsSettings } from '@bot/models/whoKnowsModels';

const containsAndRemove = (input: string, tokens: string[]): [boolean, string] => {
  const padded = ` ${input.trim().toLowerCase()} `;
  for (const token of tokens) {
    if (padded.includes(` ${token} `)) {
      const remaining = padded.replace(` ${token} `, ' ').replace(/\s+/g, ' ').trim();
      return [true, remaining];
    }
  }
  return [false, input];
};

const dayDiffFromNow = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

export class SettingService {
  public getTimePeriod(options?: string | null): TimeSettingsModel {
    const settingsModel = new TimeSettingsModel(options?.toLowerCase().trim() ?? '');
    const searchValue = ` ${settingsModel.searchValue.toLowerCase()} `;

    const weeklyTokens = ['weekly', 'week', 'w', '7d'];
    const quarterlyTokens = ['quarterly', 'quarter', 'q', '3m', '90d'];
    const halfYearlyTokens = ['halfyearly', 'half-yearly', 'hy', '6m', '180d'];
    const monthlyTokens = ['monthly', 'month', 'm', '1m', '30d'];
    const twoYearTokens = ['twoyears', 'twoyears', '2y', '730d'];
    const yearlyTokens = ['yearly', 'year', 'y', '12m', '365d', '1y'];
    const allTimeTokens = ['overall', 'alltime', 'all-time', 'all', 'a', 'o', 'at'];

    const tryPeriod = (
      tokens: string[],
      period: TimePeriod,
      description: string,
      startDays?: number,
    ): boolean => {
      const [found, remaining] = containsAndRemove(searchValue, tokens);
      if (found) {
        settingsModel.timePeriod = period;
        settingsModel.description = description;
        if (startDays !== undefined) {
          settingsModel.startDateTime = dayDiffFromNow(startDays);
          settingsModel.endDateTime = new Date();
        }
        settingsModel.searchValue = remaining.trim();
        return true;
      }
      return false;
    };

    if (tryPeriod(weeklyTokens, TimePeriod.Weekly, 'Weekly', 7)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(quarterlyTokens, TimePeriod.Quarterly, 'Quarterly', 90)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(halfYearlyTokens, TimePeriod.HalfYearly, 'Half yearly', 180)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(monthlyTokens, TimePeriod.Monthly, 'Monthly', 30)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(twoYearTokens, TimePeriod.TwoYear, 'Two years', 730)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(yearlyTokens, TimePeriod.Yearly, 'Yearly', 365)) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }
    if (tryPeriod(allTimeTokens, TimePeriod.AllTime, 'Alltime')) {
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }

    // Check custom day spans like '45d', '14days'
    const dayMatch = searchValue.match(/\s(\d+)\s*(?:d|days)\s/i);
    if (dayMatch && dayMatch[1]) {
      const days = parseInt(dayMatch[1], 10);
      if (days > 0 && days <= 3650) {
        settingsModel.timePeriod = TimePeriod.Custom;
        settingsModel.description = `${days} days`;
        settingsModel.startDateTime = dayDiffFromNow(days);
        settingsModel.endDateTime = new Date();
        settingsModel.searchValue = searchValue.replace(dayMatch[0], ' ').trim();
        settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
        return settingsModel;
      }
    }

    // Check custom week spans like '2w', '3weeks'
    const weekMatch = searchValue.match(/\s(\d+)\s*(?:w|weeks)\s/i);
    if (weekMatch && weekMatch[1]) {
      const weeks = parseInt(weekMatch[1], 10);
      if (weeks > 0 && weeks <= 520) {
        const days = weeks * 7;
        settingsModel.timePeriod = TimePeriod.Custom;
        settingsModel.description = `${weeks} weeks`;
        settingsModel.startDateTime = dayDiffFromNow(days);
        settingsModel.endDateTime = new Date();
        settingsModel.searchValue = searchValue.replace(weekMatch[0], ' ').trim();
        settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
        return settingsModel;
      }
    }

    // Check specific year (1970 to present year + 1)
    const currentYear = new Date().getFullYear();
    const yearMatch = searchValue.match(/\s(19[7-9]\d|20[0-2]\d|203\d)\s/);
    let matchedYear: number | null = null;
    if (yearMatch && yearMatch[1]) {
      const y = parseInt(yearMatch[1], 10);
      if (y >= 1970 && y <= currentYear + 1) {
        matchedYear = y;
      }
    }

    // Check month names
    const months = [
      { name: 'January', num: 0, tokens: ['january', 'jan'] },
      { name: 'February', num: 1, tokens: ['february', 'feb'] },
      { name: 'March', num: 2, tokens: ['march', 'mar'] },
      { name: 'April', num: 3, tokens: ['april', 'apr'] },
      { name: 'May', num: 4, tokens: ['may'] },
      { name: 'June', num: 5, tokens: ['june', 'jun'] },
      { name: 'July', num: 6, tokens: ['july', 'jul'] },
      { name: 'August', num: 7, tokens: ['august', 'aug'] },
      { name: 'September', num: 8, tokens: ['september', 'sep', 'sept'] },
      { name: 'October', num: 9, tokens: ['october', 'oct'] },
      { name: 'November', num: 10, tokens: ['november', 'nov'] },
      { name: 'December', num: 11, tokens: ['december', 'dec'] },
    ];

    let matchedMonth: { name: string; num: number } | null = null;
    let matchedMonthToken: string | null = null;
    for (const m of months) {
      for (const t of m.tokens) {
        if (searchValue.includes(` ${t} `)) {
          matchedMonth = m;
          matchedMonthToken = t;
          break;
        }
      }
      if (matchedMonth) break;
    }

    // Case: Both Year and Month specified (e.g. 'october 2022')
    if (matchedYear && matchedMonth) {
      const start = new Date(Date.UTC(matchedYear, matchedMonth.num, 1, 0, 0, 0));
      const end = new Date(Date.UTC(matchedYear, matchedMonth.num + 1, 0, 23, 59, 59));
      settingsModel.timePeriod = TimePeriod.Custom;
      settingsModel.description = `${matchedMonth.name} ${matchedYear}`;
      settingsModel.startDateTime = start;
      settingsModel.endDateTime = end;
      let clean = searchValue.replace(` ${matchedYear} `, ' ');
      if (matchedMonthToken) clean = clean.replace(` ${matchedMonthToken} `, ' ');
      settingsModel.searchValue = clean.trim();
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }

    // Case: Only Year specified (e.g. '2021')
    if (matchedYear && !matchedMonth) {
      const start = new Date(Date.UTC(matchedYear, 0, 1, 0, 0, 0));
      const end = new Date(Date.UTC(matchedYear, 11, 31, 23, 59, 59));
      settingsModel.timePeriod = TimePeriod.Custom;
      settingsModel.description = `${matchedYear}`;
      settingsModel.startDateTime = start;
      settingsModel.endDateTime = end;
      settingsModel.searchValue = searchValue.replace(` ${matchedYear} `, ' ').trim();
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }

    // Case: Only Month specified (e.g. 'october')
    if (!matchedYear && matchedMonth) {
      const now = new Date();
      let targetYear = now.getUTCFullYear();
      // If the month is in the future this year, assume previous year
      if (matchedMonth.num > now.getUTCMonth()) {
        targetYear -= 1;
      }
      const start = new Date(Date.UTC(targetYear, matchedMonth.num, 1, 0, 0, 0));
      const end = new Date(Date.UTC(targetYear, matchedMonth.num + 1, 0, 23, 59, 59));
      settingsModel.timePeriod = TimePeriod.Custom;
      settingsModel.description = `${matchedMonth.name}`;
      settingsModel.startDateTime = start;
      settingsModel.endDateTime = end;
      if (matchedMonthToken) {
        settingsModel.searchValue = searchValue.replace(` ${matchedMonthToken} `, ' ').trim();
      }
      settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
      return settingsModel;
    }

    const dayAmounts: Array<[string[], string, number]> = [
      [['sixdays', '6d'], 'Six days', 6],
      [['fivedays', '5d'], 'Five days', 5],
      [['fourdays', '4d'], 'Four days', 4],
      [['threedays', '3d'], 'Three days', 3],
      [['twodays', '2d'], 'Two days', 2],
      [['yesterday'], 'Yesterday', 1],
      [['today'], 'Today', 0],
      [['oneday', 'daily', 'day', '1d'], 'One day', 1],
    ];

    const now = new Date();
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);

    for (const [tokens, description, days] of dayAmounts) {
      const [found, remaining] = containsAndRemove(searchValue, tokens);
      if (found) {
        settingsModel.timePeriod = TimePeriod.Daily;
        settingsModel.description = description;
        if (description === 'Today') {
          settingsModel.startDateTime = todayMidnight;
          settingsModel.endDateTime = now;
        } else if (description === 'Yesterday') {
          settingsModel.startDateTime = new Date(todayMidnight.getTime() - 86400000);
          settingsModel.endDateTime = todayMidnight;
        } else if (description === 'One day') {
          // Last 24 hours
          settingsModel.startDateTime = new Date(now.getTime() - 86400000);
          settingsModel.endDateTime = now;
        } else {
          settingsModel.startDateTime = new Date(todayMidnight.getTime() - (days - 1) * 86400000);
          settingsModel.endDateTime = now;
        }
        settingsModel.searchValue = remaining.trim();
        settingsModel.urlParameter = timePeriodUrlParameter(settingsModel.startDateTime, settingsModel.endDateTime);
        return settingsModel;
      }
    }

    settingsModel.urlParameter = timePeriodUrlParameter(undefined, undefined);
    return settingsModel;
  }

  public setWhoKnowsSettings(
    rawArgs: string,
    defaultMode: WhoKnowsMode = WhoKnowsMode.Default,
  ): WhoKnowsSettings {
    let searchValue = rawArgs.trim();
    let responseMode = defaultMode;
    let qualityFilterDisabled = false;
    let redirectsEnabled = true;

    // Check mode
    const [hasImg, afterImg] = containsAndRemove(` ${searchValue.toLowerCase()} `, ['img', 'image']);
    if (hasImg) {
      responseMode = WhoKnowsMode.Image;
      searchValue = afterImg;
    }

    const [hasEmbed, afterEmbed] = containsAndRemove(` ${searchValue.toLowerCase()} `, ['embed', 'text', 'txt']);
    if (hasEmbed) {
      responseMode = WhoKnowsMode.Default;
      searchValue = afterEmbed;
    }

    const [hasPages, afterPages] = containsAndRemove(` ${searchValue.toLowerCase()} `, ['pages', 'page', 'p', 'pp', 'pagination']);
    if (hasPages) {
      responseMode = WhoKnowsMode.Pagination;
      searchValue = afterPages;
    }

    // Check filter disabled
    const [hasNf, afterNf] = containsAndRemove(` ${searchValue.toLowerCase()} `, ['nf', 'nofilter']);
    if (hasNf) {
      qualityFilterDisabled = true;
      searchValue = afterNf;
    }

    // Check redirects
    const [hasNr, afterNr] = containsAndRemove(` ${searchValue.toLowerCase()} `, ['nr', 'noredirect']);
    if (hasNr) {
      redirectsEnabled = false;
      searchValue = afterNr;
    }

    return {
      newSearchValue: searchValue.trim(),
      responseMode,
      qualityFilterDisabled,
      redirectsEnabled,
    };
  }

  public static getGoalAmount(
    extraOptions?: string | null,
    currentPlaycount: number = 0,
  ): number {
    let goalAmount = 100;
    let ownGoalSet = false;

    if (extraOptions) {
      const options = extraOptions
        .replace(/[()*`,. ]/g, '')
        .split(/\s+/);

      for (const option of options) {
        const lower = option.toLowerCase();
        if (lower.endsWith('k')) {
          const num = parseInt(lower.replace('k', ''), 10);
          if (!isNaN(num)) {
            const kResult = num * 1000;
            if (kResult > currentPlaycount) {
              goalAmount = kResult;
              ownGoalSet = true;
              break;
            }
          }
        } else {
          const result = parseInt(option, 10);
          if (!isNaN(result) && result > currentPlaycount) {
            goalAmount = result;
            ownGoalSet = true;
            break;
          }
        }
      }
    }

    if (!ownGoalSet) {
      for (const breakPoint of PlayCountBreakPoints) {
        if (currentPlaycount < breakPoint) {
          goalAmount = breakPoint;
          break;
        }
      }
    }

    if (goalAmount > 10000000) {
      goalAmount = 10000000;
    }

    return goalAmount;
  }

  public static getMilestoneAmount(
    extraOptions?: string | null,
    currentPlaycount: number = 0,
  ): { amount: number; isRandom: boolean } {
    let goalAmount = 100;
    let ownGoalSet = false;
    let isRandom = false;

    if (extraOptions) {
      const options = extraOptions
        .replace(/[()*`,. ]/g, '')
        .split(/\s+/);

      for (const option of options) {
        const lower = option.toLowerCase();
        if (lower.endsWith('k')) {
          const num = parseInt(lower.replace('k', ''), 10);
          if (!isNaN(num)) {
            const kResult = num * 1000;
            if (kResult < currentPlaycount) {
              goalAmount = kResult;
              ownGoalSet = true;
              break;
            }
          }
        } else if (lower.includes('random') || lower.includes('rnd')) {
          goalAmount = Math.floor(Math.random() * Math.max(1, currentPlaycount)) + 1;
          ownGoalSet = true;
          isRandom = true;
          break;
        } else {
          const result = parseInt(option, 10);
          if (!isNaN(result) && result < currentPlaycount) {
            goalAmount = result;
            ownGoalSet = true;
            break;
          }
        }
      }
    }

    if (!ownGoalSet) {
      const descBreakPoints = [...PlayCountBreakPoints].reverse();
      for (const breakPoint of descBreakPoints) {
        if (currentPlaycount > breakPoint) {
          goalAmount = breakPoint;
          break;
        }
      }
    }

    if (goalAmount < 1) {
      goalAmount = 1;
    }

    return { amount: goalAmount, isRandom };
  }
}

export const PlayCountBreakPoints = [
  50, 100, 250, 420, 500, 1000, 1337, 2500, 5000, 10000, 25000, 50000, 100000,
  150000, 200000, 250000, 300000, 350000, 400000, 450000, 500000, 600000, 700000,
  800000, 900000, 1000000, 1500000, 2000000, 2500000, 5000000, 10000000,
];
