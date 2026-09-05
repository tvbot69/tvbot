import type { Channel } from '@persistence/domain/models/channel';

export interface IChannelRepository {
  getChannel(channelId: string): Promise<Channel | null>;
  addOrUpdateChannel(channelId: string, guildId: string): Promise<Channel>;
  setToggledCommands(channelId: string, commandNames: string[]): Promise<void>;
  setWhoKnowsWhitelisted(channelId: string, whitelisted: boolean): Promise<void>;
  setFmEmbedType(channelId: string, fmEmbedType: number | null): Promise<void>;
}
