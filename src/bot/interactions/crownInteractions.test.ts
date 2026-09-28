import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { CrownInteractions } from './crownInteractions';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import type { UserCrownDto, CrownLeaderboardEntry } from '@domain/models/crownModels';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';

const makeCrown = (over: Partial<UserCrownDto> = {}): UserCrownDto => ({
  crownId: 1,
  guildId: 'g1',
  userId: 1,
  artistName: 'Radiohead',
  currentPlaycount: 500,
  startPlaycount: 300,
  created: new Date('2025-01-01'),
  modified: new Date('2025-06-01'),
  active: true,
  seededCrown: false,
  userNameLastFm: 'user1',
  discordUserId: 'u1',
  ...over,
});

const makeLeaderboardEntry = (over: Partial<CrownLeaderboardEntry> = {}): CrownLeaderboardEntry => ({
  userId: 1,
  discordUserId: 'u1',
  userNameLastFm: 'user1',
  displayName: 'user1',
  crownCount: 5,
  ...over,
});

const makeButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: { name: 'TestGuild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };

const makeSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: { name: 'TestGuild', members: { cache: new Map() } },
    values,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    message: { embeds: [], flags: { has: () => true } },
    ...over,
  }) as unknown as StringSelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const crownService = {
    getUserCrowns: vi.fn(async () => [makeCrown()]),
    getGuildLeaderboard: vi.fn(async () => ({ entries: [makeLeaderboardEntry()], totalActiveCrowns: 10 })),
    ...(over.crownService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'user1' })),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const ci = new CrownInteractions(crownService as never, userService as never, colorService as never);
  return { ci, crownService, userService, colorService };
};

const mockContainerResolve = (impl: (token: unknown) => unknown) => {
  const spy = vi.spyOn(container, 'resolve').mockImplementation(impl as never);
  return spy;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CrownInteractions.handleSelectMenu — user-crownpicker', () => {
  it('builds and updates the crown response for a valid selection', async () => {
    const { ci, crownService, userService } = build();
    const select = makeSelect('user-crownpicker', ['caller1-target1-Playcount']);

    await ci.handleSelectMenu(select);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('target1');
    expect(crownService.getUserCrowns).toHaveBeenCalledWith('g1', 1, 'Playcount');
    expect(select.update).toHaveBeenCalledTimes(1);
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('returns early when no value is selected', async () => {
    const { ci, crownService } = build();
    const select = makeSelect('user-crownpicker', []);

    await ci.handleSelectMenu(select);

    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('returns early when the value has fewer than 3 parts', async () => {
    const { ci, crownService } = build();
    const select = makeSelect('user-crownpicker', ['caller1-target1']);

    await ci.handleSelectMenu(select);

    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
  });

  it('defers update when the target user is not found', async () => {
    const { ci, userService } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const select = makeSelect('user-crownpicker', ['caller1-unknown-Playcount']);

    await ci.handleSelectMenu(select);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('unknown');
    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
    expect(select.update).not.toHaveBeenCalled();
  });

  it('uses member displayName when available', async () => {
    const { ci } = build();
    const member = { displayName: 'CoolUser' };
    const select = makeSelect('user-crownpicker', ['caller1-target1-Playcount'], {
      guild: { name: 'TestGuild', members: { cache: new Map([['target1', member]]) } },
    });

    await ci.handleSelectMenu(select);

    expect(select.update).toHaveBeenCalledTimes(1);
  });

  it('falls back to userNameLastFm when member is not cached', async () => {
    const { ci } = build();
    const select = makeSelect('user-crownpicker', ['caller1-target1-Playcount'], {
      guild: { name: 'TestGuild', members: { cache: new Map() } },
    });

    await ci.handleSelectMenu(select);

    expect(select.update).toHaveBeenCalledTimes(1);
  });

  it('falls back to deferUpdate when interaction.update throws', async () => {
    const { ci } = build();
    const select = makeSelect('user-crownpicker', ['caller1-target1-Playcount'], {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ci.handleSelectMenu(select);

    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('CrownInteractions.handleSelectMenu — guild-members', () => {
  it('builds and updates the crown leaderboard for "Crowns" selection', async () => {
    const { ci, crownService, userService } = build();
    const select = makeSelect('guild-members', ['Crowns']);

    await ci.handleSelectMenu(select);

    expect(crownService.getGuildLeaderboard).toHaveBeenCalledWith('g1');
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
    expect(select.update).toHaveBeenCalledTimes(1);
  });

  it('returns early when no value is selected', async () => {
    const { ci, crownService } = build();
    const select = makeSelect('guild-members', []);

    await ci.handleSelectMenu(select);

    expect(crownService.getGuildLeaderboard).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
  });

  it('does nothing for non-Crowns selections', async () => {
    const { ci, crownService } = build();
    const select = makeSelect('guild-members', ['Overview']);

    await ci.handleSelectMenu(select);

    expect(crownService.getGuildLeaderboard).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
  });

  it('enriches entries with member displayName when available', async () => {
    const { ci } = build();
    const member = { displayName: 'GuildMember' };
    const select = makeSelect('guild-members', ['Crowns'], {
      guild: { name: 'TestGuild', members: { cache: new Map([['u1', member]]) } },
    });

    await ci.handleSelectMenu(select);

    expect(select.update).toHaveBeenCalledTimes(1);
  });

  it('falls back to deferUpdate when interaction.update throws', async () => {
    const { ci } = build();
    const select = makeSelect('guild-members', ['Crowns'], {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ci.handleSelectMenu(select);

    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('CrownInteractions.handleButton — artist-whoknows', () => {
  it('defers, resolves artist name, calls whoKnows, and edits reply', async () => {
    const { ci } = build();
    const whoKnowsCommands = {
      whoKnowsArtistForName: vi.fn(async (_ctx: unknown, _name: string) => ({
        isComponentsV2: true,
        componentsV2Container: {},
        addButtonRow: vi.fn(),
      })),
    };
    const artistRepo = { getArtistById: vi.fn(async () => ({ id: 42, name: 'Radiohead' })) };
    mockContainerResolve((token: unknown) => {
      if (token === ArtistRepository) return artistRepo;
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    const press = makeButton('artist-whoknows:42');
    await ci.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(whoKnowsCommands.whoKnowsArtistForName).toHaveBeenCalledTimes(1);
    const ctx = whoKnowsCommands.whoKnowsArtistForName.mock.calls[0]![0] as { componentInteraction?: unknown };
    expect(ctx.componentInteraction).toBeDefined();
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('uses decoded artist name when raw is not numeric', async () => {
    const { ci } = build();
    const whoKnowsCommands = {
      whoKnowsArtistForName: vi.fn(async () => ({
        isComponentsV2: true,
        componentsV2Container: {},
        addButtonRow: vi.fn(),
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    const press = makeButton('artist-whoknows:Radiohead');
    await ci.handleButton(press);

    expect(whoKnowsCommands.whoKnowsArtistForName).toHaveBeenCalledTimes(1);
  });

  it('falls back to decoded name when ArtistRepository throws', async () => {
    const { ci } = build();
    const whoKnowsCommands = {
      whoKnowsArtistForName: vi.fn(async () => ({
        isComponentsV2: true,
        componentsV2Container: {},
        addButtonRow: vi.fn(),
      })),
    };
    const artistRepo = {
      getArtistById: vi.fn(async () => {
        throw new Error('db error');
      }),
    };
    mockContainerResolve((token: unknown) => {
      if (token === ArtistRepository) return artistRepo;
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    const press = makeButton('artist-whoknows:42');
    await ci.handleButton(press);

    expect(whoKnowsCommands.whoKnowsArtistForName).toHaveBeenCalledTimes(1);
  });

  it('uses legacy editReply path when response is not ComponentsV2', async () => {
    const { ci } = build();
    const whoKnowsCommands = {
      whoKnowsArtistForName: vi.fn(async () => ({
        isComponentsV2: false,
        addButtonRow: vi.fn(),
        hasEmbed: () => true,
        buildEmbed: () => [],
        buildComponents: () => [],
        content: 'who-knows',
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    const press = makeButton('artist-whoknows:Radiohead');
    await ci.handleButton(press);

    expect(press.editReply).toHaveBeenCalledTimes(1);
    const payload = press.editReply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toBe('who-knows');
  });

  it('swallows editReply errors', async () => {
    const { ci } = build();
    const whoKnowsCommands = {
      whoKnowsArtistForName: vi.fn(async () => ({
        isComponentsV2: true,
        componentsV2Container: {},
        addButtonRow: vi.fn(),
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    const press = makeButton('artist-whoknows:Radiohead', {
      editReply: vi.fn(async () => {
        throw new Error('edit failed');
      }),
    });
    await expect(ci.handleButton(press)).resolves.toBeUndefined();
  });
});

describe('CrownInteractions.handleButton — artist-crown', () => {
  it('defers, resolves artist name, calls crown, and edits reply', async () => {
    const { ci } = build();
    const crownCommands = {
      crownAsync: vi.fn(async (_ctx: unknown, _args: string[]) => ({
        isComponentsV2: true,
        componentsV2Container: {},
      })),
    };
    const artistRepo = { getArtistById: vi.fn(async () => ({ id: 42, name: 'Radiohead' })) };
    mockContainerResolve((token: unknown) => {
      if (token === ArtistRepository) return artistRepo;
      if (token === CrownCommands) return crownCommands;
      return {} as never;
    });

    const press = makeButton('artist-crown:42');
    await ci.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(crownCommands.crownAsync).toHaveBeenCalledTimes(1);
    const args = crownCommands.crownAsync.mock.calls[0]![1] as string[];
    expect(args).toEqual(['Radiohead']);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('uses decoded artist name when raw is not numeric', async () => {
    const { ci } = build();
    const crownCommands = {
      crownAsync: vi.fn(async (_ctx: unknown, _args: string[]) => ({
        isComponentsV2: true,
        componentsV2Container: {},
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === CrownCommands) return crownCommands;
      return {} as never;
    });

    const press = makeButton('artist-crown:Radiohead');
    await ci.handleButton(press);

    const args = crownCommands.crownAsync.mock.calls[0]![1] as string[];
    expect(args).toEqual(['Radiohead']);
  });

  it('falls back to decoded name when ArtistRepository throws', async () => {
    const { ci } = build();
    const crownCommands = {
      crownAsync: vi.fn(async (_ctx: unknown, _args: string[]) => ({
        isComponentsV2: true,
        componentsV2Container: {},
      })),
    };
    const artistRepo = {
      getArtistById: vi.fn(async () => {
        throw new Error('db error');
      }),
    };
    mockContainerResolve((token: unknown) => {
      if (token === ArtistRepository) return artistRepo;
      if (token === CrownCommands) return crownCommands;
      return {} as never;
    });

    const press = makeButton('artist-crown:42');
    await ci.handleButton(press);

    const args = crownCommands.crownAsync.mock.calls[0]![1] as string[];
    expect(args).toEqual(['42']);
  });

  it('uses legacy editReply path when response is not ComponentsV2', async () => {
    const { ci } = build();
    const crownCommands = {
      crownAsync: vi.fn(async () => ({
        isComponentsV2: false,
        hasEmbed: () => true,
        buildEmbed: () => [],
        buildComponents: () => [],
        content: 'crown',
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === CrownCommands) return crownCommands;
      return {} as never;
    });

    const press = makeButton('artist-crown:Radiohead');
    await ci.handleButton(press);

    expect(press.editReply).toHaveBeenCalledTimes(1);
    const payload = press.editReply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toBe('crown');
  });

  it('swallows editReply errors', async () => {
    const { ci } = build();
    const crownCommands = {
      crownAsync: vi.fn(async () => ({
        isComponentsV2: true,
        componentsV2Container: {},
      })),
    };
    mockContainerResolve((token: unknown) => {
      if (token === CrownCommands) return crownCommands;
      return {} as never;
    });

    const press = makeButton('artist-crown:Radiohead', {
      editReply: vi.fn(async () => {
        throw new Error('edit failed');
      }),
    });
    await expect(ci.handleButton(press)).resolves.toBeUndefined();
  });
});

describe('CrownInteractions.handleButton — crowns-page pagination', () => {
  const crowns = Array.from({ length: 25 }, (_, i) =>
    makeCrown({ crownId: i + 1, artistName: `Artist ${i + 1}` }),
  );

  it('navigates to the first page', async () => {
    const { ci, crownService } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:first:caller1:target1:Playcount:3');

    await ci.handleButton(press);

    expect(crownService.getUserCrowns).toHaveBeenCalledWith('g1', 1, 'Playcount');
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('navigates to the previous page', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:prev:caller1:target1:Playcount:3');

    await ci.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('navigates to the next page', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:next:caller1:target1:Playcount:1');

    await ci.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('navigates to the last page', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:last:caller1:target1:Playcount:1');

    await ci.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('navigates to the jump page', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:jump:caller1:target1:Playcount:1');

    await ci.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('returns early when customId has fewer than 6 parts', async () => {
    const { ci, crownService } = build();
    const press = makeButton('crowns-page:first:caller1:target1');

    await ci.handleButton(press);

    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('defers update when the target user is not found', async () => {
    const { ci, userService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    const press = makeButton('crowns-page:next:caller1:unknown:Playcount:1');

    await ci.handleButton(press);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('unknown');
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('falls back to deferUpdate when interaction.update throws', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:next:caller1:target1:Playcount:1', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ci.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps current page for unknown action', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => crowns) },
    });
    const press = makeButton('crowns-page:unknown:caller1:target1:Playcount:2');

    await ci.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
  });
});

describe('CrownInteractions.handleButton — unknown customId', () => {
  it('returns early for unrecognized customId', async () => {
    const { ci, crownService } = build();
    const press = makeButton('something-else');

    await ci.handleButton(press);

    expect(crownService.getUserCrowns).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('CrownInteractions — response building', () => {
  it('buildCrownsResponse receives correct arguments from user-crownpicker', async () => {
    const { ci } = build();
    const spy = vi.spyOn(CrownBuilders, 'buildCrownsResponse');
    const select = makeSelect('user-crownpicker', ['caller1-target1-Recent']);

    await ci.handleSelectMenu(select);

    expect(spy).toHaveBeenCalledWith(
      'user1',
      'caller1',
      'target1',
      expect.any(Array),
      1,
      'Recent',
      0xff0000,
    );
  });

  it('buildCrownLeaderboardResponse receives correct arguments from guild-members', async () => {
    const { ci } = build();
    const spy = vi.spyOn(CrownBuilders, 'buildCrownLeaderboardResponse');
    const select = makeSelect('guild-members', ['Crowns']);

    await ci.handleSelectMenu(select);

    expect(spy).toHaveBeenCalledWith(
      'TestGuild',
      expect.any(Array),
      1,
      1,
      10,
      0xff0000,
    );
  });

  it('buildCrownsResponse receives correct page from pagination', async () => {
    const { ci } = build({
      crownService: { getUserCrowns: vi.fn(async () => Array.from({ length: 25 }, (_, i) => makeCrown({ crownId: i + 1 }))) },
    });
    const spy = vi.spyOn(CrownBuilders, 'buildCrownsResponse');
    const press = makeButton('crowns-page:last:caller1:target1:Playcount:1');

    await ci.handleButton(press);

    expect(spy).toHaveBeenCalledWith(
      'user1',
      'caller1',
      'target1',
      expect.any(Array),
      3,
      'Playcount',
      0xff0000,
    );
  });
});
