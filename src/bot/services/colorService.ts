import { inject, injectable } from 'tsyringe';
import { CacheService } from './cacheService';
import { FmSettingService } from './fmSettingService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { FmAccentColor } from '@domain/enums/fmAccentColor';
import { DiscordConstants } from '@bot/resources/discordConstants';

const COLOR_CACHE_TTL_SECONDS = 300;

@injectable()
export class ColorService {
  private readonly userRepository: UserRepository;
  private readonly fmSettingService: FmSettingService;
  private readonly cache: CacheService;

  constructor(
    @inject(UserRepository) userRepository: UserRepository,
    @inject(FmSettingService) fmSettingService: FmSettingService,
    @inject(CacheService) cache: CacheService,
  ) {
    this.userRepository = userRepository;
    this.fmSettingService = fmSettingService;
    this.cache = cache;
  }

  public async getAccentColorAsync(targetId?: string | null): Promise<number | undefined> {
    return this.getUserAccentColorAsync(targetId);
  }

  public async getUserAccentColorAsync(discordUserId?: string | null): Promise<number | undefined> {
    if (!discordUserId) {
      return undefined;
    }

    const cacheKey = `accent-color:user:${discordUserId}`;
    const cached = await this.cache.get<number | null>(cacheKey);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    if (cached === null) {
      // Explicitly cached as having no custom color (default blank embed)
      return undefined;
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
    await this.cache.set(cacheKey, null, COLOR_CACHE_TTL_SECONDS);
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
      await this.cache.set(cacheKey, null, COLOR_CACHE_TTL_SECONDS);
    }
  }

  public async setAccentColorAsync(targetId: string, color: number | null): Promise<void> {
    await this.setUserAccentColorAsync(targetId, color);
  }
}

