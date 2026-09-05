import { describe, it, expect } from 'vitest';
import { CrownBuilders } from './crownBuilders';
import type { UserCrownDto, CrownLeaderboardEntry } from '@domain/models/crownModels';

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
    const json = response.componentsV2Container?.toJSON() as any;
    expect(json.type).toBe(17);
    expect(json.accent_color).toBe(0xBA0009);
    // First text component is title
    expect(json.components[0].content).toBe('### Crowns for moha');
    // Third text component has lines
    expect(json.components[2].content).toContain('1. **TV Girl** — *7,437 plays* — Claimed <t:1776592117:R>');
    expect(json.components[2].content).toContain('2. **d4vd** — *2,322 plays* — Claimed <t:1777348065:R>');
    // Footer
    expect(json.components[4].content).toContain('Page 1/1 - 2 total crowns');
    // Select menu
    expect(json.components[5].components[0].custom_id).toBe('user-crownpicker');
    // Paginator row with 5 buttons
    expect(json.components[6].components.length).toBe(5);
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
    const row = rows![0]!.toJSON() as any;
    expect(row.components[0].custom_id).toBe('artist-whoknows:19820');
    expect(row.components[0].label).toBe('WhoKnows');
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
    const json = response.componentsV2Container?.toJSON() as any;
    expect(json.components[0].content).toBe('### Users with most crowns in الازعروكش');
    expect(json.components[2].content).toBe('1. **moha** - *24 crowns*');
    expect(json.components[4].content).toContain('-# Your ranking: #1');
    expect(json.components[4].content).toContain('24 total active crowns in this server');
    // Select menu
    expect(json.components[5].components[0].custom_id).toBe('guild-members');
    expect(json.components[5].components[0].options[1].value).toBe('Crowns');
  });
});
