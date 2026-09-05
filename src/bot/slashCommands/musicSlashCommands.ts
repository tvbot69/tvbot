import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { MusicService } from '@bot/services/music/musicService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { ColorService } from '@bot/services/colorService';
import { ALL_FILTERS, type FilterName, type LoopMode } from '@domain/models/music/musicQueue';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { MusicInteractions } from '@bot/interactions/musicInteractions';

export class MusicSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

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
        data: new SlashCommandBuilder()
          .setName('play')
          .setDescription('Play a song from YouTube or Spotify')
          .addStringOption((opt) =>
            opt
              .setName('query')
              .setDescription('Song title, artist, or YouTube/Spotify URL')
              .setRequired(true),
          ),
        executeAsync: (ctx) => this.executePlay(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('search')
          .setDescription('Search for songs and pick one from an interactive menu')
          .addStringOption((opt) =>
            opt
              .setName('query')
              .setDescription('Song title or artist to search')
              .setRequired(true),
          ),
        executeAsync: (ctx) => this.executeSearch(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('nowplaying')
          .setDescription('View the currently playing track with interactive controls'),
        executeAsync: (ctx) => this.executeNowPlaying(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('queue')
          .setDescription('View the current music queue')
          .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1),
          ),
        executeAsync: (ctx) => this.executeQueue(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('skip')
          .setDescription('Skip current song or multiple songs')
          .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Number of tracks to skip').setMinValue(1),
          ),
        executeAsync: (ctx) => this.executeSkip(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('previous')
          .setDescription('Replay the previous track from history'),
        executeAsync: (ctx) => this.executePrevious(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('skipto')
          .setDescription('Jump directly to a specific track in the queue')
          .addIntegerOption((opt) =>
            opt
              .setName('position')
              .setDescription('Position of the track in queue (1-based)')
              .setRequired(true)
              .setMinValue(1),
          ),
        executeAsync: (ctx) => this.executeSkipTo(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('move')
          .setDescription('Move a track to a different position in the queue')
          .addIntegerOption((opt) =>
            opt
              .setName('from')
              .setDescription('Current position of the track')
              .setRequired(true)
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('to')
              .setDescription('Target position in the queue')
              .setRequired(true)
              .setMinValue(1),
          ),
        executeAsync: (ctx) => this.executeMove(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('replay')
          .setDescription('Restart the current song from the beginning'),
        executeAsync: (ctx) => this.executeReplay(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('stop')
          .setDescription('Stop music playback and disconnect the bot'),
        executeAsync: (ctx) => this.executeStop(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('pause')
          .setDescription('Pause music playback'),
        executeAsync: (ctx) => this.executePause(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('resume')
          .setDescription('Resume music playback'),
        executeAsync: (ctx) => this.executeResume(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('seek')
          .setDescription('Seek to a position in seconds')
          .addIntegerOption((opt) =>
            opt.setName('seconds').setDescription('Seconds into the track').setMinValue(0).setRequired(true),
          ),
        executeAsync: (ctx) => this.executeSeek(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('volume')
          .setDescription('View or change player volume (0 - 150%)')
          .addIntegerOption((opt) =>
            opt.setName('level').setDescription('Volume level (0-150)').setMinValue(0).setMaxValue(150),
          ),
        executeAsync: (ctx) => this.executeVolume(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('filter')
          .setDescription('Toggle or configure audio filters')
          .addStringOption((opt) => {
            opt.setName('type').setDescription('Filter name');
            for (const f of ALL_FILTERS) {
              opt.addChoices({ name: f, value: f });
            }
            return opt;
          }),
        executeAsync: (ctx) => this.executeFilter(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('lyrics')
          .setDescription('Display lyrics for the current song or a search query')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Song title to look up (defaults to currently playing)'),
          ),
        executeAsync: (ctx) => this.executeLyrics(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('join')
          .setDescription('Summon the bot into your current voice channel'),
        executeAsync: (ctx) => this.executeJoin(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('247')
          .setDescription('Toggle 24/7 mode (keeps bot in voice channel indefinitely)'),
        executeAsync: (ctx) => this.execute247(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('autoplay')
          .setDescription('Toggle autoplay mode (automatically plays related songs)'),
        executeAsync: (ctx) => this.executeAutoplay(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('loop')
          .setDescription('Set loop mode (off, track, or queue)')
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Loop mode')
              .setRequired(true)
              .addChoices(
                { name: 'Off', value: 'off' },
                { name: 'Track', value: 'track' },
                { name: 'Queue', value: 'queue' },
              ),
          ),
        executeAsync: (ctx) => this.executeLoop(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('shuffle')
          .setDescription('Shuffle the current queue'),
        executeAsync: (ctx) => this.executeShuffle(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('clear')
          .setDescription('Clear all tracks from the queue'),
        executeAsync: (ctx) => this.executeClear(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('remove')
          .setDescription('Remove a track from the queue by position')
          .addIntegerOption((opt) =>
            opt.setName('position').setDescription('Position in queue').setRequired(true).setMinValue(1),
          ),
        executeAsync: (ctx) => this.executeRemove(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('history')
          .setDescription('View recently played tracks in this server'),
        executeAsync: (ctx) => this.executeHistory(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('nodes')
          .setDescription('View connected Lavalink node metrics and health'),
        executeAsync: (ctx) => this.executeNodes(ctx),
      },
    ];
  }

  private async executePlay(ctx: ContextModel): Promise<ResponseModel> {
    const voiceChannelId = ctx.member?.voice?.channelId;
    if (!ctx.guildId || !voiceChannelId) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to play music.');
    }

    const query = ctx.interaction?.options.getString('query')?.trim();
    if (!query) {
      return GenericEmbedService.buildWrongInputResponse('Please provide a song name or Spotify/YouTube URL.');
    }

    const textChannelId = ctx.interaction?.channelId ?? '';
    const requester = {
      id: ctx.discordUserId,
      tag: ctx.interaction?.user.tag ?? 'User',
      avatarUrl: ctx.interaction?.user.displayAvatarURL(),
    };

    const result = await this.musicService.play(ctx.guildId, voiceChannelId, textChannelId, query, requester);
    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);

    if (result.loadType === 'empty') {
      return GenericEmbedService.buildNotFoundResponse(`No tracks found for: **${query}**.`);
    }

    if (result.loadType === 'error') {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'An error occurred while communicating with the music node. Try again in a few seconds.',
      );
    }

    if (result.loadType === 'track' && result.track) {
      const queue = this.musicService.getQueueInfo(ctx.guildId);
      return MusicBuilders.buildTrackAddedResponse(
        result.track,
        result.positionInQueue,
        queue?.totalTracks ?? 1,
        accentColor,
      );
    }

    if (result.tracks && result.tracks.length > 0) {
      const isSpotify = result.loadType.startsWith('spotify');
      const totalDuration = result.tracks.reduce((acc, t) => acc + t.duration, 0);
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

  private async executeSearch(ctx: ContextModel): Promise<ResponseModel> {
    const voiceChannelId = ctx.member?.voice?.channelId;
    if (!ctx.guildId || !voiceChannelId) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to search.');
    }

    const query = ctx.interaction?.options.getString('query')?.trim() ?? '';
    if (!query) {
      return GenericEmbedService.buildWrongInputResponse('Please provide a search term.');
    }

    const tracks = await this.musicService.searchTracks(query);
    if (tracks.length === 0) {
      return GenericEmbedService.buildNotFoundResponse(`No tracks found for: **${query}**.`);
    }

    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);
    const response = MusicBuilders.buildSearchResponse(query, tracks, accentColor);

    if (this.musicInteractions) {
      this.musicInteractions.storeSearchResults(ctx.discordUserId, tracks);
      if (ctx.interaction?.id) {
        this.musicInteractions.storeSearchResults(ctx.interaction.id, tracks);
      }
    }

    return response;
  }

  private async executeNowPlaying(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const queue = this.musicService.getQueueInfo(ctx.guildId);
    if (!queue || !queue.current) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);
    return MusicBuilders.buildNowPlayingResponse(queue, accentColor);
  }

  private async executeQueue(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const queue = this.musicService.getQueueInfo(ctx.guildId);
    if (!queue) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    const page = ctx.interaction?.options.getInteger('page') ?? 1;
    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);
    return MusicBuilders.buildQueueResponse(queue, page, 10, accentColor);
  }

  private async executeSkip(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const amount = ctx.interaction?.options.getInteger('amount') ?? 1;
    const success = await this.musicService.skip(ctx.guildId, amount);

    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No tracks in queue to skip.');
    }

    return MusicBuilders.buildSimpleResponse(
      '⏭️ Skipped',
      amount > 1 ? `Skipped **${amount}** tracks.` : 'Skipped to the next track.',
    );
  }

  private async executePrevious(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = await this.musicService.previous(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No previous track in history to replay.');
    }

    return MusicBuilders.buildSimpleResponse('⏮️ Previous Track', 'Replaying previous track from history.');
  }

  private async executeSkipTo(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const pos = ctx.interaction?.options.getInteger('position') ?? 1;
    const success = await this.musicService.skipto(ctx.guildId, pos);

    if (!success) {
      return GenericEmbedService.buildWrongInputResponse(`Invalid track position #${pos}. Check /queue.`);
    }

    return MusicBuilders.buildSimpleResponse('⏭️ Jumped Track', `Skipped to track **#${pos}** in the queue.`);
  }

  private async executeMove(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const from = ctx.interaction?.options.getInteger('from') ?? 1;
    const to = ctx.interaction?.options.getInteger('to') ?? 1;

    const success = this.musicService.move(ctx.guildId, from, to);
    if (!success) {
      return GenericEmbedService.buildWrongInputResponse('Invalid track positions. Please check the queue.');
    }

    return MusicBuilders.buildSimpleResponse('↔️ Moved Track', `Moved track from position **#${from}** to **#${to}**.`);
  }

  private async executeReplay(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = await this.musicService.replay(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('🔁 Replay', 'Restarted the current track from the beginning.');
  }

  private async executeStop(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    await this.musicService.stop(ctx.guildId);
    return MusicBuilders.buildSimpleResponse('⏹️ Stopped', 'Playback stopped and disconnected.');
  }

  private async executePause(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = await this.musicService.pause(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('⏸️ Paused', 'Playback paused. Use `/resume` to continue.');
  }

  private async executeResume(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = await this.musicService.resume(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently paused.');
    }

    return MusicBuilders.buildSimpleResponse('▶️ Resumed', 'Playback resumed.');
  }

  private async executeSeek(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const seconds = ctx.interaction?.options.getInteger('seconds') ?? 0;
    const success = await this.musicService.seek(ctx.guildId, seconds);

    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No track is currently playing to seek.');
    }

    return MusicBuilders.buildSimpleResponse('⏩ Seeked', `Jumped to **${seconds}** seconds in the current track.`);
  }

  private async executeVolume(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const level = ctx.interaction?.options.getInteger('level');
    if (level === undefined || level === null) {
      const queue = this.musicService.getQueueInfo(ctx.guildId);
      const currentVol = queue?.volume ?? 100;
      return MusicBuilders.buildSimpleResponse('🔊 Current Volume', `The player volume is currently set to **${currentVol}%**.`);
    }

    const applied = this.musicService.setVolume(ctx.guildId, level);
    return MusicBuilders.buildSimpleResponse('🔊 Volume Changed', `Volume set to **${applied}%**.`);
  }

  private async executeFilter(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const queue = this.musicService.getQueueInfo(ctx.guildId);
    if (!queue) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);
    const filterName = ctx.interaction?.options.getString('type') as FilterName | null;

    if (!filterName) {
      return MusicBuilders.buildFiltersResponse(queue.activeFilters, accentColor);
    }

    const isCurrentlyActive = queue.activeFilters.includes(filterName);
    await this.musicService.setFilter(ctx.guildId, filterName, !isCurrentlyActive);

    return MusicBuilders.buildSimpleResponse(
      '🎛️ Filter Toggled',
      `Filter **${filterName}** is now **${!isCurrentlyActive ? 'ENABLED' : 'DISABLED'}**.`,
      accentColor,
    );
  }

  private async executeLyrics(ctx: ContextModel): Promise<ResponseModel> {
    if (!this.lyricsService) {
      return GenericEmbedService.buildCommandErrorResponse(CommandResponse.Error, 'Lyrics service unavailable.');
    }

    let query = ctx.interaction?.options.getString('query')?.trim();
    let artist: string | undefined;

    if (!query) {
      if (!ctx.guildId) {
        return GenericEmbedService.buildWrongInputResponse('Please provide a song title to search lyrics for.');
      }
      const queue = this.musicService.getQueueInfo(ctx.guildId);
      if (!queue?.current) {
        return GenericEmbedService.buildWrongInputResponse('No song is currently playing. Provide a song title.');
      }
      query = queue.current.title;
      artist = queue.current.author;
    }

    const result = await this.lyricsService.getLyrics(query, artist);
    if (!result || !result.plainLyrics) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find lyrics for: **${query}**.`);
    }

    const accentColor = ctx.guildId ? await this.colorService.getAccentColorAsync(ctx.guildId) : undefined;
    const cleanLyrics = result.plainLyrics.length > 4000 ? `${result.plainLyrics.slice(0, 3950)}...\n*(Lyrics truncated)*` : result.plainLyrics;
    return MusicBuilders.buildLyricsResponse(result.title, result.artist, cleanLyrics, accentColor);
  }

  private async executeJoin(ctx: ContextModel): Promise<ResponseModel> {
    const voiceChannelId = ctx.member?.voice?.channelId;
    if (!ctx.guildId || !voiceChannelId) {
      return GenericEmbedService.buildWrongInputResponse('You must be in a voice channel to summon the bot.');
    }

    const textChannelId = ctx.interaction?.channelId ?? '';
    const player = this.musicService.getOrCreatePlayer(ctx.guildId, voiceChannelId, textChannelId);
    if (!player.connected) {
      await player.connect({ selfDeaf: true });
    }

    return MusicBuilders.buildSimpleResponse('🔊 Connected', `Joined voice channel <#${voiceChannelId}>.`);
  }

  private async execute247(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const newState = this.musicService.toggle247(ctx.guildId);
    return MusicBuilders.buildSimpleResponse(
      '📻 24/7 Mode',
      newState
        ? '24/7 mode is now **ENABLED**. The bot will remain in the voice channel indefinitely.'
        : '24/7 mode is now **DISABLED**. The bot will disconnect when the queue finishes.',
    );
  }

  private async executeAutoplay(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const newState = this.musicService.toggleAutoplay(ctx.guildId);
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

  private async executeLoop(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const mode = (ctx.interaction?.options.getString('mode') ?? 'track') as LoopMode;
    const applied = this.musicService.setLoop(ctx.guildId, mode);

    if (!applied) {
      return GenericEmbedService.buildNotFoundResponse('No music is currently playing.');
    }

    return MusicBuilders.buildSimpleResponse('🔁 Loop Mode', `Loop mode set to **${applied.toUpperCase()}**.`);
  }

  private async executeShuffle(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = this.musicService.shuffle(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildWrongInputResponse('The queue is empty or has only 1 track — nothing to shuffle.');
    }

    return MusicBuilders.buildSimpleResponse('🔀 Shuffled', 'The music queue has been randomized.');
  }

  private async executeClear(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const success = this.musicService.clear(ctx.guildId);
    if (!success) {
      return GenericEmbedService.buildNotFoundResponse('No music player is currently active.');
    }

    return MusicBuilders.buildSimpleResponse('🗑️ Queue Cleared', 'All upcoming tracks have been removed from the queue.');
  }

  private async executeRemove(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const pos = ctx.interaction?.options.getInteger('position') ?? 1;
    const removed = this.musicService.remove(ctx.guildId, pos - 1);

    if (!removed) {
      return GenericEmbedService.buildWrongInputResponse(`No track found at position #${pos}. Check /queue.`);
    }

    return MusicBuilders.buildSimpleResponse('🗑️ Removed', `Removed **${removed.title}** from position #${pos}.`);
  }

  private async executeHistory(ctx: ContextModel): Promise<ResponseModel> {
    if (!ctx.guildId) {
      return GenericEmbedService.buildWrongInputResponse('Must be in a server.');
    }

    const history = this.musicService.getHistory(ctx.guildId, 10);
    if (history.length === 0) {
      return GenericEmbedService.buildNotFoundResponse('No recently played tracks in this server yet.');
    }

    const accentColor = await this.colorService.getAccentColorAsync(ctx.guildId);
    let desc = '';
    history.forEach((item, idx) => {
      desc += `\`${idx + 1}.\` [${item.track.title}](${item.track.uri}) — \`${item.track.author}\`\n`;
    });

    return MusicBuilders.buildSimpleResponse('📜 Recently Played Tracks', desc, accentColor);
  }

  private async executeNodes(ctx: ContextModel): Promise<ResponseModel> {
    const stats = this.musicService.getNodeStats();
    const accentColor = ctx.guildId
      ? await this.colorService.getAccentColorAsync(ctx.guildId)
      : undefined;
    return MusicBuilders.buildNodeStatsResponse(stats, accentColor);
  }
}
