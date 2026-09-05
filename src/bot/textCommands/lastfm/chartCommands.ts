import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { ChartSettings, TitleSetting } from '@bot/models/chartModels';
import type { User } from '@persistence/domain/models/user';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { ChartService, TooManyImagesError } from '@bot/services/chartService';
import { NotEnoughAlbumsError } from '@bot/services/chartService';
import { ChartBuilders } from '@bot/builders/chartBuilders';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ColorService } from '@bot/services/colorService';

const CHART_COOLDOWN_MS = 40000;

const containsToken = (args: string[], tokens: string[]): number =>
  args.findIndex((a) => tokens.includes(a.toLowerCase()));

const removeAt = (args: string[], index: number): string[] =>
  args.filter((_, i) => i !== index);

export class ChartCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly chartService: ChartService;
  private readonly userService: UserService;
  private readonly settingService: SettingService;
  private readonly updateService: UpdateService;
  private readonly colorService?: ColorService;
  private readonly recentCharts: Map<string, number[]> = new Map();

  constructor(
    chartService: ChartService,
    userService: UserService,
    settingService: SettingService,
    updateService: UpdateService,
    colorService?: ColorService,
  ) {
    this.chartService = chartService;
    this.userService = userService;
    this.settingService = settingService;
    this.updateService = updateService;
    this.colorService = colorService;

    this.commands = [
      {
        name: 'chart',
        aliases: ['c', 'topster', 'topsters', 'aoty', 'albumsoftheyear', 'albumoftheyear'],
        executeAsync: (context, args) =>
          this.chartAsync(context, args, false),
      },
      {
        name: 'aotd',
        aliases: ['albumsofthedecade', 'albumofthedecade'],
        executeAsync: (context, args) => this.chartAsync(context, args, false),
      },
      {
        name: 'artistchart',
        aliases: ['ac', 'top'],
        executeAsync: (context, args) => this.chartAsync(context, args, true, false),
      },
      {
        name: 'trackchart',
        aliases: ['tc'],
        executeAsync: (context, args) => this.chartAsync(context, args, false, true),
      },
    ];
  }

  private checkCooldown(userId: string, max: number): boolean {
    const now = Date.now();
    const timestamps = (this.recentCharts.get(userId) ?? []).filter(
      (t) => now - t < CHART_COOLDOWN_MS,
    );

    if (timestamps.length >= max) {
      return false;
    }

    timestamps.push(now);
    this.recentCharts.set(userId, timestamps);
    return true;
  }

  private async chartAsync(
    context: ContextModel,
    rawArgs: string[],
    artistChart: boolean,
    trackChart: boolean = false,
  ): Promise<ResponseModel> {
    const invokedName = context.message?.content.slice(context.prefix.length).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const isAoty = ['aoty', 'albumsoftheyear', 'albumoftheyear'].includes(invokedName);
    const isAotd = ['aotd', 'albumsofthedecade', 'albumofthedecade'].includes(invokedName);

    const cooldownMax = trackChart || artistChart ? 3 : 4;
    if (!this.checkCooldown(context.discordUserId, cooldownMax)) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Cooldown,
        'Please wait a minute before generating charts again.',
      );
    }

    let args = [...rawArgs];

    let targetDiscordId = context.discordUserId;
    let requestedByOther: User | null = null;
    let targetDisplayName: string | undefined;

    const mentionMatch = args.find((a) => /^<@!?(\d+)>$/.test(a));
    if (mentionMatch) {
      const id = mentionMatch.replace(/[^\d]/g, '');
      args = removeAt(args, args.indexOf(mentionMatch));
      const target = await this.userService.getUserByDiscordId(id);
      if (!target) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      targetDiscordId = id;
      requestedByOther = target;
      try {
        const member = await context.message?.guild?.members.fetch(id).catch(() => null);
        targetDisplayName = member?.displayName ?? context.message?.guild?.members.cache.get(id)?.displayName;
      } catch { /* ignore */ }
    }

    const user =
      requestedByOther ??
      (await this.userService.getUserByDiscordId(context.discordUserId));
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const parsed = this.parseArgs(args);
    if (parsed.error) {
      return GenericEmbedService.buildWrongInputResponse(parsed.error);
    }

    try {
      const chartSettings = new ChartSettings();
      chartSettings.artistChart = artistChart;
      chartSettings.trackChart = trackChart;
      chartSettings.titleSetting = parsed.titles ?? TitleSetting.Titles;
      chartSettings.skipWithoutImage = parsed.skip ?? false;
      chartSettings.skipNsfw = parsed.sfw ?? false;
      chartSettings.rainbowSortingEnabled = parsed.rainbow ?? false;
      if (chartSettings.rainbowSortingEnabled) {
        chartSettings.skipWithoutImage = true;
      }
      chartSettings.filterSingles = parsed.noSingles ?? false;
      chartSettings.releaseYearFilter = parsed.releaseYear;
      chartSettings.releaseDecadeFilter = parsed.releaseDecade;
      if (parsed.timeSettings.searchValue) {
        chartSettings.filteredArtistName = parsed.timeSettings.searchValue;
      }
      chartSettings.timeSettings = parsed.timeSettings;
      chartSettings.timespanString = parsed.timeSettings.description;
      chartSettings.width = parsed.width;
      chartSettings.height = parsed.height;

      if (isAoty && chartSettings.releaseYearFilter === undefined) {
        chartSettings.releaseYearFilter = new Date().getUTCFullYear();
      }
      if (isAotd && chartSettings.releaseDecadeFilter === undefined) {
        chartSettings.releaseDecadeFilter = Math.floor(new Date().getUTCFullYear() / 10) * 10;
      }

      const chartResult = trackChart
        ? await this.chartService.generateTrackChart(
            targetDiscordId,
            user.userNameLastFm,
            chartSettings,
          )
        : artistChart
        ? await this.chartService.generateArtistChart(
            targetDiscordId,
            user.userNameLastFm,
            chartSettings,
          )
        : await this.chartService.generateAlbumChart(
            targetDiscordId,
            user.userNameLastFm,
            chartSettings,
          );

      this.userService.enqueueUserUpdate(user, 'Command' as never);

      const displayName =
        targetDisplayName ?? context.message?.member?.displayName ?? context.message?.author.username;
      // When a mention is used, show the target's name (not the invoker's) — fallback to LFM name
      const chartDisplayName = requestedByOther
        ? (targetDisplayName ?? user.userNameLastFm)
        : displayName;

      const accentColor = (requestedByOther && targetDiscordId && this.colorService)
        ? await this.colorService.getAccentColorAsync(targetDiscordId)
        : context.accentColor;

      return trackChart
        ? ChartBuilders.buildTrackChartResponse(
            user,
            chartDisplayName,
            chartResult,
            chartSettings,
            accentColor,
          )
        : artistChart
        ? ChartBuilders.buildArtistChartResponse(
            user,
            chartDisplayName,
            chartResult,
            chartSettings,
            accentColor,
          )
        : ChartBuilders.buildAlbumChartResponse(
            user,
            chartDisplayName,
            chartResult,
            chartSettings,
            accentColor,
          );
    } catch (err) {
      if (err instanceof NotEnoughAlbumsError) {
        return ChartBuilders.buildNotEnoughAlbumsError(err, trackChart ? 'track' : artistChart ? 'artist' : 'album');
      }
      if (err instanceof TooManyImagesError) {
        return GenericEmbedService.buildWrongInputResponse(
          'Charts are limited to 100 total images (`10x10`).',
        );
      }
      throw err;
    }
  }

  private parseArgs(args: string[]): {
    timeSettings: ReturnType<SettingService['getTimePeriod']>;
    titles?: TitleSetting;
    skip?: boolean;
    sfw?: boolean;
    rainbow?: boolean;
    noSingles?: boolean;
    releaseYear?: number;
    releaseDecade?: number;
    width: number;
    height: number;
    error?: string;
  } {
    let remaining = [...args];
    let size: string | undefined;

    const sizeIndex = remaining.findIndex((a) => /^\d+x\d+$/i.test(a));
    if (sizeIndex !== -1) {
      size = remaining[sizeIndex];
      remaining.splice(sizeIndex, 1);
    }

    let titles: TitleSetting | undefined;
    const noTitlesIndex = containsToken(remaining, ['notitles', 'nt']);
    if (noTitlesIndex !== -1) {
      titles = TitleSetting.TitlesDisabled;
      remaining = removeAt(remaining, noTitlesIndex);
    }

    let skip = false;
    const skipIndex = containsToken(remaining, [
      'skipemptyimages',
      'skipemptyalbums',
      'skipalbums',
      'skip',
      's',
    ]);
    if (skipIndex !== -1) {
      skip = true;
      remaining = removeAt(remaining, skipIndex);
    }

    let sfw = false;
    const sfwIndex = containsToken(remaining, ['sfw']);
    if (sfwIndex !== -1) {
      sfw = true;
      remaining = removeAt(remaining, sfwIndex);
    }

    let rainbow = false;
    const rainbowIndex = containsToken(remaining, ['rainbow', 'pride']);
    if (rainbowIndex !== -1) {
      rainbow = true;
      remaining = removeAt(remaining, rainbowIndex);
    }

    let noSingles = false;
    const singlesIndex = containsToken(remaining, [
      'ns',
      'nosingles',
      'hidesingles',
      'filtersingles',
    ]);
    if (singlesIndex !== -1) {
      noSingles = true;
      remaining = removeAt(remaining, singlesIndex);
    }

    let releaseYear: number | undefined;
    const yearIndex = remaining.findIndex((a) => /^(r|released):\d{4}$/i.test(a));
    if (yearIndex !== -1 && remaining[yearIndex]) {
      releaseYear = Number(remaining[yearIndex].split(':')[1]);
      remaining = removeAt(remaining, yearIndex);
    }

    let releaseDecade: number | undefined;
    const decadeIndex = remaining.findIndex((a) => /^(d|decade):\d{1,4}s?$/i.test(a));
    if (decadeIndex !== -1 && remaining[decadeIndex]) {
      let year = Number(remaining[decadeIndex].split(':')[1]?.replace(/s$/i, ''));
      if (year < 100) {
        year += year < 30 ? 2000 : 1900;
      }
      year = Math.floor(year / 10) * 10;
      if (year <= new Date().getUTCFullYear() && year >= 1900) {
        releaseDecade = year;
      }
      remaining = removeAt(remaining, decadeIndex);
    }

    const periodInput = remaining.join(' ').trim() || 'weekly';
    const timeSettings = this.settingService.getTimePeriod(periodInput);

    const dimensionProbe = new ChartSettings();
    const dimensions = ChartService.getDimensions(dimensionProbe, size);
    if (size && !dimensions.changed) {
      return {
        timeSettings: timeSettings,
        width: 0,
        height: 0,
        error:
          'Invalid chart size. Use a `widthxheight` format like `3x3`, up to 100 total images.',
      };
    }

    return {
      timeSettings: timeSettings,
      titles: titles,
      skip: skip,
      sfw: sfw,
      rainbow: rainbow,
      noSingles: noSingles,
      releaseYear: releaseYear,
      releaseDecade: releaseDecade,
      width: dimensions.chartSettings.width,
      height: dimensions.chartSettings.height,
    };
  }
}
