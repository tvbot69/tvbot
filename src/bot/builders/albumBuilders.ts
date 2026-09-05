import {
  ContainerBuilder,
  SectionBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ThumbnailBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { User } from '@domain/interfaces/iuserRepository';
import type { AlbumSearchResult } from '@bot/services/albumService';

const TRACKS_PER_PAGE = 12;

const formatSecondsToClock = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatDurationFriendly = (totalSeconds: number): string => {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  return parts.join(', ') || '0 minutes';
};

export class AlbumBuilders {
  public static buildCoverResponse(
    album: AlbumSearchResult,
    targetUser: User,
    requesterName: string,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    if (album.albumCoverUrl) {
      const galleryItem = new MediaGalleryItemBuilder()
        .setURL(album.albumCoverUrl)
        .setDescription(`Album cover for ${album.albumName} by ${album.artistName}`);
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(galleryItem));
    }

    const artistLink = album.artistUrl
      ? `[${album.artistName}](${album.artistUrl})`
      : album.artistName;
    const albumLink = album.albumUrl
      ? `[${album.albumName}](${album.albumUrl})`
      : album.albumName;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${artistLink} - ${albumLink}**\n-# Requested by ${requesterName}`,
      ),
    );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`album-info:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}`)
        .setLabel('Album')
        .setEmoji('💽')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`album-tracks:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:`)
        .setLabel('Tracks')
        .setEmoji('🎶')
        .setStyle(ButtonStyle.Secondary),
    );

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor);
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAlbumInfoResponse(
    album: AlbumSearchResult,
    targetUser: User,
    requesterName: string,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const artistLink = album.artistUrl
      ? `[${album.artistName}](${album.artistUrl})`
      : album.artistName;
    const albumLink = album.albumUrl
      ? `[${album.albumName}](${album.albumUrl})`
      : album.albumName;

    const releaseLine = album.releaseDate
      ? `\nReleased on **<t:${Math.floor(album.releaseDate.getTime() / 1000)}:D>**`
      : '';
    const labelLine = album.label ? `\n-# Label: ${album.label}` : '';

    const headerText = `## ${albumLink}\nAlbum by **${artistLink}**${releaseLine}${labelLine}`;

    const section = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerText),
    );

    if (album.albumCoverUrl) {
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(album.albumCoverUrl));
    }

    container.addSectionComponents(section);

    if (album.summary) {
      container.addSeparatorComponents(new SeparatorBuilder());
      const cleanSummary = album.summary.length > 300
        ? `${album.summary.slice(0, 297)}...`
        : album.summary;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(cleanSummary));
    }

    const serverStatsLines: string[] = [];
    if (album.serverPlaycount !== undefined && album.serverListeners !== undefined) {
      serverStatsLines.push(
        `**${album.serverPlaycount}** plays in this server by **${album.serverListeners}** listener${album.serverListeners !== 1 ? 's' : ''}`,
      );
    }
    if (album.globalPlaycount !== undefined && album.globalListeners !== undefined) {
      serverStatsLines.push(
        `**${album.globalPlaycount}** Last.fm plays by **${album.globalListeners}** listeners`,
      );
    }

    if (serverStatsLines.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(serverStatsLines.join('\n')),
      );
    }

    const userStatsLines: string[] = [];
    const targetName = targetUser.userNameLastFm;
    const plays = album.userPlaycount ?? 0;
    let playsLine = `**${plays}** play${plays !== 1 ? 's' : ''} by **${targetName}**`;
    if (album.userMonthlyPlaycount) {
      playsLine += ` — **${album.userMonthlyPlaycount}** last month`;
    }
    userStatsLines.push(playsLine);

    if (album.userTimeListenedSeconds) {
      let timeLine = `**${formatDurationFriendly(album.userTimeListenedSeconds)}** listened`;
      if (album.userPercentageOfAllPlays !== undefined) {
        timeLine += ` — **${album.userPercentageOfAllPlays}%** of all your plays`;
      }
      userStatsLines.push(timeLine);
    }

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(userStatsLines.join('\n')),
    );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`album-tracks:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:`)
        .setLabel('Tracks')
        .setEmoji('🎶')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`album-cover:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:motion:`)
        .setLabel('Cover')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
    );

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor);
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAlbumTracksResponse(
    album: AlbumSearchResult,
    targetUser: User,
    requesterName: string,
    page: number = 1,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const totalTracks = album.tracks.length;
    const totalPages = Math.max(1, Math.ceil(totalTracks / TRACKS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Track playcounts for ${album.albumName} by ${album.artistName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    const startIndex = (currentPage - 1) * TRACKS_PER_PAGE;
    const pageTracks = album.tracks.slice(startIndex, startIndex + TRACKS_PER_PAGE);

    const trackLines: string[] = [];
    pageTracks.forEach((track, idx) => {
      const number = startIndex + idx + 1;
      let line = `${number}. **${track.name}**`;
      if (track.playcount !== undefined && track.playcount > 0) {
        line += ` - *${track.playcount} play${track.playcount !== 1 ? 's' : ''}*`;
      }
      if (track.durationSeconds) {
        line += ` — \`${formatSecondsToClock(track.durationSeconds)}\``;
      }
      trackLines.push(line);
    });

    if (trackLines.length === 0) {
      trackLines.push('*No tracks found for this album.*');
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(trackLines.join('\n')),
    );
    container.addSeparatorComponents(new SeparatorBuilder());

    const durationStr = album.totalDurationSeconds
      ? ` — ${formatSecondsToClock(album.totalDurationSeconds)}`
      : '';
    const footerText =
      `-# Page ${currentPage}/${totalPages} — ${totalTracks} total tracks${durationStr}\n` +
      `-# Album source: Last.fm | ${targetUser.userNameLastFm} has ${album.userPlaycount ?? 0} total album plays`;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footerText),
    );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`album-info:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}`)
        .setLabel('Album')
        .setEmoji('💽')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`album-cover:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:motion:`)
        .setLabel('Cover')
        .setEmoji('🖼️')
        .setStyle(ButtonStyle.Secondary),
    );

    if (totalPages > 1) {
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`album-tracks:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:${currentPage - 1}`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`album-tracks:${album.albumId}:${targetUser.discordUserId}:${targetUser.discordUserId}:${currentPage + 1}`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages),
      );
    }

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor);
    response.setComponentsV2Container(container);
    return response;
  }
}
