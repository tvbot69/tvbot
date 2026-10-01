/**
 * `CommandHandler` — everything on the text-command path AFTER the prefix lookup.
 *
 * `commandHandler.prefixOutage.test.ts` already owns the prefix read and the
 * unknown-command reply. This file owns the rest of `handleMessage`, which is the
 * code that runs for EVERY message in EVERY channel of a busy guild and is
 * therefore where the cheap rejections live.
 *
 * The ordering is the whole design and is asserted here as behaviour rather than
 * as a call trace:
 *
 *   bot / webhook     -> return            (never even asks the prefix service)
 *   empty body        -> return            (Message Content intent off)
 *   not command-shaped-> game branch, then return
 *   bare prefix       -> return            (a `.` on its own is not a command)
 *   unknown name      -> one brief reply, and only for a plausible name
 *   rate limited      -> one brief reply, and only if the limiter has not said
 *   blocked           -> reply with the reason, and do NOT run the command
 *   otherwise         -> dispatch
 *
 * Every early return is asserted on what did NOT happen, because "the command did
 * not run" is the claim; a spy that fired once on an early path is the bug.
 *
 * `CommandDispatcher` is never spied on. It is a static-heavy class whose two
 * public entry points are the whole delivery path, and `vi.spyOn` on a static
 * leaves an own property behind for every later test in the file. The real
 * dispatcher runs against plain-object channel doubles instead, which means
 * `dispatchResponse` and `handleCommandException` are exercised rather than
 * replaced.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '@bot/handlers/commandHandler';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { Message } from 'discord.js';
import type { Client } from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import type { PrefixService } from '@bot/services/user/prefixService';
import type { GuildService } from '@bot/services/guild/guildService';
import type { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import type { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import type { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import type { UserService } from '@bot/services/user/userService';
import type { GuildUserService } from '@bot/services/guild/guildUserService';
import type { ColorService } from '@bot/services/system/colorService';
import type { GameService, JumbleSession } from '@bot/services/guild/gameService';
import type { RateLimitService } from '@bot/services/system/rateLimitService';
import type { TextCommandDefinition } from '@bot/models/commandModels';

/**
 * The registry is stubbed, and not as a convenience: `@bot/textCommands` lazily
 * builds hundreds of modules and is empty until startup populates it. The stub
 * makes every name in this file either deliberately known or deliberately
 * unknown, so the unknown-command branch cannot wander into a test that is about
 * something else.
 *
 * `vi.hoisted` because the factory runs during the import graph, before a plain
 * `const` above it would exist yet.
 */
const { registry } = vi.hoisted(() => ({ registry: new Map<string, TextCommandDefinition>() }));
vi.mock('@bot/textCommands', () => ({ getTextCommand: (name: string) => registry.get(name) }));

const KNOWN = 'knowncmd';

type Command = TextCommandDefinition['executeAsync'];

const textResponse = (): ResponseModel => {
  const response = new ResponseModel();
  response.setContent('here is your card');
  return response;
};

const deletedResponse = (): ResponseModel => {
  const response = new ResponseModel();
  response.commandResponse = CommandResponse.Deleted;
  return response;
};

const session = (over: Partial<JumbleSession> = {}): JumbleSession => ({
  sessionId: 's-1',
  channelId: 'c-1',
  starterUserId: 'u-1',
  starterDiscordId: 'u-1',
  type: 'artist',
  correctAnswer: 'Radiohead',
  displayTarget: 'R*********',
  artistName: 'Radiohead',
  dateStarted: new Date('2026-09-20T10:00:00Z'),
  hints: [],
  hintsShown: 0,
  blurLevel: 2,
  reshuffles: 0,
  ended: false,
  ...over,
});

interface Over {
  content?: string;
  authorBot?: boolean;
  webhookId?: string;
  guildId?: string | null;
  channelWithoutTyping?: boolean;
  /** Overrides the registered command's implementation. */
  command?: Command;
  rateLimit?: { rateLimited: boolean; messageSent?: boolean; retryAfterSeconds?: number };
  guildDisabled?: boolean;
  channelDisabled?: boolean;
  commandDisabled?: boolean;
  commandToggled?: boolean;
  getGuildThrows?: boolean;
  guildRowMissing?: boolean;
  userIsLinked?: boolean;
  activeGame?: JumbleSession | null;
  checkAnswer?: { isCorrect: boolean; session?: JumbleSession; timeSeconds?: number };
  giveUp?: JumbleSession | undefined;
}

/** A distinct message id per test: the dispatcher's edit-in-place map is module-level. */
let messageSeq = 0;

const build = (over: Over = {}) => {
  messageSeq += 1;
  const listeners: Array<(m: unknown) => void> = [];
  const client = {
    user: { id: 'bot-1' },
    on: (_event: string, cb: (m: unknown) => void) => {
      listeners.push(cb);
    },
  } as unknown as Client;

  const send = vi.fn(async (..._args: unknown[]) => ({ id: `sent-${messageSeq}` }));
  const sendTyping = vi.fn(async (..._args: unknown[]) => undefined);
  const channel = over.channelWithoutTyping
    ? { send, isTextBased: () => true, name: 'general' }
    : { send, isTextBased: () => true, sendTyping, name: 'general' };
  const reply = vi.fn(async (..._args: unknown[]) => ({ id: `replied-${messageSeq}` }));
  const react = vi.fn(async (..._args: unknown[]) => undefined);
  const message = {
    id: `message-${messageSeq}`,
    content: over.content ?? `.${KNOWN}`,
    guildId: over.guildId === undefined ? 'g-1' : over.guildId,
    webhookId: over.webhookId,
    author: { bot: over.authorBot ?? false, id: 'u-1', tag: 'u-1#0001', username: 'u-1' },
    member: { displayName: 'Someone' },
    channel,
    guild: { name: 'Music Club', shardId: 0 },
    reply,
    react,
  } as unknown as Message;

  const getPrefix = vi.fn(async (..._args: unknown[]) => '.');
  const getGuild = vi.fn(async (..._args: unknown[]) => {
    if (over.getGuildThrows) throw new Error('redis down');
    if (over.guildRowMissing) return null;
    return { commandsDisabled: over.guildDisabled ?? false };
  });
  const isChannelDisabled = vi.fn(async (..._args: unknown[]) => over.channelDisabled ?? false);
  const isCommandDisabled = vi.fn(async (..._args: unknown[]) => over.commandDisabled ?? false);
  const isCommandToggled = vi.fn(async (..._args: unknown[]) => over.commandToggled ?? false);
  const getUserByDiscordId = vi.fn(async (..._args: unknown[]) =>
    over.userIsLinked ? { userId: 42, userNameLastFm: 'listener' } : null,
  );
  const ensureUserInGuild = vi.fn(async (..._args: unknown[]) => undefined);
  const ensureGuildExists = vi.fn(async (..._args: unknown[]) => undefined);
  const trackLastCommand = vi.fn(async (..._args: unknown[]) => undefined);
  const getAccentColorAsync = vi.fn(async (..._args: unknown[]) => undefined);
  const getActiveGame = vi.fn(() => over.activeGame ?? undefined);
  const checkAnswer = vi.fn(() => over.checkAnswer ?? { isCorrect: false });
  const giveUp = vi.fn(() => over.giveUp);
  const getUserStats = vi.fn(() => ({ totalPlayed: 1, totalWon: 1, streak: 1, bestStreak: 1, avgTimeSeconds: 3 }));
  const checkUserRateLimitAsync = vi.fn(async (..._args: unknown[]) =>
    over.rateLimit ?? { rateLimited: false, messageSent: false },
  );

  new CommandHandler(
    client,
    { getPrefix } as unknown as PrefixService,
    { getGuild, ensureGuildExists, trackLastCommand } as unknown as GuildService,
    { isChannelDisabled } as unknown as DisabledChannelService,
    { isCommandDisabled } as unknown as GuildDisabledCommandService,
    { isCommandToggled } as unknown as ChannelToggledCommandService,
    { getUserByDiscordId } as unknown as UserService,
    { ensureUserInGuild } as unknown as GuildUserService,
    { getAccentColorAsync } as unknown as ColorService,
    { getActiveGame, checkAnswer, giveUp, getUserStats } as unknown as GameService,
    { checkUserRateLimitAsync } as unknown as RateLimitService,
  );

  registry.clear();
  const impl: Command = over.command ?? (async () => textResponse());
  const executeAsync = vi.fn(impl);
  registry.set(KNOWN, { name: KNOWN, executeAsync } as unknown as TextCommandDefinition);

  const fire = async () => {
    listeners[0]?.(message);
    // The registered callback is `void handleMessage(...).catch(...)`, so nothing
    // is returned and every send lands on a later tick.
    await new Promise(resolve => setTimeout(resolve, 15));
  };

  return {
    message,
    fire,
    send,
    sendTyping,
    reply,
    react,
    executeAsync,
    getPrefix,
    getGuild,
    isChannelDisabled,
    isCommandDisabled,
    isCommandToggled,
    checkUserRateLimitAsync,
    getActiveGame,
    checkAnswer,
    giveUp,
    getUserByDiscordId,
    ensureUserInGuild,
    ensureGuildExists,
    trackLastCommand,
  };
};

/** The description of the single embed that was sent. */
const embedText = (call: unknown): string =>
  (call as { embeds?: Array<{ toJSON: () => { description?: string } }> }).embeds?.[0]?.toJSON().description ?? '';

const sentContent = (call: unknown): string => (call as { content?: string }).content ?? '';

describe('CommandHandler: the cheap rejects', () => {
  it('never reads the prefix for a bot message', async () => {
    // The handler runs for every message in every channel. A bot's own messages
    // are the most common message in a busy guild and must cost nothing.
    const { fire, send, getPrefix, executeAsync } = build({ authorBot: true });
    await fire();
    expect(getPrefix).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
  });

  it('never reads the prefix for a webhook message', async () => {
    const { fire, send, getPrefix, executeAsync } = build({ webhookId: 'w-1' });
    await fire();
    expect(getPrefix).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
  });

  it('never reads the prefix for an empty body, which is what the bot sees without Message Content', async () => {
    const { fire, send, getPrefix, executeAsync } = build({ content: '' });
    await fire();
    expect(getPrefix).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
  });

  it('never reads the prefix for ordinary chat that is not command-shaped', async () => {
    const { fire, send, getPrefix, executeAsync, checkAnswer } = build({ content: 'hello everyone' });
    await fire();
    expect(getPrefix).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(checkAnswer).not.toHaveBeenCalled();
  });

  it('treats a bare prefix as no command at all', async () => {
    const { fire, send, executeAsync } = build({ content: '.' });
    await fire();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
  });

  it('treats whitespace after the prefix as no command at all', async () => {
    const { fire, send, executeAsync } = build({ content: '.    ' });
    await fire();
    expect(send).not.toHaveBeenCalled();
    expect(executeAsync).not.toHaveBeenCalled();
  });
});

describe('CommandHandler: prefix alternatives', () => {
  it('accepts the alternative "+" prefix that /help advertises', async () => {
    const { fire, executeAsync } = build({ content: `+${KNOWN}` });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('accepts a plain mention of the bot as the prefix', async () => {
    const { fire, executeAsync } = build({ content: `<@bot-1> ${KNOWN}` });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('accepts the legacy "<@!id>" mention form', async () => {
    const { fire, executeAsync } = build({ content: `<@!bot-1> ${KNOWN}` });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('passes the matched prefix and the split arguments to the command', async () => {
    const { fire, executeAsync } = build({ content: `+${KNOWN} Radiohead 25` });
    await fire();
    const call = executeAsync.mock.calls[0];
    expect((call?.[0] as ContextModel | undefined)?.prefix).toBe('+');
    expect(call?.[1]).toEqual(['Radiohead', '25']);
  });

  it('hands the command the resolved context, not the raw message', async () => {
    const { fire, executeAsync, message } = build({ content: `.${KNOWN}` });
    await fire();
    const context = executeAsync.mock.calls[0]?.[0] as ContextModel | undefined;
    expect(context?.message).toBe(message);
    expect(context?.discordUserId).toBe('u-1');
    expect(context?.guildId).toBe('g-1');
  });

  it('lower-cases the command name before looking it up', async () => {
    const { fire, executeAsync } = build({ content: `.${KNOWN.toUpperCase()}` });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('CommandHandler: the unknown-command reply', () => {
  it('says nothing at all for a one-character name, which is chat that started with a prefix', async () => {
    const { fire, send } = build({ content: '.x' });
    await fire();
    expect(send).not.toHaveBeenCalled();
  });

  it('says nothing for a name containing something that is not a command character', async () => {
    const { fire, send } = build({ content: '.not-a-command!' });
    await fire();
    expect(send).not.toHaveBeenCalled();
  });

  it('replies exactly once for a plausible mistyped command', async () => {
    const { fire, send } = build({ content: '.zzznope' });
    await fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(embedText(send.mock.calls[0]?.[0])).toContain('Unknown command `.zzznope`');
  });

  it('points at the prefix the user actually typed, not the configured one', async () => {
    // The prefix-outage sibling file exists because the old code answered about
    // `.` when the guild had been configured for `!`. A user who typed `+` must
    // be told about `+help`.
    const { fire, send } = build({ content: '+zzznope' });
    await fire();
    const text = embedText(send.mock.calls[0]?.[0]);
    expect(text).toContain('Unknown command `+zzznope`');
    expect(text).toContain('`+help`');
  });
});

describe('CommandHandler: the rate limit gate', () => {
  it('runs nothing and warns once when the user is over the limit', async () => {
    const { fire, send, executeAsync } = build({
      rateLimit: { rateLimited: true, messageSent: false, retryAfterSeconds: 12 },
    });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(embedText(send.mock.calls[0]?.[0])).toContain('12s cooldown');
  });

  it('stays silent when the limiter already told the user itself', async () => {
    // The Redis-backed limiter can warn on its own. A second warning is noise.
    const { fire, send, executeAsync } = build({ rateLimit: { rateLimited: true, messageSent: true } });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('names an eight second cooldown when the limiter did not say', async () => {
    const { fire, send } = build({ rateLimit: { rateLimited: true, messageSent: false } });
    await fire();
    expect(embedText(send.mock.calls[0]?.[0])).toContain('8s cooldown');
  });

  it('gates on the user id, not on the message', async () => {
    const { fire, checkUserRateLimitAsync } = build();
    await fire();
    expect(checkUserRateLimitAsync).toHaveBeenCalledWith('u-1');
  });
});

describe('CommandHandler: the block gate', () => {
  it('runs nothing and answers the user when the whole server is disabled', async () => {
    const { fire, reply, executeAsync } = build({ guildDisabled: true });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('Commands are currently disabled in this server.');
  });

  it('names the channel when the channel is the thing that is disabled', async () => {
    const { fire, reply, executeAsync } = build({ channelDisabled: true });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('Bot commands are disabled in this channel.');
  });

  it('names the staff when a single command is disabled', async () => {
    const { fire, reply, executeAsync } = build({ commandDisabled: true });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('This command has been disabled in this server by the staff.');
  });

  it('says "toggled off" for a channel-level toggle', async () => {
    const { fire, reply, executeAsync } = build({ commandToggled: true });
    await fire();
    expect(executeAsync).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('This command is toggled off in this channel.');
  });

  it('consults no gate in a DM, where there is nothing to configure', async () => {
    const { fire, getGuild, isChannelDisabled, isCommandDisabled, isCommandToggled, executeAsync } = build({
      guildId: null,
    });
    await fire();
    expect(getGuild).not.toHaveBeenCalled();
    expect(isChannelDisabled).not.toHaveBeenCalled();
    expect(isCommandDisabled).not.toHaveBeenCalled();
    expect(isCommandToggled).not.toHaveBeenCalled();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPENS when a gate read throws, so a cache outage cannot disable the bot', async () => {
    // Failing closed here would take every guild's bot offline because one Redis
    // read raised. The command runs and the operator still gets a WARN.
    const { fire, reply, executeAsync } = build({ getGuildThrows: true });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('FAIL-OPENS when the guild row is simply missing', async () => {
    const { fire, executeAsync } = build({ guildRowMissing: true });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('CommandHandler: the happy path', () => {
  it('dispatches the command response to the channel exactly once', async () => {
    const { fire, send, executeAsync } = build();
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentContent(send.mock.calls[0]?.[0])).toBe('here is your card');
  });

  it('sends nothing at all for a deleted response', async () => {
    const { fire, send, executeAsync } = build({ command: async () => deletedResponse() });
    await fire();
    expect(executeAsync).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the typing indicator once before the command runs', async () => {
    const { fire, sendTyping } = build();
    await fire();
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it('still answers when the channel cannot show a typing indicator at all', async () => {
    // The typing indicator is pure decoration; a missing permission must not
    // abort the command.
    const { fire, send, sendTyping } = build({ channelWithoutTyping: true });
    await fire();
    expect(sendTyping).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records the guild as active after a successful command', async () => {
    const { fire, trackLastCommand, ensureGuildExists } = build();
    await fire();
    expect(ensureGuildExists).toHaveBeenCalledTimes(1);
    expect(trackLastCommand).toHaveBeenCalledWith('g-1');
  });

  it('writes the membership row for a linked user, and only for a linked user', async () => {
    const linked = build({ userIsLinked: true });
    await linked.fire();
    expect(linked.getUserByDiscordId).toHaveBeenCalledWith('u-1');
    expect(linked.ensureUserInGuild).toHaveBeenCalledWith('g-1', 42);

    const stranger = build();
    await stranger.fire();
    expect(stranger.ensureUserInGuild).not.toHaveBeenCalled();
  });

  it('does no bookkeeping at all in a DM, where there is no guild row to keep', async () => {
    const { fire, ensureGuildExists, trackLastCommand } = build({ guildId: null });
    await fire();
    expect(ensureGuildExists).not.toHaveBeenCalled();
    expect(trackLastCommand).not.toHaveBeenCalled();
  });

  it('still answers when the bookkeeping itself throws', async () => {
    // Activity tracking is deliberately outside the command's try block: a user
    // must never see an error for a side effect they did not ask for.
    const { fire, send, getUserByDiscordId } = build();
    (getUserByDiscordId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection terminated'));
    await fire();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('CommandHandler: the failure boundary', () => {
  it('sends one apology embed with a reference id, and never the raw error', async () => {
    const { fire, send } = build({
      command: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'name')");
      },
    });
    await fire();
    expect(send).toHaveBeenCalledTimes(1);
    const text = embedText(send.mock.calls[0]?.[0]);
    expect(text).toContain('Sorry, something went wrong while executing that command.');
    expect(text).toContain('Reference ID');
    expect(text).not.toContain('Cannot read properties');
  });

  it('names Last.fm when the command raised a Last.fm outage', async () => {
    const { fire, send } = build({
      command: async () => {
        throw new LastFmUnavailableError('lastFmRepository.getRecentTracks:1', new Error('timeout'));
      },
    });
    await fire();
    expect(embedText(send.mock.calls[0]?.[0])).toContain('Could not reach Last.fm');
  });

  it('names the database when the command raised our own Postgres', async () => {
    const { fire, send } = build({
      command: async () => {
        throw new SourceUnavailableError('userRepository.getUserById:1', new Error('terminated'), 'Database unavailable');
      },
    });
    await fire();
    expect(embedText(send.mock.calls[0]?.[0])).toContain('Could not reach the database');
  });
});

describe('CommandHandler: the active-game branch', () => {
  it('answers a correct guess with a reaction and a won card', async () => {
    const { fire, react, send, executeAsync } = build({
      content: 'Radiohead',
      activeGame: session(),
      checkAnswer: { isCorrect: true, session: session(), timeSeconds: 7 },
    });
    await fire();
    expect(react).toHaveBeenCalledWith('✅');
    expect(send).toHaveBeenCalledTimes(1);
    // Chat is not a command, so nothing was routed as one.
    expect(executeAsync).not.toHaveBeenCalled();
  });

  it('says nothing for a wrong guess, so the channel cannot be used to probe for the answer', async () => {
    const { fire, send, react } = build({
      content: 'Definitely Not The Artist',
      activeGame: session(),
      checkAnswer: { isCorrect: false },
    });
    await fire();
    expect(send).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it('answers a give-up with a card and returns, without checking the answer', async () => {
    const { fire, send, checkAnswer } = build({
      content: 'give up',
      activeGame: session(),
      giveUp: session({ ended: true }),
    });
    await fire();
    expect(send).toHaveBeenCalledTimes(1);
    expect(checkAnswer).not.toHaveBeenCalled();
  });

  it('accepts "quit" and "giveup", and is case-insensitive, because those are what users type', async () => {
    for (const content of ['quit', 'GIVEUP', '  Give Up  ']) {
      const { fire, send, checkAnswer } = build({
        content,
        activeGame: session(),
        giveUp: session({ ended: true }),
      });
      await fire();
      expect(send).toHaveBeenCalledTimes(1);
      expect(checkAnswer).not.toHaveBeenCalled();
    }
  });

  it('falls through to the answer check when give-up returns nothing', async () => {
    // `giveUp` returns undefined for a session that was already ended; the user
    // still typed something, so it must not be silently swallowed.
    const { fire, checkAnswer } = build({ content: 'give up', activeGame: session(), giveUp: undefined });
    await fire();
    expect(checkAnswer).toHaveBeenCalledTimes(1);
  });

  it('ignores a give-up message in a DM, where no game can be running', async () => {
    const { fire, getActiveGame } = build({ content: 'give up', guildId: null, activeGame: session() });
    await fire();
    expect(getActiveGame).not.toHaveBeenCalled();
  });

  it('does not run the answer check for a finished game', async () => {
    const { fire, checkAnswer } = build({ content: 'Radiohead', activeGame: session({ ended: true }) });
    await fire();
    expect(checkAnswer).not.toHaveBeenCalled();
  });
});
