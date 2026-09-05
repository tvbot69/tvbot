import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type InteractionUpdateOptions,
  GuildMember,
} from 'discord.js';
import { MusicService } from '@bot/services/music/musicService';
import { LyricsService } from '@bot/services/music/lyricsService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { ColorService } from '@bot/services/colorService';
import type { FilterName } from '@domain/models/music/musicQueue';
import type { MusicTrack } from '@domain/models/music/musicTrack';

export const MUSIC_INTERACTION_PREFIXES = [
  'music:queue:',
  'music:control:',
  'music:filter:',
  'music:search:',
  'music:lyrics:',
];

export class MusicInteractions {
  private readonly musicService: MusicService;
  private readonly colorService: ColorService;
  private readonly lyricsService?: LyricsService;

  // Ephemeral memory cache for active search results per message/user
  private readonly activeSearches = new Map<string, MusicTrack[]>();

  constructor(
    musicService: MusicService,
    colorService: ColorService,
    lyricsService?: LyricsService,
  ) {
    this.musicService = musicService;
    this.colorService = colorService;
    this.lyricsService = lyricsService;
  }

  public storeSearchResults(key: string, tracks: MusicTrack[]): void {
    this.activeSearches.set(key, tracks);
    // Expire after 2 minutes
    setTimeout(() => this.activeSearches.delete(key), 120000);
  }

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'You must be in a voice channel to use music controls.',
        ephemeral: true,
      });
      return;
    }

    const accentColor = await this.colorService.getAccentColorAsync(guildId);

    // Cancel search menu
    if (customId === 'music:search:cancel') {
      this.activeSearches.delete(interaction.message.id);
      this.activeSearches.delete(interaction.user.id);
      await interaction.deferUpdate().catch(() => undefined);
      await interaction.message.delete().catch(() => undefined);
      return;
    }

    // View: Switch to Now Playing Card
    if (customId === 'music:control:view_nowplaying') {
      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }
      const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor);
      await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // View: Switch to Queue
    if (customId === 'music:control:view_queue') {
      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }
      const response = MusicBuilders.buildQueueResponse(queue, 1, 10, accentColor);
      await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // Quick Action: Fetch & Show Lyrics
    if (customId === 'music:control:lyrics') {
      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue?.current) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      if (!this.lyricsService) {
        await interaction.editReply({ content: 'Lyrics service is currently unavailable.' });
        return;
      }

      const result = await this.lyricsService.getLyrics(queue.current.title, queue.current.author);
      if (!result || !result.plainLyrics) {
        await interaction.editReply({
          content: `Could not find lyrics for: **${queue.current.title}** by **${queue.current.author}**.`,
        });
        return;
      }

      const cleanLyrics =
        result.plainLyrics.length > 4000
          ? `${result.plainLyrics.slice(0, 3950)}...\n*(Lyrics truncated)*`
          : result.plainLyrics;

      const response = MusicBuilders.buildLyricsResponse(
        result.title,
        result.artist,
        cleanLyrics,
        accentColor,
      );

      await interaction.editReply(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // View: Switch to Filters Menu
    if (customId === 'music:control:open_filters') {
      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }
      const response = MusicBuilders.buildFiltersResponse(queue.activeFilters, accentColor);
      await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // Filter: Reset All Filters
    if (customId === 'music:filter:reset') {
      await this.musicService.clearFilters(guildId);
      const queue = this.musicService.getQueueInfo(guildId);
      if (queue) {
        const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Queue pagination
    if (customId.startsWith('music:queue:')) {
      const parts = customId.split(':');
      const action = parts[2];
      const targetPage = Number(parts[3] || 1);

      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }

      let page = targetPage;
      const totalPages = Math.max(1, Math.ceil(queue.tracks.length / 10));

      if (action === 'first') page = 1;
      else if (action === 'last') page = totalPages;

      const response = MusicBuilders.buildQueueResponse(queue, page, 10, accentColor);
      await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // Playback control: Pause / Resume
    if (customId === 'music:control:pause_resume') {
      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }

      if (queue.isPaused) {
        await this.musicService.resume(guildId);
      } else {
        await this.musicService.pause(guildId);
      }

      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const isQueueView = interaction.message.embeds.some((e) => e.title?.includes('Queue'));
        const response = isQueueView
          ? MusicBuilders.buildQueueResponse(updatedQueue, 1, 10, accentColor)
          : MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Playback control: Skip
    if (customId === 'music:control:skip') {
      const success = await this.musicService.skip(guildId);
      if (success) {
        const updatedQueue = this.musicService.getQueueInfo(guildId);
        if (updatedQueue) {
          const isQueueView = interaction.message.embeds.some((e) => e.title?.includes('Queue'));
          const response = isQueueView
            ? MusicBuilders.buildQueueResponse(updatedQueue, 1, 10, accentColor)
            : MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
          await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
        } else {
          await interaction.deferUpdate().catch(() => undefined);
          await interaction.message.delete().catch(() => undefined);
        }
      } else {
        await interaction.reply({ content: 'Nothing to skip.', ephemeral: true });
      }
      return;
    }

    // Playback control: Previous Track
    if (customId === 'music:control:previous') {
      const success = await this.musicService.previous(guildId);
      if (success) {
        const updatedQueue = this.musicService.getQueueInfo(guildId);
        if (updatedQueue) {
          const response = MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
          await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
        } else {
          await interaction.deferUpdate();
        }
      } else {
        await interaction.reply({ content: 'No previous track in history to replay.', ephemeral: true });
      }
      return;
    }

    // Playback control: Shuffle
    if (customId === 'music:control:shuffle') {
      const success = this.musicService.shuffle(guildId);
      if (success) {
        const updatedQueue = this.musicService.getQueueInfo(guildId);
        if (updatedQueue) {
          const isQueueView = interaction.message.embeds.some((e) => e.title?.includes('Queue'));
          const response = isQueueView
            ? MusicBuilders.buildQueueResponse(updatedQueue, 1, 10, accentColor)
            : MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
          await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
        } else {
          await interaction.deferUpdate();
        }
      } else {
        await interaction.reply({ content: 'Queue is too small to shuffle.', ephemeral: true });
      }
      return;
    }

    // Playback control: Clear Queue
    if (customId === 'music:control:clear') {
      this.musicService.clear(guildId);
      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const isQueueView = interaction.message.embeds.some((e) => e.title?.includes('Queue'));
        const response = isQueueView
          ? MusicBuilders.buildQueueResponse(updatedQueue, 1, 10, accentColor)
          : MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Playback control: Cycle Loop Mode
    if (customId === 'music:control:loop') {
      this.musicService.cycleLoop(guildId);
      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const response = MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Volume Step Down (-10%)
    if (customId === 'music:control:vol_down') {
      this.musicService.adjustVolume(guildId, -10);
      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const response = MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Volume Step Up (+10%)
    if (customId === 'music:control:vol_up') {
      this.musicService.adjustVolume(guildId, +10);
      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const response = MusicBuilders.buildNowPlayingResponse(updatedQueue, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }
      return;
    }

    // Playback control: Stop
    if (customId === 'music:control:stop') {
      await this.musicService.stop(guildId);
      await interaction.deferUpdate().catch(() => undefined);
      await interaction.message.delete().catch(() => undefined);
      return;
    }
  }

  public async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'You must be in a voice channel to use music controls.',
        ephemeral: true,
      });
      return;
    }

    const accentColor = await this.colorService.getAccentColorAsync(guildId);

    // Audio Filter Toggle
    if (customId === 'music:filter:select') {
      const selectedFilter = interaction.values[0] as FilterName;
      if (!selectedFilter) {
        await interaction.deferUpdate();
        return;
      }

      const queue = this.musicService.getQueueInfo(guildId);
      if (!queue) {
        await interaction.reply({ content: 'No music is currently playing.', ephemeral: true });
        return;
      }

      const isCurrentlyEnabled = queue.activeFilters.includes(selectedFilter);
      await this.musicService.setFilter(guildId, selectedFilter, !isCurrentlyEnabled);

      const updatedQueue = this.musicService.getQueueInfo(guildId);
      const activeFilters = updatedQueue?.activeFilters ?? [];
      const response = MusicBuilders.buildFiltersResponse(activeFilters, accentColor);

      await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      return;
    }

    // Queue Quick Remove Track
    if (customId === 'music:queue:quick_remove') {
      const indexStr = interaction.values[0];
      const indexNumber = indexStr ? Number(indexStr) : NaN;
      if (Number.isNaN(indexNumber)) {
        await interaction.deferUpdate();
        return;
      }

      // 1-based index in queue
      const removed = this.musicService.remove(guildId, indexNumber - 1);
      const updatedQueue = this.musicService.getQueueInfo(guildId);
      if (updatedQueue) {
        const response = MusicBuilders.buildQueueResponse(updatedQueue, 1, 10, accentColor);
        await interaction.update(response.toMessagePayload() as unknown as InteractionUpdateOptions);
      } else {
        await interaction.deferUpdate();
      }

      if (removed) {
        await interaction.followUp({
          content: `🗑️ Removed **${removed.title}** from the queue.`,
          ephemeral: true,
        });
      }
      return;
    }

    // Search Result Selection
    if (customId === 'music:search:select') {
      const selectedIndexStr = interaction.values[0];
      const selectedIndex = selectedIndexStr ? Number(selectedIndexStr) : NaN;

      const cachedTracks =
        this.activeSearches.get(interaction.message.id) ??
        this.activeSearches.get(interaction.user.id);

      if (!cachedTracks || Number.isNaN(selectedIndex) || !cachedTracks[selectedIndex]) {
        await interaction.reply({
          content: 'Search results expired. Please run the search command again.',
          ephemeral: true,
        });
        return;
      }

      const chosenTrack = cachedTracks[selectedIndex]!;
      await interaction.deferUpdate();

      const requester = {
        id: interaction.user.id,
        tag: interaction.user.tag ?? interaction.user.username,
        avatarUrl: interaction.user.displayAvatarURL(),
      };

      const result = await this.musicService.play(
        guildId,
        voiceChannel.id,
        interaction.channelId,
        chosenTrack.uri,
        requester,
        {
          title: chosenTrack.title,
          author: chosenTrack.author,
          artworkUrl: chosenTrack.artworkUrl,
          source: chosenTrack.source,
        },
      );

      this.activeSearches.delete(interaction.message.id);
      this.activeSearches.delete(interaction.user.id);

      // Delete the search embed message
      await interaction.message.delete().catch(() => undefined);

      if (result.loadType === 'error') {
        if (interaction.channel && 'send' in interaction.channel) {
          await (interaction.channel as any).send({
            content: '❌ Failed to load track due to rate limits or voice connection error.',
          });
        }
        return;
      }

      const queue = this.musicService.getQueueInfo(guildId);
      const trackToDisplay = result.track ?? chosenTrack;
      const addedResponse = MusicBuilders.buildTrackAddedResponse(
        trackToDisplay,
        result.positionInQueue,
        queue?.totalTracks ?? result.totalTracksAdded,
        accentColor,
      );

      if (interaction.channel && 'send' in interaction.channel) {
        await (interaction.channel as any).send(
          addedResponse.toMessagePayload() as any
        );
      }
      return;
    }
  }
}
