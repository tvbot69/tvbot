import 'reflect-metadata';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerBuilder, MessageFlags } from 'discord.js';
import { Logger } from '@domain/logger';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ResponseModel } from '@bot/models/responseModel';
import { getSlashCommand } from '@bot/slashCommands';
import { getAutoCompleteResponder } from '@bot/autoCompleteHandlers';
import { tryHandleModal } from '@bot/interactions';
import { SETTINGS_BUTTON_PREFIX } from '@bot/interactions/settingsInteractions';
import { ALBUM_BUTTON_PREFIXES } from '@bot/interactions/albumInteractions';
import { FM_MODE_PREFIX } from '@bot/interactions/fmModeInteractions';
import { FRIEND_BUTTON_PREFIXES } from '@bot/interactions/friendInteractions';
import { MUSIC_INTERACTION_PREFIXES } from '@bot/interactions/musicInteractions';
import { TRACK_PREVIEW_PREFIX } from '@bot/interactions/trackPreviewInteractions';
import { InteractionHandler } from '@bot/handlers/interactionHandler';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';

/**
 * interactionHandler.routing.test.ts
 *
 * `interactionHandler.blocking.test.ts` already pins `isBlockedInContext` as a
 * pure function, and `interactionAckGuard.test.ts` already pins the 2.5s ack
 * timer. Neither one constructs the class, so neither one proves the DI graph
 * is wired correctly — the one failure mode that makes 30 handlers silently
 * dead at runtime while every unit test stays green.
 *
 * This file therefore does three things the others deliberately do not:
 *  1. builds the handler through the real 37-argument constructor and asserts
 *     every positional parameter landed on the field it names;
 *  2. drives `onInteractionCreated` with real interaction doubles over the
 *     whole customId routing table, asserting EXACTLY ONE handler ran;
 *  3. drives `executeSlashCommand` / `sendResponse` for the guard, typing,
 *     rate-limit, paginator and error paths.
 *
 * Prefixes exported by the interaction modules are imported and used, never
 * re-typed: re-inlining them here would make a prefix change in production
 * pass silently, which is the exact failure this file exists to catch.
 */

vi.mock('@bot/slashCommands', () => ({ getSlashCommand: vi.fn() }));
vi.mock('@bot/autoCompleteHandlers', () => ({ getAutoCompleteResponder: vi.fn() }));
vi.mock('@bot/interactions', () => ({ tryHandleModal: vi.fn(async () => true) }));

type Spy = ReturnType<typeof vi.fn>;

// `noUncheckedIndexedAccess` makes every index read `T | undefined`. This
// helper is a deliberate assertion, not a lookup that can miss: the keys are
// literals in the tests below, and a miss should be a type error, not a
// runtime `undefined`.
const priv = <T>(target: object, key: string): T =>
  (target as unknown as Record<string, T | undefined>)[key] as T;

// `.call(handler, ...)` is load-bearing: a bare `fn(interaction)` would invoke
// the method with `this === undefined`, every `this.x` access would throw
// INSIDE the handler's own try/catch, and the test would still see an
// "unexpected error" reply instead of a routing failure.
const dispatch = (handler: InteractionHandler, interaction: unknown): Promise<void> =>
  priv<(this: InteractionHandler, i: unknown) => Promise<void>>(
    handler,
    'onInteractionCreated',
  ).call(handler, interaction);

/**
 * The constructor parameter list, in the exact order declared in
 * interactionHandler.ts. Parameter names and private field names are identical
 * there, which is what lets the wiring test below loop instead of hard-coding
 * 37 assertions.
 */
const CONSTRUCTOR_ORDER = [
  'client',
  'helpInteractions',
  'nowPlayingInteractions',
  'userSettingsInteractions',
  'guildService',
  'disabledChannelService',
  'guildDisabledCommands',
  'channelToggledCommands',
  'componentTracker',
  'componentPaginatorService',
  'colorService',
  'userService',
  'guildUserService',
  'settingsInteractions',
  'chartInteractions',
  'albumInteractions',
  'fmModeInteractions',
  'friendInteractions',
  'musicInteractions',
  'trackPreviewInteractions',
  'topInteractions',
  'artistTrackInteractions',
  'artistInteractions',
  'tasteInteractions',
  'recentInteractions',
  'crownInteractions',
  'playcountInteractions',
  'profileInteractions',
  'librarySearchInteractions',
  'serverInteractions',
  'genreInteractions',
  'countryInteractions',
  'gameInteractions',
  'userHubInteractions',
  'intelligenceInteractions',
  'rateLimitService',
] as const;

/**
 * Only the collaborators a component interaction can be routed TO.
 * `userSettingsInteractions` is excluded because `asUserSettingsInteraction` is
 * probed on every component; its `handle` is asserted separately.
 */
const ROUTABLE_DEPS = [
  'helpInteractions',
  'nowPlayingInteractions',
  'settingsInteractions',
  'chartInteractions',
  'albumInteractions',
  'fmModeInteractions',
  'friendInteractions',
  'musicInteractions',
  'trackPreviewInteractions',
  'topInteractions',
  'artistTrackInteractions',
  'artistInteractions',
  'tasteInteractions',
  'recentInteractions',
  'crownInteractions',
  'playcountInteractions',
  'profileInteractions',
  'librarySearchInteractions',
  'serverInteractions',
  'genreInteractions',
  'countryInteractions',
  'gameInteractions',
  'userHubInteractions',
  'intelligenceInteractions',
  'componentPaginatorService',
] as const;

const makeDeps = () => ({
  client: { on: vi.fn() },
  helpInteractions: {
    handleSelectMenu: vi.fn(async () => undefined),
    handleButton: vi.fn(async () => undefined),
  },
  nowPlayingInteractions: {
    handleScrobble: vi.fn(async () => undefined),
    handleLove: vi.fn(async () => undefined),
    handleLovedPagination: vi.fn(async () => undefined),
    handleLyrics: vi.fn(async () => undefined),
  },
  // `unknown` return so a test can hand back a real settings interaction
  // without a type error on the mock's inferred `null`.
  userSettingsInteractions: {
    asUserSettingsInteraction: vi.fn((): unknown => null),
    handle: vi.fn(async () => undefined),
  },
  guildService: {
    getGuild: vi.fn(async () => ({ commandsDisabled: false })),
    ensureGuildExists: vi.fn(async () => undefined),
    trackLastCommand: vi.fn(async () => undefined),
  },
  disabledChannelService: { isChannelDisabled: vi.fn(async () => false) },
  guildDisabledCommands: { isCommandDisabled: vi.fn(async () => false) },
  channelToggledCommands: { isCommandToggled: vi.fn(async () => false) },
  componentTracker: { handle: vi.fn(async (): Promise<boolean> => false) },
  componentPaginatorService: {
    handleButton: vi.fn(async () => true),
    registerSession: vi.fn(),
  },
  colorService: {},
  userService: { getUserByDiscordId: vi.fn(async (): Promise<unknown> => null) },
  guildUserService: { ensureUserInGuild: vi.fn(async () => undefined) },
  settingsInteractions: { handleSettingsButton: vi.fn(async () => undefined) },
  chartInteractions: { handleEditButton: vi.fn(async () => undefined) },
  albumInteractions: { handleAlbumButton: vi.fn(async () => undefined) },
  fmModeInteractions: { handle: vi.fn(async () => undefined) },
  friendInteractions: {
    handleSelectMenu: vi.fn(async () => undefined),
    handleButton: vi.fn(async () => undefined),
  },
  musicInteractions: {
    handleSelectMenu: vi.fn(async () => undefined),
    handleButton: vi.fn(async () => undefined),
  },
  trackPreviewInteractions: { handle: vi.fn(async () => undefined) },
  topInteractions: { handle: vi.fn(async () => undefined) },
  artistTrackInteractions: { handle: vi.fn(async () => undefined) },
  artistInteractions: { handle: vi.fn(async () => undefined) },
  tasteInteractions: { handleButton: vi.fn(async () => undefined) },
  recentInteractions: { handleButton: vi.fn(async () => undefined) },
  crownInteractions: {
    handleSelectMenu: vi.fn(async () => undefined),
    handleButton: vi.fn(async () => undefined),
  },
  playcountInteractions: { handleButton: vi.fn(async () => undefined) },
  profileInteractions: { handleButton: vi.fn(async () => undefined) },
  librarySearchInteractions: { handleButton: vi.fn(async () => undefined) },
  serverInteractions: { handleButton: vi.fn(async () => undefined) },
  genreInteractions: { handleButton: vi.fn(async () => undefined) },
  countryInteractions: {
    handleStringSelect: vi.fn(async () => undefined),
    handleButton: vi.fn(async () => undefined),
  },
  gameInteractions: { handleButton: vi.fn(async () => undefined) },
  userHubInteractions: { handleButton: vi.fn(async () => undefined) },
  intelligenceInteractions: { handleButton: vi.fn(async () => undefined) },
  rateLimitService: {
    checkUserRateLimitAsync: vi.fn(
      async (): Promise<{ rateLimited: boolean; messageSent: boolean; retryAfterSeconds?: number }> => ({
        rateLimited: false,
        messageSent: false,
      }),
    ),
  },
});

type Deps = ReturnType<typeof makeDeps>;

/**
 * `InteractionHandler` has a fixed 37-parameter constructor, and TypeScript
 * will only accept a spread into a rest parameter. Going through this alias
 * is the only way to build it positionally — and building it positionally is
 * the entire point, because the alternative (`Object.create(prototype)`) is
 * what let the sibling test files miss a mis-wired graph.
 */
const InteractionHandlerCtor = InteractionHandler as unknown as new (
  ...args: never[]
) => InteractionHandler;

const build = () => {
  const deps = makeDeps();
  const ordered = CONSTRUCTOR_ORDER.map((key) => deps[key]) as never[];
  const handler = new InteractionHandlerCtor(...ordered);
  return { handler, deps, ordered };
};

const spyFor = (deps: Deps, path: string): Spy => {
  const [depName, method] = path.split('.') as [string, string];
  return priv<Record<string, Spy>>(deps, depName)[method] as Spy;
};

/** Every routable handler method that was invoked, as `dep.method`. */
const calledHandlers = (deps: Deps): string[] => {
  const invoked: string[] = [];
  for (const depName of ROUTABLE_DEPS) {
    const holder = priv<Record<string, unknown>>(deps, depName);
    for (const [method, value] of Object.entries(holder)) {
      if (typeof value !== 'function') {
        continue;
      }
      // `.mock.calls`, not `.calls` — a Vitest Mock keeps its call log under
      // `.mock`. Casting to `Spy` here and reading `.calls` typechecks (the
      // cast lies) and then throws at runtime, which reads as "every routing
      // test failed for an unrelated reason".
      const context = priv<{ calls: unknown[][] }>(value, 'mock');
      if (context.calls.length > 0) {
        invoked.push(`${depName}.${method}`);
      }
    }
  }
  return invoked;
};

const baseInteraction = () => {
  const state = { replied: false, deferred: false };
  return {
    state,
    customId: '',
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    user: { id: 'u1', tag: 'tester#0001', username: 'tester' },
    guild: { name: 'Test Guild', shardId: 0 } as { name: string; shardId: number } | null,
    guildId: 'g1' as string | null,
    channelId: 'c1' as string | null,
    commandName: 'wiki',
    channel: undefined as unknown,
    options: {
      getSubcommand: (): string => 'lookup',
      getFocused: (): { name: string } => ({ name: 'artist' }),
    },
    // The payload parameter is declared on every mock so `mock.calls[0][0]`
    // typechecks. A zero-arg mock infers a `[]` call tuple, and reading index
    // 0 of it is the error that produces a dozen bogus `unknown` assertions.
    reply: vi.fn(async (_payload: unknown) => {
      state.replied = true;
      return { id: 'm-reply', fetch: vi.fn(async () => ({ id: 'm-reply' })) };
    }),
    editReply: vi.fn(async (_payload: unknown) => ({ id: 'm1' })),
    followUp: vi.fn(async (_payload: unknown) => undefined),
    deferReply: vi.fn(async (_options?: unknown) => {
      state.deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    respond: vi.fn(async (_choices: unknown) => undefined),
  };
};

type Interaction = ReturnType<typeof baseInteraction>;

/** The `content` of the single editReply the handler issued, if any. */
const editReplyContent = (interaction: Interaction): string | undefined => {
  const payload = interaction.editReply.mock.calls[0]?.[0] as
    | { content?: string }
    | undefined;
  return payload?.content;
};

const makeButton = (customId: string): Interaction => {
  const interaction = baseInteraction();
  interaction.customId = customId;
  interaction.isButton = () => true;
  return interaction;
};

const makeStringSelect = (customId: string): Interaction => {
  const interaction = baseInteraction();
  interaction.customId = customId;
  interaction.isAnySelectMenu = () => true;
  interaction.isStringSelectMenu = () => true;
  return interaction;
};

const makeSlash = (commandName = 'wiki'): Interaction => {
  const interaction = baseInteraction();
  interaction.commandName = commandName;
  interaction.isChatInputCommand = () => true;
  return interaction;
};

const stubCommand = (
  response: ResponseModel | Error,
  options: { ephemeral?: boolean; name?: string } = {},
) => {
  const executeAsync =
    response instanceof Error
      ? vi.fn(async (_context: unknown) => {
          throw response;
        })
      : vi.fn(async (_context: unknown) => response);
  vi.mocked(getSlashCommand).mockReturnValue({
    data: { name: options.name ?? 'wiki' },
    executeAsync,
    ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
  } as unknown as ReturnType<typeof getSlashCommand>);
  return executeAsync;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Logger, 'button').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'slash').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'errorWithRef').mockReturnValue({ referenceId: 'ref123', message: 'boom' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('InteractionHandler constructor wiring', () => {
  it('takes 36 parameters', () => {
    // A guard, not a tautology: it makes adding a parameter a visible decision
    // rather than an accident, and this file must be updated alongside it.
    expect(InteractionHandler.length).toBe(36);
    expect(CONSTRUCTOR_ORDER).toHaveLength(36);
  });

  it('lands every positional parameter on the field it names', () => {
    // The failure this whole file is guarding against. A reordered constructor
    // compiles, passes every other test, and sends every customId to the wrong
    // class at runtime.
    const { handler, deps } = build();
    for (const key of CONSTRUCTOR_ORDER) {
      expect(priv(handler, key)).toBe(priv(deps, key));
    }
  });

  it('subscribes to InteractionCreate exactly once', () => {
    const { deps } = build();
    expect(deps.client.on).toHaveBeenCalledTimes(1);
    expect(deps.client.on.mock.calls[0]?.[0]).toBe('interactionCreate');
  });

  it('routes a real interaction through the listener it registered', () => {
    // The constructor's subscription is the ONLY way a component interaction
    // reaches this class in production. If it silently stopped being wired,
    // every button in the bot would go dead and the routing tests below would
    // still be green because they call the private method directly.
    const { deps } = build();
    const listener = deps.client.on.mock.calls[0]?.[1] as (i: unknown) => void;
    const interaction = makeButton('recent:1');

    expect(() => listener(interaction)).not.toThrow();

    return vi.waitFor(() => {
      expect(deps.recentInteractions.handleButton).toHaveBeenCalledWith(interaction);
    });
  });
});

describe('InteractionHandler component routing', () => {
  const BUTTON_ROUTES: Array<[string, string]> = [
    ['help:home', 'helpInteractions.handleButton'],
    ['scrobble-ref:1', 'nowPlayingInteractions.handleScrobble'],
    ['scrobble-now:1', 'nowPlayingInteractions.handleScrobble'],
    ['love-track:1', 'nowPlayingInteractions.handleLove'],
    ['unlove-track:1', 'nowPlayingInteractions.handleLove'],
    ['loved:2', 'nowPlayingInteractions.handleLovedPagination'],
    ['track-lyrics:1', 'nowPlayingInteractions.handleLyrics'],
    [`${TRACK_PREVIEW_PREFIX}1`, 'trackPreviewInteractions.handle'],
    ['artist-overview:x', 'artistInteractions.handle'],
    ['artist-info:x', 'artistInteractions.handle'],
    ['artist-tracks:x', 'artistInteractions.handle'],
    ['artist-albums:x', 'artistInteractions.handle'],
    ['aab:x', 'artistInteractions.handle'],
    ['at:x', 'artistTrackInteractions.handle'],
    ['top:artists', 'topInteractions.handle'],
    ['overview:x', 'topInteractions.handle'],
    ['chart-edit:x', 'chartInteractions.handleEditButton'],
    [`${SETTINGS_BUTTON_PREFIX}general`, 'settingsInteractions.handleSettingsButton'],
    [`${ALBUM_BUTTON_PREFIXES[0] as string}x`, 'albumInteractions.handleAlbumButton'],
    [`${ALBUM_BUTTON_PREFIXES[1] as string}x`, 'albumInteractions.handleAlbumButton'],
    [`${ALBUM_BUTTON_PREFIXES[2] as string}x`, 'albumInteractions.handleAlbumButton'],
    [`${FRIEND_BUTTON_PREFIXES[0] as string}x`, 'friendInteractions.handleButton'],
    [`${FRIEND_BUTTON_PREFIXES[1] as string}x`, 'friendInteractions.handleButton'],
    [`${FRIEND_BUTTON_PREFIXES[2] as string}x`, 'friendInteractions.handleButton'],
    [`${FRIEND_BUTTON_PREFIXES[3] as string}x`, 'friendInteractions.handleButton'],
    ['taste-tab:likes', 'tasteInteractions.handleButton'],
    ['recent:1', 'recentInteractions.handleButton'],
    ['crowns-page:1', 'crownInteractions.handleButton'],
    ['artist-whoknows:x', 'crownInteractions.handleButton'],
    ['artist-crown:x', 'crownInteractions.handleButton'],
    [`${MUSIC_INTERACTION_PREFIXES[0] as string}1`, 'musicInteractions.handleButton'],
    [`${MUSIC_INTERACTION_PREFIXES[1] as string}skip`, 'musicInteractions.handleButton'],
    [`${MUSIC_INTERACTION_PREFIXES[2] as string}clear`, 'musicInteractions.handleButton'],
    [`${MUSIC_INTERACTION_PREFIXES[3] as string}q`, 'musicInteractions.handleButton'],
    ['affinity-page:1', 'intelligenceInteractions.handleButton'],
    ['discoveries-page:1', 'intelligenceInteractions.handleButton'],
    ['gaps-page:1', 'intelligenceInteractions.handleButton'],
    ['milestone:reroll:x', 'playcountInteractions.handleButton'],
    ['profile:history:x', 'profileInteractions.handleButton'],
    ['profile:view:x', 'profileInteractions.handleButton'],
    ['search:page:2', 'librarySearchInteractions.handleButton'],
    ['search:tab:artists', 'librarySearchInteractions.handleButton'],
    ['server:page:2', 'serverInteractions.handleButton'],
    ['genre:rock', 'genreInteractions.handleButton'],
    ['country:denmark', 'countryInteractions.handleButton'],
    ['game:guess', 'gameInteractions.handleButton'],
    ['userhub:stats', 'userHubInteractions.handleButton'],
    ['component_paginator_7', 'componentPaginatorService.handleButton'],
  ];

  it.each(BUTTON_ROUTES)('routes button "%s" to %s', async (customId, expected) => {
    const { handler, deps } = build();
    const interaction = makeButton(customId);

    await dispatch(handler, interaction);

    expect(spyFor(deps, expected)).toHaveBeenCalledTimes(1);
    expect(spyFor(deps, expected)).toHaveBeenCalledWith(interaction);
    // Exactly one handler may run. Two would mean a prefix is shadowing another.
    expect(calledHandlers(deps)).toEqual([expected]);
    // A routed component must never reach the catch-all tracker.
    expect(deps.componentTracker.handle).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  const SELECT_ROUTES: Array<[string, string]> = [
    [`${FM_MODE_PREFIX}all`, 'fmModeInteractions.handle'],
    ['friends:selecttype:1', 'friendInteractions.handleSelectMenu'],
    ['music:queue:0', 'musicInteractions.handleSelectMenu'],
    ['user-crownpicker', 'crownInteractions.handleSelectMenu'],
    ['guild-members', 'crownInteractions.handleSelectMenu'],
    ['country:theme:dark', 'countryInteractions.handleStringSelect'],
    ['help:topics', 'helpInteractions.handleSelectMenu'],
  ];

  it.each(SELECT_ROUTES)('routes string select "%s" to %s', async (customId, expected) => {
    const { handler, deps } = build();
    const interaction = makeStringSelect(customId);

    await dispatch(handler, interaction);

    expect(spyFor(deps, expected)).toHaveBeenCalledTimes(1);
    expect(spyFor(deps, expected)).toHaveBeenCalledWith(interaction);
    expect(calledHandlers(deps)).toEqual([expected]);
    expect(deps.componentTracker.handle).not.toHaveBeenCalled();
  });

  it('gives the user-settings probe first refusal on every component', async () => {
    const { handler, deps } = build();
    const settingsInteraction = { customId: 'settings-btn:general' };
    deps.userSettingsInteractions.asUserSettingsInteraction.mockReturnValue(settingsInteraction);
    const interaction = makeButton('settings-btn:general');

    await dispatch(handler, interaction);

    expect(deps.userSettingsInteractions.asUserSettingsInteraction).toHaveBeenCalledWith(interaction);
    expect(deps.userSettingsInteractions.handle).toHaveBeenCalledWith(settingsInteraction);
    // Short-circuits before any prefix branch, including the real settings one.
    expect(deps.settingsInteractions.handleSettingsButton).not.toHaveBeenCalled();
    expect(calledHandlers(deps)).toEqual([]);
  });

  it('probes the user-settings hook even when it declines', async () => {
    const { handler, deps } = build();
    const interaction = makeButton('help:home');

    await dispatch(handler, interaction);

    expect(deps.userSettingsInteractions.asUserSettingsInteraction).toHaveBeenCalledWith(interaction);
    expect(deps.userSettingsInteractions.handle).not.toHaveBeenCalled();
    expect(deps.helpInteractions.handleButton).toHaveBeenCalledWith(interaction);
  });

  it('handles a modal submit through the modal registry', async () => {
    const { handler } = build();
    const interaction = baseInteraction();
    interaction.isModalSubmit = () => true;

    await dispatch(handler, interaction);

    expect(vi.mocked(tryHandleModal)).toHaveBeenCalledWith(interaction);
  });

  it('does nothing for an interaction that is none of the known kinds', async () => {
    const { handler, deps } = build();
    const interaction = baseInteraction();

    await dispatch(handler, interaction);

    expect(vi.mocked(tryHandleModal)).not.toHaveBeenCalled();
    expect(deps.componentTracker.handle).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('InteractionHandler unrecognised customId', () => {
  it('calls no interaction class and hands the interaction to the tracker', async () => {
    const { handler, deps } = build();
    const interaction = makeButton('some-feature-nobody-registered:42');

    await dispatch(handler, interaction);

    expect(calledHandlers(deps)).toEqual([]);
    expect(deps.componentTracker.handle).toHaveBeenCalledTimes(1);
    expect(deps.componentTracker.handle).toHaveBeenCalledWith(interaction);
  });

  it('does not reply itself when the tracker claims the interaction', async () => {
    const { handler, deps } = build();
    deps.componentTracker.handle.mockResolvedValue(true);
    const interaction = makeButton('unknown:42');

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('tells the user the interaction expired when nothing handled it', async () => {
    const { handler, deps } = build();
    deps.componentTracker.handle.mockResolvedValue(false);
    const interaction = makeButton('unknown:42');

    await dispatch(handler, interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'This interaction expired.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('stays silent when the interaction is already acknowledged', async () => {
    const { handler, deps } = build();
    deps.componentTracker.handle.mockResolvedValue(false);
    const interaction = makeButton('unknown:42');
    interaction.state.replied = true;

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('stays silent when the interaction is not repliable', async () => {
    const { handler, deps } = build();
    deps.componentTracker.handle.mockResolvedValue(false);
    const interaction = makeButton('unknown:42');
    interaction.isRepliable = () => false;

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('InteractionHandler isBlockedInContext gate', () => {
  it('blocks the command in a guild and never runs it', async () => {
    const { handler, deps } = build();
    deps.guildService.getGuild.mockResolvedValue({ commandsDisabled: true });
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).not.toHaveBeenCalled();
    // Acked FIRST, then the refusal edits the deferred reply. Replying
    // directly here would be the "This application did not respond" bug.
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Commands are currently disabled in this server.' }),
    );
  });

  it('reports a channel-level block with its own message', async () => {
    const { handler, deps } = build();
    deps.disabledChannelService.isChannelDisabled.mockResolvedValue(true);
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).not.toHaveBeenCalled();
    expect(editReplyContent(interaction)).toBe('Bot commands are disabled in this channel.');
  });

  it('does not consult the gates outside a guild and runs the command', async () => {
    const { handler, deps } = build();
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');
    interaction.guildId = null;

    await dispatch(handler, interaction);

    expect(deps.guildService.getGuild).not.toHaveBeenCalled();
    expect(deps.disabledChannelService.isChannelDisabled).not.toHaveBeenCalled();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPENS when a later gate throws, so a cache outage cannot disable the bot', async () => {
    // Deliberately the CHANNEL gate, not the guild gate: blocking.test.ts
    // already covers a throw from the first lookup. The point here is that
    // the command still runs, and the failure is visible in the log.
    const { handler, deps } = build();
    deps.disabledChannelService.isChannelDisabled.mockRejectedValue(new Error('redis down'));
    const executeAsync = stubCommand(new ResponseModel());

    await dispatch(handler, makeSlash('wiki'));

    expect(Logger.warn).toHaveBeenCalled();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('InteractionHandler sendTyping acknowledgement', () => {
  const channelWithTyping = () => ({ sendTyping: vi.fn(async () => undefined) });

  it('sends typing for a public command in a typed channel', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: false });
    const interaction = makeSlash('wiki');
    interaction.channel = channelWithTyping();

    await dispatch(handler, interaction);

    const channel = interaction.channel as { sendTyping: Spy };
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);
  });

  it('never sends typing for an ephemeral command', async () => {
    // An ephemeral reply shows no typing indicator to the caller, so the
    // heartbeat would be pure noise.
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: true });
    const interaction = makeSlash('wiki');
    interaction.channel = channelWithTyping();

    await dispatch(handler, interaction);

    const channel = interaction.channel as { sendTyping: Spy };
    expect(channel.sendTyping).not.toHaveBeenCalled();
  });

  it('never sends typing in a channel that cannot type', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: false });
    const interaction = makeSlash('wiki');
    interaction.channel = { id: 'dm-channel' };

    await dispatch(handler, interaction);

    expect(interaction.channel).toEqual({ id: 'dm-channel' });
  });

  it('survives a channel whose sendTyping rejects', async () => {
    const { handler } = build();
    const executeAsync = stubCommand(new ResponseModel(), { ephemeral: false });
    const interaction = makeSlash('wiki');
    interaction.channel = {
      sendTyping: vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    };

    await expect(dispatch(handler, interaction)).resolves.toBeUndefined();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('stops the typing heartbeat once the command finishes', async () => {
    vi.useFakeTimers();
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: false });
    const interaction = makeSlash('wiki');
    const channel = channelWithTyping();
    interaction.channel = channel;

    await dispatch(handler, interaction);
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(21000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);
  });

  it('stops the typing heartbeat even when the command throws', async () => {
    vi.useFakeTimers();
    const { handler } = build();
    stubCommand(new Error('command blew up'), { ephemeral: false });
    const interaction = makeSlash('wiki');
    const channel = channelWithTyping();
    interaction.channel = channel;

    await dispatch(handler, interaction);
    await vi.advanceTimersByTimeAsync(21000);

    expect(channel.sendTyping).toHaveBeenCalledTimes(1);
  });
});

describe('InteractionHandler sendResponse', () => {
  it('registers the paginator session against the edited reply message id', async () => {
    const { handler, deps } = build();
    const response = new ResponseModel();
    response.embed.setDescription('page 1');
    response._paginatorSession = { kind: 'tracks' };
    stubCommand(response);
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(deps.componentPaginatorService.registerSession).toHaveBeenCalledTimes(1);
    expect(deps.componentPaginatorService.registerSession).toHaveBeenCalledWith('m1', {
      kind: 'tracks',
    });
  });

  it('does not register a session when the response has none', async () => {
    const { handler, deps } = build();
    const response = new ResponseModel();
    response.embed.setDescription('no paginator');
    stubCommand(response);

    await dispatch(handler, makeSlash('wiki'));

    expect(deps.componentPaginatorService.registerSession).not.toHaveBeenCalled();
  });

  it('registers the session from a fresh reply when the deferral failed', async () => {
    // The defer itself can fail (3s token, flaky gateway). Falling back to a
    // plain reply is the documented behaviour, and the paginator must still
    // bind to the message that actually exists.
    const { handler, deps } = build();
    const response = new ResponseModel();
    response.embed.setDescription('page 1');
    response._paginatorSession = { kind: 'artists' };
    stubCommand(response);
    const interaction = makeSlash('wiki');
    interaction.deferReply.mockRejectedValue(new Error('Unknown interaction'));

    await dispatch(handler, interaction);

    expect(interaction.deferred).toBe(false);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(deps.componentPaginatorService.registerSession).toHaveBeenCalledWith('m-reply', {
      kind: 'artists',
    });
  });

  it('sends a Components V2 payload when the response carries a container', async () => {
    const { handler } = build();
    const response = new ResponseModel();
    response.componentsV2Container = new ContainerBuilder();
    stubCommand(response);
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const payload = interaction.editReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toBeUndefined();
  });

  it('attaches files when the response has them', async () => {
    const { handler } = build();
    const response = new ResponseModel();
    response.embed.setDescription('with a file');
    response.files = [{ attachment: Buffer.from('png-bytes'), name: 'chart.png' }];
    stubCommand(response);
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const payload = interaction.editReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.files).toEqual([{ attachment: expect.any(Buffer), name: 'chart.png' }]);
  });

  it('deletes the reply after autoDeleteSeconds', async () => {
    vi.useFakeTimers();
    const { handler } = build();
    const response = new ResponseModel();
    response.embed.setDescription('temporary');
    response.autoDeleteSeconds = 3;
    stubCommand(response);
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);
    expect(interaction.deleteReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it('never deletes the reply when autoDeleteSeconds is zero', async () => {
    vi.useFakeTimers();
    const { handler } = build();
    const response = new ResponseModel();
    response.embed.setDescription('permanent');
    response.autoDeleteSeconds = 0;
    stubCommand(response);

    await dispatch(handler, makeSlash('wiki'));
    await vi.advanceTimersByTimeAsync(60000);

    const interaction = makeSlash('wiki');
    await dispatch(handler, interaction);
    await vi.advanceTimersByTimeAsync(60000);
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral follow-up with a size hint on a 50035', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');
    interaction.editReply.mockRejectedValue(Object.assign(new Error('invalid form body'), { code: 50035 }));

    await dispatch(handler, interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    const payload = interaction.followUp.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/too large/i);
  });

  it('falls back to a generic ephemeral follow-up on any other failure', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');
    interaction.editReply.mockRejectedValue(Object.assign(new Error('no perms'), { code: 50013 }));

    await dispatch(handler, interaction);

    const payload = interaction.followUp.mock.calls[0]?.[0] as { content: string; flags: number };
    expect(payload.content).not.toMatch(/too large/i);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('never throws when even the follow-up fails', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');
    interaction.editReply.mockRejectedValue(Object.assign(new Error('no perms'), { code: 50013 }));
    interaction.followUp.mockRejectedValue(new Error('Unknown Message'));

    await expect(dispatch(handler, interaction)).resolves.toBeUndefined();
  });
});

describe('InteractionHandler slash command execution', () => {
  it('refuses an unrouted command with an ephemeral reply and a warning', async () => {
    vi.mocked(getSlashCommand).mockReturnValue(undefined);
    const { handler } = build();
    const interaction = makeSlash('ghost');

    await dispatch(handler, interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That command is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    // Ack first, then report — see the comment in executeSlashCommand.
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(Logger.warn).toHaveBeenCalled();
  });

  it('defers with the ephemeral flag set for an ephemeral command', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: true });
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('defers with no flags for a public command', async () => {
    const { handler } = build();
    stubCommand(new ResponseModel(), { ephemeral: false });
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
  });

  it('tells the user to slow down when the rate limit trips and no message was sent', async () => {
    const { handler, deps } = build();
    deps.rateLimitService.checkUserRateLimitAsync.mockResolvedValue({
      rateLimited: true,
      messageSent: false,
      retryAfterSeconds: 8,
    });
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/too fast/i);
    expect(payload.content).toContain('8s');
  });

  it('stays silent when the rate limiter already warned the user', async () => {
    const { handler, deps } = build();
    deps.rateLimitService.checkUserRateLimitAsync.mockResolvedValue({
      rateLimited: true,
      messageSent: true,
    });
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('sends nothing at all for a deleted response', async () => {
    const { handler } = build();
    const response = new ResponseModel();
    response.commandResponse = CommandResponse.Deleted;
    const executeAsync = stubCommand(response);
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('converts a thrown command into a reference-id error card', async () => {
    const { handler } = build();
    stubCommand(new Error('kaboom'));
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(Logger.errorWithRef).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    // buildEmbed() returns EmbedBuilder instances, so the description lives
    // under `.data` — reading `.description` here would silently pass on
    // `undefined` for a response that never carried the reference id.
    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: Array<{ data?: { description?: string } }>;
    };
    expect(payload.embeds[0]?.data?.description).toContain('ref123');
  });

  it('names the source when a slash command raises a Last.fm outage', async () => {
    // The component catch 150 lines above already did this. The slash catch did
    // not, so the SAME outage produced "Could not reach Last.fm" for a button
    // press and "Sorry, something went wrong while executing that command"
    // for a slash command - and the second tells the user to retry something
    // that cannot succeed while Last.fm is down.
    const { handler } = build();
    stubCommand(new LastFmUnavailableError('lastFmRepository.getTopArtists', new Error('HTTP 503')));
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: Array<{ data?: { description?: string } }>;
    };
    const description = payload.embeds[0]?.data?.description ?? '';
    expect(description).toContain('Could not reach Last.fm');
    expect(description).toMatch(/try again in a moment/i);
    expect(description).not.toMatch(/something went wrong/i);
    expect(description).toContain('ref123');
  });

  it('names the database when a slash command raises our own Postgres', async () => {
    const { handler } = build();
    stubCommand(
      new SourceUnavailableError('playRepository.getUserPlays', new Error('ECONNREFUSED'), 'Database unavailable'),
    );
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: Array<{ data?: { description?: string } }>;
    };
    const description = payload.embeds[0]?.data?.description ?? '';
    expect(description).toContain('Could not reach the database');
    expect(description).not.toMatch(/something went wrong/i);
  });

  it('still reports a genuine defect with the generic text', async () => {
    // The other half of the pair. "Could not reach the database, try again" on
    // a TypeError is a worse lie than the generic sentence: it tells the user
    // their retry is futile and hides the defect behind a source name.
    const { handler } = build();
    stubCommand(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: Array<{ data?: { description?: string } }>;
    };
    const description = payload.embeds[0]?.data?.description ?? '';
    expect(description).toMatch(/something went wrong while executing that command/i);
    expect(description).not.toMatch(/could not reach/i);
  });

  it('passes the resolved context to the command, not the raw interaction', async () => {
    const { handler } = build();
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    const context = executeAsync.mock.calls[0]?.[0] as { discordUserId: string; guildId?: string };
    expect(context.discordUserId).toBe('u1');
    expect(context.guildId).toBe('g1');
    expect(context).not.toBe(interaction);
  });

  it('tracks guild activity after a successful command', async () => {
    const { handler, deps } = build();
    deps.userService.getUserByDiscordId.mockResolvedValue({ userId: 'internal-1' });
    stubCommand(new ResponseModel());

    await dispatch(handler, makeSlash('wiki'));

    expect(deps.guildService.ensureGuildExists).toHaveBeenCalledTimes(1);
    expect(deps.guildUserService.ensureUserInGuild).toHaveBeenCalledWith('g1', 'internal-1');
    expect(deps.guildService.trackLastCommand).toHaveBeenCalledWith('g1');
  });

  it('skips the membership row when the user is not indexed', async () => {
    const { handler, deps } = build();
    deps.userService.getUserByDiscordId.mockResolvedValue(null);
    stubCommand(new ResponseModel());

    await dispatch(handler, makeSlash('wiki'));

    expect(deps.guildUserService.ensureUserInGuild).not.toHaveBeenCalled();
    expect(deps.guildService.trackLastCommand).toHaveBeenCalledWith('g1');
  });

  it('skips activity tracking entirely in a DM', async () => {
    const { handler, deps } = build();
    stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');
    interaction.guildId = null;
    interaction.guild = null;

    await dispatch(handler, interaction);

    expect(deps.guildService.ensureGuildExists).not.toHaveBeenCalled();
    expect(deps.guildUserService.ensureUserInGuild).not.toHaveBeenCalled();
    expect(deps.guildService.trackLastCommand).not.toHaveBeenCalled();
  });

  it('still returns the response when activity tracking throws', async () => {
    // Tracked with `void`, so it can reject after the fact. It must not turn a
    // successful command into an unhandled rejection.
    const { handler, deps } = build();
    deps.guildService.ensureGuildExists.mockRejectedValue(new Error('db down'));
    const executeAsync = stubCommand(new ResponseModel());
    const interaction = makeSlash('wiki');

    await dispatch(handler, interaction);

    expect(executeAsync).toHaveBeenCalledTimes(1);
    expect(Logger.warn).toHaveBeenCalled();
  });
});

describe('InteractionHandler autocomplete', () => {
  const makeAutocomplete = (): Interaction => {
    const interaction = baseInteraction();
    interaction.isAutocomplete = () => true;
    return interaction;
  };

  it('delegates to the responder for the focused option', async () => {
    const { handler } = build();
    const responder = vi.fn(async () => undefined);
    vi.mocked(getAutoCompleteResponder).mockReturnValue(responder);
    const interaction = makeAutocomplete();

    await dispatch(handler, interaction);

    expect(vi.mocked(getAutoCompleteResponder)).toHaveBeenCalledWith('artist');
    expect(responder).toHaveBeenCalledWith(interaction);
    expect(interaction.respond).not.toHaveBeenCalled();
  });

  it('responds with an empty choice list when no responder exists', async () => {
    const { handler } = build();
    vi.mocked(getAutoCompleteResponder).mockReturnValue(undefined);
    const interaction = makeAutocomplete();

    await dispatch(handler, interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('never lets a failing responder escape', async () => {
    const { handler } = build();
    vi.mocked(getAutoCompleteResponder).mockReturnValue(
      vi.fn(async () => {
        throw new Error('autocomplete exploded');
      }),
    );
    const interaction = makeAutocomplete();

    await expect(dispatch(handler, interaction)).resolves.toBeUndefined();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe('InteractionHandler unhandled component failure', () => {
  it('replies ephemerally when a routed handler throws and nothing was acked', async () => {
    const { handler, deps } = build();
    deps.helpInteractions.handleButton.mockRejectedValue(new Error('handler blew up'));
    const interaction = makeButton('help:home');

    await dispatch(handler, interaction);

    expect(Logger.error).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Sorry, something went wrong while processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not double-reply when the interaction was already acknowledged', async () => {
    const { handler, deps } = build();
    deps.helpInteractions.handleButton.mockRejectedValue(new Error('handler blew up'));
    const interaction = makeButton('help:home');
    interaction.state.deferred = true;

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('never lets a handler rejection escape the gateway listener', async () => {
    const { handler, deps } = build();
    deps.helpInteractions.handleButton.mockRejectedValue(new Error('handler blew up'));
    const interaction = makeButton('help:home');
    interaction.isRepliable = () => false;

    await expect(dispatch(handler, interaction)).resolves.toBeUndefined();
  });
});

/**
 * The outer catch is the boundary that makes re-throwing worth anything.
 *
 * The interaction modules fixed in the last round (`topInteractions`,
 * `artistInteractions`, `playcountInteractions`) now re-throw a deliberate
 * source failure instead of degrading to a dead button - and this boundary is
 * the only thing that turns that throw into something the presser sees.
 *
 * It used to gate on `!interaction.deferred` as well as `!interaction.replied`,
 * which is precisely backwards: every paginator and nav button calls
 * `deferUpdate()` BEFORE it reads anything, precisely so a slow source does not
 * blow the 3s acknowledgement window. So the interaction that most needed a
 * reply was the one that got silence, and the re-throw bought a Railway log
 * line and nothing else. `followUp` is the correct verb once deferred.
 */
describe('InteractionHandler unhandled-failure boundary', () => {
  const lastFmDown = () => new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500'));
  const databaseDown = () => new SourceUnavailableError('genreService.getGenres', new Error('ECONNREFUSED'), 'Database unavailable');

  /** A button that has already deferred - the paginator case, exactly. */
  const deferredButton = (dep: 'helpInteractions' | 'playcountInteractions', err: Error) => {
    const { handler, deps } = build();
    if (dep === 'helpInteractions') {
      deps.helpInteractions.handleButton.mockRejectedValue(err);
    } else {
      deps.playcountInteractions.handleButton.mockRejectedValue(err);
    }
    const interaction = makeButton(dep === 'helpInteractions' ? 'help:home' : 'milestone:reroll:x');
    interaction.state.deferred = true;
    return { handler, interaction };
  };

  const followUpContent = (interaction: ReturnType<typeof makeButton>): string => {
    const payload = interaction.followUp.mock.calls[0]?.[0] as { content: string } | undefined;
    return payload?.content ?? '';
  };

  it('answers a DEFERRED button with an ephemeral followUp, not silence', async () => {
    // The load-bearing assertion. `expect(followUp).toHaveBeenCalled()` is what
    // fails against the old `!interaction.deferred` gate, and it fails for the
    // right reason: the handler re-threw correctly in both versions.
    const { handler, interaction } = deferredButton('helpInteractions', lastFmDown());

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(followUpContent(interaction)).toMatch(/Last\.fm/);
  });

  it('names the database rather than Last.fm when that is what failed', async () => {
    // Sending the operator to the wrong status page is its own kind of lie.
    const { handler, interaction } = deferredButton('playcountInteractions', databaseDown());

    await dispatch(handler, interaction);

    expect(followUpContent(interaction)).toContain('the database');
    expect(followUpContent(interaction)).not.toMatch(/Last\.fm/);
  });

  it('still describes a genuine defect as a defect', async () => {
    // Reporting a TypeError as "Last.fm is unreachable, try again" tells the
    // user to retry a request that can never succeed, and hides the bug.
    const { handler, interaction } = deferredButton('helpInteractions', new TypeError('x is not a function'));

    await dispatch(handler, interaction);

    const content = followUpContent(interaction);
    expect(content).toMatch(/went wrong/i);
    expect(content).not.toMatch(/Last\.fm|database/);
  });

  it('uses reply, not followUp, when the interaction was never deferred', async () => {
    // Proves the change is not a blanket switch of verb.
    const { handler, deps } = build();
    deps.helpInteractions.handleButton.mockRejectedValue(lastFmDown());
    const interaction = makeButton('help:home');

    await dispatch(handler, interaction);

    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('says nothing at all when the interaction was already replied to', async () => {
    // A second reply throws at Discord and would mask the original failure.
    const { handler, deps } = build();
    deps.helpInteractions.handleButton.mockRejectedValue(lastFmDown());
    const interaction = makeButton('help:home');
    interaction.state.replied = true;

    await dispatch(handler, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('never throws out of the boundary when the follow-up itself fails', async () => {
    const { handler, interaction } = deferredButton('helpInteractions', lastFmDown());
    interaction.followUp.mockRejectedValue(new Error('Unknown Message'));

    await expect(dispatch(handler, interaction)).resolves.toBeUndefined();
  });
});


