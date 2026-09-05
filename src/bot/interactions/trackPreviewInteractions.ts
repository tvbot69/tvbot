import { container } from 'tsyringe';
import { ButtonInteraction, MessageFlags } from 'discord.js';
import { VoiceMessageService, previewMap } from '@bot/services/audio/voiceMessageService';
import { downloadAndConvert } from '@bot/services/audio/audioSignalService';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

export const TRACK_PREVIEW_PREFIX = 'track-preview:';

export class TrackPreviewInteractions {
  private readonly voiceService: VoiceMessageService;

  constructor() {
    this.voiceService = container.resolve(VoiceMessageService);
  }

  public async handle(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith(TRACK_PREVIEW_PREFIX)) return;

    const uniqueId = customId.slice(TRACK_PREVIEW_PREFIX.length).replace(/:$/, '');
    const previewUrl = previewMap.get(uniqueId);
    if (!previewUrl) {
      await interaction.reply({ content: '❌ Preview expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    try {
      const oggPath = await downloadAndConvert(previewUrl, uniqueId);
      const token = ConfigData.Data.discord.token;
      const appId = ConfigData.Data.discord.applicationId;

      // Prefer webhook if we have interaction token (slash), fallback to channel attachments
      if (interaction.isButton() && (interaction as any).token && appId && appId !== '0') {
        try {
          await this.voiceService.sendViaWebhook(appId, (interaction as any).token, oggPath, token);
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
    }
  }
}
