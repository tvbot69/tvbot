import { inject, injectable } from 'tsyringe';
import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { TrackService } from '@bot/services/library/trackService';
import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { setPreview } from '@bot/services/audio/voiceMessageService';
import { TrackBuilders } from '@bot/builders/library/trackBuilders';
import { TrackDetailsBuilders } from '@bot/builders/library/trackDetailsBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { ColorService } from '@bot/services/system/colorService';

@injectable()
export class TrackSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(TrackService) private readonly trackService: TrackService,
    @inject(TrackDetailsService) private readonly trackDetailsService: TrackDetailsService,
    @inject(LastFmRepository) private readonly lastfmRepository: ILastfmRepository,
    @inject(UpdateService) private readonly updateService: UpdateService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('track')
          .setDescription('Shows track scrobble stats and details for a user')
          .addStringOption(o => o.setName('track').setDescription('Track name (or "Artist | Track")').setRequired(false))
          .addStringOption(o => o.setName('artist').setDescription('Artist name (if not using "Artist | Track")').setRequired(false))
          .addUserOption(o => o.setName('user').setDescription('The user whose track stats you want to check').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.trackAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('trackdetails')
          .setDescription('Shows metadata for current track or the one you\'re searching for')
          .addStringOption(o => o.setName('track').setDescription('Track to search for (defaults to currently playing)').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.trackDetailsAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('love')
          .setDescription('Loves a track on Last.fm (defaults to currently playing)')
          .addStringOption(o => o.setName('track').setDescription('Track name (or "Artist | Track")').setRequired(false))
          .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.loveAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('unlove')
          .setDescription('Removes the track from your Last.fm loved tracks')
          .addStringOption(o => o.setName('track').setDescription('Track name (or "Artist | Track")').setRequired(false))
          .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.unloveAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('loved')
          .setDescription('Shows your or another user\'s loved tracks on Last.fm')
          .addUserOption(o => o.setName('user').setDescription('The user whose loved tracks you want to view').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.lovedAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('scrobble')
          .setDescription('Scrobbles a track to Last.fm')
          .addStringOption(o => o.setName('track').setDescription('Track name').setRequired(true))
          .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(true))
          .addStringOption(o => o.setName('album').setDescription('Album name (optional)').setRequired(false)) as SlashCommandBuilder,
        executeAsync: (ctx) => this.scrobbleAsync(ctx),
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
    // `artist | track`, NOT `track | artist`. `TrackService.searchTrack`
    // (trackService.ts:107-110) splits the joined string on ' | ' and reads
    // parts[0] as the ARTIST, so composing it the other way round searched for a
    // track called "Radiohead" by an artist called "Airbag". The one-string form
    // is split the same way in `/love` and `/trackdetails`, which is where the
    // order this line must follow comes from — not from the option order, which
    // is track-then-artist for the user.
    const searchValue = trackName && artistName ? `${artistName} | ${trackName}` : (trackName || artistName || null);

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
    // CORRECT AS IS: `mediaDetails` is the VOICE PREVIEW and store links, and it
    // is the only thing this read produces. `result` above is already fully
    // resolved, so a failed enrichment means `mediaDetails` is null and
    // `TrackBuilders` renders the track card without the preview button - an
    // omitted block, not a wrong one. Every number on the card (playcounts,
    // listeners, last-month plays) came from `trackService.searchTrack`, which is
    // outside this catch. The text twin is `trackCommands.trackAsync`.
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
      setPreview(uniqueId, mediaDetails.previewUrl);
    }

    const accentColor = await this.colorService?.getColorFromImageUrl(result.coverUrl) ?? DiscordConstants.LastFmColorRed;

    return TrackBuilders.buildTrackInfoResponse(
      result,
      user,
      targetDisplayName,
      accentColor,
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
          // Not "Unknown Artist" + the raw text. That was a confident metadata
          // card for a question Last.fm could not answer, and it is the only
          // thing on the card. `/love`, `/unlove` and the text `.trackdetails`
          // answer the same empty search with a not-found.
          return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${searchValue}\`.`);
        }
      }
    }

    const uniqueId = `td_${context.discordUserId}_${Date.now()}`;
    // CORRECT AS IS, and the same trade as `trackAsync` above and as the text
    // twin: `getDetails` contributes decoration only and no number on this card,
    // so a failed enrichment costs the metadata block and not the command. It
    // used to PROPAGATE while `/track` swallowed the identical failure — two
    // twins of one read disagreeing about what a preview-resolver outage does.
    const details = await this.trackDetailsService.getDetails(artist, trackName, uniqueId).catch(() => null);

    const accentColor = await this.colorService?.getColorFromImageUrl(details?.artworkUrl ?? null) ?? DiscordConstants.LastFmColorRed;

    if (!details?.resolved) {
      return TrackDetailsBuilders.buildNoMetadataResponse(artist, trackName, accentColor);
    }

    return TrackDetailsBuilders.buildTrackDetailsResponse(details, uniqueId, accentColor);
  }

  private async loveAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to love tracks on Last.fm. Please authorize tvbot using `/login`.',
      );
    }

    const trackOpt = context.interaction?.options.getString('track')?.trim() ?? '';
    const artistOpt = context.interaction?.options.getString('artist')?.trim() ?? '';

    let artist = artistOpt;
    let trackName = trackOpt;

    if (!trackName && !artist) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (trackName && !artist) {
      if (trackName.includes(' | ')) {
        const [a, t] = trackName.split(' | ');
        artist = (a ?? '').trim();
        trackName = (t ?? '').trim();
      } else if (trackName.toLowerCase().includes(' by ')) {
        const parts = trackName.split(/ by /i);
        trackName = parts[0]!.trim();
        artist = parts[1]!.trim();
      } else {
        const searchResults = await this.lastfmRepository.searchTracks(trackName);
        if (searchResults.length > 0) {
          artist = searchResults[0]!.artistName;
          trackName = searchResults[0]!.name;
        } else {
          return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${trackName}\`.`);
        }
      }
    }

    const success = await this.lastfmRepository.loveTrack(artist, trackName, user.sessionKey);
    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to love **${trackName}** by **${artist}** on Last.fm. Please try again.`,
      );
    }

    return TrackBuilders.buildLoveResponse(trackName, artist, context.accentColor);
  }

  private async unloveAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to unlove tracks on Last.fm. Please authorize tvbot using `/login`.',
      );
    }

    const trackOpt = context.interaction?.options.getString('track')?.trim() ?? '';
    const artistOpt = context.interaction?.options.getString('artist')?.trim() ?? '';

    let artist = artistOpt;
    let trackName = trackOpt;

    if (!trackName && !artist) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (trackName && !artist) {
      if (trackName.includes(' | ')) {
        const [a, t] = trackName.split(' | ');
        artist = (a ?? '').trim();
        trackName = (t ?? '').trim();
      } else if (trackName.toLowerCase().includes(' by ')) {
        const parts = trackName.split(/ by /i);
        trackName = parts[0]!.trim();
        artist = parts[1]!.trim();
      } else {
        const searchResults = await this.lastfmRepository.searchTracks(trackName);
        if (searchResults.length > 0) {
          artist = searchResults[0]!.artistName;
          trackName = searchResults[0]!.name;
        } else {
          return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${trackName}\`.`);
        }
      }
    }

    const success = await this.lastfmRepository.unloveTrack(artist, trackName, user.sessionKey);
    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to unlove **${trackName}** by **${artist}** on Last.fm. Please try again.`,
      );
    }

    return TrackBuilders.buildUnloveResponse(trackName, artist, context.accentColor);
  }

  private async lovedAsync(context: ContextModel): Promise<ResponseModel> {
    const targetDiscordUser = context.interaction?.options.getUser('user');
    const targetDiscordId = targetDiscordUser?.id ?? context.discordUserId;

    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        targetDiscordUser
          ? 'That user has not registered with the bot yet.'
          : 'You have not connected your Last.fm account yet. Use `/login` first.',
      );
    }

    const targetDisplayName =
      (targetDiscordUser && context.guild?.members.cache.get(targetDiscordId)?.displayName) ??
      context.member?.displayName ??
      user.userNameLastFm;

    const sessionKey = user.sessionKey ?? undefined;
    const { tracks, total } = await this.lastfmRepository.getLovedTracks(user.userNameLastFm, 200, 1, sessionKey);

    if (!tracks || tracks.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoScrobbles,
        `**${targetDisplayName}** does not have any loved tracks on Last.fm yet. Use \`/love\` to love your first track!`,
      );
    }

    return TrackBuilders.buildLovedTracksResponse(
      user.userNameLastFm,
      targetDisplayName,
      tracks,
      0,
      total,
      context.accentColor,
    );
  }

  private async scrobbleAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to scrobble to Last.fm. Please authorize tvbot using `/login`.',
      );
    }

    const trackName = context.interaction?.options.getString('track', true).trim() ?? '';
    const artist = context.interaction?.options.getString('artist', true).trim() ?? '';
    const album = context.interaction?.options.getString('album')?.trim();

    if (!artist || !trackName) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'Please specify both a track and artist name.',
      );
    }

    const success = await this.lastfmRepository.scrobbleTrack(
      artist,
      trackName,
      Math.floor(Date.now() / 1000),
      user.sessionKey,
      album,
    );

    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Failed to scrobble **${trackName}** by **${artist}** to Last.fm. Please try again later.`,
      );
    }

    return TrackBuilders.buildScrobbleResponse(trackName, artist, user.userNameLastFm, context.accentColor);
  }
}
