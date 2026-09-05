import type { Guild as DiscordGuild } from 'discord.js';
import type { IGuildRepository } from '@domain/interfaces/iguildRepository';
import type { Guild } from '@persistence/domain/models/guild';
import { CacheService } from '../cacheService';

const GUILD_CACHE_TTL_SECONDS = 300;

export class GuildService {
  private readonly guildRepository: IGuildRepository;
  private readonly cache: CacheService;

  constructor(
    guildRepository: IGuildRepository,
    cache: CacheService,
  ) {
    this.guildRepository = guildRepository;
    this.cache = cache;
  }

  public async ensureGuildExists(discordGuild: DiscordGuild): Promise<Guild> {
    const guild = await this.guildRepository.addOrUpdateGuild(
      discordGuild.id,
      discordGuild.name.slice(0, 100),
    );
    await this.cache.set(this.cacheKey(discordGuild.id), guild, GUILD_CACHE_TTL_SECONDS);
    return guild;
  }

  public async getGuild(guildId: string): Promise<Guild | null> {
    const cached = await this.cache.get<Guild>(this.cacheKey(guildId));
    if (cached) {
      return cached;
    }
    const guild = await this.guildRepository.getGuild(guildId);
    if (guild) {
      await this.cache.set(this.cacheKey(guildId), guild, GUILD_CACHE_TTL_SECONDS);
    }
    return guild;
  }

  public async setPrefix(guildId: string, prefix: string): Promise<void> {
    await this.guildRepository.setPrefix(guildId, prefix);
    await this.cache.delete(this.cacheKey(guildId));
  }

  public async setCommandsDisabled(guildId: string, disabled: boolean): Promise<void> {
    await this.guildRepository.setCommandsDisabled(guildId, disabled);
    await this.cache.delete(this.cacheKey(guildId));
  }

  public async setAccentColor(guildId: string, color: number | null): Promise<void> {
    await this.guildRepository.setAccentColor(guildId, color);
    await this.cache.delete(this.cacheKey(guildId));
  }

  public async trackLastCommand(guildId: string): Promise<void> {
    const throttleKey = `lastcmd:${guildId}`;
    const existing = await this.cache.get<string>(throttleKey);
    if (existing) {
      return;
    }
    await this.cache.set(throttleKey, new Date().toISOString(), 600);
    await this.guildRepository.setLastCommand(guildId, new Date());
  }

  private cacheKey(guildId: string): string {
    return `guild:${guildId}`;
  }
}
