import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
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
import { LyricsService } from '@bot/services/music/lyricsService';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

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
        name: 'lyric',
        aliases: ['genius'],
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
      // CORRECT AS IS, and the two catch blocks below repeat it in `lovedAsync`
      // unchanged: a DISCORD READ whose only product is `targetDisplayName`, a
      // label on the card. Every path here has a real fallback - the members
      // cache, then `context.message.member.displayName`, then the Discord
      // username, then the Last.fm name - so a missing permission or a departed
      // member costs a cosmetically less specific name and nothing else. The
      // user lookup itself is on the line above and is NOT inside this try, so
      // "That user has not registered" remains a real answer.
      try {
        const member = await context.message?.guild?.members.fetch(id).catch(() => null);
        targetDisplayName = member?.displayName ?? context.message?.guild?.members.cache.get(id)?.displayName;
      } catch {
        // ignore
      }
    }

    const user = requestedByOther ?? await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) {
      return user;
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
    // CORRECT AS IS: the VOICE PREVIEW and store links, and the only thing this
    // read produces - the same trade as the slash twin
    // `trackSlashCommands.trackAsync`. `result` above is fully resolved, so a
    // failed enrichment means `mediaDetails` is null and the builder renders the
    // card without the preview button. Every playcount on it came from
    // `trackService.searchTrack`, outside this catch.
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
      displayName,
      accentColor,
      mediaDetails,
    );
  }

  private async trackDetailsAsync(context: ContextModel, trackValues: string): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;

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
          // A card labelled "Unknown Artist" with the user's raw text as the
          // track name is a confident answer to a question Last.fm could not
          // answer, and it is the only thing on that card. `love`, `unlove` and
          // `scrobble` all answer the same empty search with a not-found, and so
          // does `/trackdetails`.
          return GenericEmbedService.buildNotFoundResponse(`Could not find track matching \`${raw}\`.`);
        }
      }
    }

    const uniqueId = `td_${context.discordUserId}_${Date.now()}`;
    // CORRECT AS IS, and the same trade as `trackAsync` above: `getDetails`
    // contributes decoration only (preview, store link, duration, bpm, key) and
    // no number on this card, so a failed enrichment costs the metadata block
    // and not the command. It used to PROPAGATE here while `.track` swallowed
    // the identical failure — two twins of one read disagreeing about what a
    // preview-resolver outage does to the user. The no-metadata card below is
    // the honest rendering of "we could not read that": it names what is
    // missing instead of asserting anything.
    const details = await this.trackDetailsService.getDetails(artist, trackName, uniqueId).catch(() => null);
    const accentColor = await this.colorService?.getColorFromImageUrl(details?.artworkUrl ?? null) ?? DiscordConstants.LastFmColorRed;
    if (!details?.resolved) {
      return TrackDetailsBuilders.buildNoMetadataResponse(artist, trackName, accentColor);
    }
    return TrackDetailsBuilders.buildTrackDetailsResponse(details, uniqueId, accentColor);
  }

  private async loveAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to love tracks on Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    let artist: string;
    let trackName: string;
    // The joined arguments, BEFORE the trim, are what the separator is tested
    // on — the same rule, and the same reason, as `scrobbleAsync` below.
    // `.trim()` eats the space that makes `' | '` matchable, so `| Airbag` did
    // not contain the separator at all and fell through to the free-text search
    // (Last.fm was asked about a track called "| Airbag"), and `Radiohead | `
    // loved a track literally named `Radiohead | ` with an empty title beside it.
    const joined = args?.join(' ') ?? '';
    const raw = joined.trim();

    if (!raw) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (joined.includes(' | ')) {
      const [a, t] = joined.split(' | ');
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

    if (!artist || !trackName) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify both an artist and track name: \`${context.prefix}love Artist | Track\`.`,
      );
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
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to unlove tracks on Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    let artist: string;
    let trackName: string;
    // Joined, untrimmed, for the same reason as `loveAsync` above and
    // `scrobbleAsync` below: two twins of one command must not disagree about
    // where a half-filled pipe belongs.
    const joined = args?.join(' ') ?? '';
    const raw = joined.trim();

    if (!raw) {
      const tracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
      if (!tracks || tracks.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recently played tracks found on your Last.fm profile.');
      }
      artist = tracks[0]!.artistName;
      trackName = tracks[0]!.name;
    } else if (joined.includes(' | ')) {
      const [a, t] = joined.split(' | ');
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

    if (!artist || !trackName) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please specify both an artist and track name: \`${context.prefix}unlove Artist | Track\`.`,
      );
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
      // CORRECT AS IS, the same display-name read as in `trackAsync` above and for
      // the same reason: a label, with a real fallback chain, and the user lookup
      // on the line above deliberately left outside the try.
      try {
        const member = await context.message?.guild?.members.fetch(id).catch(() => null);
        targetDisplayName = member?.displayName ?? context.message?.guild?.members.cache.get(id)?.displayName;
      } catch {
        // ignore
      }
    }

    const user = requestedByOther ?? await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) {
      return user;
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
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    if (!user.sessionKey) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'Session key required to scrobble to Last.fm. Please authorize tvbot using `.login` or `/login`.',
      );
    }

    // The joined arguments, BEFORE the trim, are what the separator is tested
    // on. `.trim()` eats the space that makes `' | '` matchable, so `| Airbag`
    // and `Radiohead | ` did not contain the separator at all: the first fell
    // through to the free-text search (asking Last.fm about a track called
    // "| Airbag" and reporting it as not found) and the second scrobbled a title
    // ending in a pipe. Both now reach the WrongInput guard below, which is
    // where a half-filled pipe belongs.
    const joined = rawArgs?.join(' ') ?? '';
    const raw = joined.trim();
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

    if (joined.includes(' | ')) {
      const parts = joined.split(' | ');
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
      // Tested on the RAW query for the same reason as `scrobbleAsync` above:
      // trimming removes the space that makes `' - '` matchable, so `" - Airbag"`
      // was searched for as a song called "- Airbag" and `"Radiohead - "` as one
      // called "Radiohead -". An empty artist half is "no artist given", which is
      // exactly what the bare-title path below passes.
      if (rawQuery.includes(' - ')) {
        const parts = rawQuery.split(' - ');
        const head = parts[0]?.trim() ?? '';
        artistName = head === '' ? undefined : head;
        trackName = parts.slice(1).join(' - ').trim();
      } else {
        trackName = trimmed;
      }
    } else {
      const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;

      const recentTracks = await this.lastfmRepository.getUserRecentTracks(user.userNameLastFm, 1, 1, undefined, user.sessionKey);
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
