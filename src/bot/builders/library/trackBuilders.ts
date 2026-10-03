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

import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { TrackSearchResult } from '@bot/services/library/trackService';
import { PlaycountBuilders } from '@bot/builders/library/playcountBuilders';
import { TrackDetailsBuilders } from '@bot/builders/library/trackDetailsBuilders';
import { EMOJI } from '@bot/resources/emojis';
import { pluralise } from '@bot/builders/common/pluralise';

export interface TrackMediaDetails {
  uniqueId: string;
  previewUrl?: string | null;
  storeUrl?: string | null;
  spotifyUrl?: string | null;
  source?: 'spotify' | 'deezer' | 'apple';
  durationFormatted?: string;
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
    _targetUser: User,
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
    // A Section's accessory is NOT optional in discord.js: `SectionBuilder.toJSON()`
    // validates the accessory through a required union, so a section built without
    // one throws at serialisation and the card can never be sent. With a cover the
    // header goes in a section; without one it goes in as a plain text block, the
    // same shape the artist cards already use.
    if (track.coverUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(track.coverUrl)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }

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
        `**${track.globalPlaycount.toLocaleString()}** Last.fm plays by **${track.globalListeners.toLocaleString()}** ${pluralise(track.globalListeners, 'listener')}`,
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

    // Personal user plays + last month. Presence, not magnitude: an unread
    // count (`undefined`/`null` — Last.fm gave nothing and the DB fallback was
    // unavailable) omits the line, the same rule `albumBuilders` uses. A
    // genuine 0 from a query that RAN still renders as "**0** plays".
    if (track.userPlaycount !== undefined && track.userPlaycount !== null) {
      const plays = track.userPlaycount;
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
    }

    // ActionRow with Streaming link + Preview
    const row = new ActionRowBuilder<ButtonBuilder>();

      if (mediaDetails) {
        const source = mediaDetails.source;
        const storeUrl = mediaDetails.storeUrl;
        const spotifyUrl = mediaDetails.spotifyUrl;
        // Link buttons assert a valid URL, and the Apple resolver can return
        // a null storeUrl — the `!` silenced the compiler and threw at runtime
        // ("Sorry, something went wrong") for Apple-resolved tracks.
        const link = (url: string | null | undefined, emoji: unknown): void => {
          if (!url) return;
          row.addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setURL(url)
              .setEmoji(emoji as never),
          );
        };

        if (source === 'apple' || storeUrl?.includes('apple.com') || storeUrl?.includes('itunes')) {
          link(storeUrl, EMOJI.appleMusicServices);
        } else if (source === 'spotify' || spotifyUrl || storeUrl?.includes('spotify.com')) {
          link(spotifyUrl ?? storeUrl, EMOJI.serviceSpotify);
        } else if (source === 'deezer' || storeUrl?.includes('deezer.com')) {
          link(storeUrl, EMOJI.serviceDeezer);
        }

      if (mediaDetails.uniqueId) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`track-preview:${mediaDetails.uniqueId}:`)
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Preview')
            .setEmoji(EMOJI.playPreview)
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
    // Clamp before slicing, same as `artistTrackBuilders` / `artistBuilders` /
    // `topBuilders`. The next button is disabled at the last page, but the
    // custom id is the only thing that decides the increment
    // (`nowPlayingInteractions.ts:213` adds one with no upper bound), and a loved
    // count that shrank since the card was rendered puts `page` past the end.
    // Unclamped that rendered an empty list under "Page 10000/5", and
    // `totalCount: 0` with a non-empty list printed the impossible "Page 2/1".
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = tracks.slice(currentPage * perPage, (currentPage + 1) * perPage);

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) container.setAccentColor(accentColor);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/loved`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### Loved tracks for [${displayName}](${userUrl})`),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const lines = slice.map((t, idx) => {
      const rank = currentPage * perPage + idx + 1;
      const trackUrl = t.url ?? `https://www.last.fm/music/${encodeURIComponent(t.artistName).replace(/%20/g, '+')}/_/${encodeURIComponent(t.name).replace(/%20/g, '+')}`;
      const timeStr = t.dateLoved ? ` — <t:${Math.floor(t.dateLoved.getTime() / 1000)}:R>` : '';
      return `${rank}. ❤️ **[${t.name}](${trackUrl})** by **${t.artistName}**${timeStr}`;
    }).join('\n') || 'No loved tracks found.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const footer = `-# Page ${currentPage + 1}/${totalPages} — ${totalCount.toLocaleString()} loved ${pluralise(totalCount, 'track')}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    if (totalPages > 1) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`loved:prev:${currentPage}:${encodeURIComponent(userNameLastFm)}`).setEmoji(EMOJI.pagePrevious).setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
        new ButtonBuilder().setCustomId(`loved:next:${currentPage}:${encodeURIComponent(userNameLastFm)}`).setEmoji(EMOJI.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
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
    // `TextDisplayBuilder.setContent('')` throws at build time, so a provider that
    // hands back an empty body costs the whole card. Say what happened instead.
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(snippet || '*No lyrics were returned for this track.*'),
    );

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
}
