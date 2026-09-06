import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { PlayHistoryService } from '@bot/services/playHistoryService';
import { ArtistsService } from '@bot/services/artistsService';
import { AlbumService } from '@bot/services/albumService';
import { TrackService } from '@bot/services/trackService';
import { ArtworkService } from '@bot/services/artworkService';
import { ColorService } from '@bot/services/colorService';
import { ReceiptGenerator } from '@images/generators/receiptGenerator';
import { ReceiptBuilders } from '@bot/builders/receiptBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import { CommandResponse } from '@domain/enums/commandResponse';

@injectable()
export class PlaycountSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(PlayHistoryService) private readonly playHistoryService: PlayHistoryService,
    @inject(ArtistsService) private readonly artistsService: ArtistsService,
    @inject(AlbumService) private readonly albumService: AlbumService,
    @inject(TrackService) private readonly trackService: TrackService,
    @inject(ArtworkService) private readonly artworkService: ArtworkService,
    @inject('ILastfmRepository') private readonly lastfmRepository: ILastfmRepository,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject(ReceiptGenerator) private readonly receiptGenerator?: ReceiptGenerator,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('plays')
          .setDescription('Shows playcounts for user, artist, album, or track')
          .addSubcommand((sub) =>
            sub
              .setName('total')
              .setDescription('Shows your total scrobble count for a specific time period')
              .addStringOption((opt) =>
                opt.setName('period').setDescription('Time period (e.g. weekly, monthly, yearly, alltime)').setRequired(false),
              )
              .addUserOption((opt) =>
                opt.setName('user').setDescription('User to check scrobbles for').setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Shows playcount for an artist')
              .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(false))
              .addUserOption((opt) => opt.setName('user').setDescription('User to check plays for').setRequired(false)),
          )
          .addSubcommand((sub) =>
            sub
              .setName('album')
              .setDescription('Shows playcount for an album')
              .addStringOption((opt) => opt.setName('album').setDescription('Album name (or Artist | Album)').setRequired(false))
              .addUserOption((opt) => opt.setName('user').setDescription('User to check plays for').setRequired(false)),
          )
          .addSubcommand((sub) =>
            sub
              .setName('track')
              .setDescription('Shows playcount for a track')
              .addStringOption((opt) => opt.setName('track').setDescription('Track name (or Artist | Track)').setRequired(false))
              .addUserOption((opt) => opt.setName('user').setDescription('User to check plays for').setRequired(false)),
          ),
        executeAsync: (context) => {
          const sub = context.interaction?.options.getSubcommand() || 'total';
          if (sub === 'artist') {
            const artist = context.interaction?.options.getString('artist') ?? undefined;
            const targetUser = context.interaction?.options.getUser('user');
            return this.artistPlaysSlashAsync(context, artist, targetUser?.id);
          }
          if (sub === 'album') {
            const album = context.interaction?.options.getString('album') ?? undefined;
            const targetUser = context.interaction?.options.getUser('user');
            return this.albumPlaysSlashAsync(context, album, targetUser?.id);
          }
          if (sub === 'track') {
            const track = context.interaction?.options.getString('track') ?? undefined;
            const targetUser = context.interaction?.options.getUser('user');
            return this.trackPlaysSlashAsync(context, track, targetUser?.id);
          }
          const period = context.interaction?.options.getString('period') ?? undefined;
          const targetUser = context.interaction?.options.getUser('user');
          return this.playsSlashAsync(context, period, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('pace')
          .setDescription('Shows estimated date you reach a scrobble goal based on average scrobbles per day.')
          .addStringOption((opt) =>
            opt.setName('goal').setDescription('Goal amount (e.g. 10000, 50k)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name for artist-specific pace (optional)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('period').setDescription('Time period (e.g. weekly, monthly, alltime)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check pace for').setRequired(false),
          ),
        executeAsync: (context) => {
          const artist = context.interaction?.options.getString('artist');
          const goal = context.interaction?.options.getString('goal');
          const period = context.interaction?.options.getString('period');
          const targetUser = context.interaction?.options.getUser('user');
          if (artist) {
            return this.artistPaceSlashAsync(context, artist, goal, targetUser?.id);
          }
          return this.paceSlashAsync(context, goal, period, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('milestone')
          .setDescription('Shows a milestone scrobble.')
          .addStringOption((opt) =>
            opt.setName('amount').setDescription('Milestone amount (e.g. 10000, 10k, random)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check milestone for').setRequired(false),
          ),
        executeAsync: (context) => {
          const amount = context.interaction?.options.getString('amount');
          const targetUser = context.interaction?.options.getUser('user');
          return this.milestoneSlashAsync(context, amount, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('discoverydate')
          .setDescription('Shows the date you discovered the artist, album, and track.')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Artist and/or track name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check discovery date for').setRequired(false),
          ),
        executeAsync: (context) => {
          const query = context.interaction?.options.getString('query');
          const targetUser = context.interaction?.options.getUser('user');
          return this.discoveryDateSlashAsync(context, query, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('lastlistened')
          .setDescription('Shows the date you last listened to the artist, album, and track.')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Artist and/or track name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check last listened date for').setRequired(false),
          ),
        executeAsync: (context) => {
          const query = context.interaction?.options.getString('query');
          const targetUser = context.interaction?.options.getUser('user');
          return this.lastListenedSlashAsync(context, query, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('receipt')
          .setDescription('Generates an authentic Receiptify-style thermal music receipt.')
          .addStringOption((opt) =>
            opt
              .setName('period')
              .setDescription('Time period')
              .setRequired(false)
              .addChoices(
                { name: 'Weekly (7 days)', value: 'weekly' },
                { name: 'Monthly (1 month)', value: 'monthly' },
                { name: 'Quarterly (3 months)', value: 'quarterly' },
                { name: 'Half-yearly (6 months)', value: 'halfyearly' },
                { name: 'Yearly (1 year)', value: 'yearly' },
                { name: 'Overall (All time)', value: 'overall' },
              ),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user').setRequired(false),
          ),
        executeAsync: (context) => {
          const period = context.interaction?.options.getString('period');
          const targetUser = context.interaction?.options.getUser('user');
          return this.receiptSlashAsync(context, period, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('year')
          .setDescription('Shows a full yearly music overview with artists, albums, tracks, and genres.')
          .addIntegerOption((opt) =>
            opt.setName('year').setDescription('The year to show (default: current year)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user').setRequired(false),
          ),
        executeAsync: (context) => {
          const year = context.interaction?.options.getInteger('year');
          const targetUser = context.interaction?.options.getUser('user');
          return this.yearSlashAsync(context, year, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('recap')
          .setDescription('Comprehensive music recap combining your top highlights.')
          .addIntegerOption((opt) =>
            opt.setName('year').setDescription('Year for recap').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user').setRequired(false),
          ),
        executeAsync: (context) => {
          const year = context.interaction?.options.getInteger('year');
          const targetUser = context.interaction?.options.getUser('user');
          return this.yearSlashAsync(context, year, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('leaderboard')
          .setDescription('Server member music leaderboards')
          .addSubcommand((sub) =>
            sub.setName('plays').setDescription('Rank server members by total scrobbles'),
          )
          .addSubcommand((sub) =>
            sub.setName('time').setDescription('Rank server members by total listening time'),
          ),
        executeAsync: (context) => {
          const sub = context.interaction?.options.getSubcommand();
          if (sub === 'time') {
            return this.leaderboardTimeSlashAsync(context);
          }
          return this.leaderboardPlaysSlashAsync(context);
        },
      },
    ];
  }

  private async resolveTarget(
    context: ContextModel,
    targetDiscordUserId?: string,
  ): Promise<{ targetUser: User; displayName: string; isDifferentUser: boolean } | ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (targetDiscordUserId && targetDiscordUserId !== context.discordUserId) {
      const mentioned = await this.userService.getUserByDiscordId(targetDiscordUserId);
      if (!mentioned) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${targetDiscordUserId}> hasn't connected their Last.fm account yet.`,
        );
      }
      return {
        targetUser: mentioned,
        displayName: `<@${targetDiscordUserId}>`,
        isDifferentUser: true,
      };
    }

    return {
      targetUser: callerUser,
      displayName: context.member?.displayName ?? callerUser.userNameLastFm,
      isDifferentUser: false,
    };
  }

  private async artistPlaysSlashAsync(
    context: ContextModel,
    artist?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const artistSearch = await this.artistsService.searchArtist(artist, target.targetUser, context.guildId);
    if (!artistSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any artist plays.');
    }

    const playcounts = target.targetUser.userId > 0
      ? await this.playHistoryService.getRecentArtistPlaycounts(target.targetUser.userId, artistSearch.artistName)
      : { week: 0, month: 0 };

    let totalPlays = artistSearch.userPlaycount ?? 0;
    if (totalPlays === 0 && target.targetUser.userId > 0) {
      const dbTotal = await this.playHistoryService.getArtistTotalPlays(
        target.targetUser.userId,
        artistSearch.artistName,
      );
      if (dbTotal > totalPlays) {
        totalPlays = dbTotal;
      }
    }
    if (playcounts.month > totalPlays) {
      totalPlays = playcounts.month;
    }

    return PlaycountBuilders.buildArtistPlaysResponse(
      target.displayName,
      artistSearch.artistName,
      totalPlays,
      playcounts.week,
      playcounts.month,
    );
  }

  private async albumPlaysSlashAsync(
    context: ContextModel,
    album?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const albumSearch = await this.albumService.searchAlbum(album, target.targetUser, context.guildId);
    if (!albumSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any album plays.');
    }

    const playcounts = target.targetUser.userId > 0
      ? await this.playHistoryService.getRecentAlbumPlaycounts(target.targetUser.userId, albumSearch.artistName, albumSearch.albumName)
      : { week: 0, month: 0 };

    let totalPlays = albumSearch.userPlaycount ?? 0;
    if (totalPlays === 0 && target.targetUser.userId > 0) {
      const dbTotal = await this.playHistoryService.getAlbumTotalPlays(
        target.targetUser.userId,
        albumSearch.artistName,
        albumSearch.albumName,
      );
      if (dbTotal > totalPlays) {
        totalPlays = dbTotal;
      }
    }
    if (playcounts.month > totalPlays) {
      totalPlays = playcounts.month;
    }

    return PlaycountBuilders.buildAlbumPlaysResponse(
      target.displayName,
      albumSearch.artistName,
      albumSearch.albumName,
      totalPlays,
      playcounts.week,
      playcounts.month,
    );
  }

  private async trackPlaysSlashAsync(
    context: ContextModel,
    track?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(track, target.targetUser, context.guildId);
    if (!trackSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any track plays.');
    }

    const playcounts = target.targetUser.userId > 0
      ? await this.playHistoryService.getRecentTrackPlaycounts(target.targetUser.userId, trackSearch.artistName, trackSearch.trackName)
      : { week: 0, month: 0 };

    let totalPlays = trackSearch.userPlaycount ?? 0;
    if (totalPlays === 0 && target.targetUser.userId > 0) {
      const dbTotal = await this.playHistoryService.getTrackTotalPlays(
        target.targetUser.userId,
        trackSearch.artistName,
        trackSearch.trackName,
      );
      if (dbTotal > totalPlays) {
        totalPlays = dbTotal;
      }
    }
    if (playcounts.month > totalPlays) {
      totalPlays = playcounts.month;
    }

    return PlaycountBuilders.buildTrackPlaysResponse(
      target.displayName,
      trackSearch.artistName,
      trackSearch.trackName,
      totalPlays,
      playcounts.week,
      playcounts.month,
    );
  }

  private async playsSlashAsync(
    context: ContextModel,
    period?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(period);
    const isAllTime = timeSettings.timePeriod === TimePeriod.AllTime;

    let count: number | null = null;
    if (isAllTime) {
      const userInfo = await this.lastfmRepository.getUserInfo(target.targetUser.userNameLastFm);
      count = userInfo?.playCount ?? null;
    } else {
      const from = timeSettings.startDateTime ? Math.floor(timeSettings.startDateTime.getTime() / 1000) : null;
      const to = timeSettings.endDateTime ? Math.floor(timeSettings.endDateTime.getTime() / 1000) : null;
      count = await this.playHistoryService.getScrobbleCountFromDate(
        target.targetUser.userNameLastFm,
        from,
        target.targetUser.sessionKey ?? null,
        to,
      );
    }

    if (count === null) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find total count for Last.fm user \`${target.targetUser.userNameLastFm}\`.`);
    }

    return PlaycountBuilders.buildPlaysResponse(
      target.displayName,
      count,
      isAllTime,
      timeSettings.description,
    );
  }

  private async paceSlashAsync(
    context: ContextModel,
    goal?: string | null,
    period?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const userInfo = await this.lastfmRepository.getUserInfo(target.targetUser.userNameLastFm);
    if (!userInfo) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find Last.fm user \`${target.targetUser.userNameLastFm}\`.`);
    }

    const timeSettings = this.settingService.getTimePeriod(period);
    const isAllTime = timeSettings.timePeriod === TimePeriod.AllTime;
    const goalAmount = SettingService.getGoalAmount(goal, userInfo.playCount);

    let fromTimestamp: number;
    let countInPeriod: number;

    if (isAllTime) {
      fromTimestamp = userInfo.registeredAt ? Math.floor(userInfo.registeredAt.getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400;
      countInPeriod = userInfo.playCount;
    } else {
      fromTimestamp = timeSettings.startDateTime
        ? Math.floor(timeSettings.startDateTime.getTime() / 1000)
        : Math.floor(Date.now() / 1000) - 7 * 86400;

      const scrobbles = await this.playHistoryService.getScrobbleCountFromDate(
        target.targetUser.userNameLastFm,
        fromTimestamp,
        target.targetUser.sessionKey ?? null,
      );
      countInPeriod = scrobbles ?? 0;
    }

    if (!countInPeriod || countInPeriod <= 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `<@${context.discordUserId}> No plays found in the ${timeSettings.description} time period.`,
      );
    }

    return PlaycountBuilders.buildPaceResponse(
      `<@${context.discordUserId}>`,
      target.displayName,
      target.isDifferentUser,
      goalAmount,
      userInfo.playCount,
      countInPeriod,
      fromTimestamp,
      isAllTime,
    );
  }

  private async milestoneSlashAsync(
    context: ContextModel,
    amount?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const userInfo = await this.lastfmRepository.getUserInfo(target.targetUser.userNameLastFm);
    if (!userInfo) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find Last.fm user \`${target.targetUser.userNameLastFm}\`.`);
    }

    const milestoneParse = SettingService.getMilestoneAmount(amount, userInfo.playCount);
    const milestonePlay = await this.playHistoryService.getMilestoneScrobble(
      target.targetUser.userNameLastFm,
      target.targetUser.sessionKey ?? null,
      userInfo.playCount,
      milestoneParse.amount,
    );

    if (!milestonePlay) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find milestone #${milestoneParse.amount} for \`${target.targetUser.userNameLastFm}\`.`);
    }

    let albumCoverUrl: string | null = null;
    if (milestonePlay.albumName) {
      albumCoverUrl = await this.artworkService.getAlbumCoverUrl(milestonePlay.albumName, milestonePlay.artistName);
    }
    if (!albumCoverUrl) {
      albumCoverUrl = await this.artworkService.getTrackCoverUrl(milestonePlay.name, milestonePlay.artistName);
    }

    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return PlaycountBuilders.buildMilestoneResponse(
      target.displayName,
      target.targetUser.userNameLastFm,
      milestoneParse.amount,
      milestonePlay.artistName,
      milestonePlay.albumName,
      milestonePlay.name,
      milestonePlay.timePlayed,
      albumCoverUrl,
      accentColor,
      milestoneParse.isRandom,
      target.targetUser.userId,
      callerUser?.userId,
    );
  }

  private async discoveryDateSlashAsync(
    context: ContextModel,
    query?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(query, target.targetUser, context.guildId);
    if (!trackSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any track to check discovery date.');
    }

    const dates = await this.playHistoryService.getDiscoveryDates(
      target.targetUser.userId,
      trackSearch.artistName,
      trackSearch.albumName,
      trackSearch.trackName,
    );

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    const hasSearch = (query ?? '').length > 0;
    return PlaycountBuilders.buildDiscoveryDateResponse(
      target.displayName,
      target.isDifferentUser,
      trackSearch.artistName,
      trackSearch.albumName,
      trackSearch.trackName,
      dates.artistFirstPlay?.timePlayed ?? null,
      dates.albumFirstPlayDate,
      dates.trackFirstPlayDate,
      hasSearch,
      accentColor,
    );
  }

  private async lastListenedSlashAsync(
    context: ContextModel,
    query?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(query, target.targetUser, context.guildId);
    if (!trackSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any track to check last listened date.');
    }

    const dates = await this.playHistoryService.getLastListenedDates(
      target.targetUser.userId,
      trackSearch.artistName,
      trackSearch.albumName,
      trackSearch.trackName,
    );

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    const hasSearch = (query ?? '').length > 0;
    return PlaycountBuilders.buildLastListenedDateResponse(
      target.displayName,
      target.isDifferentUser,
      trackSearch.artistName,
      trackSearch.albumName,
      trackSearch.trackName,
      dates.artistLastPlay?.timePlayed ?? null,
      dates.albumLastPlayDate,
      dates.trackLastPlayDate,
      hasSearch,
      accentColor,
    );
  }

  private async artistPaceSlashAsync(
    context: ContextModel,
    artist?: string | null,
    goalStr?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const artistSearch = await this.artistsService.searchArtist(artist, target.targetUser, context.guildId);
    if (!artistSearch) {
      return GenericEmbedService.buildNotFoundResponse('Could not find any artist to check pace.');
    }

    let allTimePlays = artistSearch.userPlaycount ?? 0;
    if (allTimePlays === 0 && target.targetUser.userId > 0) {
      const dbTotal = await this.playHistoryService.getArtistTotalPlays(
        target.targetUser.userId,
        artistSearch.artistName,
      );
      allTimePlays = dbTotal;
    }

    const goalAmount = SettingService.getGoalAmount(goalStr ?? '', allTimePlays);
    const days = 30;
    const periodPlays = await this.playHistoryService.getArtistPlaycountForDays(
      target.targetUser.userId,
      artistSearch.artistName,
      days,
    );

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return PlaycountBuilders.buildArtistPaceResponse({
      callerMention: `<@${context.discordUserId}>`,
      displayName: target.displayName,
      isDifferentUser: target.isDifferentUser,
      artistName: artistSearch.artistName,
      goalAmount,
      allTimePlays,
      periodPlays,
      days,
      accentColor,
    });
  }

  private async receiptSlashAsync(
    context: ContextModel,
    periodStr?: string | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const rawSearch = periodStr?.trim() ?? '';
    const PERIOD_TOKENS = new Set([
      'weekly', 'week', 'w', '7d',
      'quarterly', 'quarter', 'q', '3m', '90d',
      'halfyearly', 'half-yearly', 'hy', '6m', '180d',
      'monthly', 'month', 'm', '1m', '30d',
      'twoyears', '2y', '730d',
      'yearly', 'year', 'y', '12m', '365d', '1y',
      'overall', 'alltime', 'all-time', 'all', 'a', 'o', 'at',
    ]);
    const hasExplicitPeriod = rawSearch.length > 0 && rawSearch
      .toLowerCase()
      .split(/\s+/)
      .some((word) => PERIOD_TOKENS.has(word));

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthNum = now.getMonth() + 1;
    const currentMonthName = now.toLocaleString('en-US', { month: 'long' });
    const lastDay = new Date(currentYear, currentMonthNum, 0).getDate();

    let timePeriod: TimePeriod;
    let periodDesc: string;
    let fromTimestamp: number | null = null;
    let tracksUrl: string;

    if (!hasExplicitPeriod) {
      timePeriod = TimePeriod.Monthly;
      periodDesc = currentMonthName;
      fromTimestamp = Math.floor(new Date(currentYear, currentMonthNum - 1, 1).getTime() / 1000);
      tracksUrl = `https://last.fm/user/${encodeURIComponent(target.targetUser.userNameLastFm)}/library/tracks?from=${currentYear}-${currentMonthNum}-01&to=${currentYear}-${currentMonthNum}-${lastDay}`;
    } else {
      const timeSettings = this.settingService.getTimePeriod(rawSearch);
      timePeriod = timeSettings.timePeriod;
      periodDesc = timeSettings.description;
      if (timeSettings.startDateTime) {
        fromTimestamp = Math.floor(timeSettings.startDateTime.getTime() / 1000);
      }
      if (timeSettings.startDateTime && timeSettings.endDateTime) {
        const sY = timeSettings.startDateTime.getFullYear();
        const sM = timeSettings.startDateTime.getMonth() + 1;
        const sD = timeSettings.startDateTime.getDate();
        const eY = timeSettings.endDateTime.getFullYear();
        const eM = timeSettings.endDateTime.getMonth() + 1;
        const eD = timeSettings.endDateTime.getDate();
        tracksUrl = `https://last.fm/user/${encodeURIComponent(target.targetUser.userNameLastFm)}/library/tracks?from=${sY}-${sM}-${sD}&to=${eY}-${eM}-${eD}`;
      } else {
        tracksUrl = `https://last.fm/user/${encodeURIComponent(target.targetUser.userNameLastFm)}/library/tracks`;
      }
    }

    const topTracksResult = await this.lastfmRepository.getTopTracks(
      target.targetUser.userNameLastFm,
      timePeriod,
      12,
    );

    if (!topTracksResult || topTracksResult.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `Sorry, you or the user you're searching for don't have any top tracks in the ${periodDesc} time period.`,
      );
    }

    const totalScrobbles = await this.playHistoryService.getScrobbleCountFromDate(
      target.targetUser.userNameLastFm,
      fromTimestamp,
      target.targetUser.sessionKey ?? null,
    );

    const receiptTracks = topTracksResult.map((t) => ({
      artistName: t.artistName,
      trackName: t.name,
      userPlaycount: t.playcount,
    }));

    if (!this.receiptGenerator) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Receipt generator is not available.',
      );
    }

    const buffer = await this.receiptGenerator.generateReceipt({
      userNameLastFm: target.targetUser.userNameLastFm,
      displayName: target.displayName,
      periodDescription: periodDesc,
      tracks: receiptTracks,
      totalPlays: totalScrobbles ?? receiptTracks.reduce((acc, c) => acc + c.userPlaycount, 0),
      totalTracks: receiptTracks.length,
      year: currentYear,
    });

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return ReceiptBuilders.buildReceiptResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      periodDescription: periodDesc,
      tracksUrl,
      imageBuffer: buffer,
      accentColor,
    });
  }

  private async yearSlashAsync(
    context: ContextModel,
    targetYear?: number | null,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const year = targetYear ?? new Date().getFullYear();
    const yearData = await this.playHistoryService.getYearOverview(target.targetUser.userId, year);

    if (yearData.totalPlays === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No plays found in **${year}** for ${target.displayName}.`,
      );
    }

    const targetDiscordId = target.targetUser.discordUserId;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return PlaycountBuilders.buildYearOverviewResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      yearData,
      accentColor,
    });
  }

  private async leaderboardPlaysSlashAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'Server leaderboard is only available inside a server.',
      );
    }

    const entries = await this.playHistoryService.getGuildPlayLeaderboard(context.guild.id);
    const accentColor = await this.colorService.getAccentColorAsync(context.guild.id);

    return PlaycountBuilders.buildLeaderboardResponse({
      guildName: context.guild.name,
      title: 'Scrobbles Leaderboard',
      unit: 'plays',
      entries,
      accentColor,
    });
  }

  private async leaderboardTimeSlashAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'Server leaderboard is only available inside a server.',
      );
    }

    const entries = await this.playHistoryService.getGuildTimeLeaderboard(context.guild.id);
    const accentColor = await this.colorService.getAccentColorAsync(context.guild.id);

    return PlaycountBuilders.buildLeaderboardResponse({
      guildName: context.guild.name,
      title: 'Listening Time Leaderboard',
      unit: 'minutes',
      entries,
      accentColor,
    });
  }
}
