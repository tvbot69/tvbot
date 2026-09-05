import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { SettingService } from './settingService';
import { TimePeriod } from '@domain/enums/timePeriod';

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
