import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import crypto from 'crypto';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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

const periodChoices = [
  { name: 'Weekly (7 days)', value: 'weekly' },
  { name: 'Monthly (1 month)', value: 'monthly' },
  { name: 'Quarterly (3 months)', value: 'quarterly' },
  { name: 'Half-yearly (6 months)', value: 'halfyearly' },
  { name: 'Yearly (1 year)', value: 'yearly' },
  { name: 'Overall (All time)', value: 'overall' },
];

@injectable()
export class GenreSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(GenreService) private readonly genreService: GenreService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('genre')
          .setDescription('Genre statistics, overviews, and WhoKnows')
          .addSubcommand((sub) =>
            sub
              .setName('top')
              .setDescription('Shows top genres for you or someone else')
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
              .setDescription('Shows genre information or top artists for a genre')
              .addStringOption((opt) =>
                opt
                  .setName('search')
                  .setDescription('The genre or artist you want to view')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('whoknows')
              .setDescription('Shows who in the server listens to a genre')
              .addStringOption((opt) =>
                opt
                  .setName('genre')
                  .setDescription('The genre name')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Shows tags and genres for an artist')
              .addStringOption((opt) =>
                opt
                  .setName('artist')
                  .setDescription('Artist name')
                  .setRequired(true),
              ),
          ) as any,
        executeAsync: (ctx) => this.handleGenreSlash(ctx),
      },
    ];
  }

  private async handleGenreSlash(context: ContextModel): Promise<ResponseModel> {
    const subcommand = context.interaction?.options.getSubcommand() ?? 'top';

    if (subcommand === 'top') {
      return this.handleTopSubcommand(context);
    }
    if (subcommand === 'info') {
      return this.handleInfoSubcommand(context);
    }
    if (subcommand === 'whoknows') {
      return this.handleWhoKnowsSubcommand(context);
    }
    if (subcommand === 'artist') {
      return this.handleArtistSubcommand(context);
    }

    return GenericEmbedService.buildCommandErrorResponse(CommandResponse.WrongInput, 'Unknown subcommand.');
  }

  private async resolveTargetUser(
    context: ContextModel,
  ): Promise<{ userNameLastFm: string; displayName: string; userId?: number } | ResponseModel> {
    const rawUser = context.interaction?.options.getString('user') ?? null;
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
      const lfm = rawUser.toLowerCase().startsWith('lfm:') ? rawUser.slice(4).trim() : rawUser;
      const u = await this.userService.getUserByLastFmName(lfm);
      return { userNameLastFm: lfm, displayName: lfm, userId: u?.userId };
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }
    const member = context.guild?.members.cache.get(context.discordUserId);
    return {
      userNameLastFm: caller.userNameLastFm,
      displayName: member?.displayName ?? caller.userNameLastFm,
      userId: caller.userId,
    };
  }

  private async handleTopSubcommand(context: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveTargetUser(context);
    if ('commandResponse' in resolved) return resolved;

    const periodStr = context.interaction?.options.getString('period') ?? 'overall';
    const timePeriodResult = this.settingService.getTimePeriod(periodStr);
    const periodDescription = timePeriodResult.description;

    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    let genres: { genreName: string; userPlaycount: number; topArtists?: string[] }[] = [];

    if (timePeriodResult.timePeriod === undefined || periodStr === 'overall' || periodStr === 'alltime') {
      if (resolved.userId) {
        genres = await this.genreService.getTopGenresForUserAllTime(resolved.userId, 100);
      }
    }

    if (genres.length === 0) {
      const topArtists = await this.lastfmRepository.getTopArtists(
        resolved.userNameLastFm,
        timePeriodResult.timePeriod,
        150,
      );

      if (topArtists && topArtists.length > 0) {
        const artistItems = topArtists.map((a) => ({
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

  private async handleInfoSubcommand(context: ContextModel): Promise<ResponseModel> {
    let query = context.interaction?.options.getString('search')?.trim();

    if (!query) {
      const caller = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!caller) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'You have not connected your Last.fm account yet. Use `/login` first.',
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

    if (!query) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'Please specify an artist or genre.',
      );
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    const artistGenres = await this.genreService.getGenresForArtist(query);
    if (artistGenres.length > 0) {
      return GenreBuilders.buildArtistGenresResponse(query, artistGenres, accentColor);
    }

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

  private async handleWhoKnowsSubcommand(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used within a server.',
      );
    }

    let genreName = context.interaction?.options.getString('genre')?.trim();
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
        'Please specify a genre.',
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

  private async handleArtistSubcommand(context: ContextModel): Promise<ResponseModel> {
    const artistName = context.interaction?.options.getString('artist', true).trim();
    if (!artistName) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.WrongInput, 'Please specify an artist name.');
    }

    const genres = await this.genreService.getGenresForArtist(artistName);
    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    return GenreBuilders.buildArtistGenresResponse(artistName, genres, accentColor);
  }
}
