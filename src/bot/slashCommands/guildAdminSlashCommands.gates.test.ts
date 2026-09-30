/**
 * `/serversettings`, `/members`, `/refreshmembers`, `/blocklist`,
 * `/crownthreshold`, `/channeltogglecommand`, `/disabledchannel`.
 *
 * Two invariants live in this file, and both are one-way failures - a moderator
 * locks a command off and the channel stays dead until somebody edits the
 * database by hand.
 *
 * 1. THE RECOVERY COMMANDS CAN NEVER BE DISABLED. `channeltogglecommand` and
 *    `disabledchannel` are in `PROTECTED_COMMAND_NAMES` precisely because
 *    `disabledchannel` plants a `'*'` wildcard that `channeltogglecommand`
 *    alone cannot remove. So a request to disable one of them must be refused
 *    BEFORE the writer is reached, and the reply must name the command.
 *    Asserted both ways, because "always refuse" would pass the refusal test
 *    and a test that only checks the writer is untouched would pass a handler
 *    that refused everything.
 *
 * 2. EVERY WRITE IS BEHIND THE MANAGE-SERVER GATE, AND A GATE THAT FIRES
 *    BEFORE THE READ. `/serversettings` reads the guild, the prefix, the member
 *    overview and the blocklist; `/blocklist add` writes to the blocklist. A
 *    non-admin must reach none of them.
 *
 * The read side has its own A1 property: a guild row that is genuinely absent
 * answers "Server not found in the database" and reads NOTHING else, because
 * the member count and the blocklist count on that card are real numbers and
 * there is nothing to count them for. That is the difference between an honest
 * not-found and a dashboard of zeroes.
 *
 * There IS a gap, and it is characterised rather than endorsed at the bottom of
 * this file: `/blocklist list` is the one handler in the module with no
 * `userIsGuildAdmin` check. Discord's `setDefaultMemberPermissions` hides the
 * command from non-admins at the interaction layer, so it is defence in depth
 * rather than a live hole - but every sibling command re-checks in the handler,
 * and this one does not.
 *
 * Constructor arity, read from `guildAdminSlashCommands.ts`, all seven
 * positional and all required: guildService, guildAdminService, userService,
 * prefixService, colorService, channelToggledCommandService, disabledChannelService.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { GuildAdminSlashCommands } from './guildAdminSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { PROTECTED_COMMAND_NAMES } from '@bot/services/guild/protectedCommandNames';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { GuildService } from '@bot/services/guild/guildService';
import type { GuildAdminService } from '@bot/services/guildAdminService';
import type { UserService } from '@bot/services/userService';
import type { PrefixService } from '@bot/services/prefixService';
import type { ColorService } from '@bot/services/colorService';
import type { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import type { DisabledChannelService } from '@bot/services/guild/disabledChannelService';

const GUILD_ROW = {
  guildId: 5n,
  guildName: 'Loud Room',
  prefix: '!',
  crownsDisabled: false,
  commandsDisabled: false,
};

const TARGET_USER = { userId: 9, userNameLastFm: 'SomeUser', discordUserId: 'other1' };

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface CtxSpec {
  admin?: boolean;
  inGuild?: boolean;
  channelId?: string | null;
  guildName?: string;
  fetch?: () => Promise<Map<string, unknown>>;
  cache?: Map<string, unknown>;
}

const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const cache = spec.cache ?? new Map<string, unknown>();
  const channelId = spec.channelId === undefined ? 'text1' : spec.channelId;
  const guild = inGuild
    ? {
        id: '222',
        name: spec.guildName ?? 'Loud Room',
        members: {
          cache,
          fetch: spec.fetch ?? (async () => cache),
        },
      }
    : null;
  return {
    discordUserId: 'caller1',
    guildId: guild ? '222' : undefined,
    guild,
    channelId,
    member: { displayName: 'Caller' },
    interaction: {
      channelId,
      id: 'i1',
      guild,
      options: {
        getSubcommand: () => null,
        getString: () => null,
        getInteger: () => null,
        getUser: () => null,
      },
    },
    userIsGuildAdmin: spec.admin === true,
  } as unknown as ContextModel;
};

/** Rewrites one interaction option getter without touching the context itself. */
const withOption = (ctx: ContextModel, patch: Record<string, unknown>): ContextModel => {
  const interaction = ctx.interaction as unknown as { options: Record<string, unknown> };
  interaction.options = { ...interaction.options, ...patch };
  return ctx;
};

interface Doubles {
  guild?: unknown;
  members?: unknown[];
  blocked?: unknown[];
  targetUser?: unknown;
  toggledNow?: boolean;
}

const build = (over: Doubles = {}) => {
  const guildService = {
    getGuild: vi.fn(async () => (over.guild === undefined ? GUILD_ROW : over.guild)),
  } as unknown as GuildService;
  const guildAdminService = {
    getMembersOverview: vi.fn(async () => (over.members ?? [])),
    getBlockedUsers: vi.fn(async () => (over.blocked ?? [])),
    refreshGuildMembers: vi.fn(async (_guildId: string, ids: string[]) => ({
      indexedCount: ids.length,
      totalServerMembers: ids.length,
      newlyAddedCount: 0,
    })),
    setBlockUser: vi.fn(async () => undefined),
    setCrownThreshold: vi.fn(async () => undefined),
  } as unknown as GuildAdminService;
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.targetUser === undefined ? TARGET_USER : over.targetUser)),
  } as unknown as UserService;
  const prefixService = { getPrefix: vi.fn(async () => '!') } as unknown as PrefixService;
  const colorService = { getAccentColorAsync: vi.fn(async () => 0x778899) } as unknown as ColorService;
  const channelToggledCommandService = {
    toggleCommand: vi.fn(async () => over.toggledNow ?? true),
  } as unknown as ChannelToggledCommandService;
  const disabledChannelService = {
    setChannelDisabled: vi.fn(async () => undefined),
  } as unknown as DisabledChannelService;

  const cmd = new GuildAdminSlashCommands(
    guildService,
    guildAdminService,
    userService,
    prefixService,
    colorService,
    channelToggledCommandService,
    disabledChannelService,
  );
  return {
    cmd,
    guildService,
    guildAdminService,
    userService,
    prefixService,
    channelToggledCommandService,
    disabledChannelService,
  };
};

type Handlers = {
  serverSettingsSlashAsync(c: ContextModel): Promise<ResponseModel>;
  membersSlashAsync(c: ContextModel): Promise<ResponseModel>;
  refreshMembersSlashAsync(c: ContextModel): Promise<ResponseModel>;
  setBlockSlashAsync(c: ContextModel, id: string, blocked: boolean): Promise<ResponseModel>;
  blockedUsersSlashAsync(c: ContextModel): Promise<ResponseModel>;
  crownThresholdSlashAsync(c: ContextModel, n: number): Promise<ResponseModel>;
  channelToggleCommandSlashAsync(c: ContextModel, raw: string): Promise<ResponseModel>;
  disabledChannelSlashAsync(c: ContextModel, disable: boolean): Promise<ResponseModel>;
};
const h = (cmd: GuildAdminSlashCommands) => cmd as unknown as Handlers;

describe('GuildAdminSlashCommands: no Manage Server, no admin read, no admin write', () => {
  const GATED: Array<[string, (cmd: GuildAdminSlashCommands, ctx: ContextModel) => Promise<ResponseModel>]> = [
    ['/serversettings', (cmd, ctx) => h(cmd).serverSettingsSlashAsync(ctx)],
    ['/members', (cmd, ctx) => h(cmd).membersSlashAsync(ctx)],
    ['/refreshmembers', (cmd, ctx) => h(cmd).refreshMembersSlashAsync(ctx)],
    ['/blocklist add', (cmd, ctx) => h(cmd).setBlockSlashAsync(ctx, 'other1', true)],
    ['/blocklist remove', (cmd, ctx) => h(cmd).setBlockSlashAsync(ctx, 'other1', false)],
    ['/crownthreshold', (cmd, ctx) => h(cmd).crownThresholdSlashAsync(ctx, 30)],
    ['/channeltogglecommand', (cmd, ctx) => h(cmd).channelToggleCommandSlashAsync(ctx, 'who')],
    ['/disabledchannel disable', (cmd, ctx) => h(cmd).disabledChannelSlashAsync(ctx, true)],
  ];

  it.each(GATED)('%s refuses a non-admin', async (_name, run) => {
    const { cmd } = build();
    const response = await run(cmd, makeCtx({ admin: false }));
    expect(response.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it.each(GATED)('%s reaches no writer for a non-admin', async (_name, run) => {
    // The refusal has to happen BEFORE the side effect, not after it. A gate
    // that computes the answer and then refuses still wrote.
    const { cmd, guildAdminService, channelToggledCommandService, disabledChannelService } = build();
    await run(cmd, makeCtx({ admin: false }));
    expect(guildAdminService.setCrownThreshold).not.toHaveBeenCalled();
    expect(guildAdminService.setBlockUser).not.toHaveBeenCalled();
    expect(guildAdminService.refreshGuildMembers).not.toHaveBeenCalled();
    expect(channelToggledCommandService.toggleCommand).not.toHaveBeenCalled();
    expect(disabledChannelService.setChannelDisabled).not.toHaveBeenCalled();
  });

  it.each(GATED)('%s refuses in a DM even for a user the platform called an admin', async (_name, run) => {
    const { cmd } = build();
    const response = await run(cmd, makeCtx({ admin: true, inGuild: false }));
    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('/serversettings reads no member or blocklist data for a non-admin', async () => {
    const { cmd, guildService, guildAdminService, prefixService } = build();
    await h(cmd).serverSettingsSlashAsync(makeCtx({ admin: false }));
    expect(guildService.getGuild).not.toHaveBeenCalled();
    expect(guildAdminService.getMembersOverview).not.toHaveBeenCalled();
    expect(guildAdminService.getBlockedUsers).not.toHaveBeenCalled();
    expect(prefixService.getPrefix).not.toHaveBeenCalled();
  });
});

describe('/serversettings: an absent guild row is not a dashboard of zeroes', () => {
  it('answers NotFound and reads nothing else', async () => {
    // A guild row that is genuinely missing must say so. Falling through to the
    // builder with `memberCount: 0, blockedCount: 0` would render a real
    // dashboard claiming a server has no members and no blocks.
    const { cmd, guildAdminService, prefixService } = build({ guild: null });
    const response = await h(cmd).serverSettingsSlashAsync(makeCtx({ admin: true }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Server not found in the database');
    expect(guildAdminService.getMembersOverview).not.toHaveBeenCalled();
    expect(guildAdminService.getBlockedUsers).not.toHaveBeenCalled();
    expect(prefixService.getPrefix).not.toHaveBeenCalled();
  });

  it('renders the real counts when the guild does exist', async () => {
    const { cmd } = build({
      members: [
        { userId: 9, discordUserId: 'other1', userNameLastFm: 'SomeUser', totalPlayCount: 10, crownsCount: 1, whoKnowsBanned: false },
      ],
      blocked: [
        { userId: 11, discordUserId: 'other2', userNameLastFm: 'Blocked', totalPlayCount: 1, crownsCount: 0, whoKnowsBanned: true },
      ],
    });
    const response = await h(cmd).serverSettingsSlashAsync(makeCtx({ admin: true }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('Loud Room');
    expect(text).toContain('Indexed Last.fm Members: **1**');
    expect(text).toContain('Blocked from Crowns & WhoKnows: **1**');
  });
});

describe('/members and /blocklist list', () => {
  it('renders the "run .refreshmembers" empty state rather than a bare nothing', async () => {
    const { cmd } = build({ members: [] });
    const response = await h(cmd).membersSlashAsync(makeCtx({ admin: true }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No indexed Last.fm members found');
  });

  it('renders the honest empty blocklist', async () => {
    const { cmd } = build({ blocked: [] });
    const response = await h(cmd).blockedUsersSlashAsync(makeCtx({ admin: true }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No users are currently blocked');
  });

  it('CHARACTERISATION: /blocklist list has no in-handler admin check', async () => {
    // See the file header. The command declares ManageGuild so Discord hides it
    // from non-admins, which is the real gate; this is the one handler of the
    // seven that does not re-check. Pinned as a fact, not as a wish.
    const { cmd } = build();
    const response = await h(cmd).blockedUsersSlashAsync(makeCtx({ admin: false }));
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });
});

describe('/refreshmembers: the member list it reports is the one it actually read', () => {
  it('scans the fetched member list', async () => {
    const cache = new Map<string, unknown>([['a', {}], ['b', {}]]);
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).refreshMembersSlashAsync(
      makeCtx({ admin: true, fetch: async () => cache, cache: new Map() }),
    );

    expect(guildAdminService.refreshGuildMembers).toHaveBeenCalledWith('222', ['a', 'b']);
    expect(cardText(response)).toContain('Scanned **2** total Discord members');
  });

  it('falls back to the member CACHE when the fetch fails, and says how many it scanned', async () => {
    // A Discord-side failure must not become a confident "0 members in this
    // server". The degraded answer is the cache, and the card reports the count
    // it really used. (With an EMPTY cache that still reads as zero - reported
    // separately.)
    const cache = new Map<string, unknown>([['a', {}], ['b', {}], ['c', {}]]);
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).refreshMembersSlashAsync(
      makeCtx({
        admin: true,
        fetch: async () => {
          throw new Error('Missing Access');
        },
        cache,
      }),
    );

    expect(guildAdminService.refreshGuildMembers).toHaveBeenCalledWith('222', ['a', 'b', 'c']);
    expect(cardText(response)).toContain('Scanned **3** total Discord members');
  });

  it('refuses outside a guild before it fetches anything', async () => {
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).refreshMembersSlashAsync(makeCtx({ admin: true, inGuild: false }));
    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(guildAdminService.refreshGuildMembers).not.toHaveBeenCalled();
  });
});

describe('/blocklist add and remove', () => {
  it('refuses to block a user who has never connected Last.fm, and writes nothing', async () => {
    // Blocking by Discord id alone would be possible, so the not-found branch is
    // the only thing standing between a typo and a blocklist entry for a
    // stranger. It has to come BEFORE the write.
    const { cmd, guildAdminService } = build({ targetUser: null });
    const response = await h(cmd).setBlockSlashAsync(makeCtx({ admin: true }), 'other1', true);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('has not connected their Last.fm account');
    expect(guildAdminService.setBlockUser).not.toHaveBeenCalled();
  });

  it('writes the block using the DATABASE user id, not the Discord id', async () => {
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).setBlockSlashAsync(makeCtx({ admin: true }), 'other1', true);

    expect(guildAdminService.setBlockUser).toHaveBeenCalledWith('222', 9, true);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Successfully blocked');
  });

  it('unblocks with the same database id and the opposite flag', async () => {
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).setBlockSlashAsync(makeCtx({ admin: true }), 'other1', false);

    expect(guildAdminService.setBlockUser).toHaveBeenCalledWith('222', 9, false);
    expect(cardText(response)).toContain('Successfully unblocked');
  });
});

describe('/crownthreshold', () => {
  it('persists the admin-supplied threshold and echoes it back grouped', async () => {
    const { cmd, guildAdminService } = build();
    const response = await h(cmd).crownThresholdSlashAsync(makeCtx({ admin: true }), 1500);

    expect(guildAdminService.setCrownThreshold).toHaveBeenCalledWith('222', 1500);
    expect(cardText(response)).toContain('1,500 plays');
  });

  it('uses the declared default when the option is absent', async () => {
    // `executeAsync` supplies `?? 30`; pinned here so the two halves - the
    // dispatcher default and the handler - cannot drift apart silently.
    const { cmd, guildAdminService } = build();
    const command = cmd.commands.find((c) => c.data.toJSON().name === 'crownthreshold');
    expect(command).toBeDefined();
    await command!.executeAsync(withOption(makeCtx({ admin: true }), { getInteger: () => null }));
    expect(guildAdminService.setCrownThreshold).toHaveBeenCalledWith('222', 30);
  });
});

describe('/channeltogglecommand: the recovery commands can never be switched off', () => {
  it.each(PROTECTED_COMMAND_NAMES)('refuses to disable `%s` and never reaches the writer', async (name) => {
    const { cmd, channelToggledCommandService } = build();
    const response = await h(cmd).channelToggleCommandSlashAsync(makeCtx({ admin: true }), name);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('cannot be disabled');
    expect(channelToggledCommandService.toggleCommand).not.toHaveBeenCalled();
  });

  it('matches the protected list case- and whitespace-insensitively', async () => {
    const { cmd, channelToggledCommandService } = build();
    const response = await h(cmd).channelToggleCommandSlashAsync(
      makeCtx({ admin: true }),
      '  DisabledChannel  ',
    );

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(channelToggledCommandService.toggleCommand).not.toHaveBeenCalled();
  });

  it('still disables an ordinary command and names the channel it changed', async () => {
    // The other half. "Always refuse" passes every test above and would break
    // the feature entirely.
    const { cmd, channelToggledCommandService } = build({ toggledNow: true });
    const response = await h(cmd).channelToggleCommandSlashAsync(makeCtx({ admin: true }), 'Who');

    expect(channelToggledCommandService.toggleCommand).toHaveBeenCalledWith('222', 'text1', 'who');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('disabled');
    expect(text).toContain('<#text1>');
  });

  it('reports the ENABLE direction when the writer says the command was on', async () => {
    const { cmd } = build({ toggledNow: false });
    const response = await h(cmd).channelToggleCommandSlashAsync(makeCtx({ admin: true }), 'who');
    expect(cardText(response)).toContain('enabled');
  });

  it('refuses a blank command name without touching the writer', async () => {
    const { cmd, channelToggledCommandService } = build();
    const response = await h(cmd).channelToggleCommandSlashAsync(makeCtx({ admin: true }), '   ');

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(channelToggledCommandService.toggleCommand).not.toHaveBeenCalled();
  });

  it('refuses when the command has no channel to apply to', async () => {
    const { cmd, channelToggledCommandService } = build();
    const response = await h(cmd).channelToggleCommandSlashAsync(
      makeCtx({ admin: true, channelId: '' }),
      'who',
    );

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('no channel to apply to');
    expect(channelToggledCommandService.toggleCommand).not.toHaveBeenCalled();
  });
});

describe('/disabledchannel', () => {
  it('disables the whole channel and names it', async () => {
    const { cmd, disabledChannelService } = build();
    const response = await h(cmd).disabledChannelSlashAsync(makeCtx({ admin: true }), true);

    expect(disabledChannelService.setChannelDisabled).toHaveBeenCalledWith('222', 'text1', true);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('disabled');
  });

  it('enables the whole channel and says so', async () => {
    const { cmd, disabledChannelService } = build();
    const response = await h(cmd).disabledChannelSlashAsync(makeCtx({ admin: true }), false);

    expect(disabledChannelService.setChannelDisabled).toHaveBeenCalledWith('222', 'text1', false);
    expect(cardText(response)).toContain('enabled');
  });

  it('refuses when there is no channel, rather than writing a wildcard to nothing', async () => {
    const { cmd, disabledChannelService } = build();
    const response = await h(cmd).disabledChannelSlashAsync(makeCtx({ admin: true, channelId: '' }), true);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(disabledChannelService.setChannelDisabled).not.toHaveBeenCalled();
  });

  it('routes `enable` to the enable direction and anything else to disable', async () => {
    // The dispatcher decides with `sub !== 'enable'`, so a typo in the subcommand
    // list can only ever fall to the DESTRUCTIVE side. Asserted so that is
    // visible rather than assumed.
    const { cmd, disabledChannelService } = build();
    const command = cmd.commands.find((c) => c.data.toJSON().name === 'disabledchannel');
    expect(command).toBeDefined();

    const ctxFor = (sub: string) => withOption(makeCtx({ admin: true }), { getSubcommand: () => sub });

    await command!.executeAsync(ctxFor('enable'));
    expect(disabledChannelService.setChannelDisabled).toHaveBeenLastCalledWith('222', 'text1', false);

    await command!.executeAsync(ctxFor('disable'));
    expect(disabledChannelService.setChannelDisabled).toHaveBeenLastCalledWith('222', 'text1', true);
  });
});