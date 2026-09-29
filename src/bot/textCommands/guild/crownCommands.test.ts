import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CrownCommands } from './crownCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { UserCrownDto, CrownLeaderboardEntry } from '@domain/models/crownModels';

const auditAdminAction = vi.fn();
vi.mock('@domain/adminAudit', () => ({ auditAdminAction: (...args: unknown[]) => auditAdminAction(...args) }));

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'DreadRock',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const crown = (over: Partial<UserCrownDto> = {}): UserCrownDto =>
  ({
    crownId: 1,
    guildId: '222',
    userId: 1,
    artistName: 'Mitch Murder',
    currentPlaycount: 500,
    startPlaycount: 100,
    created: new Date('2025-01-01'),
    modified: new Date('2025-06-01'),
    active: true,
    seededCrown: false,
    ...over,
  }) as UserCrownDto;

const lbEntry = (over: Partial<CrownLeaderboardEntry> = {}): CrownLeaderboardEntry =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'DreadRock',
    displayName: 'DreadRock',
    crownCount: 5,
    ...over,
  }) as CrownLeaderboardEntry;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    message: {
      guild: {
        name: 'Test Guild',
        members: { cache: { get: () => undefined } },
        iconURL: () => 'https://example.com/icon.png',
      },
    },
    guild: { name: 'Test Guild', members: { cache: { get: () => undefined } } },
    prefix: '.',
    args: [],
    userIsGuildAdmin: false,
    ...over,
  }) as unknown as ContextModel;

const build = (opts: {
  registered?: User | null;
  isAdmin?: boolean;
} = {}) => {
  const caller = opts.registered === undefined ? user() : opts.registered;
  const deps: Record<string, unknown> = {
    userService: {
      getUserByDiscordId: vi.fn(async () => caller),
      getUserByLastFmName: vi.fn(async () => null),
    },
    crownService: {
      getUserCrowns: vi.fn(async () => []),
      getCurrentCrown: vi.fn(async () => null),
      getCrownHistory: vi.fn(async () => []),
      getGuildLeaderboard: vi.fn(async () => ({ entries: [], totalActiveCrowns: 0 })),
      seedCrowns: vi.fn(async () => 0),
      killCrown: vi.fn(async () => false),
      removeUserCrowns: vi.fn(async () => 0),
      setCrownBlock: vi.fn(async () => undefined),
      getBlockedCrownUsers: vi.fn(async () => []),
      setCrownRole: vi.fn(async () => undefined),
      getCrownRoles: vi.fn(async () => []),
      killAllCrowns: vi.fn(async () => 0),
    },
    lastfmRepo: { getUserRecentTracks: vi.fn(async () => []) },
    artistsService: { getArtistInfo: vi.fn(async () => null) },
    updateService: { updateUser: vi.fn(async () => undefined) },
    colorService: { getColorFromImageUrl: vi.fn(async () => undefined) },
    artworkService: { getArtistImageUrl: vi.fn(async () => undefined) },
  };
  const args = [
    deps.userService,
    deps.crownService,
    deps.lastfmRepo,
    deps.artistsService,
    deps.updateService,
    deps.colorService,
    deps.artworkService,
  ] as const;
  const commands = new CrownCommands(...(args as unknown as ConstructorParameters<typeof CrownCommands>));
  return { commands, deps, isAdmin: opts.isAdmin ?? false };
};

const privates = (commands: CrownCommands) =>
  commands as unknown as {
    crownsAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    crownAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    crownLbAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    crownSeedAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    killCrownAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    removeUserCrownsAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    crownBlockAsync: (c: ContextModel, args: string[], block: boolean) => Promise<ResponseModel>;
    crownBlockedUsersAsync: (c: ContextModel) => Promise<ResponseModel>;
    crownRolesAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
    killAllCrownsAsync: (c: ContextModel, args: string[]) => Promise<ResponseModel>;
  };

const mockBuilders = () => {
  vi.spyOn(CrownBuilders, 'buildCrownsResponse').mockResolvedValue({} as never);
  vi.spyOn(CrownBuilders, 'buildCrownDuelResponse').mockResolvedValue({} as never);
  vi.spyOn(CrownBuilders, 'buildCrownLeaderboardResponse').mockResolvedValue({} as never);
};

const mockGeneric = () => {
  vi.spyOn(GenericEmbedService, 'buildWrongInputResponse').mockReturnValue({ commandResponse: CommandResponse.WrongInput } as never);
  vi.spyOn(GenericEmbedService, 'buildCommandErrorResponse').mockReturnValue({ commandResponse: CommandResponse.NotFound } as never);
  vi.spyOn(GenericEmbedService, 'buildNotFoundResponse').mockReturnValue({ commandResponse: CommandResponse.NotFound } as never);
  vi.spyOn(GenericEmbedService, 'buildSuccessResponse').mockReturnValue({ commandResponse: CommandResponse.Ok } as never);
  vi.spyOn(GenericEmbedService, 'buildCustomEmbedResponse').mockReturnValue({ commandResponse: CommandResponse.Ok } as never);
};

beforeEach(() => {
  auditAdminAction.mockClear();
  mockBuilders();
  mockGeneric();
  vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(false);
});

describe('CrownCommands guild-only guard', () => {
  it('refuses crowns outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownsAsync(ctx({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crown duel outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownAsync(ctx({ guildId: undefined }), ['artist']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crownlb outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownLbAsync(ctx({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crownseed outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownSeedAsync(ctx({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses killcrown outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).killCrownAsync(ctx({ guildId: undefined }), ['artist']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses removeusercrowns outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).removeUserCrownsAsync(ctx({ guildId: undefined }), ['user']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crownblock outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownBlockAsync(ctx({ guildId: undefined }), ['user'], true);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crownblockedusers outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownBlockedUsersAsync(ctx({ guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses crownroles outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).crownRolesAsync(ctx({ guildId: undefined }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses killallcrowns outside a guild', async () => {
    const { commands } = build();
    const result = await privates(commands).killAllCrownsAsync(ctx({ guildId: undefined }), ['confirm']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });
});

describe('CrownCommands unregistered caller', () => {
  it('tells an unregistered caller to register on crowns', async () => {
    const { commands } = build({ registered: null });
    const result = await privates(commands).crownsAsync(ctx(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('tells an unregistered caller to register on crown duel', async () => {
    const { commands } = build({ registered: null });
    const result = await privates(commands).crownAsync(ctx(), ['artist']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('CrownCommands.crownsAsync', () => {
  it('triggers a sync when the callers scrobbles are stale', async () => {
    const stale = user({ lastUpdate: new Date(Date.now() - 10 * 60 * 1000) });
    const { commands, deps } = build({ registered: stale });
    vi.spyOn(UpdateService, 'needsUpdate').mockReturnValue(true);
    await privates(commands).crownsAsync(ctx(), []);
    const updateUser = (deps.updateService as { updateUser: ReturnType<typeof vi.fn> }).updateUser;
    expect(updateUser).toHaveBeenCalledWith(stale.userId, { accurateTotal: true });
  });

  it('resolves a mention to another user', async () => {
    const other = user({ userId: 2, discordUserId: '999', userNameLastFm: 'OtherUser' });
    const { commands, deps } = build();
    (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId.mockImplementation(async (id: string) =>
        id === '999' ? other : user(),
      );
    await privates(commands).crownsAsync(ctx(), ['<@999>']);
    const getUserCrowns = (deps.crownService as { getUserCrowns: ReturnType<typeof vi.fn> }).getUserCrowns;
    expect(getUserCrowns).toHaveBeenCalledWith('222', 2, 'Playcount');
  });

  it('resolves a last.fm name to another user', async () => {
    const other = user({ userId: 3, discordUserId: '888', userNameLastFm: 'NamedUser' });
    const { commands, deps } = build();
    (deps.userService as { getUserByLastFmName: ReturnType<typeof vi.fn> })
      .getUserByLastFmName.mockResolvedValue(other);
    await privates(commands).crownsAsync(ctx(), ['NamedUser']);
    const getUserCrowns = (deps.crownService as { getUserCrowns: ReturnType<typeof vi.fn> }).getUserCrowns;
    expect(getUserCrowns).toHaveBeenCalledWith('222', 3, 'Playcount');
  });

  it('parses a numeric argument as the page', async () => {
    const { commands } = build();
    await privates(commands).crownsAsync(ctx(), ['3']);
    const call = (CrownBuilders.buildCrownsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[4]).toBe(3);
  });

  it('defaults to page 1 when no numeric argument is given', async () => {
    const { commands } = build();
    await privates(commands).crownsAsync(ctx(), []);
    const call = (CrownBuilders.buildCrownsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[4]).toBe(1);
  });

  it('passes the display name, discord ids, crowns and view type to the builder', async () => {
    const { commands, deps } = build();
    (deps.crownService as { getUserCrowns: ReturnType<typeof vi.fn> })
      .getUserCrowns.mockResolvedValue([crown()]);
    await privates(commands).crownsAsync(ctx(), []);
    const call = (CrownBuilders.buildCrownsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('DreadRock');
    expect(call[1]).toBe('111');
    expect(call[2]).toBe('111');
    expect(call[3]).toHaveLength(1);
    expect(call[3]![0]!.artistName).toBe('Mitch Murder');
    expect(call[5]).toBe('Playcount');
  });

  it('uses the guild member display name when available', async () => {
    const { commands } = build();
    const ctxWithMember = ctx({
      message: {
        guild: {
          name: 'Test Guild',
          members: { cache: { get: () => ({ displayName: 'CoolName' }) } },
          iconURL: () => 'https://example.com/icon.png',
        },
      },
    });
    await privates(commands).crownsAsync(ctxWithMember, []);
    const call = (CrownBuilders.buildCrownsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('CoolName');
  });

  it('fetches artwork for the top artist crown', async () => {
    const { commands, deps } = build();
    (deps.crownService as { getUserCrowns: ReturnType<typeof vi.fn> })
      .getUserCrowns.mockResolvedValue([crown({ artistName: 'TopArtist' })]);
    await privates(commands).crownsAsync(ctx(), []);
    const getArtistImageUrl = (deps.artworkService as { getArtistImageUrl: ReturnType<typeof vi.fn> })
      .getArtistImageUrl;
    expect(getArtistImageUrl).toHaveBeenCalledWith('TopArtist');
  });

  it('skips artwork fetch when the user has no crowns', async () => {
    const { commands, deps } = build();
    await privates(commands).crownsAsync(ctx(), []);
    const getArtistImageUrl = (deps.artworkService as { getArtistImageUrl: ReturnType<typeof vi.fn> })
      .getArtistImageUrl;
    expect(getArtistImageUrl).not.toHaveBeenCalled();
  });
});

describe('CrownCommands.crownAsync', () => {
  it('falls back to the callers now-playing artist when no name is given', async () => {
    const { commands, deps } = build();
    (deps.lastfmRepo as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Spectral Bloom', artistName: 'Mitch Murder' }]);
    await privates(commands).crownAsync(ctx(), []);
    const getCurrentCrown = (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown;
    expect(getCurrentCrown).toHaveBeenCalledWith('222', 'Mitch Murder');
  });

  it('reports no recent tracks when the profile has none', async () => {
    const { commands } = build();
    const result = await privates(commands).crownAsync(ctx(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('uses the typed artist name directly', async () => {
    const { commands, deps } = build();
    await privates(commands).crownAsync(ctx(), ['Radiohead']);
    const getCurrentCrown = (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown;
    expect(getCurrentCrown).toHaveBeenCalledWith('222', 'Radiohead');
  });

  it('resolves a mention to another challenger', async () => {
    const other = user({ userId: 2, discordUserId: '999', userNameLastFm: 'OtherUser' });
    const { commands, deps } = build();
    (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId.mockImplementation(async (id: string) =>
        id === '999' ? other : user(),
      );
    await privates(commands).crownAsync(ctx(), ['<@999>', 'Radiohead']);
    const getArtistInfo = (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> })
      .getArtistInfo;
    expect(getArtistInfo).toHaveBeenCalledWith('Radiohead', 'OtherUser');
  });

  it('prefers the resolved artist name from the info lookup', async () => {
    const { commands, deps } = build();
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> })
      .getArtistInfo.mockResolvedValue({ name: 'Radiohead (Band)', userPlayCount: 42 });
    await privates(commands).crownAsync(ctx(), ['Radiohead']);
    const getCurrentCrown = (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown;
    expect(getCurrentCrown).toHaveBeenCalledWith('222', 'Radiohead (Band)');
  });

  it('falls back to the typed name when the info lookup returns nothing', async () => {
    const { commands, deps } = build();
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> }).getArtistInfo.mockResolvedValue(null);
    await privates(commands).crownAsync(ctx(), ['Radiohead']);
    const getCurrentCrown = (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown;
    expect(getCurrentCrown).toHaveBeenCalledWith('222', 'Radiohead');
  });

  it('builds the duel response with current crown, history and challenger payload', async () => {
    const { commands, deps } = build();
    const currentCrown = crown({ discordUserId: '555', userNameLastFm: 'Holder' });
    (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown.mockResolvedValue(currentCrown);
    (deps.crownService as { getCrownHistory: ReturnType<typeof vi.fn> })
      .getCrownHistory.mockResolvedValue([currentCrown]);
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> })
      .getArtistInfo.mockResolvedValue({ name: 'Radiohead', userPlayCount: 42 });
    await privates(commands).crownAsync(ctx(), ['Radiohead']);
    const call = (CrownBuilders.buildCrownDuelResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('Radiohead');
    expect(call[1]).toBe(currentCrown);
    expect(call[3]).toEqual({
      displayName: 'DreadRock',
      userNameLastFm: 'DreadRock',
      playcount: 42,
    });
    expect(call[4]).toHaveLength(1);
  });

  it('passes null challenger payload when the info lookup has no user play count', async () => {
    const { commands, deps } = build();
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> })
      .getArtistInfo.mockResolvedValue({ name: 'Radiohead' });
    await privates(commands).crownAsync(ctx(), ['Radiohead']);
    const call = (CrownBuilders.buildCrownDuelResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[3]).toBeNull();
  });

  it('uses the guild member display name for the holder when available', async () => {
    const { commands, deps } = build();
    const currentCrown = crown({ discordUserId: '555', userNameLastFm: 'Holder' });
    (deps.crownService as { getCurrentCrown: ReturnType<typeof vi.fn> })
      .getCurrentCrown.mockResolvedValue(currentCrown);
    const ctxWithMember = ctx({
      guild: {
        name: 'Test Guild',
        members: { cache: { get: (id: string) => (id === '555' ? { displayName: 'HolderNick' } : undefined) } },
      },
    });
    await privates(commands).crownAsync(ctxWithMember, ['Radiohead']);
    const call = (CrownBuilders.buildCrownDuelResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toBe('HolderNick');
  });
});

describe('CrownCommands.crownLbAsync', () => {
  it('parses a numeric argument as the page', async () => {
    const { commands } = build();
    await privates(commands).crownLbAsync(ctx(), ['2']);
    const call = (CrownBuilders.buildCrownLeaderboardResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[3]).toBe(2);
  });

  it('defaults to page 1', async () => {
    const { commands } = build();
    await privates(commands).crownLbAsync(ctx(), []);
    const call = (CrownBuilders.buildCrownLeaderboardResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[3]).toBe(1);
  });

  it('passes guild name, entries, caller id, page and total to the builder', async () => {
    const { commands, deps } = build();
    const entries = [lbEntry()];
    (deps.crownService as { getGuildLeaderboard: ReturnType<typeof vi.fn> })
      .getGuildLeaderboard.mockResolvedValue({ entries, totalActiveCrowns: 10 });
    await privates(commands).crownLbAsync(ctx(), []);
    const call = (CrownBuilders.buildCrownLeaderboardResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('Test Guild');
    expect(call[1]).toBe(entries);
    expect(call[2]).toBe(1);
    expect(call[4]).toBe(10);
  });

  it('enriches entries with guild member display names', async () => {
    const { commands, deps } = build();
    const entries = [lbEntry({ discordUserId: '111', displayName: '' })];
    (deps.crownService as { getGuildLeaderboard: ReturnType<typeof vi.fn> })
      .getGuildLeaderboard.mockResolvedValue({ entries, totalActiveCrowns: 1 });
    const ctxWithMember = ctx({
      message: {
        guild: {
          name: 'Test Guild',
          members: { cache: { get: () => ({ displayName: 'CoolName' }) } },
          iconURL: () => 'https://example.com/icon.png',
        },
      },
    });
    await privates(commands).crownLbAsync(ctxWithMember, []);
    expect(entries[0]!.displayName).toBe('CoolName');
  });

  it('works when the caller is not registered', async () => {
    const { commands } = build({ registered: null });
    await privates(commands).crownLbAsync(ctx(), []);
    const call = (CrownBuilders.buildCrownLeaderboardResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toBeUndefined();
  });
});

describe('CrownCommands.crownSeedAsync', () => {
  // The four cases below used to run as a NON-admin (`ctx()` defaults to
  // `userIsGuildAdmin: false`) and assert that `seedCrowns` ran anyway. That
  // WAS the bug: `seedCrownsForGuild` deletes every seeded crown for the guild
  // before re-inserting, and it was the only crown mutator in this file with no
  // `userIsGuildAdmin` check. They now pass an admin context, which keeps their
  // original assertions (default minimum, parsed minimum, floor of 1, reported
  // count) intact and moves them on the allowed side of the new gate. The
  // refusing side is the new case directly below.
  const adminCtx = () => ctx({ userIsGuildAdmin: true });

  it('refuses when the user is not a guild admin, and does not seed', async () => {
    const { commands, deps } = build({ isAdmin: false });
    const result = await privates(commands).crownSeedAsync(ctx({ userIsGuildAdmin: false }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    const seedCrowns = (deps.crownService as { seedCrowns: ReturnType<typeof vi.fn> }).seedCrowns;
    expect(seedCrowns).not.toHaveBeenCalled();
  });

  it('uses a default minimum of 30 plays', async () => {
    const { commands, deps } = build({ isAdmin: true });
    await privates(commands).crownSeedAsync(adminCtx(), []);
    const seedCrowns = (deps.crownService as { seedCrowns: ReturnType<typeof vi.fn> }).seedCrowns;
    expect(seedCrowns).toHaveBeenCalledWith('222', 30);
  });

  it('parses a custom minimum playcount', async () => {
    const { commands, deps } = build({ isAdmin: true });
    await privates(commands).crownSeedAsync(adminCtx(), ['50']);
    const seedCrowns = (deps.crownService as { seedCrowns: ReturnType<typeof vi.fn> }).seedCrowns;
    expect(seedCrowns).toHaveBeenCalledWith('222', 50);
  });

  it('enforces a minimum of 1 play', async () => {
    const { commands, deps } = build({ isAdmin: true });
    await privates(commands).crownSeedAsync(adminCtx(), ['0']);
    const seedCrowns = (deps.crownService as { seedCrowns: ReturnType<typeof vi.fn> }).seedCrowns;
    expect(seedCrowns).toHaveBeenCalledWith('222', 1);
  });

  it('reports the seeded count', async () => {
    const { commands, deps } = build({ isAdmin: true });
    (deps.crownService as { seedCrowns: ReturnType<typeof vi.fn> }).seedCrowns.mockResolvedValue(42);
    await privates(commands).crownSeedAsync(adminCtx(), []);
    expect(GenericEmbedService.buildSuccessResponse).toHaveBeenCalledWith(
      expect.stringContaining('42'),
    );
  });
});

describe('CrownCommands.killCrownAsync', () => {
  it('refuses when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).killCrownAsync(ctx({ userIsGuildAdmin: false }), ['Radiohead']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('shows usage when no artist name is given', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).killCrownAsync(ctx({ userIsGuildAdmin: true }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports not found when no active crown exists', async () => {
    const { commands, deps } = build({ isAdmin: true });
    (deps.crownService as { killCrown: ReturnType<typeof vi.fn> }).killCrown.mockResolvedValue(false);
    const result = await privates(commands).killCrownAsync(ctx({ userIsGuildAdmin: true }), ['Radiohead']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('kills the crown and audits the action', async () => {
    const { commands, deps } = build({ isAdmin: true });
    (deps.crownService as { killCrown: ReturnType<typeof vi.fn> }).killCrown.mockResolvedValue(true);
    const result = await privates(commands).killCrownAsync(ctx({ userIsGuildAdmin: true }), ['Radiohead']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const killCrown = (deps.crownService as { killCrown: ReturnType<typeof vi.fn> }).killCrown;
    expect(killCrown).toHaveBeenCalledWith('222', 'Radiohead');
  });
});

describe('CrownCommands.removeUserCrownsAsync', () => {
  it('refuses when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: false }), ['<@999>']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('shows usage when no target is given', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('resolves a mention to a discord user', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId.mockResolvedValue(target);
    await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), ['<@999>']);
    const removeUserCrowns = (deps.crownService as { removeUserCrowns: ReturnType<typeof vi.fn> })
      .removeUserCrowns;
    expect(removeUserCrowns).toHaveBeenCalledWith('222', 2);
  });

  it('resolves a plain user id', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId.mockResolvedValue(target);
    await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), ['999']);
    const removeUserCrowns = (deps.crownService as { removeUserCrowns: ReturnType<typeof vi.fn> })
      .removeUserCrowns;
    expect(removeUserCrowns).toHaveBeenCalledWith('222', 2);
  });

  it('resolves a last.fm username', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByLastFmName: ReturnType<typeof vi.fn> })
      .getUserByLastFmName.mockResolvedValue(target);
    await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), ['TargetUser']);
    const removeUserCrowns = (deps.crownService as { removeUserCrowns: ReturnType<typeof vi.fn> })
      .removeUserCrowns;
    expect(removeUserCrowns).toHaveBeenCalledWith('222', 2);
  });

  it('reports not found when no user matches', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), ['GhostUser']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports the removed count', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByLastFmName: ReturnType<typeof vi.fn> })
      .getUserByLastFmName.mockResolvedValue(target);
    (deps.crownService as { removeUserCrowns: ReturnType<typeof vi.fn> })
      .removeUserCrowns.mockResolvedValue(3);
    const result = await privates(commands).removeUserCrownsAsync(ctx({ userIsGuildAdmin: true }), ['TargetUser']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });
});

describe('CrownCommands.crownBlockAsync', () => {
  it('refuses block when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: false }), ['<@999>'], true);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('refuses unblock when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: false }), ['<@999>'], false);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('shows usage when no target is given', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: true }), [], true);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports not found when no user matches', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: true }), ['GhostUser'], true);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('blocks a user by mention', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId.mockResolvedValue(target);
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: true }), ['<@999>'], true);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setCrownBlock = (deps.crownService as { setCrownBlock: ReturnType<typeof vi.fn> })
      .setCrownBlock;
    expect(setCrownBlock).toHaveBeenCalledWith('222', 2, true);
  });

  it('unblocks a user by username', async () => {
    const target = user({ userId: 2, discordUserId: '999', userNameLastFm: 'TargetUser' });
    const { commands, deps } = build({ isAdmin: true });
    (deps.userService as { getUserByLastFmName: ReturnType<typeof vi.fn> })
      .getUserByLastFmName.mockResolvedValue(target);
    const result = await privates(commands).crownBlockAsync(ctx({ userIsGuildAdmin: true }), ['TargetUser'], false);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setCrownBlock = (deps.crownService as { setCrownBlock: ReturnType<typeof vi.fn> })
      .setCrownBlock;
    expect(setCrownBlock).toHaveBeenCalledWith('222', 2, false);
  });
});

describe('CrownCommands.crownBlockedUsersAsync', () => {
  it('refuses when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).crownBlockedUsersAsync(ctx({ userIsGuildAdmin: false }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports no blocked users', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).crownBlockedUsersAsync(ctx({ userIsGuildAdmin: true }));
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(GenericEmbedService.buildSuccessResponse).toHaveBeenCalledWith(
      expect.stringContaining('No users are currently blocked'),
    );
  });

  it('lists blocked users with mentions', async () => {
    const { commands, deps } = build({ isAdmin: true });
    (deps.crownService as { getBlockedCrownUsers: ReturnType<typeof vi.fn> })
      .getBlockedCrownUsers.mockResolvedValue([
        { userId: 2, userNameLastFm: 'BadUser', discordUserId: '999' },
      ]);
    const result = await privates(commands).crownBlockedUsersAsync(ctx({ userIsGuildAdmin: true }));
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(GenericEmbedService.buildCustomEmbedResponse).toHaveBeenCalledWith(
      expect.stringContaining('Crown Blocked Users'),
      expect.stringContaining('<@999>'),
    );
  });
});

describe('CrownCommands.crownRolesAsync', () => {
  it('shows the no-role message when no roles are configured', async () => {
    const { commands } = build();
    const result = await privates(commands).crownRolesAsync(ctx(), []);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(GenericEmbedService.buildCustomEmbedResponse).toHaveBeenCalledWith(
      expect.stringContaining('Crown Role Configuration'),
      expect.stringContaining('No crown role is configured'),
    );
  });

  it('shows the current role when one is configured', async () => {
    const { commands, deps } = build();
    (deps.crownService as { getCrownRoles: ReturnType<typeof vi.fn> })
      .getCrownRoles.mockResolvedValue(['555']);
    const result = await privates(commands).crownRolesAsync(ctx(), []);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(GenericEmbedService.buildCustomEmbedResponse).toHaveBeenCalledWith(
      expect.stringContaining('Crown Role Configuration'),
      expect.stringContaining('<@&555>'),
    );
  });

  it('refuses role changes when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: false }), ['<@&555>']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('removes the role on "none"', async () => {
    const { commands, deps } = build({ isAdmin: true });
    const result = await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['none']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setCrownRole = (deps.crownService as { setCrownRole: ReturnType<typeof vi.fn> })
      .setCrownRole;
    expect(setCrownRole).toHaveBeenCalledWith('222', null);
  });

  it('removes the role on "remove"', async () => {
    const { commands, deps } = build({ isAdmin: true });
    await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['remove']);
    const setCrownRole = (deps.crownService as { setCrownRole: ReturnType<typeof vi.fn> })
      .setCrownRole;
    expect(setCrownRole).toHaveBeenCalledWith('222', null);
  });

  it('removes the role on "clear"', async () => {
    const { commands, deps } = build({ isAdmin: true });
    await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['clear']);
    const setCrownRole = (deps.crownService as { setCrownRole: ReturnType<typeof vi.fn> })
      .setCrownRole;
    expect(setCrownRole).toHaveBeenCalledWith('222', null);
  });

  it('rejects an invalid role input', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['notarole']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('sets a role from a mention', async () => {
    const { commands, deps } = build({ isAdmin: true });
    const result = await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['<@&555>']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setCrownRole = (deps.crownService as { setCrownRole: ReturnType<typeof vi.fn> })
      .setCrownRole;
    expect(setCrownRole).toHaveBeenCalledWith('222', '555');
  });

  it('sets a role from a plain role id', async () => {
    const { commands, deps } = build({ isAdmin: true });
    const result = await privates(commands).crownRolesAsync(ctx({ userIsGuildAdmin: true }), ['555']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const setCrownRole = (deps.crownService as { setCrownRole: ReturnType<typeof vi.fn> })
      .setCrownRole;
    expect(setCrownRole).toHaveBeenCalledWith('222', '555');
  });
});

describe('CrownCommands.killAllCrownsAsync', () => {
  it('refuses when the user is not a guild admin', async () => {
    const { commands } = build({ isAdmin: false });
    const result = await privates(commands).killAllCrownsAsync(ctx({ userIsGuildAdmin: false }), ['confirm']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('requires the confirm keyword', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).killAllCrownsAsync(ctx({ userIsGuildAdmin: true }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects a non-confirm argument', async () => {
    const { commands } = build({ isAdmin: true });
    const result = await privates(commands).killAllCrownsAsync(ctx({ userIsGuildAdmin: true }), ['yes']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('kills all crowns after confirmation', async () => {
    const { commands, deps } = build({ isAdmin: true });
    (deps.crownService as { killAllCrowns: ReturnType<typeof vi.fn> })
      .killAllCrowns.mockResolvedValue(15);
    const result = await privates(commands).killAllCrownsAsync(ctx({ userIsGuildAdmin: true }), ['confirm']);
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    const killAllCrowns = (deps.crownService as { killAllCrowns: ReturnType<typeof vi.fn> })
      .killAllCrowns;
    expect(killAllCrowns).toHaveBeenCalledWith('222');
  });
});

describe('CrownCommands command table', () => {
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
