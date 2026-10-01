import { SlashCommandBuilder } from 'discord.js';
import type {
  ISlashCommandModule,
  SlashCommandData,
} from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { ChartSettings, TitleSetting } from '@bot/models/chartModels';
import { ChartService } from '@bot/services/chartService';
import { NotEnoughAlbumsError, TooManyImagesError } from '@bot/services/chartService';
import { ChartBuilders } from '@bot/builders/chartBuilders';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/system/settingService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { User } from '@domain/interfaces/iuserRepository';

import { ColorService } from '@bot/services/system/colorService';

const notRegisteredResponse = (): ResponseModel =>
  GenericEmbedService.buildCommandErrorResponse(
    CommandResponse.NotFound,
    'You have not connected your Last.fm account yet. Use `/register` first.',
  );

/**
 * `1990`, `1990s`, `90` and `90s` all name the same decade, and the refusal
 * message promises two of those four. Two digits are expanded to the most
 * recent decade beginning with them that has ALREADY STARTED, so `90s` is the
 * 1990s today and the 2090s never. Returns undefined for anything else, which
 * the caller turns into a refusal rather than an ignored filter.
 */
const parseDecade = (raw: string): number | undefined => {
  const match = raw.trim().match(/^(\d{2}|\d{4})s?$/i);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const numeric = Number(digits);
  if (digits.length === 4) {
    return Math.floor(numeric / 10) * 10;
  }
  const currentYear = new Date().getFullYear();
  for (let century = Math.floor(currentYear / 100) * 100; century >= 1000; century -= 100) {
    if (century + numeric <= currentYear) {
      return century + numeric;
    }
  }
  return undefined;
};

export class ChartSlashCommands implements ISlashCommandModule {
  public commands: Array<{
    data: SlashCommandData;
    executeAsync: (context: ContextModel) => Promise<ResponseModel>;
  }>;

  private readonly chartService: ChartService;
  private readonly userService: UserService;
  private readonly settingService: SettingService;
  private readonly updateService: UpdateService;
  private readonly colorService?: ColorService;

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

    const albums = new SlashCommandBuilder()
      .setName('chart')
      .setDescription('Generate charts with album covers, artist images, or track covers')
      .addSubcommand((sub) =>
        sub
          .setName('albums')
          .setDescription('Generates an album image chart')
          .addStringOption((o) =>
            o.setName('time-period').setDescription('Time period').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o.setName('artist').setDescription('Filter to a specific artist').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('released')
              .setDescription('Filter to albums released in year'),
          )
          .addStringOption((o) =>
            o
              .setName('decade')
              .setDescription('Filter to albums released in decade'),
          )
          .addStringOption((o) =>
            o.setName('size').setDescription('Chart size (default 3x3)').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('titles')
              .setDescription('Title display setting')
              .addChoices(
                { name: 'Titles', value: 'Titles' },
                { name: 'No titles', value: 'TitlesDisabled' },
              ),
          )
          .addBooleanOption((o) =>
            o.setName('skip').setDescription('Skip albums without an image'),
          )
          .addBooleanOption((o) =>
            o.setName('hide-singles').setDescription('Hide singles from chart'),
          )
          .addBooleanOption((o) =>
            o.setName('rainbow').setDescription('Experimental rainbow sorting'),
          )
          .addUserOption((o) =>
            o.setName('user').setDescription('Discord user to show (defaults to self)'),
          )
          .addStringOption((o) =>
            o.setName('lfm').setDescription('Last.fm username (overrides Discord user)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('artists')
          .setDescription('Generates an artist image chart')
          .addStringOption((o) =>
            o.setName('time-period').setDescription('Time period').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o.setName('size').setDescription('Chart size (default 3x3)').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('titles')
              .setDescription('Title display setting')
              .addChoices(
                { name: 'Titles', value: 'Titles' },
                { name: 'No titles', value: 'TitlesDisabled' },
              ),
          )
          .addBooleanOption((o) =>
            o.setName('skip').setDescription('Skip artists without an image'),
          )
          .addBooleanOption((o) =>
            o.setName('rainbow').setDescription('Experimental rainbow sorting'),
          )
          .addUserOption((o) =>
            o.setName('user').setDescription('Discord user to show (defaults to self)'),
          )
          .addStringOption((o) =>
            o.setName('lfm').setDescription('Last.fm username (overrides Discord user)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('tracks')
          .setDescription('Generates a track image chart')
          .addStringOption((o) =>
            o.setName('time-period').setDescription('Time period').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o.setName('artist').setDescription('Filter to a specific artist').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o.setName('size').setDescription('Chart size (default 3x3)').setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('titles')
              .setDescription('Title display setting')
              .addChoices(
                { name: 'Titles', value: 'Titles' },
                { name: 'No titles', value: 'TitlesDisabled' },
              ),
          )
          .addBooleanOption((o) =>
            o.setName('skip').setDescription('Skip tracks without an image'),
          )
          .addBooleanOption((o) =>
            o.setName('rainbow').setDescription('Experimental rainbow sorting'),
          )
          .addUserOption((o) =>
            o.setName('user').setDescription('Discord user to show (defaults to self)'),
          )
          .addStringOption((o) =>
            o.setName('lfm').setDescription('Last.fm username (overrides Discord user)'),
          ),
      );

    this.commands = [
      {
        data: albums,
        executeAsync: (context) => this.executeAsync(context),
      },
    ];
  }

  private async executeAsync(context: ContextModel): Promise<ResponseModel> {
    const subcommand = context.interaction!.options.getSubcommand(false);
    if (subcommand === 'tracks') {
      return this.chartAsync(context, false, true);
    }
    return subcommand === 'artists'
      ? this.chartAsync(context, true, false)
      : this.chartAsync(context, false, false);
  }

  private async resolveChartUser(
    context: ContextModel,
  ): Promise<{ userNameLastFm: string; discordUserId: string; displayName?: string; totalPlayCount?: number } | ResponseModel> {
    // CORRECT AS IS, and all six catch sites in this method are one of two
    // shapes, neither of which is a swallowed query.
    //
    // `getString('user')` (the legacy option slot) is ARGUMENT COERCION: it
    // throws for an option the current builder no longer declares, which is a
    // property of the SlashCommandBuilder rather than anything a user did, and
    // the comment in `countrySlashCommands` / `interactionHandler.executeSlashCommand`
    // explains why laundering that into "the database is unavailable" is worse
    // than the null. `null` here is the honest "this command has no legacy slot",
    // and the code carries on with the modern options.
    //
    // The four `members.fetch(...).catch(() => null)` blocks plus their enclosing
    // catches are DISCORD READS whose only product is `displayName` - a label on
    // the card. Every one of them has a real fallback chain (`members.cache`,
    // then the Discord username, then the Last.fm name), so a missing permission
    // or a member who left costs a cosmetically less specific label. The chart
    // data itself comes from the album/chart pipeline further down, which is not
    // inside any of these try blocks.
    const discordTarget = context.interaction?.options.getUser('user');
    const rawLfm = context.interaction?.options.getString('lfm')?.trim() ?? null;
    const legacyUserString = (() => {
      try { return context.interaction?.options.getString('user')?.trim() ?? null; } catch { return null; }
    })();

    // 1) Discord user picker takes priority
    if (discordTarget) {
      const target = await this.userService.getUserByDiscordId(discordTarget.id);
      if (!target) {
        return GenericEmbedService.buildNotFoundResponse(
          `<@${discordTarget.id}> is not registered with the bot.`,
        );
      }
      let displayName: string | undefined;
      try {
        const fetched = await context.interaction?.guild?.members.fetch(discordTarget.id).catch(() => null);
        displayName = fetched?.displayName ?? context.interaction?.guild?.members.cache.get(discordTarget.id)?.displayName ?? discordTarget.username;
      } catch { displayName = discordTarget.username; }
      return {
        userNameLastFm: target.userNameLastFm,
        discordUserId: target.discordUserId,
        displayName,
        totalPlayCount: target.totalPlayCount ?? undefined,
      };
    }

    // 2) Explicit lfm string option
    if (rawLfm) {
      let lfm = rawLfm;
      if (lfm.toLowerCase().startsWith('lfm:')) lfm = lfm.slice(4).trim();
      if (lfm) {
        const target = await this.userService.getUserByLastFmName(lfm);
        if (!target) {
          return GenericEmbedService.buildNotFoundResponse(`**${lfm}** is not registered with the bot.`);
        }
        let displayName: string | undefined;
        try {
          const fetched = await context.interaction?.guild?.members.fetch(target.discordUserId).catch(() => null);
          displayName = fetched?.displayName ?? context.interaction?.guild?.members.cache.get(target.discordUserId)?.displayName ?? lfm;
        } catch { displayName = lfm; }
        return {
          userNameLastFm: target.userNameLastFm,
          discordUserId: target.discordUserId,
          displayName,
          totalPlayCount: target.totalPlayCount ?? undefined,
        };
      }
    }

    // 3) Legacy fallback: old 'user' string that may contain LFM name or mention
    if (legacyUserString) {
      const mentionMatch = legacyUserString.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        const target = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!target) {
          return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered with the bot.`);
        }
        let displayName: string | undefined;
        try {
          const fetched = await context.interaction?.guild?.members.fetch(mentionMatch[1]!).catch(() => null);
          displayName = fetched?.displayName ?? context.interaction?.guild?.members.cache.get(mentionMatch[1]!)?.displayName;
        } catch { /* ignore */ }
        return { userNameLastFm: target.userNameLastFm, discordUserId: target.discordUserId, displayName: displayName ?? target.userNameLastFm, totalPlayCount: target.totalPlayCount ?? undefined };
      }
      let lfm = legacyUserString;
      if (lfm.toLowerCase().startsWith('lfm:')) lfm = lfm.slice(4).trim();
      if (lfm) {
        const target = await this.userService.getUserByLastFmName(lfm);
        if (target) {
          let displayName: string | undefined;
          try {
            const fetched = await context.interaction?.guild?.members.fetch(target.discordUserId).catch(() => null);
            displayName = fetched?.displayName ?? context.interaction?.guild?.members.cache.get(target.discordUserId)?.displayName ?? lfm;
          } catch { displayName = lfm; }
          return { userNameLastFm: target.userNameLastFm, discordUserId: target.discordUserId, displayName, totalPlayCount: target.totalPlayCount ?? undefined };
        }
        return GenericEmbedService.buildNotFoundResponse(`**${lfm}** is not registered with the bot.`);
      }
    }

    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return notRegisteredResponse();
    }
    const member = context.interaction?.member as { displayName?: string } | null;
    return {
      userNameLastFm: user.userNameLastFm,
      // `context.discordUserId`, NOT `user.userId.toString()`. This value is
      // handed to `chartService.generate*Chart`, which looks it up again with
      // `getUserByDiscordId`, and it is the id the Edit button's customId is
      // keyed on. The database id was neither: every self-chart resolved to
      // nobody, so the button could never be built for the majority of charts.
      discordUserId: context.discordUserId,
      displayName: member?.displayName ?? context.interaction?.user.username,
      totalPlayCount: user.totalPlayCount ?? undefined,
    };
  }

  private buildSettings(context: ContextModel, artistChart: boolean): ChartSettings | ResponseModel {
    const interaction = context.interaction!;
    const timeSettings = this.settingService.getTimePeriod(
      interaction.options.getString('time-period') ?? 'weekly',
    );

    const chartSettings = new ChartSettings();
    const sizeResult = ChartService.getDimensions(
      chartSettings,
      interaction.options.getString('size'),
    );
    if (!sizeResult.changed && interaction.options.getString('size')) {
      return GenericEmbedService.buildWrongInputResponse(
        'Invalid chart size. Use a `widthxheight` format like `3x3`, up to 100 total images.',
      );
    }

    chartSettings.artistChart = artistChart;
    chartSettings.titleSetting =
      (interaction.options.getString('titles') as TitleSetting | null) ?? TitleSetting.Titles;
    chartSettings.skipWithoutImage = interaction.options.getBoolean('skip') ?? false;
    chartSettings.filterSingles = interaction.options.getBoolean('hide-singles') ?? false;
    chartSettings.rainbowSortingEnabled =
      interaction.options.getBoolean('rainbow') ?? false;
    if (chartSettings.rainbowSortingEnabled) {
      chartSettings.skipWithoutImage = true;
    }

    const yearInput = interaction.options.getString('released');
    if (yearInput && /^\d{4}$/.test(yearInput)) {
      chartSettings.releaseYearFilter = Number(yearInput);
    } else if (yearInput) {
      return GenericEmbedService.buildWrongInputResponse('`released` must be a four-digit year.');
    }

    const decadeInput = interaction.options.getString('decade');
    if (decadeInput) {
      const decade = parseDecade(decadeInput);
      if (decade === undefined) {
        return GenericEmbedService.buildWrongInputResponse(
          '`decade` must be a year or decade like `1990` or `90s`.',
        );
      }
      chartSettings.releaseDecadeFilter = decade;
    }

    chartSettings.filteredArtistName =
      interaction.options.getString('artist') ?? undefined;

    chartSettings.timeSettings = timeSettings;
    chartSettings.timespanString = timeSettings.description;

    return chartSettings;
  }

  private async chartAsync(context: ContextModel, artistChart: boolean, trackChart: boolean = false): Promise<ResponseModel> {
    try {
      const chartUser = await this.resolveChartUser(context);
      if (chartUser instanceof ResponseModel) {
        return chartUser;
      }

      const built = this.buildSettings(context, artistChart);
      if (built instanceof ResponseModel) {
        return built;
      }

      built.trackChart = trackChart;

      const requestingUser = await this.userService.getUserByDiscordId(
        context.discordUserId,
      );

      if (requestingUser && UpdateService.needsUpdate(requestingUser, 2)) {
        void this.updateService.updateUser(requestingUser.userId, { accurateTotal: true });
      }

      const chartResult = trackChart
        ? await this.chartService.generateTrackChart(
            chartUser.discordUserId,
            chartUser.userNameLastFm,
            built,
          )
        : artistChart
        ? await this.chartService.generateArtistChart(
            chartUser.discordUserId,
            chartUser.userNameLastFm,
            built,
          )
        : await this.chartService.generateAlbumChart(
            chartUser.discordUserId,
            chartUser.userNameLastFm,
            built,
          );

      if (requestingUser) {
        this.userService.enqueueUserUpdate(requestingUser, 'Command' as never);
      }

      // `discordUserId` is the creator id the Edit button's customId is keyed
      // on; `ChartInteractions.handleEditButton` compares it with the pressing
      // user's id, so leaving it off makes the button refuse everyone, the
      // creator included.
      const author = {
        userNameLastFm: chartUser.userNameLastFm,
        discordUserId: chartUser.discordUserId,
        totalPlayCount: chartUser.totalPlayCount ?? requestingUser?.totalPlayCount,
      } as User;

      let accentColor: number | undefined;
      if (this.colorService) {
        if (chartResult.buffer) {
          accentColor = await this.colorService.extractAccentColor(chartResult.buffer);
        } else if (chartResult.imageUrl) {
          accentColor = await this.colorService.getColorFromImageUrl(chartResult.imageUrl);
        }
      }

      return trackChart
        ? ChartBuilders.buildTrackChartResponse(
            author,
            chartUser.displayName,
            chartResult,
            built,
            accentColor,
          )
        : artistChart
        ? ChartBuilders.buildArtistChartResponse(
            author,
            chartUser.displayName,
            chartResult,
            built,
            accentColor,
          )
        : ChartBuilders.buildAlbumChartResponse(
            author,
            chartUser.displayName,
            chartResult,
            built,
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
}
