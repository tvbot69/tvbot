import {
  type Message,
  type TextBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
  EmbedBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
import { container } from 'tsyringe';
import { Logger } from '@domain/logger';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/userService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { TelemetryService } from '@bot/services/telemetryService';

export class CommandDispatcher {
  // Map of context message ID -> bot response message ID for in-place edit updates
  private static readonly commandResponseMessageMap = new Map<string, string>();

  // In-memory referenced music cache: messageId -> { artist, album, track }
  private static readonly referencedMusicMap = new Map<string, { artist?: string; album?: string; track?: string }>();

  public static getReferencedMusic(messageId: string): { artist?: string; album?: string; track?: string } | undefined {
    return this.referencedMusicMap.get(messageId);
  }

  public static setReferencedMusic(messageId: string, music: { artist?: string; album?: string; track?: string }): void {
    this.referencedMusicMap.set(messageId, music);
    // Prune if map exceeds 5000 items
    if (this.referencedMusicMap.size > 5000) {
      const oldestKey = this.referencedMusicMap.keys().next().value;
      if (oldestKey) this.referencedMusicMap.delete(oldestKey);
    }
  }

  public static async ensureBotPermissions(
    channel: TextBasedChannel,
    guildId?: string | null
  ): Promise<{ canSend: boolean; canEmbed: boolean }> {
    if (!guildId || !('guild' in channel) || !channel.guild) {
      return { canSend: true, canEmbed: true };
    }

    const botMember = channel.guild.members.me;
    if (!botMember) {
      return { canSend: true, canEmbed: true };
    }

    const permissions = (channel as GuildTextBasedChannel).permissionsFor(botMember);
    if (!permissions) {
      return { canSend: true, canEmbed: true };
    }

    const canSend = permissions.has(PermissionFlagsBits.SendMessages);
    const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);
    return { canSend, canEmbed };
  }

  public static async dispatchResponse(
    message: Message,
    response: ResponseModel,
    startTime: number,
    commandName: string,
    args?: string[],
    userService?: UserService
  ): Promise<void> {
    const durationMs = Date.now() - startTime;
    const channel = message.channel;

    // Permissions check
    const perms = await this.ensureBotPermissions(channel, message.guildId);
    if (!perms.canSend) {
      Logger.warn(
        `CommandDispatcher: Missing 'Send Messages' permission | ${message.author.username} / ${message.author.id} | ${message.guild?.name ?? 'DM'} / ${message.guildId}`
      );
      return;
    }

    if (!perms.canEmbed && response.hasEmbed() && !response.isComponentsV2) {
      Logger.warn(
        `CommandDispatcher: Missing 'Embed Links' permission | ${message.author.username} / ${message.author.id} | ${message.guild?.name ?? 'DM'} / ${message.guildId}`
      );
      if ('send' in channel) {
        await (channel as unknown as { send: (m: Record<string, unknown>) => Promise<unknown> }).send({
          content: '⚠️ I need the **Embed Links** permission in this channel to display responses.',
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
      return;
    }

    // Log command usage matching fmbot format
    Logger.commandUsed({
      discordUserName: message.author.tag ?? message.author.username,
      discordUserId: message.author.id,
      guildName: message.guild?.name,
      guildId: message.guildId,
      shardId: message.guild?.shardId ?? 0,
      commandResponse: response.commandResponse,
      responseTimeMs: durationMs,
      messageContent: message.content,
    });

    try {
      if (container.isRegistered(TelemetryService)) {
        container.resolve(TelemetryService).recordCommandExecution(
          commandName,
          durationMs,
          response.commandResponse !== CommandResponse.Error && response.commandResponse !== CommandResponse.LastFmError,
        );
      }
    } catch {
      // Telemetry should never affect command dispatch
    }

    if (response.commandResponse === CommandResponse.Deleted) {
      return;
    }

    // Build payload
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

    // Check if this is an edit update
    const previousResponseId = this.commandResponseMessageMap.get(message.id);
    let sentMessage: Message | null = null;

    if (previousResponseId && 'messages' in channel) {
      try {
        const existingMsg = await (channel as unknown as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(previousResponseId);
        if (existingMsg) {
          sentMessage = await existingMsg.edit(payload as any);
        }
      } catch {
        // If edit fails (e.g. message deleted), fall back to sending new message
        sentMessage = null;
      }
    }

    if (!sentMessage && 'send' in channel) {
      sentMessage = (await (channel as unknown as { send: (m: Record<string, unknown>) => Promise<Message> }).send(payload).catch((err) => {
        Logger.error({ err }, `Failed to send command response for .${commandName}`);
        return null;
      })) as Message | null;

      if (sentMessage) {
        this.commandResponseMessageMap.set(message.id, sentMessage.id);
        // Prune if map exceeds 5000 items
        if (this.commandResponseMessageMap.size > 5000) {
          const oldest = this.commandResponseMessageMap.keys().next().value;
          if (oldest) this.commandResponseMessageMap.delete(oldest);
        }
      }
    }

    // Track referenced music for reply chaining
    if (response.referencedMusic && (response.referencedMusic.artist || response.referencedMusic.track || response.referencedMusic.album)) {
      if (sentMessage) {
        this.setReferencedMusic(sentMessage.id, response.referencedMusic);
      }
      this.setReferencedMusic(message.id, response.referencedMusic);
    }

    // Apply emoji reactions if requested
    if (sentMessage && response.emoteReactions && response.emoteReactions.length > 0) {
      for (const reaction of response.emoteReactions) {
        await sentMessage.react(reaction).catch(() => undefined);
      }
    }
  }

  public static async handleCommandException(
    error: unknown,
    message: Message,
    commandName: string
  ): Promise<void> {
    const { referenceId } = Logger.errorWithRef(error, {
      commandName,
      userName: message.author.tag ?? message.author.username,
      userId: message.author.id,
      guildName: message.guild?.name,
      guildId: message.guildId,
      shardId: message.guild?.shardId ?? 0,
      messageContent: message.content,
    });

    try {
      if (container.isRegistered(TelemetryService)) {
        container.resolve(TelemetryService).recordCommandExecution(commandName, 0, false);
      }
    } catch {
      // Telemetry should never affect error handling
    }

    const isMissingPerms = error instanceof Error && error.message.toLowerCase().includes('missing permissions');
    let apologyText: string;

    if (isMissingPerms) {
      apologyText =
        'Sorry, something went wrong because the bot is missing permissions. Make sure the bot has `Embed Links` and `Attach Files`.\n' +
        `*Reference ID: \`${referenceId}\`*`;
    } else {
      apologyText =
        'Sorry, something went wrong while executing that command. Please try again later.\n' +
        `*Reference ID: \`${referenceId}\`*`;
    }

    if (message.channel && 'send' in message.channel) {
      const errorEmbed = new EmbedBuilder()
        .setColor(DiscordConstants.LastFmColorRed)
        .setDescription(apologyText);

      await (message.channel as unknown as { send: (m: Record<string, unknown>) => Promise<unknown> }).send({
        embeds: [errorEmbed],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
  }
}
