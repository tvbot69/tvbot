import { ButtonInteraction, StringSelectMenuInteraction, MessageFlags } from 'discord.js';
import { injectable, inject } from 'tsyringe';
import { CountryService, CountryInfo, TopCountryItem, WhoKnowsCountryItem } from '@bot/services/countryService';
import { CountryBuilders } from '@bot/builders/countryBuilders';
import { CountryChartTheme, WorldMapGenerator } from '@images/generators/worldMapGenerator';
import { UserService } from '@bot/services/userService';

export type CountryInteractionType = 'top' | 'info' | 'wkc' | 'chart';

export interface CachedCountryQuery {
  type: CountryInteractionType;
  displayName?: string;
  country?: CountryInfo;
  targetName?: string;
  periodDescription?: string;
  countries?: TopCountryItem[];
  artists?: { name: string; playcount: number }[];
  whoknowsItems?: WhoKnowsCountryItem[];
  isServerView?: boolean;
  accentColor?: number | null;
  guildId?: string | null;
  serverName?: string;
  userId?: number;
  currentTheme?: CountryChartTheme;
  expiresAt: number;
}

const countryQueryCache = new Map<string, CachedCountryQuery>();

export function storeCountryQuery(
  cacheKey: string,
  data: Omit<CachedCountryQuery, 'expiresAt'>,
): void {
  countryQueryCache.set(cacheKey, {
    ...data,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  if (countryQueryCache.size > 200) {
    const now = Date.now();
    for (const [key, val] of countryQueryCache.entries()) {
      if (val.expiresAt < now) countryQueryCache.delete(key);
    }
  }
}

export function getCachedCountryQuery(cacheKey: string): CachedCountryQuery | undefined {
  const cached = countryQueryCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    countryQueryCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

@injectable()
export class CountryInteractions {
  constructor(
    @inject(CountryService) private readonly countryService: CountryService,
    @inject(WorldMapGenerator) private readonly worldMapGenerator: WorldMapGenerator,
    @inject(UserService) private readonly userService: UserService,
  ) {}

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('country:')) return;

    const parts = customId.split(':');
    // Pattern 1: country:page:{action}:{type}:{cacheKey}:{page}:{callerDiscordUserId}
    // Pattern 2: country:toggle:{user|server}:{cacheKey}:{page}:{callerDiscordUserId}

    if (parts[1] === 'toggle') {
      const targetView = parts[2]; // 'user' or 'server'
      const cacheKey = parts[3]!;
      const pageIndex = parseInt(parts[4]!, 10) || 0;
      const callerDiscordUserId = parts[5]!;

      if (interaction.user.id !== callerDiscordUserId) {
        await interaction.reply({
          content: 'Only the user who initiated the command can interact with these controls.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const cached = getCachedCountryQuery(cacheKey);
      if (!cached) {
        await interaction.reply({
          content: 'This interaction has expired. Please run the command again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const isServerView = targetView === 'server';

      if (cached.type === 'top') {
        let countries: TopCountryItem[] = [];
        if (isServerView && cached.guildId) {
          const guildCountries = await this.countryService.getGuildTopCountriesAllTime(cached.guildId);
          countries = guildCountries.map(g => ({
            countryName: g.countryName,
            countryCode: g.countryCode,
            playcount: g.totalPlaycount,
            artistCount: g.listenerCount,
          }));
        } else if (cached.userId) {
          countries = await this.countryService.getUserTopCountriesAllTime(cached.userId);
        }

        cached.countries = countries;
        cached.isServerView = isServerView;
        storeCountryQuery(cacheKey, cached);

        const response = CountryBuilders.buildTopCountriesResponse({
          displayName: isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
          countries,
          periodDescription: cached.periodDescription ?? 'all-time',
          pageIndex: 0,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
          isServerView,
          guildId: cached.guildId,
        });

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container as any],
          });
        }
        return;
      }

      if (cached.type === 'info' && cached.country) {
        let artists: { name: string; playcount: number }[] = [];
        if (isServerView && cached.guildId) {
          artists = await this.countryService.getGuildArtistsForCountry(cached.guildId, cached.country.Code);
        } else if (cached.userId) {
          artists = await this.countryService.getUserArtistsForCountry(cached.userId, cached.country.Code);
        }

        cached.artists = artists;
        cached.isServerView = isServerView;
        storeCountryQuery(cacheKey, cached);

        const response = CountryBuilders.buildCountryArtistsResponse({
          country: cached.country,
          artists,
          isServerView,
          targetName: isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
          pageIndex: 0,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
          guildId: cached.guildId,
        });

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container as any],
          });
        }
        return;
      }

      return;
    }

    if (parts[1] === 'page') {
      const action = parts[2]; // 'first' | 'prev' | 'next' | 'last'
      const queryType = parts[3] as CountryInteractionType;
      const cacheKey = parts[4]!;
      const currentPage = parseInt(parts[5]!, 10) || 0;
      const callerDiscordUserId = parts[6]!;

      if (interaction.user.id !== callerDiscordUserId) {
        await interaction.reply({
          content: 'Only the user who initiated the command can interact with these controls.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const cached = getCachedCountryQuery(cacheKey);
      if (!cached) {
        await interaction.reply({
          content: 'This interaction has expired. Please run the command again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let newPage = currentPage;
      const pageSize = 10;

      if (queryType === 'top') {
        const totalPages = Math.ceil((cached.countries?.length || 0) / pageSize);
        if (action === 'first') newPage = 0;
        else if (action === 'prev') newPage = Math.max(0, currentPage - 1);
        else if (action === 'next') newPage = Math.min(totalPages - 1, currentPage + 1);
        else if (action === 'last') newPage = totalPages - 1;

        const response = CountryBuilders.buildTopCountriesResponse({
          displayName: cached.isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
          countries: cached.countries || [],
          periodDescription: cached.periodDescription || 'all-time',
          pageIndex: newPage,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
          isServerView: cached.isServerView,
          guildId: cached.guildId,
        });

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container as any],
          });
        }
      } else if (queryType === 'info' && cached.country) {
        const totalPages = Math.ceil((cached.artists?.length || 0) / pageSize);
        if (action === 'first') newPage = 0;
        else if (action === 'prev') newPage = Math.max(0, currentPage - 1);
        else if (action === 'next') newPage = Math.min(totalPages - 1, currentPage + 1);
        else if (action === 'last') newPage = totalPages - 1;

        const response = CountryBuilders.buildCountryArtistsResponse({
          country: cached.country,
          artists: cached.artists || [],
          isServerView: !!cached.isServerView,
          targetName: cached.isServerView ? (cached.serverName ?? 'Server') : (cached.displayName ?? 'User'),
          pageIndex: newPage,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
          guildId: cached.guildId,
        });

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container as any],
          });
        }
      } else if (queryType === 'wkc' && cached.country) {
        const totalPages = Math.ceil((cached.whoknowsItems?.length || 0) / pageSize);
        if (action === 'first') newPage = 0;
        else if (action === 'prev') newPage = Math.max(0, currentPage - 1);
        else if (action === 'next') newPage = Math.min(totalPages - 1, currentPage + 1);
        else if (action === 'last') newPage = totalPages - 1;

        const response = CountryBuilders.buildWhoKnowsCountryResponse({
          country: cached.country,
          serverName: cached.serverName || 'Server',
          items: cached.whoknowsItems || [],
          pageIndex: newPage,
          cacheKey,
          callerDiscordUserId,
          accentColor: cached.accentColor,
        });

        if (response.componentsV2Container) {
          await interaction.update({
            components: [response.componentsV2Container as any],
          });
        }
      }
    }
  }

  public async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    if (!customId.startsWith('country:theme:')) return;

    const parts = customId.split(':');
    const cacheKey = parts[2]!;
    const callerDiscordUserId = parts[3]!;

    if (interaction.user.id !== callerDiscordUserId) {
      await interaction.reply({
        content: 'Only the user who initiated the command can interact with these controls.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const cached = getCachedCountryQuery(cacheKey);
    if (!cached || !cached.countries) {
      await interaction.reply({
        content: 'This interaction has expired. Please run the command again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    const selectedThemeName = interaction.values[0]!;
    const theme = WorldMapGenerator.getThemeFromName(selectedThemeName);

    cached.currentTheme = theme;
    storeCountryQuery(cacheKey, cached);

    const imageBuffer = await this.worldMapGenerator.generateWorldMap(cached.countries, theme);

    const response = CountryBuilders.buildCountryChartResponse({
      displayName: cached.displayName || 'User',
      periodDescription: cached.periodDescription || 'all-time',
      imageBuffer,
      theme,
      callerDiscordUserId,
      cacheKey,
      accentColor: cached.accentColor,
    });

    if (response.componentsV2Container) {
      await interaction.editReply({
        files: [{ attachment: imageBuffer, name: 'artist-map.png' }],
        components: [response.componentsV2Container as any],
      });
    }
  }
}
