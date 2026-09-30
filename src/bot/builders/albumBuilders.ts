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

import type { User } from '@domain/interfaces/iuserRepository';
import type { AlbumSearchResult } from '@bot/services/albumService';
import { PlaycountBuilders } from './playcountBuilders';
import { EMOJI } from '@bot/resources/emojis';

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
  // Static Facade Delegation — Zero Duplication with PlaycountBuilders
  public static buildAlbumPlaysResponse = PlaycountBuilders.buildAlbumPlaysResponse;
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
    _requesterName: string,
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

    // A Section's accessory is NOT optional in discord.js: `SectionBuilder.toJSON()`
    // runs the accessory through a required union validator, so a section with no
    // accessory throws at serialisation and the card can never be sent. With a
    // cover the header goes in a section; without one it goes in as a plain text
    // block, which is the same shape the artist cards use.
    if (album.albumCoverUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(album.albumCoverUrl)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }

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
    // Presence, not magnitude. `serverPlaycount` and `userTimeListenedSeconds`
    // above are guarded the same way: an unread count is a missing clause, and a
    // supplied 0 is a real answer.
    if (album.userPlaycount !== undefined) {
      const plays = album.userPlaycount;
      let playsLine = `**${plays}** play${plays !== 1 ? 's' : ''} by **${targetName}**`;
      if (album.userMonthlyPlaycount) {
        playsLine += ` — **${album.userMonthlyPlaycount}** last month`;
      }
      userStatsLines.push(playsLine);
    }

    if (album.userTimeListenedSeconds) {
      let timeLine = `**${formatDurationFriendly(album.userTimeListenedSeconds)}** listened`;
      if (album.userPercentageOfAllPlays !== undefined) {
        timeLine += ` — **${album.userPercentageOfAllPlays}%** of all your plays`;
      }
      userStatsLines.push(timeLine);
    }

    if (userStatsLines.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(userStatsLines.join('\n')),
      );
    }

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

    if (album.albumUrl) {
      actionRow.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Last.fm')
          .setURL(album.albumUrl)
          .setEmoji(EMOJI.serviceLastFm),
      );
    }
    if (album.spotifyUrl) {
      actionRow.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Spotify')
          .setURL(album.spotifyUrl)
          .setEmoji(EMOJI.serviceSpotify),
      );
    }

    container.addActionRowComponents(actionRow);

    const response = new ResponseModel(accentColor);
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAlbumTracksResponse(
    album: AlbumSearchResult,
    targetUser: User,
    _requesterName: string,
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
    // Same presence rule as the info card: an unread listener playcount drops the
    // clause rather than printing a 0 nobody measured.
    const listenerPlaysClause = album.userPlaycount !== undefined
      ? ` | ${targetUser.userNameLastFm} has ${album.userPlaycount} total album plays`
      : '';
    const footerText =
      `-# Page ${currentPage}/${totalPages} — ${totalTracks} total tracks${durationStr}\n` +
      `-# Album source: Last.fm${listenerPlaysClause}`;

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
