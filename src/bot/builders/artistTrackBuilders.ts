import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';

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
  ): ResponseModel {
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
    const slice = tracks.slice(page * perPage, (page + 1) * perPage);
    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Your top tracks for '${artistName}'`));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));

    const lines = slice.map((t, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **${t.name}** - *${t.playcount} ${t.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n') || 'No tracks found.';

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1 as any));

    const footer = `-# Page ${page + 1}/${totalPages} — ${distinctCount} different tracks\n-# ${displayName} has ${totalArtistPlays} total artist ${totalArtistPlays === 1 ? 'play' : 'plays'}\n-# Some tracks outside of top 6000 might not be visible`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

    const aId = artistId ?? encodeURIComponent(artistName);
    const tUser = targetUserId ?? '0';
    const aUser = authorUserId ?? '0';

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`at:first:${page}:${aId}:${tUser}:${aUser}`).setEmoji({ id: '883825508633182208', name: 'pages_first' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`at:prev:${page}:${aId}:${tUser}:${aUser}`).setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`at:next:${page}:${aId}:${tUser}:${aUser}`).setEmoji({ id: '883825508087922739', name: 'pages_next' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      new ButtonBuilder().setCustomId(`at:last:${page}:${aId}:${tUser}:${aUser}`).setEmoji({ id: '883825508482183258', name: 'pages_last' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      new ButtonBuilder().setCustomId(`artist-overview:${aId}:${tUser}:${aUser}`).setEmoji({ name: '📊' } as any).setStyle(ButtonStyle.Secondary),
    );
    container.addActionRowComponents(row);

    response.setComponentsV2Container(container);
    (response as any)._atData = { artistName, tracks, totalArtistPlays, distinctCount };
    return response;
  }
}
