import { CacheService } from '../cacheService';
import { ChannelRepository } from '@persistence/repositories/channelRepository';

const CACHE_TTL_SECONDS = 300;

export class ChannelToggledCommandService {
  private readonly cache: CacheService;
  private readonly channelRepository: ChannelRepository;

  constructor(
    cache: CacheService,
    channelRepository: ChannelRepository,
  ) {
    this.cache = cache;
    this.channelRepository = channelRepository;
  }

  public async toggleCommand(guildId: string, channelId: string, commandName: string): Promise<boolean> {
    await this.channelRepository.addOrUpdateChannel(channelId, guildId);
    const channel = await this.channelRepository.getChannel(channelId);
    const current = new Set(channel?.toggledCommands ?? []);
    const name = commandName.toLowerCase();

    let nowToggled: boolean;
    if (current.has(name)) {
      current.delete(name);
      nowToggled = false;
    } else {
      current.add(name);
      nowToggled = true;
    }

    await this.channelRepository.setToggledCommands(channelId, [...current]);
    await this.cache.delete(`channel-toggled:${channelId}`);
    return nowToggled;
  }

  public async isCommandToggled(guildId: string, channelId?: string | null, commandName?: string): Promise<boolean> {
    if (!channelId || !commandName) {
      return false;
    }
    const cacheKey = `channel-toggled:${channelId}`;
    let toggled = await this.cache.get<string[]>(cacheKey);
    if (!toggled) {
      const channel = await this.channelRepository.getChannel(channelId);
      toggled = channel?.toggledCommands ?? [];
      await this.cache.set(cacheKey, toggled, CACHE_TTL_SECONDS);
    }
    return toggled.includes(commandName.toLowerCase());
  }
}
