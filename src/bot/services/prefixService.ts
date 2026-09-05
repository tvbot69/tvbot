import { ConfigData } from '@bot/configurations/configData';
import { CacheService } from './cacheService';
import { GuildRepository } from '@persistence/repositories/guildRepository';

const PREFIX_CACHE_TTL_SECONDS = 300;

export class PrefixService {
  private readonly cache: CacheService;
  private readonly guildRepository: GuildRepository;
  private readonly defaultPrefix: string;

  constructor(
    cache: CacheService,
    guildRepository: GuildRepository,
  ) {
    this.cache = cache;
    this.guildRepository = guildRepository;
    this.defaultPrefix = ConfigData.Data.bot.prefix;
  }

  public async getPrefix(guildId?: string | null): Promise<string> {
    if (!guildId) {
      return this.defaultPrefix;
    }
    try {
      const cached = await this.cache.get<string>(`prefix:${guildId}`);
      if (cached) {
        return cached;
      }
      const guild = await this.guildRepository.getGuild(guildId);
      const prefix = guild?.prefix ?? this.defaultPrefix;
      await this.cache.set(`prefix:${guildId}`, prefix, PREFIX_CACHE_TTL_SECONDS);
      return prefix;
    } catch {
      return this.defaultPrefix;
    }
  }

  public async setPrefix(guildId: string, prefix: string): Promise<void> {
    await this.guildRepository.setPrefix(guildId, prefix);
    await this.cache.delete(`prefix:${guildId}`);
  }

  public getDefaultPrefix(): string {
    return this.defaultPrefix;
  }
}
