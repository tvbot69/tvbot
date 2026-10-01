import { SeparatorSpacingSize } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { EMOJI } from '@bot/resources/emojis';
import { pluralise } from '@bot/builders/common/pluralise';


export class ArtistTrackBuilders {
  public static buildArtistTopTracksResponse(
    artistName: string,
    displayName: string,
    tracks: { name: string; playcount: number }[],
    totalArtistPlays: number,
    distinctCount: number,
    page: number = 0,
    accentColor?: number,
    artistId?: number | string,
    targetUserId?: string,
    authorUserId?: string,
    partialIndexNotice: boolean = false,
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
    // Clamp before slicing. An out-of-range `page` used to render an empty list
    // under a page number that does not exist, so "No tracks found." read as a
    // fact about the listener rather than about the button they pressed. Same
    // clamp as the album tracks card.
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const slice = tracks.slice(currentPage * perPage, (currentPage + 1) * perPage);
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Your top tracks for '${artistName}'`));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const lines = slice.map((t, idx) => {
      const rank = currentPage * perPage + idx + 1;
      return `${rank}. **${t.name}** - *${t.playcount} ${t.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n') || 'No tracks found.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const footer = `-# Page ${currentPage + 1}/${totalPages} — ${distinctCount} different ${pluralise(distinctCount, 'track')}\n-# ${displayName} has ${totalArtistPlays} total artist ${totalArtistPlays === 1 ? 'play' : 'plays'}\n-# Some tracks outside of top 6000 might not be visible${partialIndexNotice ? '\n-# Library still indexing — showing partial results, run this again in a bit' : ''}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    const aId = artistId ?? encodeURIComponent(artistName);
    const tUser = targetUserId ?? '0';
    const aUser = authorUserId ?? '0';

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`at:first:${currentPage}:${aId}:${tUser}:${aUser}`).setEmoji(EMOJI.pageFirst).setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`at:prev:${currentPage}:${aId}:${tUser}:${aUser}`).setEmoji(EMOJI.pagePrevious).setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`at:next:${currentPage}:${aId}:${tUser}:${aUser}`).setEmoji(EMOJI.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
      new ButtonBuilder().setCustomId(`at:last:${currentPage}:${aId}:${tUser}:${aUser}`).setEmoji(EMOJI.pageLast).setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
      new ButtonBuilder().setCustomId(`artist-overview:${aId}:${tUser}:${aUser}`).setEmoji({ name: '📊' }).setStyle(ButtonStyle.Secondary),
    );
    container.addActionRowComponents(row);

    response.setComponentsV2Container(container);
    response._atData = { artistName, tracks, totalArtistPlays, distinctCount };
    return response;
  }
}
