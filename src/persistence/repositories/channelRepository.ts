import { PrismaClient, Channel as ChannelEntity } from '@prisma/client';
import type { IChannelRepository } from '@domain/interfaces/ichannelRepository';
import type { Channel } from '@persistence/domain/models/channel';

export class ChannelRepository implements IChannelRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getChannel(channelId: string): Promise<Channel | null> {
    const entity = await this.prisma.channel.findUnique({
      where: { channelId: BigInt(channelId) },
    });
    return entity ? this.map(entity) : null;
  }

  public async addOrUpdateChannel(channelId: string, guildId: string): Promise<Channel> {
    const entity = await this.prisma.channel.upsert({
      where: { channelId: BigInt(channelId) },
      update: {},
      create: { channelId: BigInt(channelId), guildId: BigInt(guildId), toggledCommands: [] },
    });
    return this.map(entity);
  }

  public async setToggledCommands(channelId: string, commandNames: string[]): Promise<void> {
    await this.prisma.channel.update({
      where: { channelId: BigInt(channelId) },
      data: { toggledCommands: commandNames },
    });
  }

  public async setWhoKnowsWhitelisted(channelId: string, whitelisted: boolean): Promise<void> {
    await this.prisma.channel.update({
      where: { channelId: BigInt(channelId) },
      data: { whoKnowsWhitelisted: whitelisted },
    });
  }
  public async setFmEmbedType(channelId: string, fmEmbedType: number | null): Promise<void> {
    await this.prisma.channel.update({ where: { channelId: BigInt(channelId) }, data: { fmEmbedType } });
  }

  private map(entity: ChannelEntity): Channel {
    return {
      channelId: entity.channelId.toString(),
      guildId: entity.guildId.toString(),
      toggledCommands: entity.toggledCommands,
      whoKnowsWhitelisted: entity.whoKnowsWhitelisted,
      fmEmbedType: (entity as unknown as { fmEmbedType?: number | null }).fmEmbedType ?? undefined,
    };
  }
}
