import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { CommandHandler } from '@bot/handlers/commandHandler';
import { PrefixService } from '@bot/services/prefixService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { ColorService } from '@bot/services/colorService';
import { GameService } from '@bot/services/gameService';
import { RateLimitService } from '@bot/services/rateLimitService';

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
  const handler = new CommandHandler();
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
