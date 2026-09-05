import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { formatDuration, type MusicTrack } from '@domain/models/music/musicTrack';
import { ALL_FILTERS, type FilterName, type MusicQueueInfo } from '@domain/models/music/musicQueue';
import type { LavalinkNodeStats } from '@bot/services/music/moonlinkManager';

export const MUSIC_SOURCE_BADGES = {
  spotify: '<:sp:1496297132381048995>',
  youtube: '<:yt:1496297072201040094>',
  soundcloud: '<:sound:1545234670239879282>',
} as const;

export const getSourceBadge = (source?: string): string => {
  if (!source) return MUSIC_SOURCE_BADGES.youtube;
  const s = source.toLowerCase();
  if (s === 'spotify') return MUSIC_SOURCE_BADGES.spotify;
  if (s === 'soundcloud') return MUSIC_SOURCE_BADGES.soundcloud;
  return MUSIC_SOURCE_BADGES.youtube;
};

export class MusicBuilders {
  /**
   * Generates a sleek Unicode progress bar.
   * e.g. "01:23 🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 03:45"
   */
  public static buildProgressBar(
    currentMs: number,
    totalMs: number,
    barLength: number = 14,
  ): string {
    if (totalMs <= 0 || !Number.isFinite(totalMs)) {
      return '🔴 `LIVE`';
    }

    const progress = Math.min(1, Math.max(0, currentMs / totalMs));
    const dotIndex = Math.floor(progress * (barLength - 1));

    let bar = '';
    for (let i = 0; i < barLength; i++) {
      if (i === dotIndex) {
        bar += '🔘';
      } else {
        bar += '▬';
      }
    }

    return `\`${formatDuration(currentMs)}\` ${bar} \`${formatDuration(totalMs)}\``;
  }

  public static buildTrackAddedResponse(
    track: MusicTrack,
    position: number,
    totalQueueCount: number,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    const isNowPlaying = position === 1 && totalQueueCount === 1;
    const title = isNowPlaying ? '🎵 Now Playing' : '🎵 Added to Queue';
    const sourceBadge = getSourceBadge(track.source);

    // Backward-compatible fallback embed
    response.embed
      .setTitle(title)
      .setDescription(`[${track.title}](${track.uri})\n**Artist:** ${track.author} • ${sourceBadge}`)
      .addFields(
        { name: 'Duration', value: track.isStream ? '🔴 LIVE' : formatDuration(track.duration), inline: true },
        { name: 'Position', value: isNowPlaying ? 'Now' : `#${position}`, inline: true },
      );

    if (track.requester?.tag) {
      response.embed.addFields({
        name: 'Requested By',
        value: `<@${track.requester.id}>`,
        inline: true,
      });
    }

    if (track.artworkUrl) {
      response.embed.setThumbnail(track.artworkUrl);
    }

    // Modern Discord Components V2 Container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }
    const header = isNowPlaying ? '-# 🎵 STARTING PLAYBACK' : '-# 📑 ADDED TO QUEUE';
    const mainContent = `### [${track.title}](${track.uri})\n**${track.author}** • ${sourceBadge} • \`${track.isStream ? 'LIVE' : formatDuration(track.duration)}\``;
    const footerText = isNowPlaying
      ? `Playing now${track.requester?.tag ? ` • Requested by ${track.requester.tag}` : ''}`
      : `Position: **#${position}**${track.requester?.tag ? ` • Requested by ${track.requester.tag}` : ''}`;

    if (track.artworkUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}\n-# ${footerText}`))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: track.artworkUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}\n-# ${footerText}`));
    }

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildPlaylistAddedResponse(
    name: string,
    count: number,
    totalDuration: number,
    artworkUrl?: string,
    position?: number,
    accentColor?: number,
    source?: string,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    // Backward-compatible fallback embed
    response.embed
      .setTitle('📑 Playlist Added to Queue')
      .setDescription(`**${name}**`)
      .addFields(
        { name: 'Tracks Added', value: `${count}`, inline: true },
        { name: 'Total Duration', value: formatDuration(totalDuration), inline: true },
      );

    if (position && position > 1) {
      response.embed.addFields({
        name: 'Starting Position',
        value: `#${position}`,
        inline: true,
      });
    }

    if (artworkUrl) {
      response.embed.setThumbnail(artworkUrl);
    }

    // Modern Discord Components V2 Container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }
    const header = `-# 📑 PLAYLIST ADDED TO QUEUE`;
    const sourceBadge = source ? ` • ${getSourceBadge(source)}` : '';
    const mainContent = `### ${name}\n**${count} tracks** • \`${formatDuration(totalDuration)}\`${sourceBadge}${position && position > 1 ? ` • Starts at #${position}` : ''}`;

    if (artworkUrl) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}`))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: artworkUrl } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header}\n${mainContent}`));
    }

    response.setComponentsV2Container(container);
    return response;
  }

  /**
   * Builds the rich, modern interactive "Now Playing" controller card using Discord Components V2.
   * Single unified container: full-width hero media gallery on top, sleek divider,
   * minimalist metadata with live progress bar, and integrated playback controls.
   */
  public static buildNowPlayingResponse(
    queue: MusicQueueInfo,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    if (!queue.current) {
      const container = new ContainerBuilder();
      if (color !== undefined && color !== null) {
        container.setAccentColor(color);
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🎵 Now Playing\n*Nothing is currently playing.*'),
      );
      response.setComponentsV2Container(container);
      response.embed
        .setTitle('🎵 Now Playing')
        .setDescription('*Nothing is currently playing.*');
      return response;
    }

    const current = queue.current;
    const progressBar = MusicBuilders.buildProgressBar(queue.position, current.duration, 14);

    const sourceIcon = getSourceBadge(current.source);

    let desc = `### [${current.title}](${current.uri})\n`;
    desc += `**${current.author}** • ${sourceIcon}\n\n`;
    desc += `${progressBar}`;

    // Single Row of 5 Square Icon Playback Controls (Mobile-perfect, zero text squishing)
    const row0 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('music:control:previous')
        .setLabel('⏮️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:pause_resume')
        .setLabel(queue.isPaused ? '▶️' : '⏸️')
        .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('music:control:skip')
        .setLabel('⏭️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:loop')
        .setLabel(queue.loopMode === 'track' ? '🔂' : '🔁')
        .setStyle(queue.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:stop')
        .setLabel('⏹️')
        .setStyle(ButtonStyle.Danger),
    );

    // Discord Components V2: Single unified card container
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) {
      container.setAccentColor(color);
    }

    if (current.artworkUrl) {
      const gallery = new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(current.artworkUrl),
      );
      container.addMediaGalleryComponents(gallery);
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
      );
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(desc));
    container.addActionRowComponents(row0);

    response.setComponentsV2Container(container);

    // Backward-compatible fallback embed & button row
    response.addButtonRow(0, row0 as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    response.embed
      .setDescription(desc);
    if (current.artworkUrl) {
      response.embed.setImage(current.artworkUrl);
    }

    return response;
  }

  /**
   * Builds the paginated queue display with interactive track removal dropdown.
   */
  public static buildQueueResponse(
    queue: MusicQueueInfo,
    page: number = 1,
    pageSize: number = 10,
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    const totalTracks = queue.tracks.length;
    const totalPages = Math.max(1, Math.ceil(totalTracks / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const startIndex = (currentPage - 1) * pageSize;
    const currentTracks = queue.tracks.slice(startIndex, startIndex + pageSize);

    let desc = '';

    if (queue.current) {
      const progressMs = queue.position;
      const totalMs = queue.current.duration;
      const progressStr = `${formatDuration(progressMs)} / ${queue.current.isStream ? 'LIVE' : formatDuration(totalMs)}`;
      desc += `**Now Playing:**\n[${queue.current.title}](${queue.current.uri}) — \`${queue.current.author}\`\n⏱️ ${progressStr}\n\n`;
    } else {
      desc += '*Nothing currently playing*\n\n';
    }

    if (currentTracks.length > 0) {
      desc += '**Up Next:**\n';
      currentTracks.forEach((track, idx) => {
        const itemNumber = startIndex + idx + 1;
        const reqStr = track.requester ? ` • <@${track.requester.id}>` : '';
        desc += `\`${itemNumber}.\` [${track.title}](${track.uri}) \`[${track.isStream ? 'LIVE' : formatDuration(track.duration)}]\`${reqStr}\n`;
      });
    } else if (queue.tracks.length === 0) {
      desc += '*Queue is empty. Use `/play` or `+play` to add tracks.*';
    }

    response.embed
      .setTitle(`🎵 Music Queue (${totalTracks} track${totalTracks === 1 ? '' : 's'})`)
      .setDescription(desc)
      .setFooter({
        text: `Page ${currentPage}/${totalPages} • Remaining: ${formatDuration(queue.remainingDuration)} • Loop: ${queue.loopMode} • 24/7: ${queue.is247 ? 'On' : 'Off'}`,
      });

    // Row 0: Pagination Buttons
    if (totalPages > 1) {
      const row0 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`music:queue:first:${currentPage}`)
          .setLabel('⏮️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`music:queue:prev:${currentPage - 1}`)
          .setLabel('◀️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`music:queue:page:${currentPage}`)
          .setLabel(`${currentPage}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`music:queue:next:${currentPage + 1}`)
          .setLabel('▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage >= totalPages),
        new ButtonBuilder()
          .setCustomId(`music:queue:last:${totalPages}`)
          .setLabel('⏭️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages),
      );
      response.addButtonRow(0, row0 as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    }

    // Row 1: Queue Actions
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('music:control:pause_resume')
        .setLabel(queue.isPaused ? '▶️ Resume' : '⏸️ Pause')
        .setStyle(queue.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music:control:skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!queue.current),
      new ButtonBuilder()
        .setCustomId('music:control:shuffle')
        .setLabel('🔀 Shuffle')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(queue.tracks.length < 2),
      new ButtonBuilder()
        .setCustomId('music:control:clear')
        .setLabel('🗑️ Clear')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(queue.tracks.length === 0),
      new ButtonBuilder()
        .setCustomId('music:control:view_nowplaying')
        .setLabel('🎵 Now Playing')
        .setStyle(ButtonStyle.Secondary),
    );
    response.addButtonRow(1, row1 as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    // Row 2: Quick Remove Dropdown (if current page has tracks)
    if (currentTracks.length > 0) {
      const removeOptions = currentTracks.slice(0, 10).map((t, idx) => {
        const itemNumber = startIndex + idx + 1;
        const cleanTitle = t.title.length > 50 ? `${t.title.slice(0, 47)}...` : t.title;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${itemNumber}. ${cleanTitle}`)
          .setValue(String(itemNumber))
          .setDescription(`By ${t.author.slice(0, 40)} (${formatDuration(t.duration)})`)
          .setEmoji('🗑️');
      });

      const removeSelectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('music:queue:quick_remove')
          .setPlaceholder('Select a track to remove from queue...')
          .addOptions(removeOptions),
      );
      response.addButtonRow(2, removeSelectRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    }

    return response;
  }

  /**
   * Builds the interactive Search Result menu with clickable dropdown.
   */
  public static buildSearchResponse(
    query: string,
    tracks: MusicTrack[],
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    let desc = `Found **${tracks.length}** results for \`${query}\`:\n\n`;
    tracks.slice(0, 10).forEach((t, idx) => {
      desc += `\`${idx + 1}.\` **[${t.title}](${t.uri})**\n`;
      desc += `   └ Artist: \`${t.author}\` • Duration: \`${formatDuration(t.duration)}\`\n`;
    });

    desc += '\n*Select a track from the dropdown below to play it:*';

    response.embed
      .setTitle(`🔍 Search Results: ${query}`)
      .setDescription(desc)
      .setFooter({ text: 'Select an option or click Cancel' });

    const options = tracks.slice(0, 10).map((t, idx) => {
      const cleanTitle = t.title.length > 50 ? `${t.title.slice(0, 47)}...` : t.title;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${idx + 1}. ${cleanTitle}`)
        .setValue(String(idx))
        .setDescription(`Artist: ${t.author.slice(0, 40)} | ${formatDuration(t.duration)}`)
        .setEmoji('🎵');
    });

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('music:search:select')
        .setPlaceholder('Choose a track to play...')
        .addOptions(options),
    );
    response.addButtonRow(0, selectRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('music:search:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    );
    response.addButtonRow(1, cancelRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    return response;
  }

  /**
   * Builds the formatted lyrics embed with pagination support.
   */
  public static buildLyricsResponse(
    title: string,
    artist: string,
    lyrics: string,
    accentColor?: number,
    page: number = 1,
    totalPages: number = 1,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    response.embed
      .setTitle(`📜 Lyrics: ${title}`)
      .setDescription(`**Artist:** ${artist}\n\n${lyrics}`)
      .setFooter({ text: `Page ${page}/${totalPages} • Powered by LRCLIB` });

    if (totalPages > 1) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`music:lyrics:page:${page - 1}`)
          .setLabel('◀️ Prev')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(`music:lyrics:curr:${page}`)
          .setLabel(`${page}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`music:lyrics:page:${page + 1}`)
          .setLabel('Next ▶️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages),
      );
      response.addButtonRow(0, row as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    }

    return response;
  }

  public static buildFiltersResponse(
    activeFilters: string[],
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor;
    const response = new ResponseModel(color);

    let desc = '**Active Audio Filters:**\n';
    if (activeFilters.length === 0) {
      desc += '*(No filters active — standard audio)*\n\n';
    } else {
      desc += activeFilters.map((f) => `✅ \`${f}\``).join(', ') + '\n\n';
    }

    desc += 'Select a filter below to toggle it on or off:';

    response.embed
      .setTitle('🎛️ Audio Filters')
      .setDescription(desc)
      .setFooter({ text: 'Select a filter from the menu below' });

    const options = ALL_FILTERS.map((f: FilterName) => {
      const isEnabled = activeFilters.includes(f);
      return new StringSelectMenuOptionBuilder()
        .setLabel(f.charAt(0).toUpperCase() + f.slice(1))
        .setValue(f)
        .setDescription(isEnabled ? 'Currently ENABLED (click to disable)' : 'Currently DISABLED (click to enable)')
        .setEmoji(isEnabled ? '✅' : '⚪');
    });

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('music:filter:select')
        .setPlaceholder('Toggle an audio filter...')
        .addOptions(options),
    );
    response.addButtonRow(0, selectRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    const resetRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('music:filter:reset')
        .setLabel('Reset All Filters')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(activeFilters.length === 0),
      new ButtonBuilder()
        .setCustomId('music:control:view_nowplaying')
        .setLabel('Back to Player')
        .setStyle(ButtonStyle.Secondary),
    );
    response.addButtonRow(1, resetRow as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);

    return response;
  }

  public static buildNodeStatsResponse(
    stats: LavalinkNodeStats[],
    accentColor?: number,
  ): ResponseModel {
    const color = accentColor ?? DiscordConstants.LastFmColorBlue;
    const response = new ResponseModel(color);

    response.embed.setTitle('📊 Lavalink Nodes Status (Public Nodes Masterclass)');

    if (stats.length === 0) {
      response.embed.setDescription('No Lavalink nodes configured or connected.');
      return response;
    }

    let totalPlayers = 0;
    let totalPlaying = 0;

    for (const node of stats) {
      totalPlayers += node.players;
      totalPlaying += node.playingPlayers;

      const statusIcon = node.connected ? '🟢 Connected' : '🔴 Disconnected';
      const value = [
        `**Status:** ${statusIcon}`,
        `**Players:** ${node.players} (${node.playingPlayers} playing)`,
        `**CPU Load:** System ${node.cpuLoad}% | Lavalink ${node.lavalinkLoad}%`,
        `**Memory:** ${node.memoryUsedMb}MB / ${node.memoryAllocatedMb}MB`,
        `**Uptime:** ${Math.floor(node.uptimeMs / 1000 / 60)} min`,
      ].join('\n');

      response.embed.addFields({
        name: `Node: ${node.identifier} (${node.host}:${node.port})`,
        value,
        inline: false,
      });
    }

    response.embed.setFooter({
      text: `Total Nodes: ${stats.length} • Total Players: ${totalPlayers} (${totalPlaying} playing)`,
    });

    return response;
  }

  public static buildSimpleResponse(
    title: string,
    description?: string,
    color?: number,
  ): ResponseModel {
    const response = new ResponseModel(color);
    response.embed.setTitle(title);
    if (description) {
      response.embed.setDescription(description);
    }
    return response;
  }
}
