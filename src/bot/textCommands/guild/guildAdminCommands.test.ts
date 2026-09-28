import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GuildAdminCommands } from './guildAdminCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GuildAdminBuilders } from '@bot/builders/guildAdminBuilders';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { Guild } from '@persistence/domain/models/guild';
import type {
  GuildMemberOverviewItem,
  RefreshResult,
} from '@bot/services/guildAdminService';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';

/**
 * Branch coverage for the guild admin text commands: the dashboard, member
 * overview, refresh, block/unblock, crown settings, prefix and command
 * toggles, plus the guild-only and Manage Server permission guards.
 *
 * Same construction pattern as whoKnowsCommands.test.ts: collaborators are
 * built by NAME from a record and spread positionally, so a swap is caught by
 * the assertions rather than by the compiler.
 */

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'DreadRock',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const guild = (over: Partial<Guild> = {}): Guild =>
  ({
    guildId: '222',
    guildName: 'Test Guild',
    guildCreatedOn: new Date(),
    commandsDisabled: false,
    emotesDisabled: false,
    crownsDisabled: false,
    crownsMinimumPlaycountThreshold: 30,
    crownsActivityThresholdDays: 90,
    ...over,
  }) as Guild;

const member = (over: Partial<GuildMemberOverviewItem> = {}): GuildMemberOverviewItem =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'DreadRock',
    totalPlayCount: 5000,
    crownsCount: 2,
    whoKnowsBanned: false,
    ...over,
  }) as GuildMemberOverviewItem;

const blockedUser = (over: Partial<FullGuildUserDetails> = {}): FullGuildUserDetails =>
  ({
    userId: 2,
    discordUserId: '333',
    userNameLastFm: 'BlockedBob',
    userName: 'BlockedBob',
    whoKnowsBanned: true,
    ...over,
  }) as FullGuildUserDetails;

const refreshResult: RefreshResult = {
  indexedCount: 5,
  totalServerMembers: 12,
  newlyAddedCount: 2,
};

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { name: 'Test Guild', ownerId: '999' },
    prefix: '.',
    args: [],
    userIsGuildAdmin: true,
    ...over,
  }) as unknown as ContextModel;

const build = (opts: {
  registered?: User | null;
  guild?: Guild | null;
  members?: GuildMemberOverviewItem[];
  blocked?: FullGuildUserDetails[];
  prefix?: string;
  disabledCommands?: string[];
  accentColor?: number | null;
} = {}) => {
  const caller = opts.registered === undefined ? user() : opts.registered;
  const members = opts.members === undefined ? [member()] : opts.members;
  const blocked = opts.blocked === undefined ? [] : opts.blocked;
  const disabledCommands = opts.disabledCommands === undefined ? [] : opts.disabledCommands;
  const accentColor = opts.accentColor === undefined ? 0x336699 : opts.accentColor;

  const deps: Record<string, unknown> = {
    guildService: { getGuild: vi.fn(async () => opts.guild === undefined ? guild() : opts.guild) },
    guildAdminService: {
      getMembersOverview: vi.fn(async () => members),
      getBlockedUsers: vi.fn(async () => blocked),
      refreshGuildMembers: vi.fn(async () => refreshResult),
      setBlockUser: vi.fn(async () => undefined),
      setCrownThreshold: vi.fn(async () => undefined),
      setCrownActivityThreshold: vi.fn(async () => undefined),
      toggleCrowns: vi.fn(async () => undefined),
    },
    userService: { getUserByDiscordId: vi.fn(async () => caller) },
    prefixService: {
      getPrefix: vi.fn(async () => opts.prefix === undefined ? '.' : opts.prefix),
      setPrefix: vi.fn(async () => undefined),
    },
    guildDisabledCommandService: {
      isCommandDisabled: vi.fn(async (guildId: string, name: string) =>
        disabledCommands.includes(name.toLowerCase())),
      addDisabledCommand: vi.fn(async () => undefined),
      removeDisabledCommand: vi.fn(async () => undefined),
      getDisabledCommands: vi.fn(async () => disabledCommands),
    },
    colorService: { getAccentColorAsync: vi.fn(async () => accentColor) },
  };
  const args = [
    deps.guildService,
    deps.guildAdminService,
    deps.userService,
    deps.prefixService,
    deps.guildDisabledCommandService,
    deps.colorService,
  ] as const;
  const commands = new GuildAdminCommands(...(args as unknown as ConstructorParameters<typeof GuildAdminCommands>));
  return { commands, deps };
};

const builderArgs = (method: keyof typeof GuildAdminBuilders) =>
  (GuildAdminBuilders[method] as ReturnType<typeof vi.fn>).mock.calls[0]!;

const privates = (commands: GuildAdminCommands) =>
  commands as unknown as {
    serverSettingsAsync: (c: ContextModel) => Promise<ResponseModel>;
    membersAsync: (c: ContextModel) => Promise<ResponseModel>;
    refreshMembersAsync: (c: ContextModel) => Promise<ResponseModel>;
    setBlockAsync: (c: ContextModel, raw: string, blocked: boolean) => Promise<ResponseModel>;
    blockedUsersAsync: (c: ContextModel) => Promise<ResponseModel>;
    crownThresholdAsync: (c: ContextModel, raw: string) => Promise<ResponseModel>;
    crownActivityThresholdAsync: (c: ContextModel, raw: string) => Promise<ResponseModel>;
    toggleCrownsAsync: (c: ContextModel) => Promise<ResponseModel>;
    prefixAsync: (c: ContextModel, newPrefix: string) => Promise<ResponseModel>;
    toggleCommandAsync: (c: ContextModel, raw: string) => Promise<ResponseModel>;
    disabledCommandsAsync: (c: ContextModel) => Promise<ResponseModel>;
  };

const dmCtx = () => ctx({ guildId: undefined, guild: undefined, userIsGuildAdmin: false });
const noAdminCtx = () => ctx({ userIsGuildAdmin: false });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(GuildAdminBuilders, 'buildGuildDashboard').mockResolvedValue({} as never);
  vi.spyOn(GuildAdminBuilders, 'buildMembersOverviewResponse').mockResolvedValue({} as never);
  vi.spyOn(GuildAdminBuilders, 'buildBlockedUsersResponse').mockResolvedValue({} as never);
  vi.spyOn(GuildAdminBuilders, 'buildRefreshResultResponse').mockResolvedValue({} as never);
  vi.spyOn(GuildAdminBuilders, 'buildBlockSuccessResponse').mockResolvedValue({} as never);
  vi.spyOn(GuildAdminBuilders, 'buildCrownSettingSuccessResponse').mockResolvedValue({} as never);
});

const embedDescription = (result: ResponseModel): string =>
  (result.embed.data.description ?? '') as string;

const embedTitle = (result: ResponseModel): string =>
  (result.embed.data.title ?? '') as string;

describe('GuildAdminCommands.serverSettingsAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).serverSettingsAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).serverSettingsAsync(noAdminCtx());
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('reports a missing guild instead of building a dashboard', async () => {
    const { commands } = build({ guild: null });
    const result = await privates(commands).serverSettingsAsync(ctx());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the dashboard with prefix, member and blocked counts and accent color', async () => {
    const { commands, deps } = build({ members: [member(), member({ userId: 3 })], blocked: [blockedUser()] });
    await privates(commands).serverSettingsAsync(ctx());
    const call = (deps.guildAdminService as { getMembersOverview: ReturnType<typeof vi.fn> }).getMembersOverview;
    const blockedCall = (deps.guildAdminService as { getBlockedUsers: ReturnType<typeof vi.fn> }).getBlockedUsers;
    expect(call).toHaveBeenCalledWith('222');
    expect(blockedCall).toHaveBeenCalledWith('222');
    const args = builderArgs('buildGuildDashboard');
    expect(args[0].guild).toMatchObject({ guildName: 'Test Guild' });
    expect(args[0].prefix).toBe('.');
    expect(args[0].memberCount).toBe(2);
    expect(args[0].blockedCount).toBe(1);
    expect(args[0].accentColor).toBe(0x336699);
  });
});

describe('GuildAdminCommands.membersAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).membersAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).membersAsync(noAdminCtx());
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('builds the members overview with the guild name and accent color', async () => {
    const { commands } = build({ members: [member()] });
    await privates(commands).membersAsync(ctx());
    const args = builderArgs('buildMembersOverviewResponse');
    expect(args[0].guildName).toBe('Test Guild');
    expect(args[0].members).toHaveLength(1);
    expect(args[0].accentColor).toBe(0x336699);
  });

  it('falls back to a generic server name when the context carries no guild', async () => {
    const { commands } = build();
    await privates(commands).membersAsync(ctx({ guild: undefined }));
    expect(builderArgs('buildMembersOverviewResponse')[0].guildName).toBe('this server');
  });
});

describe('GuildAdminCommands.refreshMembersAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).refreshMembersAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).refreshMembersAsync(noAdminCtx());
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('fetches members, refreshes the index and builds the result response', async () => {
    const { commands, deps } = build();
    const fetchMock = vi.fn(async () => new Map([['111', {}], ['333', {}]]));
    await privates(commands).refreshMembersAsync(ctx({ guild: { name: 'Test Guild', members: { fetch: fetchMock } } }));
    expect(fetchMock).toHaveBeenCalled();
    const refresh = (deps.guildAdminService as { refreshGuildMembers: ReturnType<typeof vi.fn> }).refreshGuildMembers;
    expect(refresh).toHaveBeenCalledWith('222', ['111', '333']);
    const args = builderArgs('buildRefreshResultResponse');
    expect(args[0].guildName).toBe('Test Guild');
    expect(args[0].result).toMatchObject(refreshResult);
  });
});

describe('GuildAdminCommands.setBlockAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).setBlockAsync(dmCtx(), '111', true);
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).setBlockAsync(noAdminCtx(), '111', true);
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('rejects input with neither a mention nor a numeric id', async () => {
    const { commands } = build();
    const result = await privates(commands).setBlockAsync(ctx(), 'someuser', true);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects an unregistered target user', async () => {
    const { commands } = build({ registered: null });
    const result = await privates(commands).setBlockAsync(ctx(), '111', true);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('blocks a user resolved by mention and builds the success response', async () => {
    const { commands, deps } = build();
    await privates(commands).setBlockAsync(ctx(), '<@111>', true);
    const setBlock = (deps.guildAdminService as { setBlockUser: ReturnType<typeof vi.fn> }).setBlockUser;
    expect(setBlock).toHaveBeenCalledWith('222', 1, true);
    const args = builderArgs('buildBlockSuccessResponse');
    expect(args[0].discordUserId).toBe('111');
    expect(args[0].userNameLastFm).toBe('DreadRock');
    expect(args[0].blocked).toBe(true);
  });

  it('blocks a user resolved by raw discord id', async () => {
    const { commands, deps } = build();
    await privates(commands).setBlockAsync(ctx(), '111', true);
    const setBlock = (deps.guildAdminService as { setBlockUser: ReturnType<typeof vi.fn> }).setBlockUser;
    expect(setBlock).toHaveBeenCalledWith('222', 1, true);
  });

  it('unblocks a user when the blocked flag is false', async () => {
    const { commands, deps } = build();
    await privates(commands).setBlockAsync(ctx(), '111', false);
    const setBlock = (deps.guildAdminService as { setBlockUser: ReturnType<typeof vi.fn> }).setBlockUser;
    expect(setBlock).toHaveBeenCalledWith('222', 1, false);
    expect(builderArgs('buildBlockSuccessResponse')[0].blocked).toBe(false);
  });
});

describe('GuildAdminCommands.blockedUsersAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).blockedUsersAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).blockedUsersAsync(noAdminCtx());
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('builds the blocked users response with the guild name', async () => {
    const { commands } = build({ blocked: [blockedUser()] });
    await privates(commands).blockedUsersAsync(ctx());
    const args = builderArgs('buildBlockedUsersResponse');
    expect(args[0].guildName).toBe('Test Guild');
    expect(args[0].blocked).toHaveLength(1);
  });
});

describe('GuildAdminCommands.crownThresholdAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownThresholdAsync(dmCtx(), '50');
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).crownThresholdAsync(noAdminCtx(), '50');
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('rejects a non-numeric threshold', async () => {
    const { commands } = build();
    const result = await privates(commands).crownThresholdAsync(ctx(), 'abc');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects a threshold below one', async () => {
    const { commands } = build();
    const result = await privates(commands).crownThresholdAsync(ctx(), '0');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects a threshold above one hundred thousand', async () => {
    const { commands } = build();
    const result = await privates(commands).crownThresholdAsync(ctx(), '100001');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('sets a valid threshold and builds the success response', async () => {
    const { commands, deps } = build();
    await privates(commands).crownThresholdAsync(ctx(), '50');
    const setThreshold = (deps.guildAdminService as { setCrownThreshold: ReturnType<typeof vi.fn> }).setCrownThreshold;
    expect(setThreshold).toHaveBeenCalledWith('222', 50);
    const args = builderArgs('buildCrownSettingSuccessResponse');
    expect(args[0].settingName).toBe('Minimum Crown Playcount Threshold');
    expect(args[0].value).toBe('50 plays');
  });
});

describe('GuildAdminCommands.crownActivityThresholdAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownActivityThresholdAsync(dmCtx(), '30');
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).crownActivityThresholdAsync(noAdminCtx(), '30');
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('rejects a non-numeric threshold that is not a disable keyword', async () => {
    const { commands } = build();
    const result = await privates(commands).crownActivityThresholdAsync(ctx(), 'abc');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects a day count above the maximum', async () => {
    const { commands } = build();
    const result = await privates(commands).crownActivityThresholdAsync(ctx(), '3651');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('disables expiration when given "none" and reports it as disabled', async () => {
    const { commands, deps } = build();
    await privates(commands).crownActivityThresholdAsync(ctx(), 'none');
    const setThreshold = (deps.guildAdminService as { setCrownActivityThreshold: ReturnType<typeof vi.fn> }).setCrownActivityThreshold;
    expect(setThreshold).toHaveBeenCalledWith('222', null);
    const args = builderArgs('buildCrownSettingSuccessResponse');
    expect(args[0].settingName).toBe('Crown Activity Expiration Threshold');
    expect(args[0].value).toBe('Disabled (no expiration)');
  });

  it('sets a valid day count', async () => {
    const { commands, deps } = build();
    await privates(commands).crownActivityThresholdAsync(ctx(), '30');
    const setThreshold = (deps.guildAdminService as { setCrownActivityThreshold: ReturnType<typeof vi.fn> }).setCrownActivityThreshold;
    expect(setThreshold).toHaveBeenCalledWith('222', 30);
    expect(builderArgs('buildCrownSettingSuccessResponse')[0].value).toBe('30 days');
  });
});

describe('GuildAdminCommands.toggleCrownsAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCrownsAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCrownsAsync(noAdminCtx());
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('enables crowns when they are currently disabled', async () => {
    const { commands, deps } = build({ guild: guild({ crownsDisabled: true }) });
    await privates(commands).toggleCrownsAsync(ctx());
    const toggle = (deps.guildAdminService as { toggleCrowns: ReturnType<typeof vi.fn> }).toggleCrowns;
    expect(toggle).toHaveBeenCalledWith('222', false);
    const args = builderArgs('buildCrownSettingSuccessResponse');
    expect(args[0].settingName).toBe('Crowns Feature');
    expect(args[0].value).toBe('Enabled');
  });

  it('disables crowns when they are currently enabled', async () => {
    const { commands, deps } = build({ guild: guild({ crownsDisabled: false }) });
    await privates(commands).toggleCrownsAsync(ctx());
    const toggle = (deps.guildAdminService as { toggleCrowns: ReturnType<typeof vi.fn> }).toggleCrowns;
    expect(toggle).toHaveBeenCalledWith('222', true);
    expect(builderArgs('buildCrownSettingSuccessResponse')[0].value).toBe('Disabled');
  });
});

describe('GuildAdminCommands.prefixAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).prefixAsync(dmCtx(), '!');
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('shows the current prefix when no new prefix is given', async () => {
    const { commands, deps } = build({ prefix: '>' });
    const result = await privates(commands).prefixAsync(ctx(), '   ');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setPrefix = (deps.prefixService as { setPrefix: ReturnType<typeof vi.fn> }).setPrefix;
    expect(setPrefix).not.toHaveBeenCalled();
    expect(embedTitle(result)).toContain('Server Prefix');
    expect(embedDescription(result)).toContain('>');
  });

  it('refuses a caller without the Manage Server permission when changing the prefix', async () => {
    const { commands } = build();
    const result = await privates(commands).prefixAsync(noAdminCtx(), '!');
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('rejects a prefix longer than ten characters', async () => {
    const { commands } = build();
    const result = await privates(commands).prefixAsync(ctx(), 'abcdefghijk');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('sets a valid prefix and confirms the change', async () => {
    const { commands, deps } = build();
    const result = await privates(commands).prefixAsync(ctx(), '!');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setPrefix = (deps.prefixService as { setPrefix: ReturnType<typeof vi.fn> }).setPrefix;
    expect(setPrefix).toHaveBeenCalledWith('222', '!');
    expect(embedDescription(result)).toContain('!');
  });
});

describe('GuildAdminCommands.toggleCommandAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCommandAsync(dmCtx(), 'who');
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses a caller without the Manage Server permission', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCommandAsync(noAdminCtx(), 'who');
    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
  });

  it('rejects an empty command name with usage', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCommandAsync(ctx(), '  ');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses to disable a protected command', async () => {
    const { commands } = build();
    const result = await privates(commands).toggleCommandAsync(ctx(), 'serversettings');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('enables a currently disabled command', async () => {
    const { commands, deps } = build({ disabledCommands: ['who'] });
    const result = await privates(commands).toggleCommandAsync(ctx(), 'who');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const remove = (deps.guildDisabledCommandService as { removeDisabledCommand: ReturnType<typeof vi.fn> }).removeDisabledCommand;
    const add = (deps.guildDisabledCommandService as { addDisabledCommand: ReturnType<typeof vi.fn> }).addDisabledCommand;
    expect(remove).toHaveBeenCalledWith('222', 'who');
    expect(add).not.toHaveBeenCalled();
    expect(embedDescription(result)).toContain('enabled');
  });

  it('disables a currently enabled command', async () => {
    const { commands, deps } = build({ disabledCommands: [] });
    const result = await privates(commands).toggleCommandAsync(ctx(), 'who');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const add = (deps.guildDisabledCommandService as { addDisabledCommand: ReturnType<typeof vi.fn> }).addDisabledCommand;
    expect(add).toHaveBeenCalledWith('222', 'who');
    expect(embedDescription(result)).toContain('disabled');
  });
});

describe('GuildAdminCommands.disabledCommandsAsync', () => {
  it('refuses the command outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).disabledCommandsAsync(dmCtx());
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('reports when no commands are disabled', async () => {
    const { commands } = build({ disabledCommands: [] });
    const result = await privates(commands).disabledCommandsAsync(ctx());
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(embedDescription(result)).toContain('No commands are currently disabled');
  });

  it('lists disabled commands with a count in the title', async () => {
    const { commands } = build({ disabledCommands: ['who', 'crowns'] });
    const result = await privates(commands).disabledCommandsAsync(ctx());
    expect(embedTitle(result)).toContain('(2)');
    expect(embedDescription(result)).toContain('who');
    expect(embedDescription(result)).toContain('crowns');
  });
});

describe('GuildAdminCommands command table', () => {
  it('registers every name and alias uniquely', () => {
    const { commands } = build();
    const names = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with a documented reserved name', () => {
    const { commands } = build();
    const names = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(names).not.toContain('remove');
  });
});
