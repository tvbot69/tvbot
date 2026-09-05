import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import { CommandResponse } from '@domain/enums/commandResponse';

interface TargetResolution {
  targetUser: User;
  displayName: string;
  isDifferentUser: boolean;
  cleanSearchValue: string;
}

@injectable()
export class PlaycountCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

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
  ) {
    this.commands = [
      {
        name: 'artistplays',
        aliases: ['ap'],
        executeAsync: (context, args) => this.artistPlaysAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'albumplays',
        aliases: ['abp', 'albumplay', 'abplays', 'albump'],
        executeAsync: (context, args) => this.albumPlaysAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'trackplays',
        aliases: ['tp', 'trackplay', 'tplays', 'trackp'],
        executeAsync: (context, args) => this.trackPlaysAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'plays',
        aliases: ['p', 'scrobbles'],
        executeAsync: (context, args) => this.playsAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'pace',
        aliases: ['pc'],
        executeAsync: (context, args) => this.paceAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'milestone',
        aliases: ['m', 'ms'],
        executeAsync: (context, args) => this.milestoneAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'discoverydate',
        aliases: ['dd', 'datediscovered', 'datediscovery', 'first', 'firstlistened'],
        executeAsync: (context, args) => this.discoveryDateAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'lastlistened',
        aliases: ['last', 'll', 'lastlisten', 'lastplayed', 'lastheard'],
        executeAsync: (context, args) => this.lastListenedAsync(context, args?.join(' ') ?? ''),
      },
    ];
  }

  private async resolveTarget(
    context: ContextModel,
    rawOptions: string,
  ): Promise<TargetResolution | ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    let cleanOptions = rawOptions;
    let targetUser = callerUser;
    let displayName = context.member?.displayName ?? callerUser.userNameLastFm;
    let isDifferentUser = false;

    // Check for @user mention
    const mentionMatch = cleanOptions.match(/<@!?(\d+)>/);
    if (mentionMatch) {
      const mentionedDiscordId = mentionMatch[1]!;
      cleanOptions = cleanOptions.replace(mentionMatch[0], '').replace(/\s+/g, ' ').trim();
      const mentioned = await this.userService.getUserByDiscordId(mentionedDiscordId);
      if (!mentioned) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${mentionedDiscordId}> hasn't connected their Last.fm account yet.`,
        );
      }
      targetUser = mentioned;
      isDifferentUser = targetUser.userId !== callerUser.userId;
      displayName = `<@${mentionedDiscordId}>`;
    } else {
      // Check for lfm:username
      const lfmMatch = cleanOptions.match(/\blfm:(\S+)/i);
      if (lfmMatch) {
        const lfmName = lfmMatch[1]!;
        cleanOptions = cleanOptions.replace(lfmMatch[0], '').replace(/\s+/g, ' ').trim();
        const existing = await this.userService.getUserByLastFmName(lfmName);
        if (existing) {
          targetUser = existing;
          isDifferentUser = targetUser.userId !== callerUser.userId;
          displayName = targetUser.userNameLastFm;
        } else {
          targetUser = {
            ...callerUser,
            userId: 0,
            userNameLastFm: lfmName,
          } as User;
          isDifferentUser = true;
          displayName = lfmName;
        }
      }
    }

    return {
      targetUser,
      displayName,
      isDifferentUser,
      cleanSearchValue: cleanOptions.trim(),
    };
  }

  private async artistPlaysAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const artistSearch = await this.artistsService.searchArtist(
      target.cleanSearchValue,
      target.targetUser,
      context.guildId,
    );
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

  private async albumPlaysAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const albumSearch = await this.albumService.searchAlbum(
      target.cleanSearchValue,
      target.targetUser,
      context.guildId,
    );
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

  private async trackPlaysAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(
      target.cleanSearchValue,
      target.targetUser,
      context.guildId,
    );
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

  private async playsAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);
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

  private async paceAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const userInfo = await this.lastfmRepository.getUserInfo(target.targetUser.userNameLastFm);
    if (!userInfo) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find Last.fm user \`${target.targetUser.userNameLastFm}\`.`);
    }

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);
    const isAllTime = timeSettings.timePeriod === TimePeriod.AllTime;
    const goalAmount = SettingService.getGoalAmount(timeSettings.searchValue, userInfo.playCount);

    let fromTimestamp: number;
    let countInPeriod: number;

    if (isAllTime) {
      fromTimestamp = userInfo.registeredAt
        ? Math.floor(userInfo.registeredAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000) - 86400;
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

  private async milestoneAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const userInfo = await this.lastfmRepository.getUserInfo(target.targetUser.userNameLastFm);
    if (!userInfo) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find Last.fm user \`${target.targetUser.userNameLastFm}\`.`);
    }

    const milestoneParse = SettingService.getMilestoneAmount(target.cleanSearchValue, userInfo.playCount);
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

  private async discoveryDateAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(
      target.cleanSearchValue,
      target.targetUser,
      context.guildId,
    );
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

    const hasSearch = target.cleanSearchValue.length > 0;
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

  private async lastListenedAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const trackSearch = await this.trackService.searchTrack(
      target.cleanSearchValue,
      target.targetUser,
      context.guildId,
    );
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

    const hasSearch = target.cleanSearchValue.length > 0;
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
}
