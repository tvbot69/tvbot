import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { GuildAdminCommands } from '@bot/textCommands/guild/guildAdminCommands';
import { GuildAdminSlashCommands } from '@bot/slashCommands/guild/guildAdminSlashCommands';
import { CommandHandler } from '@bot/handlers/commands/commandHandler';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { PROTECTED_COMMAND_NAMES } from '@bot/services/guild/protectedCommandNames';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { TextCommandDefinition } from '@bot/models/commandModels';
import type { SlashCommandDefinition } from '@bot/models/commandModels';
import type { Client } from 'discord.js';
import type { CacheService } from '@bot/services/system/cacheService';
import type { ChannelRepository } from '@persistence/repositories/channelRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { GuildAdminService } from '@bot/services/guild/guildAdminService';
import type { UserService } from '@bot/services/user/userService';
import type { PrefixService } from '@bot/services/user/prefixService';
import type { ColorService } from '@bot/services/system/colorService';
import type { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import type { GuildUserService } from '@bot/services/guild/guildUserService';
import type { GameService } from '@bot/services/guild/gameService';
import type { RateLimitService } from '@bot/services/system/rateLimitService';

/**
 * THE WRITERS FOR THE PER-CHANNEL DISABLE GATE.
 *
 * `ChannelToggledCommandService.toggleCommand` and
 * `DisabledChannelService.setChannelDisabled` shipped with live readers
 * (`commandHandler.isBlockedInContext` at commandHandler.ts:292, and the same
 * method in `interactionHandler`) and NO callers. The gate therefore answered
 * "not blocked" forever. A one-sided test is exactly what hid that: the readers
 * had coverage, the writers had none, and the feature was dead in production
 * with a green suite.
 *
 * So this file tests the PAIR, and in this order of importance:
 *
 *   1. the real gate. `isBlockedInContext` is called on a REAL `CommandHandler`
 *      wired to the SAME `ChannelToggledCommandService` /
 *      `DisabledChannelService` instances the commands write through, over an
 *      in-memory channel repository and an in-memory cache. Nothing is stubbed
 *      on that path, so a broken write or a stale cache key both show up.
 *   2. the toggle ROUND TRIP. "It got disabled" cannot tell a working toggle
 *      from a one-way write, and a one-way write is the failure mode that leaves
 *      a channel permanently deaf.
 *   3. the guards, with fresh plain-object doubles per test so "the service was
 *      not called" is directly observable.
 *
 * No `vi.spyOn` anywhere. Not on the object under test, not on a static, not on
 * the container: `mockRestore()` leaves an own property `undefined` and every
 * later test in the file dies silently. That is a proven bug class here - it
 * cost 35 failures once.
 */

const GUILD_ID = '222';
const CHANNEL_ID = '4444';

// ---------------------------------------------------------------------------
// Doubles. Every builder below returns FRESH objects; nothing is shared, so
// there is no state to leak between tests and nothing to restore.
// ---------------------------------------------------------------------------

const guildServiceStub = () =>
  ({ getGuild: vi.fn(async () => ({ commandsDisabled: false })) }) as unknown as GuildService;

const guildAdminServiceStub = () => ({}) as unknown as GuildAdminService;

const userServiceStub = () => ({}) as unknown as UserService;

const prefixServiceStub = () =>
  ({ getPrefix: vi.fn(async () => '.') }) as unknown as PrefixService;

const colorServiceStub = () =>
  ({ getAccentColorAsync: vi.fn(async () => undefined) }) as unknown as ColorService;

/** The guild-wide gate. Always open, so a channel result is unambiguous. */
const guildDisabledCommandServiceStub = () =>
  ({
    isCommandDisabled: vi.fn(async () => false),
    addDisabledCommand: vi.fn(async () => undefined),
    removeDisabledCommand: vi.fn(async () => undefined),
    getDisabledCommands: vi.fn(async () => [] as string[]),
  }) as unknown as GuildDisabledCommandService;

/**
 * The PER-CHANNEL toggle store. Distinct from `guildDisabledCommandServiceStub`:
 * that one is the guild-wide gate (`isCommandDisabled`), this one is the only
 * writer of the per-channel `*` list the gate reads. Passing the wrong one is
 * the mistake the 7-argument arity forced, so both are named by their real type.
 */
const channelToggledCommandServiceStub = () =>
  ({
    toggleCommand: vi.fn(async () => true),
    isCommandToggled: vi.fn(async () => false),
  }) as unknown as ChannelToggledCommandService;

/** The per-channel mute gate, NOT the guild-wide one. */
const disabledChannelServiceStub = () =>
  ({
    setChannelDisabled: vi.fn(async () => undefined),
    isChannelDisabled: vi.fn(async () => false),
  }) as unknown as DisabledChannelService;

/**
 * An in-memory `CacheService` with WORKING get/set/delete.
 *
 * `delete` is the part that matters: both real services invalidate on write, and
 * a `delete` that quietly did nothing would let this file pass while production
 * served a stale gate for the full 5 minute TTL.
 */
const memoryCache = () => {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | null> =>
      store.has(key) ? (store.get(key) as T) : null,
    set: async <T>(key: string, value: T): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };
};

const memoryChannelRepository = () => {
  const rows = new Map<string, { channelId: string; guildId: string; toggledCommands: string[] }>();
  return {
    rows,
    addOrUpdateChannel: vi.fn(async (channelId: string, guildId: string) => {
      if (!rows.has(channelId)) {
        rows.set(channelId, { channelId, guildId, toggledCommands: [] });
      }
      return rows.get(channelId)!;
    }),
    getChannel: vi.fn(async (channelId: string) => rows.get(channelId) ?? null),
    setToggledCommands: vi.fn(async (channelId: string, names: string[]) => {
      const row = rows.get(channelId);
      if (row) {
        row.toggledCommands = names;
      }
    }),
  };
};

/**
 * Spied doubles, for the "refused" cases where the assertion is that a service
 * was NOT reached. Built fresh per call.
 */
const writerSpies = (toggleResult: boolean = true) => ({
  channelToggled: {
    toggleCommand: vi.fn(async () => toggleResult),
    isCommandToggled: vi.fn(async () => false),
  } as unknown as ChannelToggledCommandService & {
    toggleCommand: ReturnType<typeof vi.fn>;
  },
  disabledChannel: {
    setChannelDisabled: vi.fn(async () => undefined),
    isChannelDisabled: vi.fn(async () => false),
  } as unknown as DisabledChannelService & {
    setChannelDisabled: ReturnType<typeof vi.fn>;
  },
});

/**
 * Real services over the in-memory repository and cache, plus a REAL
 * `CommandHandler` reading through the same instances. This is the graph the
 * feature actually needs and did not have.
 */
const buildLive = () => {
  const cache = memoryCache();
  const channelRepository = memoryChannelRepository();

  const channelToggled = new ChannelToggledCommandService(
    cache as unknown as CacheService,
    channelRepository as unknown as ChannelRepository,
  );
  const disabledChannel = new DisabledChannelService(
    cache as unknown as CacheService,
    channelRepository as unknown as ChannelRepository,
  );

  const guildService = guildServiceStub();
  const guildAdminService = guildAdminServiceStub();
  const userService = userServiceStub();
  const prefixService = prefixServiceStub();
  const colorService = colorServiceStub();
  const guildDisabled = guildDisabledCommandServiceStub();

  // Positional arity is load-bearing, so every stub is named with its real type
  // rather than written inline: with inline `as never` literals the arguments
  // are mutually assignable and a swap compiles silently.
  const text = new GuildAdminCommands(
    guildService,
    guildAdminService,
    userService,
    prefixService,
    guildDisabled,
    colorService,
    channelToggled,
    disabledChannel,
  );
  const slash = new GuildAdminSlashCommands(
    guildService,
    guildAdminService,
    userService,
    prefixService,
    colorService,
    channelToggled,
    disabledChannel,
  );

  // The gate. `isBlockedInContext` is public, so this needs no casts.
  const handler = new CommandHandler(
    { user: { id: 'bot-1' }, on: vi.fn() } as unknown as Client,
    prefixService,
    guildService,
    disabledChannel,
    guildDisabled,
    channelToggled,
    userService,
    { storeGuildUsers: vi.fn(async () => undefined) } as unknown as GuildUserService,
    colorService,
    {
      getActiveGame: vi.fn(() => null),
      checkAnswer: vi.fn(() => ({ isCorrect: false })),
      giveUp: vi.fn(() => null),
      getUserStats: vi.fn(() => ({})),
    } as unknown as GameService,
    { checkUserRateLimitAsync: vi.fn(async () => ({ rateLimited: false, messageSent: false })) } as unknown as RateLimitService,
  );

  return { text, slash, handler, channelRepository, channelToggled, disabledChannel };
};

/** Same two command modules, but with spy doubles for the writers. */
const buildWithWriters = (toggleResult: boolean = true) => {
  const writers = writerSpies(toggleResult);
  const guildService = guildServiceStub();
  const guildAdminService = guildAdminServiceStub();
  const userService = userServiceStub();
  const prefixService = prefixServiceStub();
  const colorService = colorServiceStub();
  const guildDisabled = guildDisabledCommandServiceStub();

  const text = new GuildAdminCommands(
    guildService,
    guildAdminService,
    userService,
    prefixService,
    guildDisabled,
    colorService,
    writers.channelToggled,
    writers.disabledChannel,
  );
  const slash = new GuildAdminSlashCommands(
    guildService,
    guildAdminService,
    userService,
    prefixService,
    colorService,
    writers.channelToggled,
    writers.disabledChannel,
  );

  return { ...writers, text, slash };
};

/**
 * A command module built WITHOUT the two writers, i.e. the pre-fix wiring. A
 * writer that is missing must not degrade into a reply that claims success.
 */
const buildWithoutWriters = () => {
  const text = new GuildAdminCommands(
    guildServiceStub(),
    guildAdminServiceStub(),
    userServiceStub(),
    prefixServiceStub(),
    guildDisabledCommandServiceStub(),
    colorServiceStub(),
  );
  const slash = new GuildAdminSlashCommands(
    guildServiceStub(),
    guildAdminServiceStub(),
    userServiceStub(),
    prefixServiceStub(),
    colorServiceStub(),
    channelToggledCommandServiceStub(),
    disabledChannelServiceStub(),
  );
  return { text, slash };
};

// ---------------------------------------------------------------------------
// Contexts. Plain objects cast to ContextModel, which is the established pattern
// here: the real class's getters need a live `Message`/`interaction`, and the
// commands read `guildId`, `channelId`, `prefix` and `userIsGuildAdmin` only.
// ---------------------------------------------------------------------------

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: GUILD_ID,
    guild: { name: 'Test Guild', ownerId: '999' },
    channelId: CHANNEL_ID,
    prefix: '.',
    args: [],
    userIsGuildAdmin: true,
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => ctx({ guildId: undefined, guild: undefined, userIsGuildAdmin: false, channelId: undefined });
const noAdminCtx = () => ctx({ userIsGuildAdmin: false });
const noChannelCtx = () => ctx({ channelId: '' });

const slashCtx = (
  opts: { command?: string; subcommand?: string },
  over: Record<string, unknown> = {},
): ContextModel => {
  const context = ctx(over) as unknown as { interaction: unknown };
  context.interaction = {
    commandName: 'channeltogglecommand',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    options: {
      getString: (name: string) => (name === 'command' ? opts.command ?? null : null),
      getSubcommand: () => opts.subcommand ?? 'disable',
    },
  };
  return context as unknown as ContextModel;
};

const description = (result: ResponseModel): string => (result.embed.data.description ?? '') as string;

const findText = (module: GuildAdminCommands, name: string): TextCommandDefinition => {
  const command = module.commands.find((c) => c.name === name);
  if (!command) {
    throw new Error(`text command '${name}' is not registered`);
  }
  return command;
};

const findSlash = (module: GuildAdminSlashCommands, name: string): SlashCommandDefinition => {
  const command = module.commands.find((c) => c.data.name === name);
  if (!command) {
    throw new Error(`slash command '/${name}' is not registered`);
  }
  return command;
};

// ---------------------------------------------------------------------------
// 1. Registration - both families, because half a feature is half a feature.
// ---------------------------------------------------------------------------

describe('per-channel disable commands are registered in BOTH families', () => {
  it('registers channeltogglecommand and disabledchannel as text commands', () => {
    const { text } = buildLive();
    const names = text.commands.map((c) => c.name);
    expect(names).toContain('channeltogglecommand');
    expect(names).toContain('disabledchannel');
  });

  it('registers the same two names as slash commands', () => {
    const { slash } = buildLive();
    const names = slash.commands.map((c) => c.data.name);
    expect(names).toContain('channeltogglecommand');
    expect(names).toContain('disabledchannel');
  });

  it('keeps the new names and aliases unique inside the module', () => {
    const { text } = buildLive();
    const names = text.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// 2. THE END-TO-END GATE. The whole bug was that writer and reader were never
//    connected, so this is the only assertion that would have caught it.
// ---------------------------------------------------------------------------

describe('a channel toggle moves the REAL gate (commandHandler.isBlockedInContext)', () => {
  it('blocks the command in that channel after the first invocation, then lets it through after the second', async () => {
    const { text, handler } = buildLive();
    const command = findText(text, 'channeltogglecommand');

    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBeNull();

    const off = await command.executeAsync(ctx(), ['who']);
    expect(description(off)).toContain('disabled');
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'This command is toggled off in this channel.',
    );

    const on = await command.executeAsync(ctx(), ['who']);
    expect(description(on)).toContain('enabled');
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBeNull();
  });

  it('leaves other commands in the same channel alone - it is per command, not per channel', async () => {
    const { text, handler } = buildLive();
    await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);

    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'This command is toggled off in this channel.',
    );
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'chart')).toBeNull();
  });

  it('does not leak the toggle into another channel', async () => {
    const { text, handler } = buildLive();
    await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);

    expect(await handler.isBlockedInContext(GUILD_ID, '9999', 'who')).toBeNull();
  });

  it('blocks EVERY command in the channel after disabledchannel off, and releases them after on', async () => {
    const { text, handler, channelRepository } = buildLive();
    const command = findText(text, 'disabledchannel');

    const off = await command.executeAsync(ctx(), ['off']);
    expect(description(off)).toContain('disabled');
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'Bot commands are disabled in this channel.',
    );
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'chart')).toBe(
      'Bot commands are disabled in this channel.',
    );
    // The wildcard is the contract with DisabledChannelService, so assert the
    // stored value rather than only the reader's verdict.
    expect(channelRepository.rows.get(CHANNEL_ID)!.toggledCommands).toContain('*');

    const on = await command.executeAsync(ctx(), ['on']);
    expect(description(on)).toContain('enabled');
    expect(channelRepository.rows.get(CHANNEL_ID)!.toggledCommands).not.toContain('*');
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBeNull();
  });

  it('is driven by the slash family too, not only the text one', async () => {
    const { slash, handler } = buildLive();

    await findSlash(slash, 'channeltogglecommand').executeAsync(slashCtx({ command: 'who' }));
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'This command is toggled off in this channel.',
    );

    await findSlash(slash, 'disabledchannel').executeAsync(slashCtx({ subcommand: 'disable' }));
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'Bot commands are disabled in this channel.',
    );

    await findSlash(slash, 'disabledchannel').executeAsync(slashCtx({ subcommand: 'enable' }));
    expect(await handler.isBlockedInContext(GUILD_ID, CHANNEL_ID, 'who')).toBe(
      'This command is toggled off in this channel.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The toggle round trip, on the writers' own contract.
// ---------------------------------------------------------------------------

describe('channeltogglecommand is a toggle, not a one-way write', () => {
  it('disables then re-enables across two invocations', async () => {
    const { text, channelRepository } = buildLive();
    const command = findText(text, 'channeltogglecommand');

    await command.executeAsync(ctx(), ['who']);
    expect(channelRepository.rows.get(CHANNEL_ID)!.toggledCommands).toEqual(['who']);

    await command.executeAsync(ctx(), ['who']);
    expect(channelRepository.rows.get(CHANNEL_ID)!.toggledCommands).toEqual([]);
  });

  it('stores the name lowercased, so the gate matches it however the user typed it', async () => {
    const { text, channelToggled, channelRepository } = buildLive();
    await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['  WHO  ']);

    expect(channelRepository.rows.get(CHANNEL_ID)!.toggledCommands).toEqual(['who']);
    expect(await channelToggled.isCommandToggled(GUILD_ID, CHANNEL_ID, 'who')).toBe(true);
    expect(await channelToggled.isCommandToggled(GUILD_ID, CHANNEL_ID, 'WHO')).toBe(true);
  });

  it('reports the state the service returned rather than assuming one', async () => {
    // The first invocation of a fresh channel MUST report "disabled". If the
    // command assumed `true` instead of using the return value, this double -
    // which is asked to say the opposite - is the only thing that notices.
    const { text, channelToggled } = buildWithWriters(false);
    const result = await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);

    expect(description(result)).toContain('enabled');
    expect(description(result)).not.toContain('disabled');
    expect(channelToggled.toggleCommand).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, 'who');
  });

  it('passes the name it was given straight through, without re-deriving it', async () => {
    const { text, channelToggled } = buildWithWriters();
    await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);
    expect(channelToggled.toggleCommand).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, 'who');
  });
});

// ---------------------------------------------------------------------------
// 4. The reply names the channel. That is the only thing distinguishing it from
//    `.togglecommand`, whose text says "for this server".
// ---------------------------------------------------------------------------

describe('the reply names the channel it changed', () => {
  it('names it when disabling, and says "in", not "for this server"', async () => {
    const { text } = buildWithWriters(true);
    const result = await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);
    const text_ = description(result);

    expect(text_).toContain(`<#${CHANNEL_ID}>`);
    expect(text_).toContain('in');
    expect(text_).not.toContain('for this server');
  });

  it('names it when re-enabling too', async () => {
    const { text } = buildWithWriters(false);
    expect(description(await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who'])))
      .toContain(`<#${CHANNEL_ID}>`);
  });

  it('names it on the disabledchannel command, both directions', async () => {
    const { text, disabledChannel } = buildWithWriters();

    const off = description(await findText(text, 'disabledchannel').executeAsync(ctx(), ['off']));
    expect(off).toContain(`<#${CHANNEL_ID}>`);
    expect(off).toContain('disabled');
    expect(disabledChannel.setChannelDisabled).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, true);

    const on = description(await findText(text, 'disabledchannel').executeAsync(ctx(), ['on']));
    expect(on).toContain(`<#${CHANNEL_ID}>`);
    expect(on).toContain('enabled');
    expect(disabledChannel.setChannelDisabled).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, false);
  });

  it('names the channel in the slash family as well', async () => {
    const { slash } = buildWithWriters();
    const result = await findSlash(slash, 'channeltogglecommand').executeAsync(slashCtx({ command: 'who' }));
    expect(description(result)).toContain(`<#${CHANNEL_ID}>`);
  });
});

// ---------------------------------------------------------------------------
// 5. Moderation controls: admin only, guild only, channel required.
// ---------------------------------------------------------------------------

describe('channeltogglecommand guards', () => {
  it('refuses a caller without the Manage Server permission and writes nothing', async () => {
    const { text, channelToggled } = buildWithWriters();
    const result = await findText(text, 'channeltogglecommand').executeAsync(noAdminCtx(), ['who']);

    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
    expect(channelToggled.toggleCommand).not.toHaveBeenCalled();
  });

  it('refuses the command in a DM and writes nothing', async () => {
    const { text, channelToggled } = buildWithWriters();
    const result = await findText(text, 'channeltogglecommand').executeAsync(dmCtx(), ['who']);

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(channelToggled.toggleCommand).not.toHaveBeenCalled();
  });

  it('refuses a context with no channel, because there is nothing to write to', async () => {
    const { text, channelToggled } = buildWithWriters();
    const result = await findText(text, 'channeltogglecommand').executeAsync(noChannelCtx(), ['who']);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(channelToggled.toggleCommand).not.toHaveBeenCalled();
  });

  it('rejects an empty command name with the usage line', async () => {
    const { text, channelToggled } = buildWithWriters();
    const result = await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['   ']);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(description(result)).toContain('channeltogglecommand');
    expect(channelToggled.toggleCommand).not.toHaveBeenCalled();
  });

  it('refuses to disable the gate-breakers, including the two new commands', async () => {
    // The list is the shared constant, so this covers the guild-wide command
    // too. `disabledchannel` matters most: once `'*'` is in place,
    // `channeltogglecommand` alone cannot bring the channel back.
    expect(PROTECTED_COMMAND_NAMES).toContain('channeltogglecommand');
    expect(PROTECTED_COMMAND_NAMES).toContain('disabledchannel');

    for (const name of PROTECTED_COMMAND_NAMES) {
      const { text, channelToggled, disabledChannel } = buildWithWriters();
      const result = await findText(text, 'channeltogglecommand').executeAsync(ctx(), [name]);

      expect(result.commandResponse, name).toBe(CommandResponse.WrongInput);
      expect(description(result), name).toContain('cannot be disabled');
      expect(channelToggled.toggleCommand, name).not.toHaveBeenCalled();
      expect(disabledChannel.setChannelDisabled, name).not.toHaveBeenCalled();
    }
  });

  it('refuses to disable the gate-breakers from the slash family too', async () => {
    for (const name of PROTECTED_COMMAND_NAMES) {
      const { slash, channelToggled } = buildWithWriters();
      const result = await findSlash(slash, 'channeltogglecommand').executeAsync(slashCtx({ command: name }));

      expect(result.commandResponse, name).toBe(CommandResponse.WrongInput);
      expect(channelToggled.toggleCommand, name).not.toHaveBeenCalled();
    }
  });

  it('applies the same guards in the slash family', async () => {
    const noAdmin = buildWithWriters();
    expect(
      (await findSlash(noAdmin.slash, 'channeltogglecommand').executeAsync(
        slashCtx({ command: 'who' }, { userIsGuildAdmin: false }),
      )).commandResponse,
    ).toBe(CommandResponse.NoPermission);
    expect(noAdmin.channelToggled.toggleCommand).not.toHaveBeenCalled();

    const inDm = buildWithWriters();
    expect(
      (await findSlash(inDm.slash, 'channeltogglecommand').executeAsync(
        slashCtx({ command: 'who' }, { guildId: undefined, channelId: undefined, userIsGuildAdmin: false }),
      )).commandResponse,
    ).toBe(CommandResponse.NotSupportedInDm);
    expect(inDm.channelToggled.toggleCommand).not.toHaveBeenCalled();
  });
});

describe('disabledchannel guards', () => {
  it('refuses a caller without the Manage Server permission and writes nothing', async () => {
    const { text, disabledChannel } = buildWithWriters();
    const result = await findText(text, 'disabledchannel').executeAsync(noAdminCtx(), ['off']);

    expect(result.commandResponse).toBe(CommandResponse.NoPermission);
    expect(disabledChannel.setChannelDisabled).not.toHaveBeenCalled();
  });

  it('refuses the command in a DM and writes nothing', async () => {
    const { text, disabledChannel } = buildWithWriters();
    const result = await findText(text, 'disabledchannel').executeAsync(dmCtx(), ['off']);

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(disabledChannel.setChannelDisabled).not.toHaveBeenCalled();
  });

  it('refuses a context with no channel', async () => {
    const { text, disabledChannel } = buildWithWriters();
    const result = await findText(text, 'disabledchannel').executeAsync(noChannelCtx(), ['off']);

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(disabledChannel.setChannelDisabled).not.toHaveBeenCalled();
  });

  it('requires an explicit on/off instead of guessing a direction', async () => {
    for (const state of ['', 'maybe', 'trueish', '2']) {
      const { text, disabledChannel } = buildWithWriters();
      const result = await findText(text, 'disabledchannel').executeAsync(ctx(), [state]);

      expect(result.commandResponse, state).toBe(CommandResponse.WrongInput);
      expect(description(result), state).toContain('disabledchannel');
      expect(disabledChannel.setChannelDisabled, state).not.toHaveBeenCalled();
    }
  });

  it('accepts the documented synonyms for each direction', async () => {
    for (const state of ['off', 'disable', 'disabled', 'false', '0']) {
      const { text, disabledChannel } = buildWithWriters();
      await findText(text, 'disabledchannel').executeAsync(ctx(), [state]);
      expect(disabledChannel.setChannelDisabled, state).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, true);
    }
    for (const state of ['on', 'enable', 'enabled', 'true', '1']) {
      const { text, disabledChannel } = buildWithWriters();
      await findText(text, 'disabledchannel').executeAsync(ctx(), [state]);
      expect(disabledChannel.setChannelDisabled, state).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID, false);
    }
  });

  it('applies the same guards in the slash family', async () => {
    const noAdmin = buildWithWriters();
    expect(
      (await findSlash(noAdmin.slash, 'disabledchannel').executeAsync(
        slashCtx({ subcommand: 'disable' }, { userIsGuildAdmin: false }),
      )).commandResponse,
    ).toBe(CommandResponse.NoPermission);
    expect(noAdmin.disabledChannel.setChannelDisabled).not.toHaveBeenCalled();

    const inDm = buildWithWriters();
    expect(
      (await findSlash(inDm.slash, 'disabledchannel').executeAsync(
        slashCtx({ subcommand: 'disable' }, { guildId: undefined, channelId: undefined, userIsGuildAdmin: false }),
      )).commandResponse,
    ).toBe(CommandResponse.NotSupportedInDm);
    expect(inDm.disabledChannel.setChannelDisabled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. A missing writer must say so. The pre-fix shape of this class - six
//    constructor arguments, no writer - must not answer "disabled".
// ---------------------------------------------------------------------------

describe('an unwired writer refuses instead of lying', () => {
  it('answers with an error instead of claiming a channel toggle succeeded', async () => {
    const { text } = buildWithoutWriters();
    const result = await findText(text, 'channeltogglecommand').executeAsync(ctx(), ['who']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(description(result)).toContain('Nothing was changed');
  });

  it('answers with an error instead of claiming the channel was disabled', async () => {
    const { text } = buildWithoutWriters();
    const result = await findText(text, 'disabledchannel').executeAsync(ctx(), ['off']);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(description(result)).toContain('Nothing was changed');
  });

/**
   * The slash family is the FIX for this, and it is a different kind of fix.
   *
   * `GuildAdminSlashCommands` now REQUIRES both writers, so "the writer was
   * never passed" stopped being a reachable runtime state: it is a compile error
   * instead. The `if (!this.channelToggledCommandService)` branch that answered
   * "not available right now" is deleted, because it was the no-op that made the
   * gate look enforced.
   *
   * That makes the "unwired writer" test above unreachable for slash, so the
   * assertion that actually matters replaces it: a writer that FAILS must
   * propagate. A swallowed rejection would be reported to the admin as a
   * channel toggle that never happened - the exact lie this file exists to catch.
   */
  it('surfaces a FAILED write in the slash family instead of claiming success', async () => {
    const boom = new Error('channel repository unreachable');
    const toggled = {
      toggleCommand: vi.fn(async () => {
        throw boom;
      }),
      isCommandToggled: vi.fn(async () => false),
    } as unknown as ChannelToggledCommandService;
    const disabled = {
      setChannelDisabled: vi.fn(async () => {
        throw boom;
      }),
      isChannelDisabled: vi.fn(async () => false),
    } as unknown as DisabledChannelService;

    const slash = new GuildAdminSlashCommands(
      guildServiceStub(),
      guildAdminServiceStub(),
      userServiceStub(),
      prefixServiceStub(),
      colorServiceStub(),
      toggled,
      disabled,
    );

    await expect(
      findSlash(slash, 'channeltogglecommand').executeAsync(slashCtx({ command: 'who' })),
    ).rejects.toThrow('channel repository unreachable');
    await expect(
      findSlash(slash, 'disabledchannel').executeAsync(slashCtx({ subcommand: 'disable' })),
    ).rejects.toThrow('channel repository unreachable');
  });

  /**
   * A no-op branch left behind by the optional-DI era is exactly the defect this
   * test file was written for, so its absence is asserted from the source rather
   * than trusted to a reader of the constructor: the slash class must not carry
   * the "not available right now" wording, because its writers are required and
   * the branch could only ever be unreachable.
   *
   * Scoped to the slash class on purpose. The TEXT twin still takes both writers
   * as optional and still answers an error without touching anything - that is
   * deliberate (several construction sites pass 6 arguments) and is asserted by
   * the two tests above.
   */
  it('has no unreachable "not available right now" branch in the slash class', () => {
    // `process.cwd()` rather than `import.meta.url`: this project compiles to
    // CommonJS, so a test is invoked from the repo root. A wrong root makes
    // `readFileSync` throw, which is a loud failure rather than a silent pass.
    const source = readFileSync(
      join(process.cwd(), 'src/bot/slashCommands/guild/guildAdminSlashCommands.ts'),
      'utf8',
    );
    expect(source).not.toContain('is not available right now');
  });
});
