import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import {
  GuildRankingService,
  parseGuildRankingSettings,
  OrderType,
} from '@bot/services/guildRankingService';
import { ServerBuilders } from '@bot/builders/serverBuilders';
import { storeServerRankingQuery } from '@bot/interactions/serverInteractions';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class ServerSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(GuildRankingService) private readonly guildRankingService: GuildRankingService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('server')
          .setDescription('Server billboard commands')
          .addSubcommand((sub) =>
            sub
              .setName('artists')
              .setDescription('Top artists for your server')
              .addStringOption((opt) =>
                opt
                  .setName('time-period')
                  .setDescription('Time period (e.g. weekly, monthly, alltime)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'All-Time', value: 'alltime' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('order')
                  .setDescription('Order for chart (defaults to listeners)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Listeners', value: 'listeners' },
                    { name: 'Plays', value: 'plays' },
                  ),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('albums')
              .setDescription('Top albums for your server')
              .addStringOption((opt) =>
                opt
                  .setName('time-period')
                  .setDescription('Time period (e.g. weekly, monthly, alltime)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'All-Time', value: 'alltime' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('order')
                  .setDescription('Order for chart (defaults to listeners)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Listeners', value: 'listeners' },
                    { name: 'Plays', value: 'plays' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('artist')
                  .setDescription('The artist you want to filter on')
                  .setRequired(false)
                  .setAutocomplete(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('tracks')
              .setDescription('Top tracks for your server')
              .addStringOption((opt) =>
                opt
                  .setName('time-period')
                  .setDescription('Time period (e.g. weekly, monthly, alltime)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'All-Time', value: 'alltime' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('order')
                  .setDescription('Order for chart (defaults to listeners)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Listeners', value: 'listeners' },
                    { name: 'Plays', value: 'plays' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('artist')
                  .setDescription('The artist you want to filter on')
                  .setRequired(false)
                  .setAutocomplete(true),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('genres')
              .setDescription('Top genres for your server')
              .addStringOption((opt) =>
                opt
                  .setName('time-period')
                  .setDescription('Time period (e.g. weekly, monthly, alltime)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'All-Time', value: 'alltime' },
                  ),
              )
              .addStringOption((opt) =>
                opt
                  .setName('order')
                  .setDescription('Order for chart (defaults to listeners)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Listeners', value: 'listeners' },
                    { name: 'Plays', value: 'plays' },
                  ),
              ),
          ) as unknown as SlashCommandBuilder,
        executeAsync: (context) => this.handleSubcommandAsync(context),
      },
    ];
  }

  private async getAccentColor(context: ContextModel): Promise<number | undefined> {
    const guildColor = await this.colorService.getGuildAccentColorAsync(context.guildId);
    if (guildColor !== undefined && guildColor !== null) {
      return guildColor;
    }
    return this.colorService.getUserAccentColorAsync(context.discordUserId);
  }

  private async handleSubcommandAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const sub = context.interaction?.options.getSubcommand() ?? 'artists';
    const timePeriodOpt = context.interaction?.options.getString('time-period') ?? '';
    const orderOpt = context.interaction?.options.getString('order') ?? '';
    const artistOpt = context.interaction?.options.getString('artist') ?? '';

    let combinedOptions = `${timePeriodOpt} ${orderOpt}`.trim();

    if (sub === 'artists') {
      return this.serverArtistsSlashAsync(context, combinedOptions);
    }
    if (sub === 'albums') {
      if (artistOpt) combinedOptions = `${combinedOptions} ${artistOpt}`.trim();
      return this.serverAlbumsSlashAsync(context, combinedOptions, artistOpt || undefined);
    }
    if (sub === 'tracks') {
      if (artistOpt) combinedOptions = `${combinedOptions} ${artistOpt}`.trim();
      return this.serverTracksSlashAsync(context, combinedOptions, artistOpt || undefined);
    }
    if (sub === 'genres') {
      return this.serverGenresSlashAsync(context, combinedOptions);
    }

    return this.serverArtistsSlashAsync(context, combinedOptions);
  }

  private async serverArtistsSlashAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    const settings = parseGuildRankingSettings(extraOptions);
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopArtists(context.guildId!, settings);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopArtists(context.guildId!, {
        ...settings,
        startDateTime: settings.billboardStartDateTime,
        endDateTime: settings.billboardEndDateTime,
      });
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'artists',
      guildId: context.guildId!,
      serverName,
      settings,
      accentColor,
    });

    return ServerBuilders.buildServerLeaderboardResponse({
      type: 'artists',
      serverName,
      items,
      previousItems,
      settings,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
    });
  }

  private async serverAlbumsSlashAsync(
    context: ContextModel,
    extraOptions: string,
    explicitArtist?: string,
  ): Promise<ResponseModel> {
    const settings = parseGuildRankingSettings(extraOptions);
    const artistFilter = explicitArtist?.trim() || settings.newSearchValue;
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopAlbums(context.guildId!, settings, artistFilter);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopAlbums(
        context.guildId!,
        {
          ...settings,
          startDateTime: settings.billboardStartDateTime,
          endDateTime: settings.billboardEndDateTime,
        },
        artistFilter,
      );
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'albums',
      guildId: context.guildId!,
      serverName,
      settings,
      artistFilter,
      accentColor,
    });

    return ServerBuilders.buildServerLeaderboardResponse({
      type: 'albums',
      serverName,
      items,
      previousItems,
      settings,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
      artistFilter,
    });
  }

  private async serverTracksSlashAsync(
    context: ContextModel,
    extraOptions: string,
    explicitArtist?: string,
  ): Promise<ResponseModel> {
    const settings = parseGuildRankingSettings(extraOptions);
    const artistFilter = explicitArtist?.trim() || settings.newSearchValue;
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopTracks(context.guildId!, settings, artistFilter);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopTracks(
        context.guildId!,
        {
          ...settings,
          startDateTime: settings.billboardStartDateTime,
          endDateTime: settings.billboardEndDateTime,
        },
        artistFilter,
      );
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'tracks',
      guildId: context.guildId!,
      serverName,
      settings,
      artistFilter,
      accentColor,
    });

    return ServerBuilders.buildServerLeaderboardResponse({
      type: 'tracks',
      serverName,
      items,
      previousItems,
      settings,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
      artistFilter,
    });
  }

  private async serverGenresSlashAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    const settings = parseGuildRankingSettings(extraOptions);
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopGenres(context.guildId!, settings);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopGenres(context.guildId!, {
        ...settings,
        startDateTime: settings.billboardStartDateTime,
        endDateTime: settings.billboardEndDateTime,
      });
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'genres',
      guildId: context.guildId!,
      serverName,
      settings,
      accentColor,
    });

    return ServerBuilders.buildServerLeaderboardResponse({
      type: 'genres',
      serverName,
      items,
      previousItems,
      settings,
      pageIndex: 0,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
    });
  }
}
