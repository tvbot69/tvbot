import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
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
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { ColorService } from '@bot/services/colorService';
import { LyricsService } from '@bot/services/music/lyricsService';

@injectable()
export class TrackCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(TrackService) private readonly trackService: TrackService,
    @inject(TrackDetailsService) private readonly trackDetailsService: TrackDetailsService,
    @inject(LastFmRepository) private readonly lastfmRepository: ILastfmRepository,
    @inject(UpdateService) private readonly updateService: UpdateService,
    @inject(LyricsService) private readonly lyricsService?: LyricsService,
    @inject(ColorService) private readonly colorService?: ColorService,
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
      {
        name: 'love',
        aliases: ['l', 'heart', 'favorite', 'affection', 'appreciation', 'lust', 'fuckyeah', 'fukk'],
        executeAsync: (context, args) => {
          if (args && args.length > 0 && args[0]?.toLowerCase() === 'list') {
            return this.lovedAsync(context, args.slice(1));
          }
          return this.loveAsync(context, args);
        },
      },
      {
        name: 'unlove',
        aliases: ['ul', 'unheart'],
        executeAsync: (context, args) => this.unloveAsync(context, args),
      },
      {
        name: 'loved',
        aliases: ['lovedtracks', 'lt'],
        executeAsync: (context, args) => this.lovedAsync(context, args),
      },
      {
        name: 'scrobble',
        aliases: ['scrobblesingle'],
        executeAsync: (context, args) => this.scrobbleAsync(context, args),
      },
      {
        name: 'lyrics',
        aliases: ['lyric', 'genius'],
        executeAsync: (context, args) => this.lyricsAsync(context, args?.join(' ') ?? ''),
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

    const accentColor = await this.colorService?.getColorFromImageUrl(result.coverUrl) ?? DiscordConstants.LastFmColorRed;

    return TrackBuilders.buildTrackInfoResponse(
      result,
      user,
      displayName,
      accentColor,
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
    const accentColor = await this.colorService?.getColorFromImageUrl(details.artworkUrl) ?? DiscordConstants.LastFmColorRed;
    if (!details.resolved) return TrackDetailsBuilders.buildNoMetadataResponse(artist, trackName, accentColor);
    return TrackDetailsBuilders.buildTrackDetailsResponse(details, uniqueId, accentColor);
  }

  private async loveAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `.login` or `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to love tracks on Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    let artist: string;
    let trackName: string;
    const raw = (args?.join(' ') ?? '').trim();

    if (!raw) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (raw.includes(' | ')) {
      const [a, t] = raw.split(' | ');
      artist = (a ?? '').trim();
      trackName = (t ?? '').trim();
    } else if (raw.toLowerCase().includes(' by ')) {
      const parts = raw.split(/ by /i);
      trackName = parts[0]!.trim();
      artist = parts[1]!.trim();
    } else {
      const searchResults = await this.lastfmRepository.searchTracks(raw);
      if (searchResults.length > 0) {
        artist = searchResults[0]!.artistName;
        trackName = searchResults[0]!.name;
      } else {
        return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${raw}\`.`);
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

  private async unloveAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `.login` or `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to unlove tracks on Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    let artist: string;
    let trackName: string;
    const raw = (args?.join(' ') ?? '').trim();

    if (!raw) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (raw.includes(' | ')) {
      const [a, t] = raw.split(' | ');
      artist = (a ?? '').trim();
      trackName = (t ?? '').trim();
    } else if (raw.toLowerCase().includes(' by ')) {
      const parts = raw.split(/ by /i);
      trackName = parts[0]!.trim();
      artist = parts[1]!.trim();
    } else {
      const searchResults = await this.lastfmRepository.searchTracks(raw);
      if (searchResults.length > 0) {
        artist = searchResults[0]!.artistName;
        trackName = searchResults[0]!.name;
      } else {
        return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${raw}\`.`);
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

  private async lovedAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
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

    const user = requestedByOther ?? (await this.userService.getUserByDiscordId(context.discordUserId));
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `.login` or `/login` first.',
      );
    }

    const displayName =
      targetDisplayName ??
      context.message?.member?.displayName ??
      context.message?.author.username ??
      user.userNameLastFm;

    const sessionKey = user.sessionKey ?? undefined;
    const { tracks, total } = await this.lastfmRepository.getLovedTracks(user.userNameLastFm, 200, 1, sessionKey);

    if (!tracks || tracks.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoScrobbles,
        `**${displayName}** does not have any loved tracks on Last.fm yet. Use \`${context.prefix}love\` to love your first track!`,
      );
    }

    return TrackBuilders.buildLovedTracksResponse(
      user.userNameLastFm,
      displayName,
      tracks,
      0,
      total,
      context.accentColor,
    );
  }

  private async scrobbleAsync(context: ContextModel, rawArgs: string[]): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `.login` or `/login` first.',
      );
    }
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to scrobble to Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    const raw = (rawArgs?.join(' ') ?? '').trim();
    if (!raw) {
      return GenericEmbedService.buildInfoResponse(
        `### ${context.prefix}scrobble\n` +
        `Scrobbles a track to your Last.fm account.\n\n` +
        `**Usage:**\n` +
        `\`${context.prefix}scrobble Artist | Track\`\n` +
        `\`${context.prefix}scrobble Artist | Track | Album\`\n` +
        `\`${context.prefix}sb Track by Artist\`\n` +
        `\`${context.prefix}sb Song Name\``,
      );
    }

    let artist: string;
    let trackName: string;
    let album: string | undefined;

    if (raw.includes(' | ')) {
      const parts = raw.split(' | ');
      artist = (parts[0] ?? '').trim();
      trackName = (parts[1] ?? '').trim();
      if (parts.length > 2) {
        album = (parts[2] ?? '').trim();
      }
    } else if (raw.toLowerCase().includes(' by ')) {
      const parts = raw.split(/ by /i);
      trackName = parts[0]!.trim();
      artist = parts[1]!.trim();
    } else {
      const searchResults = await this.lastfmRepository.searchTracks(raw);
      if (searchResults.length > 0) {
        artist = searchResults[0]!.artistName;
        trackName = searchResults[0]!.name;
      } else {
        return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${raw}\`. Try \`${context.prefix}scrobble Artist | Track\`.`);
      }
    }

    if (!artist || !trackName) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify both an artist and track name: \`${context.prefix}scrobble Artist | Track\`.`,
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

  private async lyricsAsync(context: ContextModel, rawQuery: string): Promise<ResponseModel> {
    let artistName: string | undefined;
    let trackName: string | undefined;

    const trimmed = rawQuery.trim();
    if (trimmed) {
      if (trimmed.includes(' - ')) {
        const parts = trimmed.split(' - ');
        artistName = parts[0]?.trim();
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        trackName = trimmed;
      }
    } else {
      const user = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!user) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Either specify a song (\`${context.prefix}lyrics Artist - Track\`) or connect with \`${context.prefix}login\`.`,
        );
      }

      const recentTracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1);
      if (!recentTracks || recentTracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse(`No recent tracks found on Last.fm for **${user.userNameLastFm}**.`);
      }

      artistName = recentTracks[0]!.artistName;
      trackName = recentTracks[0]!.name;
    }

    if (!trackName) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}lyrics [Artist - Track]\``);
    }

    if (!this.lyricsService) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.Error, 'Lyrics service is currently unavailable.');
    }

    const lyricsResult = await this.lyricsService.getLyrics(trackName, artistName);
    if (!lyricsResult || !lyricsResult.plainLyrics?.trim()) {
      const displayTitle = artistName ? `${artistName} – ${trackName}` : trackName;
      return GenericEmbedService.buildNotFoundResponse(`Could not find lyrics for **${displayTitle}**.`);
    }

    const response = new ResponseModel(context.accentColor ?? DiscordConstants.LastFmColorBlue);
    response.commandResponse = CommandResponse.Ok;

    let content = lyricsResult.plainLyrics.trim();
    if (content.length > 4000) {
      content = content.slice(0, 3950) + '\n\n... *(lyrics truncated)*';
    }

    response.embed.setTitle(`🎵 ${lyricsResult.artist} – ${lyricsResult.title}`);
    response.embed.setDescription(content);
    response.embed.setFooter({
      text: `Lyrics provided by ${lyricsResult.source?.toUpperCase() ?? 'GENIUS'}`,
    });

    return response;
  }
}
