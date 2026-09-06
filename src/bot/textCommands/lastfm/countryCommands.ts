import { injectable, inject } from 'tsyringe';
import crypto from 'crypto';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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

@injectable()
export class CountryCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

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
        name: 'topcountries',
        aliases: ['cl', 'tc', 'countrylist', 'countries', 'countrieslist'],
        executeAsync: (ctx, args) => this.topCountriesAsync(ctx, args.join(' ')),
      },
      {
        name: 'country',
        aliases: ['from', 'countryinfo', 'ci'],
        executeAsync: (ctx, args) => this.countryInfoAsync(ctx, args.join(' ')),
      },
      {
        name: 'whoknowscountry',
        aliases: ['wkc', 'wkcountry', 'whoknowsc'],
        executeAsync: (ctx, args) => this.whoKnowsCountryAsync(ctx, args.join(' ')),
      },
      {
        name: 'countrychart',
        aliases: ['cc', 'worldmap', 'artistmap'],
        executeAsync: (ctx, args) => this.countryChartAsync(ctx, args.join(' ')),
      },
    ];
  }

  private parseUserAndQuery(raw: string): { userStr: string | null; cleanQuery: string } {
    const tokens = raw.split(/\s+/).filter(Boolean);
    let userStr: string | null = null;
    const mention = tokens.find(t => /^<@!?\d+>$/.test(t));
    if (mention) userStr = mention;
    else {
      const lfm = tokens.find(t => t.toLowerCase().startsWith('lfm:'));
      if (lfm) userStr = lfm;
    }

    let cleanQuery = raw;
    if (userStr) {
      cleanQuery = cleanQuery.replace(userStr, '').trim();
    }
    return { userStr, cleanQuery };
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
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }
    const member = context.guild?.members.cache.get(context.discordUserId);
    return {
      userNameLastFm: caller.userNameLastFm,
      displayName: member?.displayName ?? caller.userNameLastFm,
      userId: caller.userId,
    };
  }

  public async topCountriesAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    const { userStr, cleanQuery } = this.parseUserAndQuery(extraOptions);
    const userRes = await this.resolveUser(context, userStr);
    if ('commandResponse' in userRes) return userRes;

    const timeSettings = this.settingService.getTimePeriod(cleanQuery);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let countries: TopCountryItem[] = [];

    // If all time and user has DB ID, query indexed raw SQL for lightning fast results
    if (userRes.userId && (timeSettings.timePeriod === undefined || cleanQuery.includes('alltime') || cleanQuery.includes('overall'))) {
      countries = await this.countryService.getUserTopCountriesAllTime(userRes.userId);
    }

    // If still empty or time-scoped, fetch from Last.fm top artists and map
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

  public async countryInfoAsync(context: ContextModel, rawInput: string): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;
    let target = rawInput.trim();

    // If no argument, resolve the current playing track's artist
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
        `Please specify a country or artist name, e.g.: \`${context.prefix}country Japan\` or \`${context.prefix}country Radiohead\`.`,
      );
    }

    // 1) Check if target matches a valid country
    const foundCountry = this.countryService.searchCountry(target);

    if (foundCountry) {
      // User is requesting top artists for this country
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

    // 2) Otherwise treat target as an artist name
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

  public async whoKnowsCountryAsync(context: ContextModel, rawInput: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used inside a server.',
      );
    }

    const countryInput = rawInput.trim();
    if (!countryInput) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify a country, e.g.: \`${context.prefix}whoknowscountry Japan\` or \`${context.prefix}wkc UK\`.`,
      );
    }

    const country = this.countryService.searchCountry(countryInput);
    if (!country) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Could not find a country matching **${countryInput}**.`,
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

  public async countryChartAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    const { userStr, cleanQuery } = this.parseUserAndQuery(extraOptions);
    const userRes = await this.resolveUser(context, userStr);
    if ('commandResponse' in userRes) return userRes;

    // Detect theme from options
    let theme = CountryChartTheme.Dark;
    const themeMatch = cleanQuery.match(/\b(light|ocean|synthwave|sunset|forest|dark)\b/i);
    let remainingQuery = cleanQuery;
    if (themeMatch) {
      theme = WorldMapGenerator.getThemeFromName(themeMatch[1]);
      remainingQuery = remainingQuery.replace(themeMatch[0], '').trim();
    }

    const timeSettings = this.settingService.getTimePeriod(remainingQuery);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let countries: TopCountryItem[] = [];

    if (userRes.userId && (timeSettings.timePeriod === undefined || cleanQuery.includes('alltime') || cleanQuery.includes('overall'))) {
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
