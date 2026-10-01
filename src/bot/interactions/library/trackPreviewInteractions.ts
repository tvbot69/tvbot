import { inject, injectable } from 'tsyringe';
import { ButtonInteraction, MessageFlags } from 'discord.js';
import { VoiceMessageService, getPreview } from '@bot/services/audio/voiceMessageService';
import { downloadAndConvert } from '@bot/services/audio/audioSignalService';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logging/logger';

export const TRACK_PREVIEW_PREFIX = 'track-preview:';

@injectable()
export class TrackPreviewInteractions {

  constructor(
    @inject(VoiceMessageService)
    private readonly voiceService: VoiceMessageService,
  ) {
  }

  /**
   * In-flight previews, keyed by user. Each press runs a download AND an
   * ffmpeg transcode, and the button path was not covered by the command rate
   * limiter — so holding the button (or spamming it) spawned parallel ffmpeg
   * processes and re-uploaded the same clip repeatedly.
   */
  private readonly inFlight = new Set<string>();

  public async handle(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith(TRACK_PREVIEW_PREFIX)) return;

    // Builders append an optional context suffix after the id ("<id>:fm").
    // Stripping only a TRAILING colon left "name:fm" as the key, so the
    // lookup always missed; take the first segment instead.
    const uniqueId = customId.slice(TRACK_PREVIEW_PREFIX.length).split(':')[0] ?? '';
    const previewUrl = getPreview(uniqueId);
    if (!previewUrl) {
      // CORRECT AS IS, all four `.catch`es in this file, and they are one class:
      // Discord transport. A press is a component interaction with a 3s token, and
      // each of these replies is a statement about the PRESS, never about the
      // track - "your preview expired", "still working on that", "failed to send".
      // None of them carries a playcount or a measurement, so a rejected reply
      // costs a sentence the user did not see rather than a wrong number.
      //
      // The one that looks like a data source is `getPreview(uniqueId)` returning
      // undefined. It is a bounded in-memory map with a TTL (`setPreview` at the
      // bottom of this file), so a miss genuinely IS expiry: there is no database
      // and no upstream to be unavailable. "Preview expired" is the true
      // statement.
      await interaction.reply({ content: '❌ Preview expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    const flightKey = `${interaction.user.id}:${uniqueId}`;
    if (this.inFlight.has(flightKey)) {
      // CORRECT AS IS: a statement about this press, not about the track. The
      // in-flight guard is the local `Set` above, so a hit is a real duplicate
      // press and the message is the true one.
      await interaction
        .reply({ content: '⏳ Still working on that preview — give it a moment.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }
    this.inFlight.add(flightKey);

    // CORRECT AS IS: acknowledging the press. A download plus an ffmpeg transcode
    // cannot finish inside Discord's 3s window, so deferring first is what makes
    // the button work at all, and the later `followUp` at the bottom is the
    // documented answer to a deferred interaction.
    await interaction.deferUpdate().catch(() => undefined);

    try {
      const oggPath = await downloadAndConvert(previewUrl, uniqueId);
      const token = ConfigData.Data.discord.token;
      const appId = ConfigData.Data.discord.applicationId;

      // Prefer webhook if we have interaction token (slash), fallback to channel attachments
      if (interaction.isButton() && interaction.token && appId && appId !== '0') {
        try {
          await this.voiceService.sendViaWebhook(appId, interaction.token, oggPath, token);
          // Webhook send already posted the voice message, we just ack
          return;
        } catch (err) {
          Logger.warn({ err }, '[TrackPreview] webhook send failed, falling back to channel send');
        }
      }

      const channelId = interaction.channelId!;
      await this.voiceService.sendViaChannel(channelId, oggPath, token, interaction.message?.id);
    } catch (err) {
      // CORRECT AS IS: the failure is ALREADY logged one line above at ERROR, and
      // this only adds the user-facing sentence. The `.catch` on the `followUp`
      // is the interaction being spent - `deferUpdate` already consumed the
      // token and a long transcode is exactly the case where Discord has given
      // up on it. Nothing observable is lost: the operator has the error, and
      // the only thing the user loses is a message they may never see.
      Logger.error({ err }, '[TrackPreview] failed to send voice preview');
      await interaction.followUp({ content: '⚠️ Failed to send preview.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } finally {
      this.inFlight.delete(flightKey);
    }
  }
}
