import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import {
  MusicIntelligenceService,
  GapEntityType,
} from '@bot/services/musicIntelligenceService';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { User } from '@domain/interfaces/iuserRepository';

const periodChoices = [
  { name: 'Weekly (7 days)', value: 'weekly' },
  { name: 'Monthly (1 month)', value: 'monthly' },
  { name: 'Quarterly (3 months)', value: 'quarterly' },
  { name: 'Half-yearly (6 months)', value: 'halfyearly' },
  { name: 'Yearly (1 year)', value: 'yearly' },
  { name: 'Overall (All time)', value: 'overall' },
];

interface TargetResolution {
  callerUser: User;
  targetUser: User;
  displayName: string;
}

@injectable()
export class IntelligenceSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(MusicIntelligenceService) private readonly intelligenceService: MusicIntelligenceService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('gaps')
          .setDescription('Show items you returned to after a hiatus of at least 90 days')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Entity type to check gaps for')
              .setRequired(false)
              .addChoices(
                { name: 'Artists', value: 'artist' },
                { name: 'Albums', value: 'album' },
                { name: 'Tracks', value: 'track' },
              ),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user (defaults to you)').setRequired(false),
          ),
        executeAsync: (context) => {
          const type = (context.interaction?.options.getString('type') as GapEntityType) || 'artist';
          const targetUser = context.interaction?.options.getUser('user');
          return this.listeningGapsSlashAsync(context, type, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('discoveries')
          .setDescription('Show newly discovered artists first listened to in a time period')
          .addStringOption((opt) =>
            opt
              .setName('period')
              .setDescription('Time period')
              .setRequired(false)
              .addChoices(...periodChoices),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user (defaults to you)').setRequired(false),
          ),
        executeAsync: (context) => {
          const period = context.interaction?.options.getString('period') ?? 'quarterly';
          const targetUser = context.interaction?.options.getUser('user');
          return this.discoveriesSlashAsync(context, period, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('iceberg')
          .setDescription('Show your taste iceberg classified by mainstream popularity')
          .addStringOption((opt) =>
            opt
              .setName('period')
              .setDescription('Time period')
              .setRequired(false)
              .addChoices(...periodChoices),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user (defaults to you)').setRequired(false),
          ),
        executeAsync: (context) => {
          const period = context.interaction?.options.getString('period') ?? 'overall';
          const targetUser = context.interaction?.options.getUser('user');
          return this.icebergSlashAsync(context, period, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('affinity')
          .setDescription('Find server members with the most similar music taste')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user (defaults to you)').setRequired(false),
          ),
        executeAsync: (context) => {
          const targetUser = context.interaction?.options.getUser('user');
          return this.affinitySlashAsync(context, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('love')
          .setDescription('Love a track on Last.fm')
          .addStringOption((opt) =>
            opt.setName('track').setDescription('Track name (leave empty for current playing)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name').setRequired(false),
          ),
        executeAsync: (context) => {
          const track = context.interaction?.options.getString('track') ?? '';
          const artist = context.interaction?.options.getString('artist') ?? '';
          return this.loveSlashAsync(context, track, artist);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('unlove')
          .setDescription('Remove a track from your loved tracks on Last.fm')
          .addStringOption((opt) =>
            opt.setName('track').setDescription('Track name (leave empty for current playing)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name').setRequired(false),
          ),
        executeAsync: (context) => {
          const track = context.interaction?.options.getString('track') ?? '';
          const artist = context.interaction?.options.getString('artist') ?? '';
          return this.unloveSlashAsync(context, track, artist);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('loved')
          .setDescription('Show loved tracks on Last.fm')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user (defaults to you)').setRequired(false),
          ),
        executeAsync: (context) => {
          const targetUser = context.interaction?.options.getUser('user');
          return this.lovedSlashAsync(context, targetUser?.id);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('scrobble')
          .setDescription('Scrobble a track directly to Last.fm')
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('track').setDescription('Track name').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('album').setDescription('Album name (optional)').setRequired(false),
          ),
        executeAsync: (context) => {
          const artist = context.interaction?.options.getString('artist', true) ?? '';
          const track = context.interaction?.options.getString('track', true) ?? '';
          const album = context.interaction?.options.getString('album') ?? undefined;
          return this.scrobbleSlashAsync(context, artist, track, album);
        },
      },
    ];
  }

  private async resolveTarget(
    context: ContextModel,
    targetDiscordUserId?: string,
  ): Promise<TargetResolution | ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }

    let targetUser = callerUser;
    let displayName = context.discordDisplayName;

    if (targetDiscordUserId && targetDiscordUserId !== context.discordUserId) {
      const foundUser = await this.userService.getUserByDiscordId(targetDiscordUserId);
      if (foundUser) {
        targetUser = foundUser;
        displayName = foundUser.userNameLastFm;
      }
    }

    return { callerUser, targetUser, displayName };
  }

  private async listeningGapsSlashAsync(
    context: ContextModel,
    entityType: GapEntityType,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const items = await this.intelligenceService.getListeningGaps(target.targetUser.userId, entityType, 90);

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildListeningGapsResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      entityType,
      items,
      accentColor,
    });
  }

  private async discoveriesSlashAsync(
    context: ContextModel,
    periodOption: string,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(periodOption);
    const start = timeSettings.startDateTime ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const end = timeSettings.endDateTime ?? new Date();
    const periodDesc = timeSettings.timePeriod === TimePeriod.AllTime ? 'the past 90 days' : timeSettings.description;

    const items = await this.intelligenceService.getDiscoveries(target.targetUser.userId, start, end);

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildDiscoveriesResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      periodDescription: periodDesc,
      items,
      accentColor,
    });
  }

  private async icebergSlashAsync(
    context: ContextModel,
    periodOption: string,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(periodOption);

    const topArtists = await this.lastfmRepository.getTopArtists(
      target.targetUser.userNameLastFm,
      timeSettings.timePeriod,
      100,
      1,
      target.targetUser.sessionKey ?? undefined,
    );

    if (!topArtists || topArtists.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No top artists found for ${target.displayName} in ${timeSettings.description}.`,
      );
    }

    const icebergData = await this.intelligenceService.getIceberg(
      target.targetUser.userId,
      topArtists.map((a) => ({ name: a.name, playcount: a.playcount })),
      target.displayName,
      target.targetUser.userNameLastFm,
      timeSettings.description,
    );

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildIcebergResponse({
      data: icebergData,
      accentColor,
    });
  }

  private async affinitySlashAsync(
    context: ContextModel,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'The affinity command can only be used in a server.',
      );
    }

    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const guildName = context.guild?.name || 'this server';

    const affinityData = await this.intelligenceService.getGuildAffinity(
      context.guildId,
      target.targetUser.userId,
      target.displayName,
      target.targetUser.userNameLastFm,
      guildName,
    );

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildAffinityResponse({
      data: affinityData,
      accentColor,
    });
  }

  private async loveSlashAsync(
    context: ContextModel,
    rawTrack: string,
    rawArtist: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to love tracks.',
      );
    }

    let artistName = rawArtist.trim();
    let trackName = rawTrack.trim();

    if (!artistName && !trackName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(
        callerUser.userNameLastFm,
        1,
        1,
        undefined,
        callerUser.sessionKey,
      );
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'No recent tracks found to love.',
        );
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else if (!artistName) {
      if (trackName.includes(' - ')) {
        const parts = trackName.split(' - ');
        artistName = parts[0]!.trim();
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        const search = await this.lastfmRepository.searchTracks(trackName);
        if (!search || search.length === 0) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not find track matching "${trackName}".`,
          );
        }
        artistName = search[0]!.artistName;
        trackName = search[0]!.name;
      }
    }

    const success = await this.intelligenceService.loveTrack(callerUser.sessionKey, artistName, trackName);
    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to love **${artistName} - ${trackName}** on Last.fm. Please try again later.`,
      );
    }

    return IntelligenceBuilders.buildLoveSuccessResponse(artistName, trackName, true, context.accentColor);
  }

  private async unloveSlashAsync(
    context: ContextModel,
    rawTrack: string,
    rawArtist: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to unlove tracks.',
      );
    }

    let artistName = rawArtist.trim();
    let trackName = rawTrack.trim();

    if (!artistName && !trackName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(
        callerUser.userNameLastFm,
        1,
        1,
        undefined,
        callerUser.sessionKey,
      );
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          'No recent tracks found to unlove.',
        );
      }
      artistName = recent[0]!.artistName;
      trackName = recent[0]!.name;
    } else if (!artistName) {
      if (trackName.includes(' - ')) {
        const parts = trackName.split(' - ');
        artistName = parts[0]!.trim();
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        const search = await this.lastfmRepository.searchTracks(trackName);
        if (!search || search.length === 0) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not find track matching "${trackName}".`,
          );
        }
        artistName = search[0]!.artistName;
        trackName = search[0]!.name;
      }
    }

    const success = await this.intelligenceService.unloveTrack(callerUser.sessionKey, artistName, trackName);
    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to unlove **${artistName} - ${trackName}** on Last.fm. Please try again later.`,
      );
    }

    return IntelligenceBuilders.buildLoveSuccessResponse(artistName, trackName, false, context.accentColor);
  }

  private async lovedSlashAsync(
    context: ContextModel,
    targetDiscordUserId?: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, targetDiscordUserId);
    if ('commandResponse' in target) return target;

    const { tracks, total } = await this.intelligenceService.getLovedTracks(
      target.targetUser.userNameLastFm,
      20,
      1,
      target.targetUser.sessionKey ?? undefined,
    );

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildLovedTracksResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      tracks,
      total,
      accentColor,
    });
  }

  private async scrobbleSlashAsync(
    context: ContextModel,
    artist: string,
    track: string,
    album?: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to scrobble tracks.',
      );
    }

    const success = await this.intelligenceService.scrobbleTrack(
      callerUser.sessionKey,
      artist,
      track,
      album,
    );

    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to scrobble **${artist} - ${track}** to Last.fm. Please try again later.`,
      );
    }

    return IntelligenceBuilders.buildScrobbleSuccessResponse(artist, track, album, context.accentColor);
  }
}
