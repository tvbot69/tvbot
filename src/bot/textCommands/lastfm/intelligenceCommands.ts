import { injectable, inject } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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

interface TargetResolution {
  callerUser: User;
  targetUser: User;
  displayName: string;
  cleanSearchValue: string;
}

import { IcebergGenerator } from '@images/generators/icebergGenerator';
import { Logger } from '@domain/logger';

@injectable()
export class IntelligenceCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(MusicIntelligenceService) private readonly intelligenceService: MusicIntelligenceService,
    @inject(ColorService) private readonly colorService?: ColorService,
    @inject(IcebergGenerator) private readonly icebergGenerator?: IcebergGenerator,
  ) {
    this.commands = [
      {
        name: 'artistgaps',
        aliases: ['gaps', 'gap', 'agaps', 'artistgap'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'artist'),
      },
      {
        name: 'albumgaps',
        aliases: ['abgaps', 'algaps'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'album'),
      },
      {
        name: 'trackgaps',
        aliases: ['tgaps', 'songgaps'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'track'),
      },
      {
        name: 'discoveries',
        aliases: ['d', 'discovered', 'discovery', 'newartists'],
        executeAsync: (ctx, args) => this.discoveriesAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'iceberg',
        aliases: ['ice', 'icebergify', 'berg'],
        executeAsync: (ctx, args) => this.icebergAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'affinity',
        aliases: ['n', 'aff', 'neighbors', 'soulmates', 'neighbours'],
        executeAsync: (ctx, args) => this.affinityAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'love',
        aliases: ['heart', 'favorite'],
        executeAsync: (ctx, args) => {
          if (args && args.length > 0 && args[0]?.toLowerCase() === 'list') {
            return this.lovedAsync(ctx, args.slice(1).join(' '));
          }
          return this.loveAsync(ctx, args?.join(' ') ?? '');
        },
      },
      {
        name: 'unlove',
        aliases: ['ul', 'unheart'],
        executeAsync: (ctx, args) => this.unloveAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'loved',
        aliases: ['lovedtracks', 'lt'],
        executeAsync: (ctx, args) => this.lovedAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'scrobble',
        aliases: ['sb'],
        executeAsync: (ctx, args) => this.scrobbleAsync(ctx, args?.join(' ') ?? ''),
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

    let cleanSearchValue = rawOptions.trim();
    let targetUser = callerUser;
    let displayName = context.discordDisplayName;

    const mentionMatch = cleanSearchValue.match(/<@!?(\d+)>/);
    if (mentionMatch && mentionMatch[1]) {
      const mentionedDiscordId = mentionMatch[1];
      const foundUser = await this.userService.getUserByDiscordId(mentionedDiscordId);
      if (foundUser) {
        targetUser = foundUser;
        displayName = foundUser.userNameLastFm;
      }
      cleanSearchValue = cleanSearchValue.replace(mentionMatch[0], '').trim();
    } else {
      const lfmMatch = cleanSearchValue.match(/lfm:([a-zA-Z0-9_-]+)/i);
      if (lfmMatch && lfmMatch[1]) {
        const lfmName = lfmMatch[1];
        const foundUser = await this.userService.getUserByLastFmName(lfmName);
        if (foundUser) {
          targetUser = foundUser;
          displayName = foundUser.userNameLastFm;
        } else {
          targetUser = {
            ...callerUser,
            userNameLastFm: lfmName,
            discordUserId: '0',
          };
          displayName = lfmName;
        }
        cleanSearchValue = cleanSearchValue.replace(lfmMatch[0], '').trim();
      }
    }

    return {
      callerUser,
      targetUser,
      displayName,
      cleanSearchValue,
    };
  }

  private async listeningGapsAsync(
    context: ContextModel,
    rawOptions: string,
    defaultType: GapEntityType,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    let entityType: GapEntityType = defaultType;
    let clean = target.cleanSearchValue;
    if (/\b(album|albums)\b/i.test(clean)) {
      entityType = 'album';
      clean = clean.replace(/\b(album|albums)\b/i, '').trim();
    } else if (/\b(track|tracks|song|songs)\b/i.test(clean)) {
      entityType = 'track';
      clean = clean.replace(/\b(track|tracks|song|songs)\b/i, '').trim();
    } else if (/\b(artist|artists)\b/i.test(clean)) {
      entityType = 'artist';
      clean = clean.replace(/\b(artist|artists)\b/i, '').trim();
    }

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
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

  private async discoveriesAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);
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
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

  private async icebergAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);

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

    let imageBuffer: Buffer | null = null;
    if (this.icebergGenerator) {
      try {
        imageBuffer = await this.icebergGenerator.generateIceberg(icebergData);
      } catch (err) {
        Logger.warn({ err }, 'Failed to generate iceberg image');
      }
    }

    const targetDiscordId = target.targetUser.discordUserId.toString();
    const accentColor = targetDiscordId && targetDiscordId !== '0'
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    return IntelligenceBuilders.buildIcebergResponse({
      data: icebergData,
      imageBuffer,
      accentColor,
    });
  }

  private async affinityAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'The affinity command can only be used in a server.',
      );
    }

    const target = await this.resolveTarget(context, rawOptions);
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
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

  private async loveAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to love tracks.',
      );
    }

    let artistName: string;
    let trackName: string;

    const query = rawOptions.trim();
    if (!query) {
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
    } else {
      const parts = query.includes(' - ')
        ? query.split(' - ')
        : query.includes(' | ')
          ? query.split(' | ')
          : [query];

      if (parts.length >= 2) {
        artistName = parts[0]!.trim();
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        const search = await this.lastfmRepository.searchTracks(query);
        if (!search || search.length === 0) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not find track matching "${query}".`,
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

  private async unloveAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to unlove tracks.',
      );
    }

    let artistName: string;
    let trackName: string;

    const query = rawOptions.trim();
    if (!query) {
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
    } else {
      const parts = query.includes(' - ')
        ? query.split(' - ')
        : query.includes(' | ')
          ? query.split(' | ')
          : [query];

      if (parts.length >= 2) {
        artistName = parts[0]!.trim();
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        const search = await this.lastfmRepository.searchTracks(query);
        if (!search || search.length === 0) {
          return GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not find track matching "${query}".`,
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

  private async lovedAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
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

  private async scrobbleAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    if (!callerUser.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need to link your Last.fm account with write permissions using `/login` to scrobble tracks.',
      );
    }

    const query = rawOptions.trim();
    if (!query) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify the track to scrobble.\nFormat: \`${context.prefix}scrobble Artist - Track\` or \`${context.prefix}scrobble Artist | Track | Album\``,
      );
    }

    let artist: string;
    let track: string;
    let album: string | undefined;

    if (query.includes('|')) {
      const parts = query.split('|').map((p) => p.trim());
      artist = parts[0]!;
      track = parts[1] || '';
      album = parts[2] || undefined;
    } else if (query.includes(' - ')) {
      const parts = query.split(' - ').map((p) => p.trim());
      artist = parts[0]!;
      track = parts.slice(1).join(' - ');
    } else {
      const search = await this.lastfmRepository.searchTracks(query);
      if (!search || search.length === 0) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `Could not find track matching "${query}". Please use the \`Artist - Track\` format.`,
        );
      }
      artist = search[0]!.artistName;
      track = search[0]!.name;
    }

    if (!artist || !track) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Could not parse artist and track. Please use \`${context.prefix}scrobble Artist - Track\``,
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
