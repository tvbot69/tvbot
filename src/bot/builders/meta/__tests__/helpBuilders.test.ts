import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  ButtonBuilder,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { HelpBuilders, HELP_CATEGORIES } from '@bot/builders/meta/helpBuilders';

/*
 * `ResponseModel.buttonRows` is `ActionRowBuilder<MessageActionRowComponentBuilder>[]`,
 * so a row's `.components[0]` is a six-way union. The builder that lands in each
 * slot is the contract under test, so it is narrowed with the real `instanceof`
 * rather than an unchecked cast.
 */
const asStringSelect = (
  c: MessageActionRowComponentBuilder | undefined,
): StringSelectMenuBuilder => {
  expect(c).toBeInstanceOf(StringSelectMenuBuilder);
  return c as StringSelectMenuBuilder;
};

const asButton = (c: MessageActionRowComponentBuilder | undefined): ButtonBuilder => {
  expect(c).toBeInstanceOf(ButtonBuilder);
  return c as ButtonBuilder;
};

/**
 * `ButtonBuilder.data` is `Partial<APIButtonComponent>`, and that union's link
 * and SKU variants have no `custom_id` - only the custom-id variant does. `in`
 * is that discriminant.
 */
const buttonCustomId = (b: ButtonBuilder): string | undefined =>
  'custom_id' in b.data ? b.data.custom_id : undefined;

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
    const selectMenu = asStringSelect(row0!.components[0]);
    expect(selectMenu.data.custom_id).toBe('help:category:12345');
    expect(selectMenu.options.length).toBe(HELP_CATEGORIES.length);
    const homeOption = selectMenu.options.find((o) => o.data.value === 'home');
    expect(homeOption?.data.default).toBe(true);

    // Verify buttons row
    const row1 = response.buttonRows.get(1)?.[0];
    expect(row1).toBeDefined();
    expect(row1!.components.length).toBe(5);
    const homeBtn = asButton(row1!.components[0]);
    expect(buttonCustomId(homeBtn)).toBe('help:btn:home:12345');
    expect(homeBtn.data.disabled).toBe(true); // Home is active
  });

  it('builds category-specific response correctly', () => {
    const categories = ['stats', 'charts', 'top', 'whoknows', 'music', 'social', 'settings'] as const;

    for (const cat of categories) {
      const response = HelpBuilders.buildHelpResponse(cat, '+', 'user99', 0xff0000);
      expect(response.hasEmbed()).toBe(true);
      expect(response.embed.data.description).toContain('+');

      const selectMenu = asStringSelect(response.buttonRows.get(0)?.[0]?.components[0]);
      const selected = selectMenu.options.find((o) => o.data.value === cat);
      expect(selected?.data.default).toBe(true);
    }
  });
});
