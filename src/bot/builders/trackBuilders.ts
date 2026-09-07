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
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackSearchResult } from '@bot/services/trackService';
import { PlaycountBuilders } from './playcountBuilders';
import { TrackDetailsBuilders } from './trackDetailsBuilders';

export interface TrackMediaDetails {
  uniqueId: string;
  previewUrl?: string | null;
  storeUrl?: string | null;
  spotifyUrl?: string | null;
  source?: 'spotify' | 'deezer' | 'apple';
  durationFormatted?: string;
}

export interface AudioFeaturesData {
  danceability?: number;
  energy?: number;
  valence?: number;
  acousticness?: number;
  instrumentalness?: number;
  tempo?: number;
  key?: string;
}

export interface LovedTrackItem {
  name: string;
  artistName: string;
  url?: string;
  dateLoved?: Date;
}

export function renderProgressBar(percentage: number, totalBlocks: number = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const filledBlocks = Math.round((clamped / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}] ${clamped}%`;
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

  // Static Facade Delegations — Zero Duplication
  public static buildTrackPlaysResponse = PlaycountBuilders.buildTrackPlaysResponse;
  public static buildTrackDetailsResponse = TrackDetailsBuilders.buildTrackDetailsResponse;

  public static buildLoveResponse(trackName: string, artistName: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`❤️ Loved **${trackName}** by **${artistName}** on Last.fm.`),
    );
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildUnloveResponse(trackName: string, artistName: string, accentColor?: number): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`💔 Unloved **${trackName}** by **${artistName}** on Last.fm.`),
    );
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildLovedTracksResponse(
    userNameLastFm: string,
    displayName: string,
    tracks: LovedTrackItem[],
    page: number = 0,
    totalCount: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const slice = tracks.slice(page * perPage, (page + 1) * perPage);

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/loved`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Loved tracks for [${displayName}](${userUrl})`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const lines = slice.map((t, idx) => {
      const rank = page * perPage + idx + 1;
      const trackUrl = t.url ?? `https://www.last.fm/music/${encodeURIComponent(t.artistName).replace(/%20/g, '+')}/_/${encodeURIComponent(t.name).replace(/%20/g, '+')}`;
      const timeStr = t.dateLoved ? ` — <t:${Math.floor(t.dateLoved.getTime() / 1000)}:R>` : '';
      return `${rank}. ❤️ **[${t.name}](${trackUrl})** by **${t.artistName}**${timeStr}`;
    }).join('\n') || 'No loved tracks found.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const footer = `-# Page ${page + 1}/${totalPages} — ${totalCount.toLocaleString()} loved tracks`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    if (totalPages > 1) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`loved:prev:${page}:${encodeURIComponent(userNameLastFm)}`).setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`loved:next:${page}:${encodeURIComponent(userNameLastFm)}`).setEmoji({ id: '883825508087922739', name: 'pages_next' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      );
      container.addActionRowComponents(row);
    }

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildTrackLyricsResponse(
    trackName: string,
    artistName: string,
    lyrics: string,
    sourceUrl?: string | null,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);

    const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artistName).replace(/%20/g, '+')}/_/${encodeURIComponent(trackName).replace(/%20/g, '+')}`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Lyrics for [${trackName}](${trackUrl}) by ${artistName}`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const snippet = lyrics.length > 2000 ? `${lyrics.slice(0, 1990)}...` : lyrics;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(snippet));

    if (sourceUrl) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Source: [View full lyrics](${sourceUrl})`));
    }

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildScrobbleResponse(
    trackName: string,
    artistName: string,
    userNameLastFm: string,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`Scrobbled **${trackName}** by **${artistName}** to **${userNameLastFm}**'s Last.fm profile.`),
    );
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAudioFeaturesResponse(
    trackName: string,
    artistName: string,
    features: AudioFeaturesData,
    coverUrl?: string | null,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);

    const trackUrl = `https://www.last.fm/music/${encodeURIComponent(artistName).replace(/%20/g, '+')}/_/${encodeURIComponent(trackName).replace(/%20/g, '+')}`;
    const header = `### Audio Features for [${trackName}](${trackUrl})\n**${artistName}**`;

    if (coverUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(coverUrl)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const lines: string[] = [];
    if (features.tempo !== undefined) lines.push(`**Tempo / BPM:** \`${features.tempo.toFixed(1)}\` bpm`);
    if (features.key !== undefined) lines.push(`**Musical Key:** \`${features.key}\``);
    if (features.danceability !== undefined) lines.push(`**Danceability:**  ${renderProgressBar(features.danceability * 100)}`);
    if (features.energy !== undefined) lines.push(`**Energy:**        ${renderProgressBar(features.energy * 100)}`);
    if (features.valence !== undefined) lines.push(`**Valence / Mood:** ${renderProgressBar(features.valence * 100)}`);
    if (features.acousticness !== undefined) lines.push(`**Acousticness:**  ${renderProgressBar(features.acousticness * 100)}`);
    if (features.instrumentalness !== undefined) lines.push(`**Instrumental:**  ${renderProgressBar(features.instrumentalness * 100)}`);

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
