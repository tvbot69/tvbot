import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
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

export class TrackSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly trackService: TrackService,
    private readonly trackDetailsService: TrackDetailsService,
    private readonly lastfmRepository: ILastfmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('track')
          .setDescription('Shows track scrobble stats and details for a user')
          .addStringOption(o => o.setName('track').setDescription('Track name (or "Artist | Track")').setRequired(false))
          .addStringOption(o => o.setName('artist').setDescription('Artist name (if not using "Artist | Track")').setRequired(false))
          .addUserOption(o => o.setName('user').setDescription('The user whose track stats you want to check').setRequired(false)) as any,
        executeAsync: (ctx) => this.trackAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('trackdetails')
          .setDescription('Shows metadata for current track or the one you\'re searching for')
          .addStringOption(o => o.setName('track').setDescription('Track to search for (defaults to currently playing)').setRequired(false)) as any,
        executeAsync: (ctx) => this.trackDetailsAsync(ctx),
      },
    ];
  }

  private async trackAsync(context: ContextModel): Promise<ResponseModel> {
    const targetDiscordUser = context.interaction?.options.getUser('user');
    const targetDiscordId = targetDiscordUser?.id ?? context.discordUserId;

    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        targetDiscordUser
          ? 'That user has not registered with the bot yet.'
          : 'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const trackName = context.interaction?.options.getString('track')?.trim() ?? '';
    const artistName = context.interaction?.options.getString('artist')?.trim() ?? '';
    const searchValue = trackName && artistName ? `${trackName} | ${artistName}` : (trackName || artistName || null);

    const result = await this.trackService.searchTrack(
      searchValue,
      user,
      context.guildId,
    );

    if (!result) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'No track could be found. Try providing an artist and track name (`track | artist` or `track by artist`).',
      );
    }

    const targetDisplayName =
      (targetDiscordUser && context.guild?.members.cache.get(targetDiscordId)?.displayName) ??
      context.member?.displayName ??
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
      targetDisplayName,
      context.accentColor,
      mediaDetails,
    );
  }

  private async trackDetailsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet. Use `/register` first.');
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const searchValue = context.interaction?.options.getString('track')?.trim() ?? null;
    let artist: string;
    let trackName: string;

    if (!searchValue) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile.');
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (searchValue.includes(' | ')) {
      const [a, t] = searchValue.split(' | ');
      artist = (a ?? '').trim();
      trackName = (t ?? '').trim();
    } else {
      // Try to parse "Track by Artist" or just track name — fallback to search
      // We'll resolve via Last.fm search if needed, but for now use raw and let preview resolver score
      // If custom contains ' by ', split
      if (searchValue.toLowerCase().includes(' by ')) {
        const parts = searchValue.split(/ by /i);
        trackName = parts[0]!.trim();
        artist = parts[1]!.trim();
      } else {
        // Search Last.fm for best match
        const searchResults = await this.lastfmRepository.searchTracks(searchValue);
        if (searchResults.length > 0) {
          artist = searchResults[0]!.artistName;
          trackName = searchResults[0]!.name;
        } else {
          artist = 'Unknown Artist';
          trackName = searchValue;
        }
      }
    }

    const uniqueId = `td_${context.discordUserId}_${Date.now()}`;
    const details = await this.trackDetailsService.getDetails(artist, trackName, uniqueId);

    if (!details.resolved) {
      return TrackDetailsBuilders.buildNoMetadataResponse(artist, trackName, context.accentColor);
    }

    return TrackDetailsBuilders.buildTrackDetailsResponse(details, uniqueId, context.accentColor);
  }
}
