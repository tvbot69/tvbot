import { SeparatorSpacingSize } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';

import type { OverviewResult } from '@bot/services/overviewService';
import { EMOJI } from '@bot/resources/emojis';

function formatDuration(ms: number): string {
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function buildPaginatorRow(page: number, totalPages: number, userNameLastFm?: string, timeKey?: string): ActionRowBuilder<ButtonBuilder> {
  const safeUser = userNameLastFm ? encodeURIComponent(userNameLastFm) : 'self';
  const safeTime = timeKey ? encodeURIComponent(timeKey) : 'weekly';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`overview:first:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageFirst).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`overview:prev:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pagePrevious).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`overview:next:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`overview:last:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageLast).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`overview:jump:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageGoto).setStyle(ButtonStyle.Secondary),
  );
}

export class OverviewBuilders {
  public static buildOverviewResponse(
    userNameLastFm: string,
    displayName: string,
    timeDescription: string,
    overview: OverviewResult,
    page: number = 0,
    accentColor?: number,
  ): ResponseModel {
    const perPage = 4;
    const totalPages = Math.max(1, Math.ceil(overview.dailyBlocks.length / perPage));
    const slice = overview.dailyBlocks.slice(page * perPage, (page + 1) * perPage);

    // Calculate stats for current page (4 days on this page) matching fmbot
    const pagePlays = slice.reduce((sum, b) => sum + b.playCount, 0);
    const pageAvg = slice.length > 0 ? Math.round(pagePlays / slice.length) : 0;
    const pageUniqueTracks = new Set<string>();
    for (const b of slice) {
      for (const k of b.trackKeys) pageUniqueTracks.add(k);
    }

    const response = new ResponseModel(accentColor);
    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Daily overview for [${displayName}](https://last.fm/user/${encodeURIComponent(userNameLastFm)}/library?date_preset=LAST_7_DAYS)`));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    for (const block of slice) {
      const unix = block.epochSeconds;
      const durationStr = formatDuration(block.durationMs);
      const genreLine = block.genres.length > 0 ? `-# *${block.genres.join(' - ')}*` : '';

      const lines = [
        `**<t:${unix}:D> — ${durationStr} — ${block.playCount} ${block.playCount === 1 ? 'play' : 'plays'}**`,
        genreLine,
        block.topArtist,
        block.topAlbum,
        block.topTrack,
      ].filter(Boolean).join('\n');

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    }

    const footer = `-# ${page + 1}/${totalPages} - Top genres, artist, album and track\n-# ${pageUniqueTracks.size} unique tracks - ${pagePlays} total plays - ${pageAvg} avg`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
    container.addActionRowComponents(buildPaginatorRow(page, totalPages, userNameLastFm, timeDescription));

    response.setComponentsV2Container(container);
    (response as any)._overviewData = { userNameLastFm, displayName, timeDescription, overview };
    return response;
  }
}

