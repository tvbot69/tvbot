import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import {
  GuildRankingService,
  parseGuildRankingSettings,
} from '@bot/services/guildRankingService';
import { ServerBuilders } from '@bot/builders/serverBuilders';
import { storeServerRankingQuery } from '@bot/interactions/serverInteractions';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class ServerCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(GuildRankingService) private readonly guildRankingService: GuildRankingService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        name: 'serverartists',
        aliases: ['sa', 'sta', 'servertopartists', 'serverartist'],
        executeAsync: (context, args) => this.serverArtistsAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'serveralbums',
        aliases: ['sab', 'stab', 'servertopalbums', 'serveralbum'],
        executeAsync: (context, args) => this.serverAlbumsAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'servertracks',
        aliases: ['st', 'bb', 'billboard', 'servertoptracks', 'servertrack'],
        executeAsync: (context, args) => this.serverTracksAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'servergenres',
        aliases: ['sg', 'sgenres', 'servergenre', 'serverg'],
        executeAsync: (context, args) => this.serverGenresAsync(context, args?.join(' ') ?? ''),
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

  private async serverArtistsAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const settings = parseGuildRankingSettings(extraOptions);
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopArtists(context.guildId, settings);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopArtists(context.guildId, {
        ...settings,
        startDateTime: settings.billboardStartDateTime,
        endDateTime: settings.billboardEndDateTime,
      });
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'artists',
      guildId: context.guildId,
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

  private async serverAlbumsAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const settings = parseGuildRankingSettings(extraOptions);
    const artistFilter = settings.newSearchValue;
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopAlbums(context.guildId, settings, artistFilter);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopAlbums(
        context.guildId,
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
      guildId: context.guildId,
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

  private async serverTracksAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const settings = parseGuildRankingSettings(extraOptions);
    const artistFilter = settings.newSearchValue;
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopTracks(context.guildId, settings, artistFilter);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopTracks(
        context.guildId,
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
      guildId: context.guildId,
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

  private async serverGenresAsync(context: ContextModel, extraOptions: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const settings = parseGuildRankingSettings(extraOptions);
    const serverName = context.guild?.name ?? 'Server';
    const accentColor = await this.getAccentColor(context);

    const items = await this.guildRankingService.getGuildTopGenres(context.guildId, settings);

    let previousItems = null;
    if (settings.billboardStartDateTime) {
      previousItems = await this.guildRankingService.getGuildTopGenres(context.guildId, {
        ...settings,
        startDateTime: settings.billboardStartDateTime,
        endDateTime: settings.billboardEndDateTime,
      });
    }

    const cacheKey = Math.random().toString(36).substring(2, 10);
    storeServerRankingQuery(cacheKey, {
      type: 'genres',
      guildId: context.guildId,
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
