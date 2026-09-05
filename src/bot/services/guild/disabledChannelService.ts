import { CacheService } from '../cacheService';
import { ChannelRepository } from '@persistence/repositories/channelRepository';

const CACHE_TTL_SECONDS = 300;

export class DisabledChannelService {
  private readonly cache: CacheService;
  private readonly channelRepository: ChannelRepository;

  constructor(
    cache: CacheService,
    channelRepository: ChannelRepository,
  ) {
    this.cache = cache;
    this.channelRepository = channelRepository;
  }

  public async setChannelDisabled(
    guildId: string,
    channelId: string,
    disabled: boolean,
  ): Promise<void> {
    await this.channelRepository.addOrUpdateChannel(channelId, guildId);
    const channel = await this.channelRepository.getChannel(channelId);
    const current = new Set(channel?.toggledCommands ?? []);

    if (disabled) {
      current.add('*');
    } else {
      current.delete('*');
    }

    await this.channelRepository.setToggledCommands(channelId, [...current]);
    await this.cache.delete(this.cacheKey(channelId));
    await this.cache.delete(`channel-toggled:${channelId}`);
  }

  public async isChannelDisabled(channelId?: string | null): Promise<boolean> {
    if (!channelId) {
      return false;
    }
    const cached = await this.cache.get<string>(this.cacheKey(channelId));
    if (cached === 'disabled') {
      return true;
    }
    if (cached === 'enabled') {
      return false;
    }
    const channel = await this.channelRepository.getChannel(channelId);
    const isDisabled = channel ? channel.toggledCommands.includes('*') : false;
    await this.cache.set(
      this.cacheKey(channelId),
      isDisabled ? 'disabled' : 'enabled',
      CACHE_TTL_SECONDS,
    );
    return isDisabled;
  }

  private cacheKey(channelId: string): string {
    return `channel-disabled:${channelId}`;
  }
}
