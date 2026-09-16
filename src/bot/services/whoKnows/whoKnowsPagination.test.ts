import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsService } from './whoKnowsService';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { ContextModel } from '@bot/models/contextModel';
import { ComponentPaginatorService } from '../componentPaginatorService';

describe('WhoKnows Pagination Mode & Parity', () => {
  const users = [
    {
      userId: 1,
      discordUserId: '1001',
      discordName: 'moha',
      lastFmUsername: 'Moha504',
      playcount: 241,
      hasCrown: true,
    },
    {
      userId: 2,
      discordUserId: '1002',
      discordName: 'مس',
      lastFmUsername: 'fm-bot',
      playcount: 2,
      hasCrown: false,
    },
  ];

  it('generatePages avoids duplicate requester when requester holds crown', () => {
    const pages = WhoKnowsService.generatePages(users, 1, undefined, 10, '1001');
    expect(pages.length).toBe(1);
    const lines = pages[0]!.lines;

    // Crown line should have requester formatting
    expect(lines).toContain('👑  **[moha](https://last.fm/user/Moha504) - 241 plays**');
    // Other user should have bold playcount
    expect(lines).toContain('2.  [مس](https://last.fm/user/fm-bot) - **2** plays');
    // Requester must NOT be duplicated at bottom
    const occurrences = (lines.match(/moha/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('buildWhoKnowsResponse in Pagination mode matches fmbot Components V2 structure', async () => {
    const ctx = new ContextModel();
    ctx.discordUserId = '1001';

    const response = await WhoKnowsBuilders.buildWhoKnowsResponse(
      ctx,
      'EsDeeKid in الازعروكش',
      'https://www.last.fm/music/EsDeeKid',
      'https://i.scdn.co/image/xyz',
      users,
      undefined,
      undefined,
      ['cloud rap', 'british', 'trap'],
      undefined,
      WhoKnowsMode.Pagination,
      undefined,
      'Artist',
    );

    expect(response.isComponentsV2).toBe(true);
    const container = response.componentsV2Container;
    expect(container).toBeDefined();

    const json = container!.toJSON() as any;
    expect(json.type).toBe(17); // Container
    expect(json.accent_color).toBeUndefined(); // No accent color on container, matching fmbot

    const comps = json.components;
    expect(comps.length).toBe(6);

    // Component 0: TextDisplay with clean title (no link, no thumbnail accessory)
    expect(comps[0].type).toBe(10);
    expect(comps[0].content).toBe('### EsDeeKid in الازعروكش');

    // Component 1: Separator
    expect(comps[1].type).toBe(14);
    expect(comps[1].divider).toBe(true);

    // Component 2: TextDisplay with leaderboard
    expect(comps[2].type).toBe(10);
    expect(comps[2].content).toContain('👑  **[moha](https://last.fm/user/Moha504) - 241 plays**');
    expect(comps[2].content).toContain('2.  [مس](https://last.fm/user/fm-bot) - **2** plays');

    // Component 3: Separator
    expect(comps[3].type).toBe(14);
    expect(comps[3].divider).toBe(true);

    // Component 4: TextDisplay with footer
    expect(comps[4].type).toBe(10);
    expect(comps[4].content).toContain('-# Page 1/1');
    expect(comps[4].content).toContain('-# Artist - 2 listeners - 243 plays - 121 avg');
    expect(comps[4].content).toContain("-# Spotify not tracking properly? Check '.outofsync'");

    // Component 5: ActionRow with 5 pagination buttons
    expect(comps[5].type).toBe(1); // ActionRow
    const buttons = comps[5].components;
    expect(buttons.length).toBe(5);

    expect(buttons[0].custom_id).toBe('component_paginator_first');
    expect(buttons[0].emoji?.id).toBe('883825508633182208');
    expect(buttons[0].disabled).toBe(true); // Total pages is 1, so disabled

    expect(buttons[1].custom_id).toBe('component_paginator_previous');
    expect(buttons[1].emoji?.id).toBe('883825508507336704');
    expect(buttons[1].disabled).toBe(true);

    expect(buttons[2].custom_id).toBe('component_paginator_next');
    expect(buttons[2].emoji?.id).toBe('883825508087922739');
    expect(buttons[2].disabled).toBe(true);

    expect(buttons[3].custom_id).toBe('component_paginator_last');
    expect(buttons[3].emoji?.id).toBe('883825508482183258');
    expect(buttons[3].disabled).toBe(true);

    expect(buttons[4].custom_id).toBe('component_paginator_jump');
    expect(buttons[4].emoji?.id).toBe('1138849626234036264');
    expect(buttons[4].disabled).toBe(true);

    // Paginator session attached
    const session = (response as any)._paginatorSession;
    expect(session).toBeDefined();
    expect(session.currentPage).toBe(0);
    expect(session.totalPages).toBe(1);
  });

  it('ComponentPaginatorService handles button interaction correctly', async () => {
    const service = new ComponentPaginatorService();
    const renderPage = vi.fn().mockImplementation((idx: number) => {
      const c = new (require('discord.js').ContainerBuilder)();
      c.addTextDisplayComponents(new (require('discord.js').TextDisplayBuilder)().setContent(`Page ${idx}`));
      return c;
    });

    const session = {
      currentPage: 0,
      totalPages: 3,
      renderPage,
      expiresAt: Date.now() + 60000,
    };

    service.registerSession('msg-123', session);

    const fakeInteraction: any = {
      customId: 'component_paginator_next',
      message: { id: 'msg-123' },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const handled = await service.handleButton(fakeInteraction);
    expect(handled).toBe(true);
    expect(session.currentPage).toBe(1);
    expect(renderPage).toHaveBeenCalledWith(1);
    expect(fakeInteraction.update).toHaveBeenCalled();
  });
});
