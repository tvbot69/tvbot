import { TimePeriod } from '@domain/enums/timePeriod';

export interface TimeSettings {
  startDateTime?: Date;
  endDateTime?: Date;
  timePeriod: TimePeriod;
  description: string;
  searchValue: string;
  urlParameter?: string;
}

const URL_PARAMETERS: Partial<Record<TimePeriod, string>> = {
  [TimePeriod.Weekly]: 'LAST_7_DAYS',
  [TimePeriod.Monthly]: 'LAST_30_DAYS',
  [TimePeriod.Quarterly]: 'LAST_90_DAYS',
  [TimePeriod.HalfYearly]: 'LAST_180_DAYS',
  [TimePeriod.Yearly]: 'LAST_365_DAYS',
  [TimePeriod.AllTime]: 'ALL',
};

export const timePeriodUrlParameter = (
  startDateTime?: Date,
  endDateTime?: Date,
): string | undefined => {
  if (!startDateTime) {
    return undefined;
  }
  if (URL_PARAMETERS[TimePeriod.Weekly]) {
    const days = Math.ceil(
      ((endDateTime ?? new Date()).getTime() - startDateTime.getTime()) / 86400000,
    );
    if (days <= 7) return 'LAST_7_DAYS';
    if (days <= 31) return 'LAST_30_DAYS';
    if (days <= 92) return 'LAST_90_DAYS';
    if (days <= 183) return 'LAST_180_DAYS';
    if (days <= 366) return 'LAST_365_DAYS';
  }
  return 'ALL';
};

export class TimeSettingsModel implements TimeSettings {
  public startDateTime?: Date;
  public endDateTime?: Date;
  public timePeriod: TimePeriod;
  public description: string;
  public searchValue: string;
  public urlParameter?: string;

  constructor(searchValue: string) {
    this.timePeriod = TimePeriod.AllTime;
    this.description = 'Alltime';
    this.searchValue = searchValue;
    this.urlParameter = 'ALL';
  }

  public get days(): number | null {
    if (!this.startDateTime) {
      return null;
    }
    const end = this.endDateTime ?? new Date();
    return Math.round((end.getTime() - this.startDateTime.getTime()) / (1000 * 60 * 60 * 24));
  }
}
