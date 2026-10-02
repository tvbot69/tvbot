import { describe, it, expect } from 'vitest';
import {
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import { CrownBuilders } from '@bot/builders/crown/crownBuilders';
import type { UserCrownDto, CrownLeaderboardEntry } from '@domain/models/crownModels';

/*
 * The positional layout of a serialised container IS what these tests assert, so
 * each slot is read through the real discord-api-types union and checked against
 * the expected `type` discriminant. A builder that moved a component now fails
 * here instead of silently reading `.content` off the wrong object.
 */
const componentAt = <T extends APIComponentInContainer['type']>(
  components: readonly APIComponentInContainer[],
  index: number,
  type: T,
): Extract<APIComponentInContainer, { type: T }> => {
  const component = components[index];
  expect(component?.type).toBe(type);
  return component as Extract<APIComponentInContainer, { type: T }>;
};

const rowComponentAt = <T extends APIComponentInMessageActionRow['type']>(
  row: APIActionRowComponent<APIComponentInMessageActionRow>,
  index: number,
  type: T,
): Extract<APIComponentInMessageActionRow, { type: T }> => {
  const component = row.components[index];
  expect(component?.type).toBe(type);
  return component as Extract<APIComponentInMessageActionRow, { type: T }>;
};

/**
 * `APIButtonComponent` is a three-way union discriminated by `style`, and only
 * the custom-id variant carries `custom_id` - a link button carries `url`
 * instead. `in` is that discriminant.
 */
const customIdButtonAt = (
  row: APIActionRowComponent<APIComponentInMessageActionRow>,
  index: number,
): APIButtonComponentWithCustomId => {
  const button = rowComponentAt(row, index, ComponentType.Button);
  if (!('custom_id' in button)) {
    throw new Error(`row.components[${index}] is not a custom-id button`);
  }
  return button;
};

describe('CrownBuilders', () => {
  it('builds crowns list response in Component V2 format with correct structure', () => {
    const crowns: UserCrownDto[] = [
      {
        crownId: 1,
        guildId: '123456789',
        userId: 10,
        artistName: 'TV Girl',
        currentPlaycount: 7437,
        startPlaycount: 7000,
        created: new Date(1776592117000),
        modified: new Date(1776592117000),
        active: true,
        seededCrown: false,
      },
      {
        crownId: 2,
        guildId: '123456789',
        userId: 10,
        artistName: 'd4vd',
        currentPlaycount: 2322,
        startPlaycount: 2000,
        created: new Date(1777348065000),
        modified: new Date(1777348065000),
        active: true,
        seededCrown: false,
      },
    ];

    const response = CrownBuilders.buildCrownsResponse(
      'moha',
      '687636049576722472',
      '687636049576722472',
      crowns,
      1,
      'Playcount',
      0xBA0009,
    );

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();
    expect(json.type).toBe(17);
    expect(json.accent_color).toBe(0xBA0009);
    // First text component is title
    expect(componentAt(json.components, 0, ComponentType.TextDisplay).content).toBe(
      '### Crowns for moha',
    );
    // Third text component has lines
    const lines = componentAt(json.components, 2, ComponentType.TextDisplay).content;
    expect(lines).toContain('1. **TV Girl** — *7,437 plays* — Claimed <t:1776592117:R>');
    expect(lines).toContain('2. **d4vd** — *2,322 plays* — Claimed <t:1777348065:R>');
    // Footer
    expect(componentAt(json.components, 4, ComponentType.TextDisplay).content).toContain(
      'Page 1/1 - 2 total crowns',
    );
    // Select menu
    const selectRow = componentAt(json.components, 5, ComponentType.ActionRow);
    expect(rowComponentAt(selectRow, 0, ComponentType.StringSelect).custom_id).toBe(
      'user-crownpicker',
    );
    // Paginator row with 5 buttons
    expect(componentAt(json.components, 6, ComponentType.ActionRow).components.length).toBe(5);
  });

  it('builds crown duel response in embed format with WhoKnows button', () => {
    const crown: UserCrownDto = {
      crownId: 1,
      guildId: '123456789',
      userId: 10,
      artistName: 'Ken Carson',
      currentPlaycount: 915,
      startPlaycount: 788,
      created: new Date(1776591985000),
      modified: new Date(1788445896000),
      active: true,
      seededCrown: false,
      userNameLastFm: 'Moha504',
    };

    const response = CrownBuilders.buildCrownDuelResponse(
      'Ken Carson',
      crown,
      'moha',
      null,
      [crown],
      0xBA0009,
      19820,
    );

    expect(response.embed).toBeDefined();
    expect(response.embed?.data.title).toBe('Crown for Ken Carson');
    expect(response.embed?.data.description).toContain('👑 → [moha](https://last.fm/user/Moha504) — **915 plays**');
    expect(response.embed?.data.description).toContain('**moha** holds the crown for [Ken Carson]');
    expect(response.embed?.data.fields?.[0]?.name).toBe('Current crown holder');
    expect(response.embed?.data.fields?.[0]?.value).toContain('**<t:1776591985:D>** to **<t:1788445896:D>**');
    expect(response.embed?.data.fields?.[0]?.value).toContain('*788 to 915 plays*');

    // WhoKnows button
    const rows = response.buttonRows.get(0);
    expect(rows).toBeDefined();
    expect(rows!.length).toBe(1);
    const row = rows![0]!.toJSON();
    const whoknowsButton = customIdButtonAt(row, 0);
    expect(whoknowsButton.custom_id).toBe('artist-whoknows:19820');
    expect(whoknowsButton.label).toBe('WhoKnows');
  });

  it('builds crown leaderboard response in Component V2 format with guild-members select menu', () => {
    const items: CrownLeaderboardEntry[] = [
      {
        userId: 10,
        discordUserId: '687636049576722472',
        userNameLastFm: 'Moha504',
        displayName: 'moha',
        crownCount: 24,
      },
    ];

    const response = CrownBuilders.buildCrownLeaderboardResponse(
      'الازعروكش',
      items,
      10,
      1,
      24,
      0xBA0009,
    );

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();
    expect(componentAt(json.components, 0, ComponentType.TextDisplay).content).toBe(
      '### Users with most crowns in الازعروكش',
    );
    expect(componentAt(json.components, 2, ComponentType.TextDisplay).content).toBe(
      '1. **moha** - *24 crowns*',
    );
    const ranking = componentAt(json.components, 4, ComponentType.TextDisplay).content;
    expect(ranking).toContain('-# Your ranking: #1');
    expect(ranking).toContain('24 total active crowns in this server');
    // Select menu
    const selectRow = componentAt(json.components, 5, ComponentType.ActionRow);
    const memberSelect = rowComponentAt(selectRow, 0, ComponentType.StringSelect);
    expect(memberSelect.custom_id).toBe('guild-members');
    expect(memberSelect.options[1]?.value).toBe('Crowns');
  });
});
