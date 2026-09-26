import { container } from 'tsyringe';
import { Client, Events, MessageFlags, type Message } from 'discord.js';
import { Logger } from '@domain/logger';
import { Statistics } from '@domain/statistics';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ContextModel } from '@bot/models/contextModel';
import { PrefixService } from '@bot/services/prefixService';
import { GuildService } from '@bot/services/guild/guildService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { UserService } from '@bot/services/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { ColorService } from '@bot/services/colorService';
import { getTextCommand } from '@bot/textCommands';
import { GameService } from '@bot/services/gameService';
import { GameBuilders } from '@bot/builders/gameBuilders';

import { RateLimitService } from '@bot/services/rateLimitService';
import { CommandDispatcher } from './commandDispatcher';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { EmbedBuilder } from 'discord.js';

export class CommandHandler {
  private readonly client: Client;
  private readonly prefixService: PrefixService;
  private readonly guildService: GuildService;
  private readonly disabledChannelService: DisabledChannelService;
  private readonly guildDisabledCommands: GuildDisabledCommandService;
  private readonly channelToggledCommands: ChannelToggledCommandService;
  private readonly userService: UserService;
  private readonly guildUserService: GuildUserService;
  private readonly colorService: ColorService;
  private readonly gameService: GameService;
  private readonly rateLimitService: RateLimitService;

  constructor() {
    this.client = container.resolve(Client);
    this.prefixService = container.resolve(PrefixService);
    this.guildService = container.resolve(GuildService);
    this.disabledChannelService = container.resolve(DisabledChannelService);
    this.guildDisabledCommands = container.resolve(GuildDisabledCommandService);
    this.channelToggledCommands = container.resolve(ChannelToggledCommandService);
    this.userService = container.resolve(UserService);
    this.guildUserService = container.resolve(GuildUserService);
    this.colorService = container.resolve(ColorService);
    this.gameService = container.resolve(GameService);
    this.rateLimitService = container.resolve(RateLimitService);

    this.client.on(Events.MessageCreate, (message) => {
      // handleMessage has no top-level catch: any throw in prefix lookup or
      // the game branch rejected into an unhandledRejection, which the
      // process handler reports as a FATAL error (and pings the error feed)
      // for what is an ordinary, user-triggered bug.
      void this.handleMessage(message, false).catch((err) => {
        Logger.error(
          { err, guildId: message.guildId, author: message.author?.id },
          'Message handler failed',
        );
      });
    });
  }

  private async handleMessage(message: Message, isUpdate: boolean = false): Promise<void> {
    if (message.author.bot || message.webhookId) {
      return;
    }
    if (!message.content || message.content.length === 0) {
      Logger.debug({ guild: message.guild?.name, author: message.author.tag }, 'Received empty message content (check Message Content Intent in Discord Developer Portal)');
      return;
    }

    // Cheap reject first. The prefix lookup is an async cache/Redis/DB read,
    // and with MessageContent + GuildMessages intents this handler runs for
    // EVERY message in EVERY channel — so a busy guild paid a round trip per
    // message just to discover it was not a command. Non-command messages skip
    // the lookup and fall straight through to the active-game handling below.
    const content = message.content;
    const mentionsBot =
      (this.client.user && (content.startsWith(`<@${this.client.user.id}>`) || content.startsWith(`<@!${this.client.user.id}>`))) ||
      false;
    const looksLikeCommand = content.startsWith('.') || content.startsWith('+') || mentionsBot;

    let matchedPrefix: string | null = null;
    if (looksLikeCommand) {
      const prefix = await this.prefixService.getPrefix(message.guildId);
      const botMention1 = this.client.user ? `<@${this.client.user.id}>` : null;
      const botMention2 = this.client.user ? `<@!${this.client.user.id}>` : null;
      if (content.startsWith(prefix)) {
        matchedPrefix = prefix;
      } else if (content.startsWith('+')) {
        // Alternative prefix advertised by /help.
        matchedPrefix = '+';
      } else if (botMention1 && content.startsWith(botMention1)) {
        matchedPrefix = botMention1;
      } else if (botMention2 && content.startsWith(botMention2)) {
        matchedPrefix = botMention2;
      }
    }

    if (!matchedPrefix) {
      if (message.guildId && !isUpdate) {
        const active = this.gameService.getActiveGame(message.channelId);
        if (active && !active.ended) {
          const cleanText = message.content.trim().toLowerCase();
          if (cleanText === 'give up' || cleanText === 'giveup' || cleanText === 'quit') {
            const ended = this.gameService.giveUp(active.sessionId);
            if (ended) {
              const accentColor = await this.colorService.getAccentColorAsync(message.author.id)
                ?? (message.guildId ? await this.colorService.getAccentColorAsync(message.guildId) : undefined);
              const giveUpResp = GameBuilders.buildGameGiveUpResponse(ended, accentColor);
              if (giveUpResp.componentsV2Container && message.channel.isTextBased() && 'send' in message.channel) {
                await (message.channel as unknown as { send: (msg: Record<string, unknown>) => Promise<unknown> }).send({
                  components: [giveUpResp.componentsV2Container],
                  flags: MessageFlags.IsComponentsV2,
                  allowedMentions: { parse: [] },
                }).catch(() => undefined);
              }
              return;
            }
          }

          const authorName = message.member?.displayName ?? message.author.username;
          const result = this.gameService.checkAnswer(
            message.channelId,
            message.author.id,
            authorName,
            message.content,
          );
          if (result.isCorrect && result.session) {
            await message.react('✅').catch(() => undefined);
            const accentColor = await this.colorService.getAccentColorAsync(message.author.id)
              ?? (message.guildId ? await this.colorService.getAccentColorAsync(message.guildId) : undefined);
            const stats = this.gameService.getUserStats(message.author.id);
            const wonResp = GameBuilders.buildGameWonResponse(
              result.session,
              result.timeSeconds ?? 0,
              stats,
              accentColor,
            );
            if (wonResp.componentsV2Container && message.channel.isTextBased() && 'send' in message.channel) {
              await (message.channel as unknown as { send: (msg: Record<string, unknown>) => Promise<unknown> }).send({
                components: [wonResp.componentsV2Container],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
              }).catch(() => undefined);
            }
          }
        }
      }
      return;
    }

    const rawArguments = content.slice(matchedPrefix.length).trim();
    if (!rawArguments) {
      return;
    }

    const split = rawArguments.split(/\s+/);
    const commandName = (split.shift() ?? '').toLowerCase();
    const prefix = matchedPrefix;

    const command = getTextCommand(commandName);
    if (!command) {
      // Total silence is the worst possible answer: a guest who mistypes, or
      // follows a command name the bot itself used to advertise, gets no
      // signal at all and concludes the bot is broken. Answer briefly, and
      // only for real command-shaped input (not chat that happens to start
      // with the prefix).
      if (commandName.length >= 2 && /^[a-z0-9_]+$/.test(commandName) && message.channel && 'send' in message.channel) {
        const embed = new EmbedBuilder()
          .setColor(DiscordConstants.ErrorColorRed)
          .setDescription(
            `Unknown command \`${prefix}${commandName}\`. Use \`${prefix}help\` to see what is available.`,
          );
        await (message.channel as unknown as { send: (m: Record<string, unknown>) => Promise<unknown> }).send({
          embeds: [embed],
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
      return;
    }

    // Two-tier Rate limit check (Redis-backed across processes when available)
    const rateLimit = await this.rateLimitService.checkUserRateLimitAsync(message.author.id);
    if (rateLimit.rateLimited) {
      if (!rateLimit.messageSent && message.channel && 'send' in message.channel) {
        const embed = new EmbedBuilder()
          .setColor(DiscordConstants.WarningColorOrange)
          .setDescription(`⏳ You are using commands too fast! Please slow down (${rateLimit.retryAfterSeconds ?? 8}s cooldown).`);
        await (message.channel as unknown as { send: (m: Record<string, unknown>) => Promise<unknown> }).send({
          embeds: [embed],
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
      return;
    }

    Statistics.inc('TextCommandExecuted');

    const blocked = await this.isBlockedInContext(
      message.guildId,
      message.channelId,
      commandName,
    );
    if (blocked) {
      await message.reply(blocked).catch(() => undefined);
      return;
    }

    void this.trackActivity(message);

    const context = ContextModel.fromMessage(message, prefix, split);

    const typingInterval = message.channel.isTextBased() && 'sendTyping' in message.channel
      ? setInterval(() => {
          (message.channel as unknown as { sendTyping: () => Promise<void> })
            .sendTyping()
            .catch(() => undefined);
        }, 8000)
      : null;

    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await (message.channel as unknown as { sendTyping: () => Promise<void> })
        .sendTyping()
        .catch(() => undefined);
    }

    const startTime = Date.now();
    try {
      const response = await command.executeAsync(context, split);
      await CommandDispatcher.dispatchResponse(
        message,
        response,
        startTime,
        commandName,
        split,
        this.userService
      );
    } catch (err) {
      await CommandDispatcher.handleCommandException(err, message, commandName);
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  }

  public async isBlockedInContext(
    guildId: string | null,
    channelId: string | null,
    commandName: string,
  ): Promise<string | null> {
    if (!guildId) {
      return null;
    }

    try {
      const guild = await this.guildService.getGuild(guildId);
      if (guild?.commandsDisabled) {
        return 'Commands are currently disabled in this server.';
      }

      if (await this.disabledChannelService.isChannelDisabled(channelId)) {
        return 'Bot commands are disabled in this channel.';
      }

      if (await this.guildDisabledCommands.isCommandDisabled(guildId, commandName)) {
        return 'This command has been disabled in this server by the staff.';
      }

      if (await this.channelToggledCommands.isCommandToggled(guildId, channelId, commandName)) {
        return 'This command is toggled off in this channel.';
      }
    } catch (err) {
      Logger.warn({ err }, `Error in isBlockedInContext for guild ${guildId}`);
      return null;
    }

    return null;
  }

  private async trackActivity(message: Message): Promise<void> {
    if (!message.guildId || !message.guild) {
      return;
    }
    try {
      await this.guildService.ensureGuildExists(message.guild);

      const user = await this.userService.getUserByDiscordId(message.author.id);
      if (user) {
        await this.guildUserService.ensureUserInGuild(message.guildId, user.userId);
      }
      await this.guildService.trackLastCommand(message.guildId);
    } catch (err) {
      Logger.warn({ err }, 'Failed to track command activity');
    }
  }
}
