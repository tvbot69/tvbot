import { container } from 'tsyringe';
import { ButtonInteraction, MessageFlags } from 'discord.js';
import { VoiceMessageService, getPreview } from '@bot/services/audio/voiceMessageService';
import { downloadAndConvert } from '@bot/services/audio/audioSignalService';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

export const TRACK_PREVIEW_PREFIX = 'track-preview:';

export class TrackPreviewInteractions {
  private readonly voiceService: VoiceMessageService;

  constructor() {
    this.voiceService = container.resolve(VoiceMessageService);
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
      await interaction.reply({ content: '❌ Preview expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    const flightKey = `${interaction.user.id}:${uniqueId}`;
    if (this.inFlight.has(flightKey)) {
      await interaction
        .reply({ content: '⏳ Still working on that preview — give it a moment.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }
    this.inFlight.add(flightKey);

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
      Logger.error({ err }, '[TrackPreview] failed to send voice preview');
      await interaction.followUp({ content: '⚠️ Failed to send preview.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } finally {
      this.inFlight.delete(flightKey);
    }
  }
}
