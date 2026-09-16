import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { HelpBuilders, HELP_CATEGORIES } from './helpBuilders';

describe('HelpBuilders', () => {
  it('normalizes category strings correctly', () => {
    expect(HelpBuilders.normalizeCategory()).toBe('home');
    expect(HelpBuilders.normalizeCategory('overview')).toBe('home');
    expect(HelpBuilders.normalizeCategory('wk')).toBe('whoknows');
    expect(HelpBuilders.normalizeCategory('whoknows')).toBe('whoknows');
    expect(HelpBuilders.normalizeCategory('music')).toBe('music');
    expect(HelpBuilders.normalizeCategory('audio')).toBe('music');
    expect(HelpBuilders.normalizeCategory('tar')).toBe('top');
    expect(HelpBuilders.normalizeCategory('top')).toBe('top');
    expect(HelpBuilders.normalizeCategory('c')).toBe('charts');
    expect(HelpBuilders.normalizeCategory('chart')).toBe('charts');
    expect(HelpBuilders.normalizeCategory('streak')).toBe('stats');
    expect(HelpBuilders.normalizeCategory('fm')).toBe('stats');
    expect(HelpBuilders.normalizeCategory('taste')).toBe('social');
    expect(HelpBuilders.normalizeCategory('login')).toBe('settings');
    expect(HelpBuilders.normalizeCategory('unknown_xyz')).toBe('home');
  });

  it('builds home help response with select menu and action buttons', () => {
    const response = HelpBuilders.buildHelpResponse('home', '.', '12345', 0x5865f2);

    expect(response.hasEmbed()).toBe(true);
    expect(response.embed.data.title).toContain('Overview & Quick Start');
    expect(response.embed.data.description).toContain('Quick Start Guide');
    expect(response.embed.data.color).toBe(0x5865f2);

    // Verify select menu row
    const row0 = response.buttonRows.get(0)?.[0];
    expect(row0).toBeDefined();
    const selectMenu = row0!.components[0] as any;
    expect(selectMenu.data.custom_id).toBe('help:category:12345');
    expect(selectMenu.options.length).toBe(HELP_CATEGORIES.length);
    const homeOption = selectMenu.options.find((o: any) => o.data.value === 'home');
    expect(homeOption?.data.default).toBe(true);

    // Verify buttons row
    const row1 = response.buttonRows.get(1)?.[0];
    expect(row1).toBeDefined();
    expect(row1!.components.length).toBe(5);
    const homeBtn = row1!.components[0] as any;
    expect(homeBtn.data.custom_id).toBe('help:btn:home:12345');
    expect(homeBtn.data.disabled).toBe(true); // Home is active
  });

  it('builds category-specific response correctly', () => {
    const categories = ['stats', 'charts', 'top', 'whoknows', 'music', 'social', 'settings'] as const;

    for (const cat of categories) {
      const response = HelpBuilders.buildHelpResponse(cat, '+', 'user99', 0xff0000);
      expect(response.hasEmbed()).toBe(true);
      expect(response.embed.data.description).toContain('+');

      const selectMenu = response.buttonRows.get(0)?.[0]?.components[0] as any;
      const selected = selectMenu.options.find((o: any) => o.data.value === cat);
      expect(selected?.data.default).toBe(true);
    }
  });
});
