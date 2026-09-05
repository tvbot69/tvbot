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
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('artistplays')
          .setDescription("Shows playcount for current artist or the one you're searching for.")
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check plays for').setRequired(false),
          ),
        executeAsync: (context) => {
          const artist = context.interaction?.options.getString('artist');
          const targetUser = context.interaction?.options.getUser('user');
          return this.artistPlaysSlashAsync(context, artist, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('albumplays')
          .setDescription("Shows playcount for current album or the one you're searching for.")
          .addStringOption((opt) =>
            opt.setName('album').setDescription('Album name (or Artist | Album)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check plays for').setRequired(false),
          ),
        executeAsync: (context) => {
          const album = context.interaction?.options.getString('album');
          const targetUser = context.interaction?.options.getUser('user');
          return this.albumPlaysSlashAsync(context, album, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('trackplays')
          .setDescription("Shows playcount for current track or the one you're searching for.")
          .addStringOption((opt) =>
            opt.setName('track').setDescription('Track name (or Artist | Track)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check plays for').setRequired(false),
          ),
        executeAsync: (context) => {
          const track = context.interaction?.options.getString('track');
          const targetUser = context.interaction?.options.getUser('user');
          return this.trackPlaysSlashAsync(context, track, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('plays')
          .setDescription('Shows your total scrobble count for a specific time period.')
          .addStringOption((opt) =>
            opt.setName('period').setDescription('Time period (e.g. weekly, monthly, yearly, alltime)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check scrobbles for').setRequired(false),
          ),
        executeAsync: (context) => {
          const period = context.interaction?.options.getString('period');
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
            opt.setName('period').setDescription('Time period (e.g. weekly, monthly, alltime)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to check pace for').setRequired(false),
          ),
        executeAsync: (context) => {
          const goal = context.interaction?.options.getString('goal');
          const period = context.interaction?.options.getString('period');
          const targetUser = context.interaction?.options.getUser('user');
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

    return PlaycountBuilders.buildArtistPlaysResponse(
      target.displayName,
      artistSearch.artistName,
      artistSearch.userPlaycount ?? 0,
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

    return PlaycountBuilders.buildAlbumPlaysResponse(
      target.displayName,
      albumSearch.artistName,
      albumSearch.albumName,
      albumSearch.userPlaycount ?? 0,
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

    return PlaycountBuilders.buildTrackPlaysResponse(
      target.displayName,
      trackSearch.artistName,
      trackSearch.trackName,
      trackSearch.userPlaycount ?? 0,
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

    return PlaycountBuilders.buildMilestoneResponse(
      target.displayName,
      target.targetUser.userNameLastFm,
      milestoneParse.amount,
      milestonePlay.artistName,
      milestonePlay.albumName,
      milestonePlay.name,
      milestonePlay.timePlayed,
      albumCoverUrl,
      null,
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
    );
  }
}
