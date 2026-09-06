import { injectable, inject } from 'tsyringe';
import crypto from 'crypto';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { GenreService } from '@bot/services/genreService';
import { GenreBuilders } from '@bot/builders/genreBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ColorService } from '@bot/services/colorService';
import { storeGenreQuery } from '@bot/interactions/genreInteractions';

@injectable()
export class GenreCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(GenreService) private readonly genreService: GenreService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'topgenres',
        aliases: ['gl', 'tg', 'genrelist', 'genres', 'genreslist'],
        executeAsync: (ctx, args) => this.topGenresAsync(ctx, args.join(' ')),
      },
      {
        name: 'genre',
        aliases: ['genreinfo', 'gi', 'g'],
        executeAsync: (ctx, args) => this.genreInfoAsync(ctx, args.join(' ')),
      },
      {
        name: 'whoknowsgenre',
        aliases: ['wg', 'wkg', 'wkgenre'],
        executeAsync: (ctx, args) => this.whoKnowsGenreAsync(ctx, args.join(' ')),
      },
      {
        name: 'artistgenres',
        aliases: ['ag'],
        executeAsync: (ctx, args) => this.artistGenresAsync(ctx, args.join(' ')),
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

  private async topGenresAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    const { userStr, cleanQuery } = this.parseUserAndQuery(rawArgs);
    const resolved = await this.resolveUser(context, userStr);
    if ('commandResponse' in resolved) return resolved;

    const timePeriodResult = this.settingService.getTimePeriod(cleanQuery);
    const period = timePeriodResult.timePeriod; // TimePeriod enum or undefined
    const periodDescription = timePeriodResult.description;

    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let genres: { genreName: string; userPlaycount: number; topArtists?: string[] }[] = [];

    if (period === undefined || cleanQuery.includes('alltime') || cleanQuery.includes('overall')) {
      if (resolved.userId) {
        genres = await this.genreService.getTopGenresForUserAllTime(resolved.userId, 100);
      }
    }

    if (genres.length === 0) {
      // Fetch user's top artists for this time period via Last.fm API
      const topArtists = await this.lastfmRepository.getTopArtists(
        resolved.userNameLastFm,
        period,
        150,
      );

      if (topArtists && topArtists.length > 0) {
        const artistItems = topArtists.map(a => ({
          name: a.name,
          playcount: a.playcount ?? 0,
        }));
        genres = await this.genreService.getTopGenresForTopArtists(artistItems, 100);
      }
    }

    const cacheKey = crypto.randomUUID().slice(0, 8);
    storeGenreQuery(cacheKey, {
      type: 'top',
      displayName: resolved.displayName,
      genres,
      periodDescription,
      accentColor,
    });

    return GenreBuilders.buildTopGenresResponse({
      displayName: resolved.displayName,
      genres,
      periodDescription,
      pageIndex: 0,
      pageSize: 10,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
    });
  }

  private async genreInfoAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    let query = rawArgs.trim();

    if (!query) {
      // Pick current playing / recent track
      const caller = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!caller) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
        );
      }

      const recent = await this.lastfmRepository.getUserRecentTracks(caller.userNameLastFm, 1);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'No recent tracks found to detect an artist or genre.',
        );
      }
      query = recent[0]!.artistName;
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    // Check if query is an artist
    const artistGenres = await this.genreService.getGenresForArtist(query);
    const isDirectGenre = artistGenres.length === 0;

    if (!isDirectGenre && artistGenres.length > 0) {
      // The user searched for an artist -> show artist's genres/tags
      return GenreBuilders.buildArtistGenresResponse(query, artistGenres, accentColor);
    }

    // Otherwise, treat as genre query
    const genreName = query;
    let userArtists: { artistName: string; userPlaycount: number }[] = [];
    if (caller) {
      userArtists = await this.genreService.getUserArtistsForGenre(caller.userId, genreName, 50);
    }

    const cacheKey = crypto.randomUUID().slice(0, 8);
    const member = context.guild?.members.cache.get(context.discordUserId);
    const displayName = member?.displayName ?? caller?.userNameLastFm ?? 'User';

    storeGenreQuery(cacheKey, {
      type: 'info',
      genreName,
      displayName,
      artists: userArtists,
      isServerView: false,
      accentColor,
      guildId: context.guild?.id ?? null,
      serverName: context.guild?.name ?? 'Server',
      userId: caller?.userId,
    });

    return GenreBuilders.buildGenreArtistsResponse({
      genreName,
      artists: userArtists,
      isServerView: false,
      targetName: displayName,
      pageIndex: 0,
      pageSize: 10,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
      guildId: context.guild?.id ?? null,
    });
  }

  private async whoKnowsGenreAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used within a server.',
      );
    }

    let genreName = rawArgs.trim();
    if (!genreName) {
      const caller = await this.userService.getUserByDiscordId(context.discordUserId);
      if (caller) {
        const recent = await this.lastfmRepository.getUserRecentTracks(caller.userNameLastFm, 1);
        if (recent?.length) {
          const artistTags = await this.genreService.getGenresForArtist(recent[0]!.artistName);
          if (artistTags.length) {
            genreName = artistTags[0]!;
          }
        }
      }
    }

    if (!genreName) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify a genre. Example: \`${context.prefix}whoknowsgenre indie rock\``,
      );
    }

    const items = await this.genreService.getGuildUsersForGenre(context.guild.id, genreName);
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    const cacheKey = crypto.randomUUID().slice(0, 8);
    storeGenreQuery(cacheKey, {
      type: 'whoknows',
      genreName,
      serverName: context.guild.name,
      whoknowsItems: items,
      accentColor,
      guildId: context.guild.id,
    });

    return GenreBuilders.buildWhoKnowsGenreResponse({
      genreName,
      serverName: context.guild.name,
      items,
      pageIndex: 0,
      pageSize: 12,
      cacheKey,
      callerDiscordUserId: context.discordUserId,
      accentColor,
    });
  }

  private async artistGenresAsync(context: ContextModel, rawArgs: string): Promise<ResponseModel> {
    let artistName = rawArgs.trim();

    if (!artistName) {
      const caller = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!caller) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
        );
      }

      const recent = await this.lastfmRepository.getUserRecentTracks(caller.userNameLastFm, 1);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'No recent tracks found to detect an artist.',
        );
      }
      artistName = recent[0]!.artistName;
    }

    const genres = await this.genreService.getGenresForArtist(artistName);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    return GenreBuilders.buildArtistGenresResponse(artistName, genres, accentColor);
  }
}
