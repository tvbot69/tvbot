import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/iuserRepository';
import { UserService } from '@bot/services/userService';
import { TrackService } from '@bot/services/trackService';
import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { previewMap } from '@bot/services/audio/voiceMessageService';
import { TrackBuilders } from '@bot/builders/trackBuilders';
import { TrackDetailsBuilders } from '@bot/builders/trackDetailsBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

export class TrackCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly trackService: TrackService,
    private readonly trackDetailsService: TrackDetailsService,
    private readonly lastfmRepository: ILastfmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        name: 'track',
        aliases: ['t', 'tr', 'trackinfo', 'ti'],
        executeAsync: (context, args) => this.trackAsync(context, args),
      },
      {
        name: 'trackdetails',
        aliases: ['td', 'trackdata', 'trackmetadata', 'tds'],
        executeAsync: (context, args) => this.trackDetailsAsync(context, args?.join(' ') ?? ''),
      },
    ];
  }

  private async trackAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
    let args = [...rawArgs];
    let requestedByOther: User | null = null;
    let targetDisplayName: string | undefined;

    const mentionMatch = args.find((a) => /^<@!?(\d+)>$/.test(a));
    if (mentionMatch) {
      const id = mentionMatch.replace(/[^\d]/g, '');
      args = args.filter((a) => a !== mentionMatch);
      const target = await this.userService.getUserByDiscordId(id);
      if (!target) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      requestedByOther = target;
      try {
        const member = await context.message?.guild?.members.fetch(id).catch(() => null);
        targetDisplayName = member?.displayName ?? context.message?.guild?.members.cache.get(id)?.displayName;
      } catch {
        // ignore
      }
    }

    const user =
      requestedByOther ??
      (await this.userService.getUserByDiscordId(context.discordUserId));
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const searchValue = args.join(' ').trim();
    const result = await this.trackService.searchTrack(
      searchValue || null,
      user,
      context.guildId,
    );

    if (!result) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'No track could be found. Try providing an artist and track name (`track | artist` or `track by artist`).',
      );
    }

    const displayName =
      targetDisplayName ??
      context.message?.member?.displayName ??
      context.message?.author.username ??
      user.userNameLastFm;

    const uniqueId = `track_${context.discordUserId}_${Date.now()}`;
    const mediaDetailsRaw = await this.trackDetailsService.getDetails(result.artistName, result.trackName, uniqueId).catch(() => null);

    const mediaDetails = mediaDetailsRaw ? {
      uniqueId,
      previewUrl: mediaDetailsRaw.previewUrl,
      storeUrl: mediaDetailsRaw.storeUrl,
      spotifyUrl: mediaDetailsRaw.spotifyUrl,
      source: mediaDetailsRaw.resolved?.source,
      durationFormatted: mediaDetailsRaw.durationFormatted,
    } : null;

    if (mediaDetails?.previewUrl) {
      previewMap.set(uniqueId, mediaDetails.previewUrl);
    }

    return TrackBuilders.buildTrackInfoResponse(
      result,
      user,
      displayName,
      context.accentColor,
      mediaDetails,
    );
  }

  private async trackDetailsAsync(context: ContextModel, trackValues: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use the register command first.');
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    let artist: string;
    let trackName: string;
    const raw = (trackValues ?? '').trim();

    if (!raw) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (raw.includes(' | ')) {
      const [a, t] = raw.split(' | ');
      artist = (a ?? '').trim();
      trackName = (t ?? '').trim();
    } else {
      if (raw.toLowerCase().includes(' by ')) {
        const parts = raw.split(/ by /i);
        trackName = parts[0]!.trim();
        artist = parts[1]!.trim();
      } else {
        const searchResults = await this.lastfmRepository.searchTracks(raw);
        if (searchResults.length > 0) {
          artist = searchResults[0]!.artistName;
          trackName = searchResults[0]!.name;
        } else {
          artist = 'Unknown Artist';
          trackName = raw;
        }
      }
    }

    const uniqueId = `td_${context.discordUserId}_${Date.now()}`;
    const details = await this.trackDetailsService.getDetails(artist, trackName, uniqueId);
    if (!details.resolved) return TrackDetailsBuilders.buildNoMetadataResponse(artist, trackName, context.accentColor);
    return TrackDetailsBuilders.buildTrackDetailsResponse(details, uniqueId, context.accentColor);
  }
}
