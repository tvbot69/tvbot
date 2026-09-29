import { replyChannel, fetchableChannel } from '@domain/interfaces/discordChannel';
import {
  type Message,
  type TextBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
  EmbedBuilder,
  type GuildTextBasedChannel,
} from 'discord.js';
/**
 * A response may carry a paginator session, attached by whichever builder
 * produced it. Checked rather than cast, so this adds no type escape and
 * a differently-shaped response is simply skipped.
 */
const hasPaginatorSession = (v: unknown): v is { _paginatorSession: ComponentPaginatorSession } =>
  typeof v === 'object' && v !== null && '_paginatorSession' in v &&
  (v as { _paginatorSession?: unknown })._paginatorSession !== undefined;
import { container } from 'tsyringe';
import type { ComponentPaginatorSession } from '@bot/services/componentPaginatorService';
import { Logger } from '@domain/logger';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { isLastFmUnavailable } from '@domain/models/lastfmUnavailableError';
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
    _args?: string[],
    _userService?: UserService
  ): Promise<void> {
    const durationMs = Date.now() - startTime;
    const channel = message.channel;

    // Permissions check
    const perms = await this.ensureBotPermissions(channel, message.guildId);
    if (!perms.canSend) {
      // CORRECT AS IS. A permission miss is not a data source, the user is
      // already getting nothing, and a second send would need the same missing
      // permission. The WARN line is the whole report.
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
        // CORRECT AS IS. Transport, and the same missing-permission class as
        // the check above: a retry needs the permission that just failed.
        await replyChannel(channel).send({
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
      // CORRECT AS IS. Telemetry is a side channel: it is called inside its own
      // try precisely so that a metrics failure can never be the reason a
      // command does not reach the user. It cannot produce a wrong number the
      // user reads, because nothing it records is rendered.
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
        const existingMsg = await fetchableChannel(channel).messages.fetch(previousResponseId);
        if (existingMsg) {
          // `edit` returns the edited message; the caller only needs it to know
          // the response was delivered, so the domain port returns `unknown`
          // rather than a cast back to a discord.js Message.
          sentMessage = (await existingMsg.edit(payload)) as Message;
        }
      } catch {
        // CORRECT AS IS. A failed in-place edit falls through to a fresh send
        // below, which is the real answer for a deleted or uneditable message -
        // the user still gets their card, just as a new message. Not a source
        // read, and not a wrong number.
        sentMessage = null;
      }
    }

    if (!sentMessage && 'send' in channel) {
      sentMessage = (await replyChannel(channel).send(payload).catch(async (err) => {
        const code = (err as { code?: number })?.code;
        Logger.error({ err, code }, `Failed to send command response for .${commandName}`);
        // Silence is the worst outcome: the user typed a command and got
        // nothing at all, with no hint that anything happened. A 50035 here
        // means the payload was too large.
        await replyChannel(channel)
          .send({
            content:
              code === 50035
                ? '⚠️ That result was too large to display. Try a shorter search or a smaller page.'
                : '⚠️ I could not display that result. Please try again in a moment.',
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
        return null;
      })) as Message | null;

      if (sentMessage) {
        this.commandResponseMessageMap.set(message.id, sentMessage.id);
        // Prune if map exceeds 5000 items
        if (this.commandResponseMessageMap.size > 5000) {
          const oldest = this.commandResponseMessageMap.keys().next().value;
          if (oldest) this.commandResponseMessageMap.delete(oldest);
        }

        if (hasPaginatorSession(response)) {
          try {
            const { ComponentPaginatorService } = await import('@bot/services/componentPaginatorService');
            if (container.isRegistered(ComponentPaginatorService)) {
              container.resolve(ComponentPaginatorService).registerSession(sentMessage.id, response._paginatorSession);
            }
          } catch (err) {
            // The card is already sent, so the user is looking at page 1 with
            // arrow buttons that cannot fetch page 2. That is a real, visible
            // defect and it was invisible: `// ignore` is why a broken
            // paginator looked identical to a paginator nobody pressed. The
            // response is not rebuilt - that is not this layer's job - but the
            // log must say so, because "no log line" is what made it undiagnosable.
            Logger.warn({ err, commandName }, 'Failed to register paginator session');
          }
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

    // Auto-delete feedback messages after specified duration (e.g. 3-5 seconds for music queue/pause/skip)
    if (sentMessage && response.autoDeleteSeconds && response.autoDeleteSeconds > 0) {
      const timeoutMs = response.autoDeleteSeconds * 1000;
      setTimeout(() => {
        // CORRECT AS IS. Both of these are cosmetic housekeeping on a message
        // that has already been delivered and read; a delete that fails leaves
        // a message the user will read a few seconds later. Retrying, or
        // apologising for it, is strictly worse. Not a data source.
        sentMessage?.delete().catch(() => undefined);
        if (message.guildId) {
          message.delete().catch(() => undefined);
        }
      }, timeoutMs);
    }

    // Apply emoji reactions if requested
    if (sentMessage && response.emoteReactions && response.emoteReactions.length > 0) {
      for (const reaction of response.emoteReactions) {
        // CORRECT AS IS. Same reasoning: the card is delivered either way, and a
        // reaction is decoration layered on it, never information the user reads.
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
      // CORRECT AS IS. Same reasoning as the dispatch-path telemetry catch
      // above, and here it is doubly so: this runs while already handling a
      // failure, so a telemetry throw is never allowed to become the reason the
      // apology below is not sent.
      // Telemetry should never affect error handling
    }

    const isMissingPerms = error instanceof Error && error.message.toLowerCase().includes('missing permissions');
    let apologyText: string;

    // A source that did not answer is a different event from a defect, and the
    // COMPONENT boundary was taught to say so last commit
    // (`interactionHandler.onInteractionCreated`: `isSourceUnavailable` ->
    // "Could not reach the database"). This is the same boundary for a TEXT
    // command and it was still collapsing both into "something went wrong -
    // try again later", which asks the user to retry a command that will fail
    // identically and hides from the log reader that this was a known,
    // retryable outage rather than a bug. This repo already documents the gap
    // from the other side - `tasteCommands.ts` wraps `getTasteData` in a catch
    // *because* this function does not name the source. Checked before the
    // message sniff: a typed error outranks a substring match on its cause.
    if (isSourceUnavailable(error)) {
      apologyText =
        `Could not reach ${isLastFmUnavailable(error) ? 'Last.fm' : 'the database'}. Please try again in a moment.\n` +
        `*Reference ID: \`${referenceId}\`\``;
    } else if (isMissingPerms) {
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

      // CORRECT AS IS, and it is the last resort by construction: this is the
      // final delivery attempt, so if the send itself fails there is no channel
      // left to report on and no second attempt that could produce a double
      // post. `Logger.errorWithRef` above already wrote the error with its
      // reference id, so the failure is recorded even though it is not shown.
      await replyChannel(message.channel).send({
        embeds: [errorEmbed],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
  }
}
