import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import {
  GuildRankingService,
  parseGuildRankingSettings,
} from '@bot/services/guild/guildRankingService';
import { ServerBuilders } from '@bot/builders/serverBuilders';
import { storeServerRankingQuery } from '@bot/interactions/serverInteractions';
import { ColorService } from '@bot/services/system/colorService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { Logger } from '@domain/logger';
import { DiscordConstants } from '@bot/resources/discordConstants';

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

  /**
   * The guild icon's colour, or the brand red. NEVER a reason the command
   * fails.
   *
   * This awaited `colorService.getColorFromImageUrl` with no guard, so a single
   * failed colour read took down all four rankings — including the rows, which
   * are correct, and including the honest "this server has nothing in the
   * window" card for a server that genuinely has nothing in the window. An
   * accent is decoration, and `AGENTS.md` §3.6 says the same about chapter and
   * artwork state: it must never break the answer.
   *
   * `await` is INSIDE the try, deliberately. `return promise` inside a try block
   * hands a rejected promise straight to the caller, which is the failure mode
   * `artistsService.test.ts:491` documents. The fallback is the Last.fm red
   * rather than `undefined`, because `ServerBuilders` only sets a container
   * accent when one was supplied and dropping it would be a second, quieter
   * change to the card.
   */
  private async getAccentColor(context: ContextModel): Promise<number> {
    const iconUrl = context.guild?.iconURL();
    if (!iconUrl) {
      return DiscordConstants.LastFmColorRed;
    }

    try {
      return await this.colorService.getColorFromImageUrl(iconUrl);
    } catch (err) {
      // Expected-but-notable, so DEBUG rather than WARN: the ranking that this
      // decoration was refining is still on its way, and an unreadable guild
      // icon is not a lost capability worth waking the operator for.
      Logger.debug({ err, iconUrl }, 'serverCommands: guild icon accent lookup failed');
      return DiscordConstants.LastFmColorRed;
    }
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
