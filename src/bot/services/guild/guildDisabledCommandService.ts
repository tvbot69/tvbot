import { CacheService } from '../cacheService';
import { GuildDisabledCommandRepository } from '@persistence/repositories/guildDisabledCommandRepository';

const CACHE_TTL_SECONDS = 300;

export class GuildDisabledCommandService {
  private readonly cache: CacheService;
  private readonly repository: GuildDisabledCommandRepository;

  constructor(
    cache: CacheService,
    repository: GuildDisabledCommandRepository,
  ) {
    this.cache = cache;
    this.repository = repository;
  }

  public async addDisabledCommand(guildId: string, commandName: string): Promise<void> {
    await this.repository.add(guildId, commandName.toLowerCase());
    await this.cache.delete(`guild-disabled-commands:${guildId}`);
  }

  public async removeDisabledCommand(guildId: string, commandName: string): Promise<void> {
    await this.repository.remove(guildId, commandName.toLowerCase());
    await this.cache.delete(`guild-disabled-commands:${guildId}`);
  }

  public async getDisabledCommands(guildId: string): Promise<string[]> {
    const cached = await this.cache.get<string[]>(`guild-disabled-commands:${guildId}`);
    if (cached) {
      return cached;
    }
    const all = await this.repository.getAllForGuild(guildId);
    const names = all.map((c) => c.commandName);
    await this.cache.set(`guild-disabled-commands:${guildId}`, names, CACHE_TTL_SECONDS);
    return names;
  }

  public async isCommandDisabled(guildId: string, commandName: string): Promise<boolean> {
    const disabled = await this.getDisabledCommands(guildId);
    return disabled.includes(commandName.toLowerCase());
  }
}
