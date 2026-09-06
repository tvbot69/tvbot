import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import crypto from 'crypto';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { CountryService, TopCountryItem } from '@bot/services/countryService';
import { CountryBuilders } from '@bot/builders/countryBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ColorService } from '@bot/services/colorService';
import { storeCountryQuery } from '@bot/interactions/countryInteractions';
import { CountryChartTheme, WorldMapGenerator } from '@images/generators/worldMapGenerator';

const periodChoices = [
  { name: 'Weekly (7 days)', value: 'weekly' },
  { name: 'Monthly (1 month)', value: 'monthly' },
  { name: 'Quarterly (3 months)', value: 'quarterly' },
  { name: 'Half-yearly (6 months)', value: 'halfyearly' },
  { name: 'Yearly (1 year)', value: 'yearly' },
  { name: 'Overall (All time)', value: 'overall' },
];

const themeChoices = [
  { name: 'Dark', value: 'dark' },
  { name: 'Light', value: 'light' },
  { name: 'Ocean', value: 'ocean' },
  { name: 'Synthwave', value: 'synthwave' },
  { name: 'Sunset', value: 'sunset' },
  { name: 'Forest', value: 'forest' },
];

@injectable()
export class CountrySlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(CountryService) private readonly countryService: CountryService,
    @inject(WorldMapGenerator) private readonly worldMapGenerator: WorldMapGenerator,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('country')
          .setDescription('Country statistics, overviews, and world artist map')
          .addSubcommand((sub) =>
            sub
              .setName('top')
              .setDescription('Shows top artist countries for you or someone else')
              .addStringOption((opt) =>
                opt
                  .setName('period')
                  .setDescription('Time period')
                  .setRequired(false)
                  .addChoices(...periodChoices),
              )
              .addStringOption((opt) =>
                opt
                  .setName('user')
                  .setDescription('User to show (default: yourself)')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('info')
              .setDescription('Country for artist or top artists for country')
              .addStringOption((opt) =>
                opt
                  .setName('search')
                  .setDescription('The country or artist you want to view')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('whoknows')
              .setDescription('Shows who in the server listens to artists from a country')
              .addStringOption((opt) =>
                opt
                  .setName('country')
                  .setDescription('The country name or code')
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('chart')
              .setDescription('Generates a map of the locations of your top artists')
              .addStringOption((opt) =>
                opt
                  .setName('period')
                  .setDescription('Time period')
                  .setRequired(false)
                  .addChoices(...periodChoices),
              )
              .addStringOption((opt) =>
                opt
                  .setName('theme')
                  .setDescription('Map theme')
                  .setRequired(false)
                  .addChoices(...themeChoices),
              )
              .addStringOption((opt) =>
                opt
                  .setName('user')
                  .setDescription('User to show (default: yourself)')
                  .setRequired(false),
              ),
          ) as any,
        executeAsync: (ctx) => this.handleCountrySlash(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('topcountries')
          .setDescription('Shows a list of your top artist countries')
          .addStringOption((opt) =>
            opt
              .setName('period')
              .setDescription('Time period')
              .setRequired(false)
              .addChoices(...periodChoices),
          )
          .addStringOption((opt) =>
            opt
              .setName('user')
              .setDescription('User to show (default: yourself)')
              .setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.handleTopCountriesSlash(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('countrychart')
          .setDescription('Generates a map of the locations of your top artists')
          .addStringOption((opt) =>
            opt
              .setName('period')
              .setDescription('Time period')
              .setRequired(false)
              .addChoices(...periodChoices),
          )
          .addStringOption((opt) =>
            opt
              .setName('theme')
              .setDescription('Color theme for the map')
              .setRequired(false)
              .addChoices(...themeChoices),
          )
          .addStringOption((opt) =>
            opt
              .setName('user')
              .setDescription('User to show (default: yourself)')
              .setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.handleCountryChartSlash(ctx),
      },
    ];
  }

  private async handleCountrySlash(context: ContextModel): Promise<ResponseModel> {
    const subcommand = context.interaction?.options.getSubcommand() ?? 'top';

    if (subcommand === 'top') {
      return this.handleTopCountriesSlash(context);
    }
    if (subcommand === 'info') {
      const search = context.interaction?.options.getString('search') ?? '';
      return this.handleCountryInfoSlash(context, search);
    }
    if (subcommand === 'whoknows') {
      const countryStr = context.interaction?.options.getString('country') ?? '';
      return this.handleWhoKnowsCountrySlash(context, countryStr);
    }
    if (subcommand === 'chart') {
      return this.handleCountryChartSlash(context);
    }

    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.WrongInput,
      'Unknown subcommand.',
    );
  }

  private async resolveUser(
    context: ContextModel,
    rawUser: string | null,
  ): Promise<{ userNameLastFm: string; displayName: string; userId?: number } | ResponseModel> {
    if (rawUser) {
      const mentionMatch = rawUser.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const u = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!u) return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered.`);
        const member = context.guild?.members.cache.get(mentionMatch[1]!);
        return {
          userNameLastFm: u.userNameLastFm,
          displayName: member?.displayName ?? u.userNameLastFm,
          userId: u.userId,
        };
      }
      if (rawUser.toLowerCase().startsWith('lfm:')) {
        const lfm = rawUser.slice(4).trim().split(/\s+/)[0]!;
        const u = await this.userService.getUserByLastFmName(lfm);
        return { userNameLastFm: lfm, displayName: lfm, userId: u?.userId };
      }
      const u = await this.userService.getUserByLastFmName(rawUser.trim());
      if (u) {
        return { userNameLastFm: u.userNameLastFm, displayName: u.userNameLastFm, userId: u.userId };
      }
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }
    const member = context.guild?.members.cache.get(context.discordUserId);
    return {
      userNameLastFm: caller.userNameLastFm,
      displayName: member?.displayName ?? caller.userNameLastFm,
      userId: caller.userId,
    };
  }

  private async handleTopCountriesSlash(context: ContextModel): Promise<ResponseModel> {
    const rawUser = context.interaction?.options.getString('user') ?? null;
    const periodOpt = context.interaction?.options.getString('period') ?? '';

    const userRes = await this.resolveUser(context, rawUser);
    if ('commandResponse' in userRes) return userRes;

    const timeSettings = this.settingService.getTimePeriod(periodOpt);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let countries: TopCountryItem[] = [];

    if (userRes.userId && (timeSettings.timePeriod === undefined || periodOpt === 'overall')) {
      countries = await this.countryService.getUserTopCountriesAllTime(userRes.userId);
    }

    if (countries.length === 0) {
      try {
        const topArtists = await this.lastfmRepository.getTopArtists(
          userRes.userNameLastFm,
          timeSettings.timePeriod,
          1000,
        );
        countries = await this.countryService.getTopCountriesForTopArtists(topArtists, true);
      } catch {
        countries = [];
      }
    }

    const cacheKey = crypto.randomBytes(6).toString('hex');
    storeCountryQuery(cacheKey, {
      type: 'top',
      displayName: userRes.displayName,
      countries,
      periodDescription: timeSettings.description,
      isServerView: false,
      accentColor,
      guildId: context.guild?.id ?? null,
      serverName: context.guild?.name ?? 'Server',
      userId: userRes.userId,
    });

    return CountryBuilders.buildTopCountriesResponse({
      displayName: userRes.displayName,
      countries,
      periodDescription: timeSettings.description,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
      isServerView: false,
      guildId: context.guild?.id ?? null,
    });
  }

  private async handleCountryInfoSlash(context: ContextModel, search: string): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use \`/register\` first.`,
      );
    }

    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;
    let target = search.trim();

    if (!target) {
      try {
        const recents = await this.lastfmRepository.getUserRecentTracks(caller.userNameLastFm, 1);
        if (recents && recents.length > 0 && recents[0]?.artistName) {
          target = recents[0].artistName;
        }
      } catch {
        // ignore
      }
    }

    if (!target) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'Please specify a country or artist name.',
      );
    }

    const foundCountry = this.countryService.searchCountry(target);

    if (foundCountry) {
      let artists: { name: string; playcount: number }[] = [];
      if (caller.userId) {
        artists = await this.countryService.getUserArtistsForCountry(caller.userId, foundCountry.Code);
      }

      const cacheKey = crypto.randomBytes(6).toString('hex');
      storeCountryQuery(cacheKey, {
        type: 'info',
        displayName: caller.userNameLastFm,
        country: foundCountry,
        artists,
        isServerView: false,
        accentColor,
        guildId: context.guild?.id ?? null,
        serverName: context.guild?.name ?? 'Server',
        userId: caller.userId,
      });

      return CountryBuilders.buildCountryArtistsResponse({
        country: foundCountry,
        artists,
        isServerView: false,
        targetName: caller.userNameLastFm,
        pageIndex: 0,
        cacheKey,
        callerDiscordUserId: context.discordUserId,
        accentColor,
        guildId: context.guild?.id ?? null,
      });
    }

    const info = await this.countryService.getArtistInfoWithCountry(target);

    let playcount: number | undefined;
    try {
      const artistInfo = await this.lastfmRepository.getArtistInfo(target, caller.userNameLastFm);
      if (typeof artistInfo?.userPlayCount === 'number') {
        playcount = artistInfo.userPlayCount;
      }
    } catch {
      // ignore
    }

    return CountryBuilders.buildArtistCountryInfoResponse({
      artistName: target,
      country: info.country,
      spotifyImageUrl: info.spotifyImageUrl,
      userPlaycount: playcount,
      accentColor,
    });
  }

  private async handleWhoKnowsCountrySlash(context: ContextModel, countryStr: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used inside a server.',
      );
    }

    const country = this.countryService.searchCountry(countryStr);
    if (!country) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Could not find a country matching **${countryStr}**.`,
      );
    }

    const accentColor = context.guild.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;
    const items = await this.countryService.getGuildUsersForCountry(context.guild.id, country.Code);

    const cacheKey = crypto.randomBytes(6).toString('hex');
    storeCountryQuery(cacheKey, {
      type: 'wkc',
      country,
      serverName: context.guild.name,
      whoknowsItems: items,
      accentColor,
      guildId: context.guild.id,
    });

    return CountryBuilders.buildWhoKnowsCountryResponse({
      country,
      serverName: context.guild.name,
      items,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
    });
  }

  private async handleCountryChartSlash(context: ContextModel): Promise<ResponseModel> {
    const rawUser = context.interaction?.options.getString('user') ?? null;
    const periodOpt = context.interaction?.options.getString('period') ?? '';
    const themeOpt = context.interaction?.options.getString('theme') ?? 'dark';

    const userRes = await this.resolveUser(context, rawUser);
    if ('commandResponse' in userRes) return userRes;

    const theme = WorldMapGenerator.getThemeFromName(themeOpt);
    const timeSettings = this.settingService.getTimePeriod(periodOpt);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let countries: TopCountryItem[] = [];

    if (userRes.userId && (timeSettings.timePeriod === undefined || periodOpt === 'overall')) {
      countries = await this.countryService.getUserTopCountriesAllTime(userRes.userId);
    }

    if (countries.length === 0) {
      try {
        const topArtists = await this.lastfmRepository.getTopArtists(
          userRes.userNameLastFm,
          timeSettings.timePeriod,
          1000,
        );
        countries = await this.countryService.getTopCountriesForTopArtists(topArtists, true);
      } catch {
        countries = [];
      }
    }

    if (countries.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No country data found for **${userRes.displayName}** in the selected time period.`,
      );
    }

    const imageBuffer = await this.worldMapGenerator.generateWorldMap(countries, theme);
    const cacheKey = crypto.randomBytes(6).toString('hex');

    storeCountryQuery(cacheKey, {
      type: 'chart',
      displayName: userRes.displayName,
      countries,
      periodDescription: timeSettings.description,
      currentTheme: theme,
      accentColor,
      userId: userRes.userId,
    });

    return CountryBuilders.buildCountryChartResponse({
      displayName: userRes.displayName,
      periodDescription: timeSettings.description,
      imageBuffer,
      theme,
      callerDiscordUserId: context.discordUserId,
      cacheKey,
      accentColor,
    });
  }
}
