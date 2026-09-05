export enum TimePeriod {
  AllTime = 'AllTime',
  Yearly = 'Yearly',
  TwoYear = 'TwoYear',
  HalfYearly = 'HalfYearly',
  Quarterly = 'Quarterly',
  Monthly = 'Monthly',
  Weekly = 'Weekly',
  Daily = 'Daily',
  Custom = 'Custom',
}

export const TimePeriodToLastfmApiPeriod: Record<TimePeriod, string> = {
  [TimePeriod.AllTime]: 'overall',
  [TimePeriod.Yearly]: '12month',
  [TimePeriod.TwoYear]: '12month',
  [TimePeriod.HalfYearly]: '6month',
  [TimePeriod.Quarterly]: '3month',
  [TimePeriod.Monthly]: '1month',
  [TimePeriod.Weekly]: '7day',
  [TimePeriod.Daily]: '7day',
  [TimePeriod.Custom]: 'overall',
};
