import { GuildMember } from 'discord.js';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { MusicService } from '@bot/services/music/musicService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { ColorService } from '@bot/services/colorService';
import type { FilterName, LoopMode } from '@domain/models/music/musicQueue';
import { ALL_FILTERS } from '@domain/models/music/musicQueue';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { MusicInteractions } from '@bot/interactions/musicInteractions';

export class MusicCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly musicService: MusicService;
  private readonly colorService: ColorService;
  private readonly lyricsService?: LyricsService;
  private readonly musicInteractions?: MusicInteractions;

  constructor(
    musicService: MusicService,
    colorService: ColorService,
    lyricsService?: LyricsService,
    musicInteractions?: MusicInteractions,
  ) {
    this.musicService = musicService;
    this.colorService = colorService;
    this.lyricsService = lyricsService;
    this.musicInteractions = musicInteractions;

    this.commands = [
      {
        name: 'play',
        aliases: ['p'],
        executeAsync: (ctx, args) => this.playAsync(ctx, args),
      },
      {
        name: 'search',
        aliases: ['find'],
        executeAsync: (ctx, args) => this.searchAsync(ctx, args),
      },
      {
        name: 'nowplaying',
        aliases: ['np', 'now', 'current'],
        executeAsync: (ctx) => this.nowPlayingAsync(ctx),
      },
      {
        name: 'queue',
        aliases: ['q'],
        executeAsync: (ctx, args) => this.queueAsync(ctx, args),
      },
      {
        name: 'skip',
        aliases: ['next', 's'],
        executeAsync: (ctx, args) => this.skipAsync(ctx, args),
      },
      {
        name: 'previous',
        aliases: ['prev', 'back'],
        executeAsync: (ctx) => this.previousAsync(ctx),
      },
      {
        name: 'skipto',
        aliases: ['jump'],
        executeAsync: (ctx, args) => this.skiptoAsync(ctx, args),
      },
      {
        name: 'move',
        aliases: ['mv'],
        executeAsync: (ctx, args) => this.moveAsync(ctx, args),
      },
      {
        name: 'replay',
        aliases: ['restart'],
        executeAsync: (ctx) => this.replayAsync(ctx),
      },
      {
        name: 'stop',
        aliases: ['leave', 'dc'],
        executeAsync: (ctx) => this.stopAsync(ctx),
      },
      {
        name: 'pause',
        executeAsync: (ctx) => this.pauseAsync(ctx),
      },
      {
        name: 'resume',
        executeAsync: (ctx) => this.resumeAsync(ctx),
      },
      {
        name: 'seek',
        executeAsync: (ctx, args) => this.seekAsync(ctx, args),
      },
      {
        name: 'volume',
        aliases: ['vol', 'v'],
        executeAsync: (ctx, args) => this.volumeAsync(ctx, args),
      },
      {
        name: 'filters',
        aliases: ['filter', 'f'],
        executeAsync: (ctx, args) => this.filtersAsync(ctx, args),
      },
      {
        name: 'lyrics',
        aliases: ['ly'],
        executeAsync: (ctx, args) => this.lyricsAsync(ctx, args),
      },
      {
        name: 'join',
        aliases: ['summon', 'j'],
        executeAsync: (ctx) => this.joinAsync(ctx),
      },
      {
        name: '247',
        aliases: ['stay', '24/7'],
        executeAsync: (ctx, args) => this.toggle247Async(ctx, args),
      },
      {
        name: 'autoplay',
        aliases: ['ap'],
        executeAsync: (ctx, args) => this.autoplayAsync(ctx, args),
      },
      {
        name: 'loop',
        aliases: ['repeat', 'l'],
        executeAsync: (ctx, args) => this.loopAsync(ctx, args),
      },
      {
        name: 'shuffle',
        executeAsync: (ctx) => this.shuffleAsync(ctx),
      },
      {
        name: 'clear',
        executeAsync: (ctx) => this.clearAsync(ctx),
      },
      {
        name: 'remove',
        aliases: ['rm'],
        executeAsync: (ctx, args) => this.removeAsync(ctx, args),
      },
      {
        name: 'history',
        executeAsync: (ctx) => this.historyAsync(ctx),
      },
      {
        name: 'nodes',
        aliases: ['lavalink', 'nodestats'],
        executeAsync: (ctx) => this.nodesAsync(ctx),
      },
    ];
  }

  private async getGuildAndMember(
    context: ContextModel,
  ): Promise<{ guildId: string; member: GuildMember; voiceChannelId: string; textChannelId: string } | null> {
    if (!context.guildId) return null;
    const member = context.member;
    if (!member) return null;
    const voiceChannelId = member.voice?.channelId;
    const textChannelId = context.interaction?.channelId ?? context.message?.channelId;
    if (!voiceChannelId || !textChannelId) return null;

    return {
      guildId: context.guildId,
      member,
      voiceChannelId,
      textChannelId,
    };
  }

  private async playAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse(
        'You must be in a voice channel to play music.',
      );
    }

    const query = args.join(' ').trim();
    if (!query) {
      return GenericEmbedService.buildWrongInputResponse(
        `Please provide a song name or Spotify/YouTube URL. Example: \`${context.prefix}play bohemian rhapsody\``,
      );
    }

    const requesterTag = context.member?.user?.tag ?? 'User';
    const requester = {
      id: context.discordUserId,
      tag: requesterTag,
      avatarUrl: context.member?.user?.displayAvatarURL(),
    };

    const result = await this.musicService.play(
      info.guildId,
      info.voiceChannelId,
      info.textChannelId,
      query,
      requester,
    );

    const accentColor = await this.colorService.getAccentColorAsync(info.guildId);

    if (result.loadType === 'empty') {
      return GenericEmbedService.buildNotFoundResponse(
        `No tracks found for: **${query}**.`,
      );
    }

    if (result.loadType === 'error') {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'An error occurred while communicating with the music node. Try again in a few seconds.',
      );
    }

    if (result.loadType === 'track' && result.track) {
      const queue = this.musicService.getQueueInfo(info.guildId);
      return MusicBuilders.buildTrackAddedResponse(
        result.track,
        result.positionInQueue,
        queue?.totalTracks ?? 1,
        accentColor,
      );
    }

    if (
      result.loadType === 'playlist' ||
      result.loadType === 'spotify_album' ||
      result.loadType === 'spotify_playlist' ||
      result.loadType === 'spotify_artist'
    ) {
      const isSpotify = result.loadType.startsWith('spotify');
      const totalDuration = result.tracks?.reduce((acc, t) => acc + t.duration, 0) ?? 0;
      return MusicBuilders.buildPlaylistAddedResponse(
        result.playlistName ?? 'Playlist',
        result.totalTracksAdded,
        totalDuration,
        result.artworkUrl,
        result.positionInQueue,
        accentColor,
        isSpotify ? 'spotify' : 'youtube',
      );
    }

    return MusicBuilders.buildSimpleResponse('🎵 Added to Queue', `Added **${query}** to the queue.`, accentColor);
  }

  private async searchAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to search for music.');
    }

    const query = args.join(' ').trim();
    if (!query) {
      return GenericEmbedService.buildWrongInputResponse(`Please provide a search term. Example: \`${context.prefix}search daft punk\``);
    }

    const tracks = await this.musicService.searchTracks(query);
    if (tracks.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(`No tracks found for: **${query}**.`);
    }

    const accentColor = await this.colorService.getAccentColorAsync(info.guildId);
    const response = MusicBuilders.buildSearchResponse(query, tracks, accentColor);

    if (this.musicInteractions) {
      const msgId = context.message?.id ?? context.discordUserId;
      this.musicInteractions.storeSearchResults(msgId, tracks);
      this.musicInteractions.storeSearchResults(context.discordUserId, tracks);
    }

    return response;
  }

  private async nowPlayingAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const queue = this.musicService.getQueueInfo(context.guildId);
    if (!queue || !queue.current) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(context.guildId);
    return MusicBuilders.buildNowPlayingResponse(queue, accentColor);
  }

  private async queueAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const queue = this.musicService.getQueueInfo(context.guildId);
    if (!queue) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    const page = args[0] ? Number(args[0]) : 1;
    const accentColor = await this.colorService.getAccentColorAsync(context.guildId);
    return MusicBuilders.buildQueueResponse(queue, page, 10, accentColor);
  }

  private async skipAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to skip tracks.');
    }

    const amount = args[0] ? Number(args[0]) : 1;
    const count = Number.isFinite(amount) && amount > 1 ? Math.floor(amount) : 1;
    const success = await this.musicService.skip(info.guildId, count);

    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No tracks in queue to skip.');
    }

    return MusicBuilders.buildSimpleResponse(
      '⏭️ Skipped',
      count > 1 ? `Skipped **${count}** tracks.` : 'Skipped to the next track.',
    );
  }

  private async previousAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to replay tracks.');
    }

    const success = await this.musicService.previous(info.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No previous track in history to replay.');
    }

    return MusicBuilders.buildSimpleResponse('⏮️ Previous Track', 'Replaying previous track from history.');
  }

  private async skiptoAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to jump tracks.');
    }

    const pos = parseInt(args[0] ?? '', 10);
    if (Number.isNaN(pos) || pos < 1) {
      return GenericEmbedService.buildWrongInputResponse(`Please specify a valid track position. Example: \`${context.prefix}skipto 3\``);
    }

    const success = await this.musicService.skipto(info.guildId, pos);
    if (!success) {
      return GenericEmbedService.buildWrongInputResponse(`Invalid track position #${pos}. Check \`${context.prefix}queue\`.`);
    }

    return MusicBuilders.buildSimpleResponse('⏭️ Jumped Track', `Skipped to track **#${pos}** in the queue.`);
  }

  private async moveAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to move tracks.');
    }

    const from = parseInt(args[0] ?? '', 10);
    const to = parseInt(args[1] ?? '', 10);
    if (Number.isNaN(from) || Number.isNaN(to) || from < 1 || to < 1) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}move <from_pos> <to_pos>\`. Example: \`${context.prefix}move 5 1\``);
    }

    const success = this.musicService.move(info.guildId, from, to);
    if (!success) {
      return GenericEmbedService.buildWrongInputResponse('Invalid track positions. Please check the queue.');
    }

    return MusicBuilders.buildSimpleResponse('↔️ Moved Track', `Moved track from position **#${from}** to **#${to}**.`);
  }

  private async replayAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const success = await this.musicService.replay(info.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('🔁 Replay', 'Restarted the current track from the beginning.');
  }

  private async stopAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to stop music.');
    }

    await this.musicService.stop(info.guildId);
    return MusicBuilders.buildSimpleResponse('⏹️ Stopped', 'Playback stopped and disconnected from voice.');
  }

  private async pauseAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const success = await this.musicService.pause(info.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('⏸️ Paused', `Playback paused. Use \`${context.prefix}resume\` to continue.`);
  }

  private async resumeAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const success = await this.musicService.resume(info.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently paused.');
    }

    return MusicBuilders.buildSimpleResponse('▶️ Resumed', 'Playback resumed.');
  }

  private async seekAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const raw = args[0];
    if (!raw) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}seek <seconds | mm:ss>\`. Example: \`${context.prefix}seek 1:30\``);
    }

    let seconds: number;
    if (raw.includes(':')) {
      const parts = raw.split(':').map(Number);
      if (parts.length === 2) {
        seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
      } else if (parts.length === 3) {
        seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
      } else {
        return GenericEmbedService.buildWrongInputResponse('Invalid time format. Use `mm:ss` or seconds.');
      }
    } else {
      seconds = Number(raw);
    }

    if (!Number.isFinite(seconds) || seconds < 0) {
      return GenericEmbedService.buildWrongInputResponse('Please provide a valid time in seconds or `mm:ss`.');
    }

    const success = await this.musicService.seek(info.guildId, seconds);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No track is currently playing to seek.');
    }

    return MusicBuilders.buildSimpleResponse('⏩ Seeked', `Jumped to \`${raw}\` in the current track.`);
  }

  private async volumeAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    if (!args[0]) {
      const queue = this.musicService.getQueueInfo(info.guildId);
      const currentVol = queue?.volume ?? 100;
      return MusicBuilders.buildSimpleResponse('🔊 Current Volume', `The player volume is currently set to **${currentVol}%**.`);
    }

    const vol = Number(args[0]);
    if (!Number.isFinite(vol) || vol < 0 || vol > 150) {
      return GenericEmbedService.buildWrongInputResponse('Volume must be a number between 0 and 150.');
    }

    const applied = this.musicService.setVolume(info.guildId, vol);
    return MusicBuilders.buildSimpleResponse('🔊 Volume Changed', `Volume set to **${applied}%**.`);
  }

  private async filtersAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to configure filters.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(info.guildId);
    const queue = this.musicService.getQueueInfo(info.guildId);
    if (!queue) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    if (!args[0]) {
      return MusicBuilders.buildFiltersResponse(queue.activeFilters, accentColor);
    }

    const filterArg = args[0].toLowerCase();
    if (filterArg === 'clear' || filterArg === 'reset') {
      await this.musicService.clearFilters(info.guildId);
      return MusicBuilders.buildSimpleResponse('🎛️ Filters Cleared', 'All audio filters have been removed.', accentColor);
    }

    if (!ALL_FILTERS.includes(filterArg as FilterName)) {
      return GenericEmbedService.buildWrongInputResponse(
        `Unknown filter \`${filterArg}\`. Available: ${ALL_FILTERS.map((f) => `\`${f}\``).join(', ')}`,
      );
    }

    const filterName = filterArg as FilterName;
    const isCurrentlyActive = queue.activeFilters.includes(filterName);
    await this.musicService.setFilter(info.guildId, filterName, !isCurrentlyActive);

    return MusicBuilders.buildSimpleResponse(
      '🎛️ Filter Toggled',
      `Filter **${filterName}** is now **${!isCurrentlyActive ? 'ENABLED' : 'DISABLED'}**.`,
      accentColor,
    );
  }

  private async lyricsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!this.lyricsService) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.Error, 'Lyrics service unavailable.');
    }

    let query = args.join(' ').trim();
    let artist: string | undefined;

    if (!query) {
      if (!context.guildId) {
        return GenericEmbedService.buildWrongInputResponse('Please provide a song title to search lyrics for.');
      }
      const queue = this.musicService.getQueueInfo(context.guildId);
      if (!queue?.current) {
        return GenericEmbedService.buildWrongInputResponse(`No song is currently playing. Usage: \`${context.prefix}lyrics <song title>\``);
      }
      query = queue.current.title;
      artist = queue.current.author;
    }

    const result = await this.lyricsService.getLyrics(query, artist);
    if (!result || !result.plainLyrics) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find lyrics for: **${query}**.`);
    }

    const accentColor = context.guildId ? await this.colorService.getAccentColorAsync(context.guildId) : undefined;
    const cleanLyrics = result.plainLyrics.length > 4000 ? `${result.plainLyrics.slice(0, 3950)}...\n*(Lyrics truncated)*` : result.plainLyrics;
    return MusicBuilders.buildLyricsResponse(result.title, result.artist, cleanLyrics, accentColor);
  }

  private async joinAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to summon the bot.');
    }

    const player = this.musicService.getOrCreatePlayer(info.guildId, info.voiceChannelId, info.textChannelId);
    if (!player.connected) {
      await player.connect({ selfDeaf: true });
    }

    return MusicBuilders.buildSimpleResponse('🔊 Connected', `Joined voice channel <#${info.voiceChannelId}>.`);
  }

  private async toggle247Async(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    let explicitState: boolean | undefined;
    if (args[0]) {
      const lower = args[0].toLowerCase();
      if (['on', 'enable', 'true', '1'].includes(lower)) explicitState = true;
      if (['off', 'disable', 'false', '0'].includes(lower)) explicitState = false;
    }

    const newState = this.musicService.toggle247(context.guildId, explicitState);
    return MusicBuilders.buildSimpleResponse(
      '📻 24/7 Mode',
      newState
        ? '24/7 mode is now **ENABLED**. The bot will remain in the voice channel indefinitely.'
        : '24/7 mode is now **DISABLED**. The bot will disconnect when the queue finishes.',
    );
  }

  private async autoplayAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    let explicitState: boolean | undefined;
    if (args[0]) {
      const lower = args[0].toLowerCase();
      if (['on', 'enable', 'true', '1'].includes(lower)) explicitState = true;
      if (['off', 'disable', 'false', '0'].includes(lower)) explicitState = false;
    }

    const newState = this.musicService.toggleAutoplay(info.guildId, explicitState);
    if (newState === null) {
      return GenericEmbedService.buildNotFoundResponse('No music player is currently active.');
    }

    return MusicBuilders.buildSimpleResponse(
      '📻 Autoplay',
      newState
        ? 'Autoplay is now **ENABLED**. Related tracks will play automatically when the queue ends.'
        : 'Autoplay is now **DISABLED**.',
    );
  }

  private async loopAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const modeArg = (args[0] || 'track').toLowerCase();
    let mode: LoopMode;
    if (['track', 'song', 'current', '1'].includes(modeArg)) mode = 'track';
    else if (['queue', 'all', 'q'].includes(modeArg)) mode = 'queue';
    else if (['off', 'disable', 'none', '0'].includes(modeArg)) mode = 'off';
    else {
      return GenericEmbedService.buildWrongInputResponse(`Invalid loop mode. Usage: \`${context.prefix}loop <track | queue | off>\``);
    }

    const applied = this.musicService.setLoop(info.guildId, mode);
    if (!applied) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('🔁 Loop Mode', `Loop mode set to **${applied.toUpperCase()}**.`);
  }

  private async shuffleAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const success = this.musicService.shuffle(info.guildId);
    if (!success) {
      return GenericEmbedService.buildWrongInputResponse('The queue is empty or has only 1 track — nothing to shuffle.');
    }

    return MusicBuilders.buildSimpleResponse('🔀 Shuffled', 'The music queue has been randomized.');
  }

  private async clearAsync(context: ContextModel): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const success = this.musicService.clear(info.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music player is currently active.');
    }

    return MusicBuilders.buildSimpleResponse('🗑️ Queue Cleared', 'All upcoming tracks have been removed from the queue.');
  }

  private async removeAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const info = await this.getGuildAndMember(context);
    if (!info) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel.');
    }

    const indexArg = args[0];
    if (!indexArg) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}remove <position>\`. Example: \`${context.prefix}remove 2\``);
    }

    const pos = Number(indexArg);
    if (!Number.isFinite(pos) || pos < 1) {
      return GenericEmbedService.buildWrongInputResponse('Please provide a valid position number.');
    }

    const removed = this.musicService.remove(info.guildId, pos - 1);
    if (!removed) {
      return GenericEmbedService.buildWrongInputResponse(`No track found at position #${pos}. Check \`${context.prefix}queue\`.`);
    }

    return MusicBuilders.buildSimpleResponse('🗑️ Removed', `Removed **${removed.title}** from position #${pos}.`);
  }

  private async historyAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const history = this.musicService.getHistory(context.guildId, 10);
    if (history.length === 0) {
      return GenericEmbedService.buildNotFoundResponse('No recently played tracks in this server yet.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(context.guildId);
    let desc = '';
    history.forEach((item, idx) => {
      desc += `\`${idx + 1}.\` [${item.track.title}](${item.track.uri}) — \`${item.track.author}\`\n`;
    });

    const response = MusicBuilders.buildSimpleResponse('📜 Recently Played Tracks', desc, accentColor);
    return response;
  }

  private async nodesAsync(context: ContextModel): Promise<ResponseModel> {
    const stats = this.musicService.getNodeStats();
    const accentColor = context.guildId
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;
    return MusicBuilders.buildNodeStatsResponse(stats, accentColor);
  }
}
