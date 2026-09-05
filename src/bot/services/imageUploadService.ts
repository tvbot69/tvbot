import { container } from 'tsyringe';
import { Client, type Channel, TextChannel } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

export class ImageUploadService {
  private readonly client: Client;

  constructor() {
    this.client = container.resolve(Client);
  }

  public async uploadToStagingChannel(
    buffer: Buffer,
    fileName: string,
    description?: string,
  ): Promise<string | null> {
    const stagingChannelId = ConfigData.Data.bot.stagingChannelId;
    if (!stagingChannelId || stagingChannelId === '0') {
      return null;
    }

    try {
      const channel = (await this.client.channels.fetch(stagingChannelId)) as Channel | null;
      if (!channel || !channel.isTextBased() || !(channel instanceof TextChannel)) {
        Logger.warn('Staging channel not found or not a text channel');
        return null;
      }

      const message = await channel.send({
        files: [{ attachment: buffer, name: fileName, description: description }],
      });

      const first = message.attachments.first();
      return first?.url ?? null;
    } catch (err) {
      Logger.warn({ err }, 'Failed to stage chart image to channel');
      return null;
    }
  }
}
