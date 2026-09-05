import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { TimeSettingsModel } from '@domain/models/timeSettings';

const lastfmArtistUrl = (artist: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;
const lastfmAlbumUrl = (artist: string, album: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;
const lastfmTrackUrl = (artist: string, track: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

function buildPaginatorRow(page: number, totalPages: number, prefix: string, userNameLastFm?: string, timeKey?: string): ActionRowBuilder<ButtonBuilder> {
  const safeUser = userNameLastFm ? encodeURIComponent(userNameLastFm) : 'self';
  const safeTime = timeKey ? encodeURIComponent(timeKey) : 'weekly';
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:first:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508633182208', name: 'pages_first' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:prev:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:next:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508087922739', name: 'pages_next' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:last:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508482183258', name: 'pages_last' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:jump:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '1138849626234036264', name: 'pages_goto' } as any).setStyle(ButtonStyle.Secondary),
  );
  return row;
}

export class TopBuilders {
  public static buildTopArtistsResponse(
    userNameLastFm: string,
    displayName: string,
    topArtists: TopArtist[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topArtists.length / perPage));
    const slice = topArtists.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topArtists.length;

    const description = slice.map((a, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **[${a.name}](${lastfmArtistUrl(a.name)})** - *${a.playcount} ${a.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} artists for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/artists?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No artists found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different artists` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'topartists', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'artists', userNameLastFm, displayName, timeSettings, items: topArtists, accentColor };
    return response;
  }

  public static buildTopAlbumsResponse(
    userNameLastFm: string,
    displayName: string,
    topAlbums: TopAlbum[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topAlbums.length / perPage));
    const slice = topAlbums.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topAlbums.length;

    const description = slice.map((a, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **${a.artistName}** - **[${a.name}](${lastfmAlbumUrl(a.artistName, a.name)})** - *${a.playcount} ${a.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} albums for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/albums?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No albums found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different albums` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'topalbums', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'albums', userNameLastFm, displayName, timeSettings, items: topAlbums, accentColor };
    return response;
  }

  public static buildTopTracksResponse(
    userNameLastFm: string,
    displayName: string,
    topTracks: TopTrack[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topTracks.length / perPage));
    const slice = topTracks.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topTracks.length;

    const description = slice.map((t, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **${t.artistName}** - **[${t.name}](${lastfmTrackUrl(t.artistName, t.name)})** - *${t.playcount} ${t.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} tracks for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/tracks?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No tracks found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different tracks` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'toptracks', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'tracks', userNameLastFm, displayName, timeSettings, items: topTracks, accentColor };
    return response;
  }
}
