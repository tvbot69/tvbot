import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ThumbnailBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackSearchResult } from '@bot/services/trackService';

export interface TrackMediaDetails {
  uniqueId: string;
  previewUrl?: string | null;
  storeUrl?: string | null;
  spotifyUrl?: string | null;
  source?: 'spotify' | 'deezer' | 'apple';
  durationFormatted?: string;
}

const formatSeconds = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export class TrackBuilders {
  public static buildTrackInfoResponse(
    track: TrackSearchResult,
    targetUser: User,
    displayName: string,
    accentColor?: number,
    mediaDetails?: TrackMediaDetails | null,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const artistLink = track.artistUrl
      ? `[${track.artistName}](${track.artistUrl})`
      : track.artistName;
    const trackLink = track.trackUrl
      ? `[${track.trackName}](${track.trackUrl})`
      : track.trackName;

    let subLine = `Track by **${artistLink}**`;
    if (track.albumName) {
      const albumLink = track.albumUrl
        ? `[${track.albumName}](${track.albumUrl})`
        : track.albumName;
      subLine += `\n-# On album ${albumLink}`;
    }

    const headerText = `## ${trackLink}\n${subLine}`;
    const section = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerText),
    );

    if (track.coverUrl) {
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(track.coverUrl));
    }

    container.addSectionComponents(section);

    // Duration line
    const durationStr =
      mediaDetails?.durationFormatted ??
      (track.durationSeconds && track.durationSeconds > 0 ? formatSeconds(track.durationSeconds) : null);

    if (durationStr || track.isLoved) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      let durationContent = durationStr ? `\`${durationStr}\` duration` : '';
      if (track.isLoved) {
        durationContent = durationContent ? `${durationContent} • ❤️ Loved` : '❤️ Loved';
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(durationContent));
    }

    // Stats section
    const statLines: string[] = [];
    if (track.serverPlaycount !== undefined && track.serverListeners !== undefined) {
      statLines.push(
        `**${track.serverPlaycount.toLocaleString()}** ${
          track.serverPlaycount === 1 ? 'play' : 'plays'
        } in this server by **${track.serverListeners.toLocaleString()}** listener${
          track.serverListeners !== 1 ? 's' : ''
        }`,
      );
    }
    if (track.globalPlaycount !== undefined && track.globalListeners !== undefined) {
      statLines.push(
        `**${track.globalPlaycount.toLocaleString()}** Last.fm plays by **${track.globalListeners.toLocaleString()}** listeners`,
      );
    }

    if (statLines.length > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(statLines.join('\n')),
      );
    }

    // Personal user plays + last month
    const plays = track.userPlaycount ?? 0;
    const playsWord = plays === 1 ? 'play' : 'plays';
    const monthPart =
      track.lastMonthPlays !== undefined && track.lastMonthPlays > 0
        ? ` — **${track.lastMonthPlays.toLocaleString()}** last month`
        : '';
    const userPlaysLine = `**${plays.toLocaleString()}** ${playsWord} by **${displayName}**${monthPart}`;

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(userPlaysLine));

    // ActionRow with Streaming link + Preview
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (mediaDetails) {
      const source = mediaDetails.source;
      const storeUrl = mediaDetails.storeUrl;
      const spotifyUrl = mediaDetails.spotifyUrl;

      if (source === 'apple' || storeUrl?.includes('apple.com') || storeUrl?.includes('itunes')) {
        row.addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(storeUrl!)
            .setEmoji({ id: '1218182727149420544', name: 'services_apple_music' } as any),
        );
      } else if (source === 'spotify' || spotifyUrl || storeUrl?.includes('spotify.com')) {
        row.addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(spotifyUrl ?? storeUrl!)
            .setEmoji({ id: '1496297132381048995', name: 'sp' } as any),
        );
      } else if (source === 'deezer' || storeUrl?.includes('deezer.com')) {
        row.addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(storeUrl!)
            .setEmoji({ id: '1496297153717473311', name: 'dez' } as any),
        );
      }

      if (mediaDetails.uniqueId) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`track-preview:${mediaDetails.uniqueId}:`)
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Preview')
            .setEmoji({ id: '1305607890941378672', name: 'fmbot_playpreview' } as any)
            .setDisabled(!mediaDetails.previewUrl),
        );
      }
    }

    if (row.components.length > 0) {
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(accentColor);
    response.setComponentsV2Container(container);
    return response;
  }
}
