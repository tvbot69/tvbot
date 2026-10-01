import { inject, injectable } from 'tsyringe';
import { replyChannel, typingChannel } from '@domain/interfaces/discord/discordChannel';
import { Client, Events, MessageFlags, type Message } from 'discord.js';
import { Logger } from '@domain/logging/logger';
import { Statistics } from '@domain/text/statistics';

import { ContextModel } from '@bot/models/contextModel';
import { PrefixService } from '@bot/services/user/prefixService';
import { isSourceUnavailable } from '@domain/models/errors/sourceUnavailableError';
import { GuildService } from '@bot/services/guild/guildService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { UserService } from '@bot/services/user/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { ColorService } from '@bot/services/system/colorService';
import { getTextCommand } from '@bot/textCommands';
import { GameService } from '@bot/services/guild/gameService';
import { GameBuilders } from '@bot/builders/guild/gameBuilders';

import { RateLimitService } from '@bot/services/system/rateLimitService';
import { CommandDispatcher } from '@bot/handlers/commands/commandDispatcher';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { EmbedBuilder } from 'discord.js';

@injectable()
export class CommandHandler {

  constructor(
    @inject(Client)
    private readonly client: Client,
    @inject(PrefixService)
    private readonly prefixService: PrefixService,
    @inject(GuildService)
    private readonly guildService: GuildService,
    @inject(DisabledChannelService)
    private readonly disabledChannelService: DisabledChannelService,
    @inject(GuildDisabledCommandService)
    private readonly guildDisabledCommands: GuildDisabledCommandService,
    @inject(ChannelToggledCommandService)
    private readonly channelToggledCommands: ChannelToggledCommandService,
    @inject(UserService)
    private readonly userService: UserService,
    @inject(GuildUserService)
    private readonly guildUserService: GuildUserService,
    @inject(ColorService)
    private readonly colorService: ColorService,
    @inject(GameService)
    private readonly gameService: GameService,
    @inject(RateLimitService)
    private readonly rateLimitService: RateLimitService,
  ) {

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
    // CORRECT AS IS for every `.catch(() => undefined)` in this method: each one
    // wraps a Discord send or a typing indicator, i.e. transport, not a data
    // source. None of them can turn a failed read into a wrong number, and a
    // second delivery attempt on a send that already failed is how you get
    // double posts. The two that DO answer the user are unchanged and must
    // stay: the unknown-command reply below, and the "try again later" boundary
    // that `CommandDispatcher.handleCommandException` owns.
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
      let prefix: string;
      try {
        prefix = await this.prefixService.getPrefix(message.guildId);
      } catch (err) {
        // `PrefixService` used to answer `'.'` here on any failure, which in a
        // `!` guild turned a `!foo` into "Unknown command `.foo`" - a confident
        // wrong answer naming a prefix the user never typed. It raises now, so
        // this handler owes the user a real answer, and it has to be here:
        // an uncaught throw only reaches the `Logger.error` in the constructor,
        // so the user would get total silence.
        //
        // A defect is not an outage, though. The narrowing is
        // `isSourceUnavailable`, and anything else rethrows, because "Could not
        // reach the database" about a `TypeError` would send an operator hunting
        // a database that is answering fine.
        if (!isSourceUnavailable(err)) throw err;

        // Routing through `handleCommandException` is what makes the outage
        // legible to the user ("Could not reach the database") and to the log
        // reader (a reference id), and it reuses the exact text every other
        // source failure on this path already gets, so there is one message for
        // one cause rather than two that disagree.
        //
        // `'prefix-lookup'` as the command name is honest - the run died before
        // any command name was resolved - and it is a fixed string, so it cannot
        // fragment the telemetry buckets per user typo.
        await CommandDispatcher.handleCommandException(err, message, 'prefix-lookup');
        // Nothing below the prefix lookup can run without a prefix, and every
        // branch after it would have to guess one. The lookup only happens for
        // command-shaped input, so this cannot reply to ordinary chat.
        return;
      }

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
                await replyChannel(message.channel).send({
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
              await replyChannel(message.channel).send({
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
        await replyChannel(message.channel).send({
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
        await replyChannel(message.channel).send({
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
          typingChannel(message.channel)
            .sendTyping()
            .catch(() => undefined);
        }, 8000)
      : null;

    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await typingChannel(message.channel)
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
      // CORRECT AS IS, and the trade is deliberate. Returning `null` here means
      // "not blocked", so a failed gate read lets the command through. Failing
      // CLOSED would instead take every guild's bot offline because one Redis
      // read threw, which is a far worse wrong answer than a command that ran
      // in a guild that had meant to disable it. It is not silent either: this
      // logs at WARN with the guild id. `InteractionHandler.isBlockedInContext`
      // is the same code and the same reasoning.
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
      // CORRECT AS IS. Fire-and-forget bookkeeping - guild row, membership row,
      // "last command at" - whose worst outcome is a stale timestamp. It is
      // deliberately NOT in the command's own try block: a user must never see
      // an error for a side effect they did not ask for, and the command
      // response has already been sent by the time this runs. It logs, so it is
      // not silent.
      Logger.warn({ err }, 'Failed to track command activity');
    }
  }
}
