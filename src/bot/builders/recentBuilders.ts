import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { RecentTrackList } from '@domain/models/recentTrack';

const lastfmTrackUrl = (artist: string, track: string): string =>
  `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

export class RecentBuilders {
  public static buildRecentTracksResponse(
    userNameLastFm: string,
    displayName: string,
    targetDiscordId: string,
    recentData: RecentTrackList,
    page: number = 1,
    accentColor?: number,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### Recent tracks for [${displayName}](https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library)`,
      ),
    );

    for (const track of recentData.tracks) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );

      let timeStr = 'Right now';
      if (track.timePlayed && !track.nowPlaying) {
        timeStr = `<t:${Math.floor(track.timePlayed.getTime() / 1000)}:t>`;
      }
      const albumPart = track.albumName ? ` • *${track.albumName}*` : '';
      const trackLink = `**[${track.name}](${lastfmTrackUrl(track.artistName, track.name)})** by **${track.artistName}**`;
      const subline = `-# ${timeStr}${albumPart}`;

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${trackLink}\n${subline}`));
    }

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    const totalPages = Math.min(80, Math.max(1, recentData.totalPages));
    const scrobblesFormatted = (recentData.totalScrobbles ?? 0).toLocaleString();

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${page}/${totalPages} - ${userNameLastFm} has ${scrobblesFormatted} scrobbles`,
      ),
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`recent:prev:${page}:${targetDiscordId}:${encodeURIComponent(userNameLastFm)}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1)
        .setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any),
      new ButtonBuilder()
        .setCustomId(`recent:next:${page}:${targetDiscordId}:${encodeURIComponent(userNameLastFm)}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages)
        .setEmoji({ id: '883825508087922739', name: 'pages_next' } as any),
    );

    container.addActionRowComponents(row);

    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
