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

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.webhookId) {
      return;
    }
    if (!message.content || message.content.length === 0) {
      Logger.debug({ guild: message.guild?.name, author: message.author.tag }, 'Received empty message content (check Message Content Intent in Discord Developer Portal)');
      return;
    }

    const prefix = await this.prefixService.getPrefix(message.guildId);
    const botMention1 = this.client.user ? `<@${this.client.user.id}>` : null;
    const botMention2 = this.client.user ? `<@!${this.client.user.id}>` : null;

    let matchedPrefix: string | null = null;
    if (message.content.startsWith(prefix)) {
      matchedPrefix = prefix;
    } else if (botMention1 && message.content.startsWith(botMention1)) {
      matchedPrefix = botMention1;
    } else if (botMention2 && message.content.startsWith(botMention2)) {
      matchedPrefix = botMention2;
    }

    if (!matchedPrefix) {
      if (message.guildId) {
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

    const rawArguments = message.content.slice(matchedPrefix.length).trim();
    if (!rawArguments) {
      return;
    }

    const split = rawArguments.split(/\s+/);
    const commandName = (split.shift() ?? '').toLowerCase();

    const command = getTextCommand(commandName);
    if (!command) {
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
    context.accentColor = await this.colorService.getAccentColorAsync(context.discordUserId)
      ?? (context.guildId ? await this.colorService.getAccentColorAsync(context.guildId) : undefined);

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
      const durationMs = Date.now() - startTime;
      Logger.command({
        commandName,
        args: split?.join(' '),
        userName: message.author.tag ?? message.author.username,
        guildName: message.guild?.name,
        channelName: 'name' in message.channel ? (message.channel.name as string) : undefined,
        durationMs,
      });

      if (response.commandResponse === CommandResponse.Deleted) {
        return;
      }
      const allowedMentions = { parse: [] as string[] };
      let payload: Record<string, unknown>;
      if (response.isComponentsV2) {
        payload = {
          components: [response.componentsV2Container],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions,
        };
        if (response.hasFile()) {
          payload.files = response.getFiles();
        }
      } else {
        const hasEmbed = response.hasEmbed();
        payload = {
          content: response.content ?? (hasEmbed ? undefined : response._textContent),
          embeds: hasEmbed ? response.buildEmbed() : [],
          components: response.buildComponents(),
          allowedMentions,
        };
        if (!payload.content && response._textContent) payload.content = response._textContent;
        if (!hasEmbed && payload.content) delete payload.embeds;
        if (response.hasFile()) {
          payload.files = response.getFiles();
        }
      }
      // fmbot posts command output as a regular channel message, not as a Discord
      // reply.  This also avoids the reply reference shown in message JSON.
      if (message.channel.isTextBased() && 'send' in message.channel) {
        await (message.channel as unknown as { send: (message: Record<string, unknown>) => Promise<unknown> }).send(payload);
      }
    } catch (err) {
      Logger.error({ err }, `Error executing text command .${commandName}`);
      await message
        .reply('Something went wrong while executing that command.')
        .catch(() => undefined);
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
