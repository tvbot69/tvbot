import { inject, injectable } from 'tsyringe';
import { CacheService } from './cacheService';
import { FmSettingService } from './fmSettingService';
import { UserRepository } from '@persistence/repositories/userRepository';
import type { IGuildRepository } from '@domain/interfaces/iguildRepository';
import { FmAccentColor } from '@domain/enums/fmAccentColor';
import { DiscordConstants } from '@bot/resources/discordConstants';

const COLOR_CACHE_TTL_SECONDS = 300;

@injectable()
export class ColorService {
  private readonly userRepository: UserRepository;
  private readonly fmSettingService: FmSettingService;
  private readonly cache: CacheService;
  private readonly guildRepository?: IGuildRepository;

  constructor(
    @inject(UserRepository) userRepository: UserRepository,
    @inject(FmSettingService) fmSettingService: FmSettingService,
    @inject(CacheService) cache: CacheService,
    @inject('IGuildRepository') guildRepository?: IGuildRepository,
  ) {
    this.userRepository = userRepository;
    this.fmSettingService = fmSettingService;
    this.cache = cache;
    this.guildRepository = guildRepository;
  }

  public async getAccentColorAsync(targetId?: string | null): Promise<number | undefined> {
    if (!targetId) {
      return undefined;
    }
    const userColor = await this.getUserAccentColorAsync(targetId);
    if (userColor !== undefined) {
      return userColor;
    }
    return this.getGuildAccentColorAsync(targetId);
  }

  public async getGuildAccentColorAsync(guildId?: string | null): Promise<number | undefined> {
    if (!guildId || !this.guildRepository) {
      return undefined;
    }
    const cacheKey = `accent-color:guild:${guildId}`;
    const cached = await this.cache.get<number | string>(cacheKey);
    if (cached !== null && cached !== undefined) {
      if (cached === 'none' || cached === -1) {
        return undefined;
      }
      if (typeof cached === 'number') {
        return cached;
      }
      const parsed = parseInt(String(cached), 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }

    const guild = await this.guildRepository.getGuild(guildId);
    if (guild?.accentColor) {
      await this.cache.set(cacheKey, guild.accentColor, COLOR_CACHE_TTL_SECONDS);
      return guild.accentColor;
    }

    await this.cache.set(cacheKey, 'none', COLOR_CACHE_TTL_SECONDS);
    return undefined;
  }

  public async getUserAccentColorAsync(discordUserId?: string | null): Promise<number | undefined> {
    if (!discordUserId) {
      return undefined;
    }

    const cacheKey = `accent-color:user:${discordUserId}`;
    const cached = await this.cache.get<number | string>(cacheKey);
    if (cached !== null && cached !== undefined) {
      if (cached === 'none' || cached === -1) {
        return undefined;
      }
      if (typeof cached === 'number') {
        return cached;
      }
      const parsed = parseInt(String(cached), 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }

    // Check if user has a custom color or LastFmRed configured in database
    const user = await this.userRepository.getUserByDiscordUserId(discordUserId);
    if (user) {
      const setting = await this.fmSettingService.get(user.userId);
      if (setting?.accentColor === FmAccentColor.LastFmRed) {
        await this.cache.set(cacheKey, DiscordConstants.LastFmColorRed, COLOR_CACHE_TTL_SECONDS);
        return DiscordConstants.LastFmColorRed;
      }
      if (setting?.customColor) {
        const clean = setting.customColor.replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(clean)) {
          const color = parseInt(clean, 16);
          await this.cache.set(cacheKey, color, COLOR_CACHE_TTL_SECONDS);
          return color;
        }
      }
    }

    // Default: no custom color set -> blank color embed
    await this.cache.set(cacheKey, 'none', COLOR_CACHE_TTL_SECONDS);
    return undefined;
  }

  public async setUserAccentColorAsync(discordUserId: string, color: number | null): Promise<void> {
    const cacheKey = `accent-color:user:${discordUserId}`;
    const user = await this.userRepository.getUserByDiscordUserId(discordUserId);
    if (user) {
      const hex = color !== null ? `#${color.toString(16).padStart(6, '0')}` : null;
      await this.fmSettingService.setAccentColor(user.userId, color !== null ? FmAccentColor.Custom : null, hex);
    }
    if (color !== null) {
      await this.cache.set(cacheKey, color, COLOR_CACHE_TTL_SECONDS);
    } else {
      await this.cache.set(cacheKey, 'none', COLOR_CACHE_TTL_SECONDS);
    }
  }

  public async setAccentColorAsync(targetId: string, color: number | null): Promise<void> {
    await this.setUserAccentColorAsync(targetId, color);
  }
}

