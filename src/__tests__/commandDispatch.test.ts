import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { CommandHandler } from '@bot/handlers/commandHandler';
import { PrefixService } from '@bot/services/prefixService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { ColorService } from '@bot/services/system/colorService';
import { GameService } from '@bot/services/gameService';
import { RateLimitService } from '@bot/services/system/rateLimitService';
import type { Client } from 'discord.js';
import type { GuildService } from '@bot/services/guild/guildService';
import type { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import type { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import type { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import type { UserService } from '@bot/services/userService';

/**
 * The text dispatcher runs for every message in every channel. These cover
 * the cheap reject (no async prefix lookup for ordinary chat) and the
 * alternative prefix /help advertises.
 */
const makeHandler = (opts: { guildPrefix?: string } = {}) => {
  const getPrefix = vi.fn(async () => opts.guildPrefix ?? '.');
  const executeAsync = vi.fn(async () => ({
    toMessagePayload: () => ({ content: 'ok' }),
    hasEmbed: () => false,
    buildComponents: () => [],
  }));
  vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
    if (token === PrefixService) return { getPrefix } as never;
    if (token === GuildUserService) return { storeGuildUsers: vi.fn(async () => undefined) } as never;
    if (token === ColorService) return { getAccentColorAsync: vi.fn(async () => undefined) } as never;
    if (token === GameService) return { getActiveGame: vi.fn(() => null), checkAnswer: vi.fn(() => ({ isCorrect: false })), giveUp: vi.fn(() => null), getUserStats: vi.fn(() => ({})) } as never;
    if (typeof token === 'function' && token.name === 'GuildService') {
      return { getGuild: vi.fn(async () => null) } as never;
    }
    if (typeof token === 'function' && token.name === 'DisabledChannelService') {
      return { isChannelDisabled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'GuildDisabledCommandService') {
      return { isCommandDisabled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'ChannelToggledCommandService') {
      return { isCommandToggled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'UserService') {
      return { getUserByDiscordUserId: vi.fn(async () => null) } as never;
    }
    if (token === RateLimitService) {
      return {
        checkUserRateLimitAsync: vi.fn(async () => ({ rateLimited: false, messageSent: false })),
      } as never;
    }
    return {} as never;
  });
  const handlers: Array<(m: unknown) => void> = [];
  const client = {
    user: { id: 'bot-1' },
    on: (_e: string, cb: (m: unknown) => void) => handlers.push(cb),
  };  // The handler resolves Client from the container, not from a constructor arg.
  vi.spyOn(container, 'resolve').mockImplementation((token: unknown) => {
    if ((token as { name?: string })?.name === 'Client') return client as never;
    if (token === PrefixService) return { getPrefix } as never;
    if (token === GuildUserService) return { storeGuildUsers: vi.fn(async () => undefined) } as never;
    if (token === ColorService) return { getAccentColorAsync: vi.fn(async () => undefined) } as never;
    if (token === GameService) return { getActiveGame: vi.fn(() => null), checkAnswer: vi.fn(() => ({ isCorrect: false })), giveUp: vi.fn(() => null), getUserStats: vi.fn(() => ({})) } as never;
    if (typeof token === 'function' && token.name === 'GuildService') {
      return { getGuild: vi.fn(async () => null) } as never;
    }
    if (typeof token === 'function' && token.name === 'DisabledChannelService') {
      return { isChannelDisabled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'GuildDisabledCommandService') {
      return { isCommandDisabled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'ChannelToggledCommandService') {
      return { isCommandToggled: vi.fn(async () => false) } as never;
    }
    if (typeof token === 'function' && token.name === 'UserService') {
      return { getUserByDiscordUserId: vi.fn(async () => null) } as never;
    }
    if (token === RateLimitService) {
      return {
        checkUserRateLimitAsync: vi.fn(async () => ({ rateLimited: false, messageSent: false })),
      } as never;
    }
    return {} as never;
  });
  // The 11 constructor dependencies are declared as TYPED variables rather than
  // inline `as never` literals, and that is load-bearing.
  //
  // With inline literals every argument is `never`, so all 11 are mutually
  // assignable and a positional swap compiles silently. Verified: swapping
  // getPrefix and getGuild left this file green. Naming each stub with its real
  // type makes a swap a COMPILE error, which is the only thing that actually
  // pins the order.
  const clientStub = client as unknown as Client;
  const prefixServiceStub = { getPrefix } as unknown as PrefixService;
  const guildServiceStub = { getGuild: vi.fn(async () => null) } as unknown as GuildService;
  const disabledChannelStub = { isChannelDisabled: vi.fn(async () => false) } as unknown as DisabledChannelService;
  const guildDisabledStub = { isCommandDisabled: vi.fn(async () => false) } as unknown as GuildDisabledCommandService;
  const channelToggledStub = { isCommandToggled: vi.fn(async () => false) } as unknown as ChannelToggledCommandService;
  const userServiceStub = { getUserByDiscordUserId: vi.fn(async () => null) } as unknown as UserService;
  const guildUserStub = { storeGuildUsers: vi.fn(async () => undefined) } as unknown as GuildUserService;
  const colorServiceStub = { getAccentColorAsync: vi.fn(async () => undefined) } as unknown as ColorService;
  const gameServiceStub = {
    getActiveGame: vi.fn(() => null),
    checkAnswer: vi.fn(() => ({ isCorrect: false })),
    giveUp: vi.fn(() => null),
    getUserStats: vi.fn(() => ({})),
  } as unknown as GameService;
  const rateLimitStub = {
    checkUserRateLimitAsync: vi.fn(async () => ({ rateLimited: false, messageSent: false })),
  } as unknown as RateLimitService;

  // The container mock above stays: the handler still resolves command classes
  // at dispatch time. This list is positional and must match the constructor.
  const handler = new CommandHandler(
    clientStub,
    prefixServiceStub,
    guildServiceStub,
    disabledChannelStub,
    guildDisabledStub,
    channelToggledStub,
    userServiceStub,
    guildUserStub,
    colorServiceStub,
    gameServiceStub,
    rateLimitStub,
  );
  return { handler, getPrefix, executeAsync, fire: (content: string) => handlers[0]?.({ content, author: { bot: false }, guildId: 'g1' }) };
};

describe('text command dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not do a prefix lookup for ordinary chat', async () => {
    const { getPrefix, fire } = makeHandler();
    fire('hey everyone how are we doing tonight');
    // Give any (incorrect) async work a chance to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(getPrefix).not.toHaveBeenCalled();
  });

  it('accepts the + alternative prefix that /help advertises', async () => {
    const { getPrefix, fire } = makeHandler({ guildPrefix: '.' });
    // Beyond this point the dispatcher looks the command up in the global
    // registry, which is only populated at startup — so the run logs an error
    // here. The assertion is about the PREFIX LOOKUP, which is the behaviour
    // under test: `+help` must be recognised as command-shaped.
    fire('+help');
    await new Promise((r) => setTimeout(r, 5));
    expect(getPrefix).toHaveBeenCalled();
  });
});
