/**
 * The text-command boundary's answer when the PREFIX lookup is what failed.
 *
 * The whole point of `PrefixService.getPrefix` raising instead of returning `'.'`
 * is this line: a raised `SourceUnavailableError` has to reach a boundary that
 * can name the source, or the user gets nothing at all. Before the raise, the
 * handler never had to cope: the service had already answered `'.'` and the
 * user got "Unknown command `.foo`" - a confident wrong answer that named a
 * prefix they never typed, and which was indistinguishable in the log from a
 * typo.
 *
 * An uncaught throw from the prefix lookup would have been just as bad in the
 * other direction: it escapes to the `Logger.error` in the `CommandHandler`
 * constructor, so the user gets TOTAL SILENCE - and this very file's
 * neighbour in `commandHandler.ts` records that total silence is the worst
 * possible answer. So the catch has to exist, it has to be narrow, and it has
 * to name the source. Those are three separate things and the tests below take
 * them one at a time.
 *
 * Doubles are fresh plain objects per test. The container is NOT spied on:
 * `CommandDispatcher.handleCommandException` resolves `TelemetryService` inside
 * its own try/catch, so an unregistered container is simply the "not wired"
 * case, and `vi.spyOn(container, ...)` here would leave an own property behind
 * for every later test in the file.
 *
 * `reflect-metadata` first: `CommandHandler` is a `tsyringe` class.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CommandHandler } from '@bot/handlers/commandHandler';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { Client } from 'discord.js';
import type { PrefixService } from '@bot/services/prefixService';
import type { GuildService } from '@bot/services/guild/guildService';
import type { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import type { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import type { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import type { UserService } from '@bot/services/userService';
import type { GuildUserService } from '@bot/services/guild/guildUserService';
import type { ColorService } from '@bot/services/colorService';
import type { GameService } from '@bot/services/gameService';
import type { RateLimitService } from '@bot/services/rateLimitService';

/**
 * The command registry is stubbed out, and not as a convenience.
 *
 * `commandHandler.ts` imports `getTextCommand` from `@bot/textCommands`, which
 * lazily builds the entire text-command registry - hundreds of modules, and the
 * only lookup this file needs is "is this name known?". A real registry is also
 * empty until startup populates it, which is why the sibling
 * `commandDispatch.test.ts` has to comment that "the run logs an error here" and
 * assert only on the prefix. Stubbing it makes the two halves of this file
 * deterministic: every name is unknown, so the unknown-command branch is the
 * one under test in the PAIR and nothing else can wander in.
 */
vi.mock('@bot/textCommands', () => ({ getTextCommand: () => undefined }));

/** A name no registry holds. The unknown-command branch is then deterministic. */
const UNKNOWN_COMMAND = '.zzznope';

const dbDown = () =>
  new SourceUnavailableError(
    'prefixService.getPrefix:1445761601129943222',
    new Error('connection terminated unexpectedly'),
    'Database unavailable',
  );

/**
 * Constructor arity, read off `commandHandler.ts` and pinned by naming each
 * stub with its real type - with inline `as never` literals all eleven are
 * mutually assignable, so a positional swap compiles silently and every query
 * then fails inside the service's own catch. That has already been verified to
 * leave this repo's `commandDispatch.test.ts` green in this exact shape.
 */
const build = (getPrefix: () => Promise<string>) => {
  const listeners: Array<(m: unknown) => void> = [];
  const client = {
    user: { id: 'bot-1' },
    on: (_event: string, cb: (m: unknown) => void) => { listeners.push(cb); },
  } as unknown as Client;

  // The payload parameter is declared so `mock.calls[0]?.[0]` typechecks. A
// zero-arg mock infers a `[]` call tuple, and indexing it is a compile error
// vitest never reports.
const send = vi.fn(async (..._args: unknown[]) => ({ id: 'm1' }));
  const message = {
    content: UNKNOWN_COMMAND,
    guildId: '1445761601129943222',
    author: { bot: false, id: 'u1', tag: 'u1#0001', username: 'u1' },
    channel: { send, isTextBased: () => true, sendTyping: vi.fn(async () => undefined) },
    reply: vi.fn(async () => ({ id: 'm2' })),
  };

  const handler = new CommandHandler(
    client,
    { getPrefix: vi.fn(getPrefix) } as unknown as PrefixService,
    { getGuild: vi.fn(async () => null) } as unknown as GuildService,
    { isChannelDisabled: vi.fn(async () => false) } as unknown as DisabledChannelService,
    { isCommandDisabled: vi.fn(async () => false) } as unknown as GuildDisabledCommandService,
    { isCommandToggled: vi.fn(async () => false) } as unknown as ChannelToggledCommandService,
    { getUserByDiscordUserId: vi.fn(async () => null) } as unknown as UserService,
    { storeGuildUsers: vi.fn(async () => undefined) } as unknown as GuildUserService,
    { getAccentColorAsync: vi.fn(async () => undefined) } as unknown as ColorService,
    {
      getActiveGame: vi.fn(() => null),
      checkAnswer: vi.fn(() => ({ isCorrect: false })),
      giveUp: vi.fn(() => null),
      getUserStats: vi.fn(() => ({})),
    } as unknown as GameService,
    { checkUserRateLimitAsync: vi.fn(async () => ({ rateLimited: false, messageSent: false })) } as unknown as RateLimitService,
  );

  // The registered MessageCreate callback is `void handleMessage(...).catch(...)`,
  // so it returns nothing and the reply lands on a later tick. `fireNow` is
  // the same call WITHOUT the wait, for the case where nothing must be sent -
  // `fire` would sit in `vi.waitFor` waiting for a call that is the assertion.
  const fireNow = () => {
    listeners[0]?.(message);
    return new Promise((r) => setTimeout(r, 10));
  };
  const fire = async () => {
    listeners[0]?.(message);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
  };

  /**
   * The description of the single embed that was sent.
   *
   * `toJSON()`, not `.description`: the boundary sends `EmbedBuilder`
   * instances, and an `EmbedBuilder` has no own `description` property - reading
   * it yields `undefined` and every assertion below would compare against `''`.
   */
  const embedText = () => {
    const payload = send.mock.calls[0]?.[0] as
      | { embeds?: Array<{ toJSON: () => { description?: string } }> }
      | undefined;
    return payload?.embeds?.[0]?.toJSON().description ?? '';
  };

  return { handler, message, send, fire, fireNow, embedText };
};

describe('CommandHandler: the prefix lookup is the read that failed', () => {
  it('tells the user the database was unreachable, and does not blame their command', async () => {
    // The failure half. The old reply was "Unknown command `.zzznope`", which
    // is a statement about the USER'S input. This one is a statement about a
    // source that did not answer.
    const { send, fire, embedText } = build(async () => {
      throw dbDown();
    });

    await fire();

    const text = embedText();
    expect(text).toContain('Could not reach the database');
    expect(text).not.toContain('Unknown command');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch, rate limit or touch the game state on an unread prefix', async () => {
    // The prefix is the gate on EVERYTHING after it, so guessing one would run
    // a command the guild never addressed. Exactly one reply, and no further
    // work: the handler returns.
    const { send, fire, embedText } = build(async () => {
      throw dbDown();
    });

    await fire();

    expect(send).toHaveBeenCalledTimes(1);
    expect(embedText()).not.toContain('help');
  });

  it('still answers "Unknown command" for a command that genuinely does not exist', async () => {
    // The PAIR, and the load-bearing half of this file. With the prefix read
    // answering normally, the unknown-command branch must still fire - so the
    // first test cannot be passing because the branch was removed or the catch
    // hijacked everything.
    const { send, fire, embedText } = build(async () => '.');

    await fire();

    expect(embedText()).toContain('Unknown command');
    expect(embedText()).toContain(UNKNOWN_COMMAND);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not answer about the database for a non-source failure from the prefix read', async () => {
    // The narrowness. A plain `TypeError` from the lookup is a defect, not an
    // outage, and naming it "Could not reach the database" would send an
    // operator hunting a database that is fine. So only `isSourceUnavailable`
    // gets the outage reply; anything else rethrows to the constructor's
    // `Logger.error`, exactly as it did before. The ERROR line that reach
    // produces is left in the test output on purpose - it is the log the
    // operator would have been reading.
    const { send, fireNow } = build(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'prefix')");
    });

    await fireNow();

    expect(send).not.toHaveBeenCalled();
  });
});
