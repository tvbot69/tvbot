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
