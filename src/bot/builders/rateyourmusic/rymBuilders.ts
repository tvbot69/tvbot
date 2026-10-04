import {
  SeparatorBuilder,
  SeparatorSpacingSize,
  ContainerBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { EMOJI } from '@bot/resources/emojis';
import type { RymArtist, RymRelease, RymReleaseStub, RymSong } from '@rateyourmusic/models/rymModels';

function buildPaginatorRow(customIdPrefix: string, page: number, totalPages: number, safeSlug: string): ActionRowBuilder<ButtonBuilder> {
  const isOnePage = totalPages <= 1;
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`${customIdPrefix}:first:${page}:${safeSlug}`).setEmoji(EMOJI.pageFirst).setStyle(ButtonStyle.Secondary).setDisabled(isOnePage || page === 0),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:prev:${page}:${safeSlug}`).setEmoji(EMOJI.pagePrevious).setStyle(ButtonStyle.Secondary).setDisabled(isOnePage || page === 0),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:next:${page}:${safeSlug}`).setEmoji(EMOJI.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(isOnePage || page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:last:${page}:${safeSlug}`).setEmoji(EMOJI.pageLast).setStyle(ButtonStyle.Secondary).setDisabled(isOnePage || page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${customIdPrefix}:jump:${page}:${safeSlug}`).setEmoji(EMOJI.pageGoto).setStyle(ButtonStyle.Secondary).setDisabled(isOnePage),
  );
  return row;
}

const star = (e: { id: string; name: string }): string => `<:${e.name}:${e.id}>`;

/** A 0-5 RYM rating rendered as filled stars only: full per whole star,
 *  half for the .5 band and quarter for the .1 band. No placeholders — a 3.1
 *  rating is three stars and a quarter, never three stars and two dots. */
export const starsFor = (rating: number | null): string => {
  if (rating === null) {
    return '';
  }
  const clamped = Math.max(0, Math.min(5, rating));
  const out: string[] = [];
  for (let slot = 0; slot < 5; slot += 1) {
    if (clamped >= slot + 1) {
      out.push(star(EMOJI.starFull));
    } else {
      const frac = clamped - slot;
      if (frac >= 0.5) {
        out.push(star(EMOJI.starHalf));
      } else if (frac >= 0.1) {
        out.push(star(EMOJI.starQuarter));
      }
    }
  }
  return out.join('');
};

/** Stars followed by the numeric score, collapsing the gap when the card has
 *  no score to show. */
const starsRow = (rating: number | null): string => {
  const stars = starsFor(rating);
  return stars ? `${stars}  ${fmtRating(rating)}` : fmtRating(rating);
};

const fmtRating = (rating: number | null): string =>
  rating === null ? '—' : `${rating.toFixed(2)}/5`;

const fmtCount = (count: number | null): string =>
  count === null ? '—' : count.toLocaleString('en-US');

const genresLine = (primary: string[], secondary: string[]): string => {
  const all = [...primary, ...secondary];
  return all.length === 0 ? '—' : all.slice(0, 6).join(', ');
};

export class RymBuilders {
  public static buildChartResponse(
    label: string,
    stubs: RymReleaseStub[],
    accentColor?: number,
    page = 1,
  ): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Top albums — ${label}\n-# ${stubs.length} releases, ranked by rateyourmusic.com`,
      ),
    );
    if (stubs.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('No entries found.'),
      );
    }
    const perPage = 15;
    const totalPages = Math.max(1, Math.ceil(stubs.length / perPage));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    for (const stub of stubs.slice((safePage - 1) * perPage, safePage * perPage)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${stub.position ?? '-'}. [${stub.title}](${stub.url})** — ${stub.artist} • ${stub.year ?? '?'}`),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${starsRow(stub.rating)} • ${fmtCount(stub.nRatings)} ratings`),
      );
    }
    if (totalPages > 1) {
      container.addActionRowComponents(
        buildPaginatorRow('rymchart', safePage - 1, totalPages, encodeURIComponent(label)),
      );
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistResponse(artist: RymArtist, accentColor?: number, coverUrl?: string | null, page = 1): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    // RYM lists several locations in ONE info-table cell, separated by a bullet,
    // so the raw value is split here. Left joined it became a single "item" that
    // held two locations and pushed the row past three.
    const bits: string[] = [];
    if (artist.formed) bits.push(`Formed ${artist.formed}`);
    for (const place of artist.located.split('•').map((p) => p.trim()).filter(Boolean)) {
      bits.push(place);
    }
    if (artist.genres.length > 0) bits.push(...artist.genres.slice(0, 4));
    const subLines: string[] = [];
    for (const chunk of [bits.slice(0, 3), bits.slice(3, 6)]) {
      if (chunk.length > 0) subLines.push(`-# ${chunk.join(' • ')}`);
    }
    const headerText = `### [${artist.name}](${artist.url})${subLines.length ? `\n${subLines.join('\n')}` : ''}`;
    if (coverUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(coverUrl)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }
    const detail: string[] = [];
    if (artist.members.length > 0) detail.push(`Members: ${artist.members.slice(0, 8).join(', ')}`);
    if (artist.aliases.length > 0) detail.push(`Aliases: ${artist.aliases.slice(0, 4).join(', ')}`);
    if (artist.notes) detail.push(artist.notes.slice(0, 300));
    if (detail.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${detail.join(' • ')}`),
      );
    }
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Discography\n-# ${artist.discography.length} releases`),
    );
    const discoPerPage = 10;
    const totalPages = Math.max(1, Math.ceil(artist.discography.length / discoPerPage));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    for (const stub of artist.discography.slice((safePage - 1) * discoPerPage, safePage * discoPerPage)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**[${stub.title}](${stub.url})** — ${stub.year ?? '?'}`),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${starsRow(stub.rating)} • ${fmtCount(stub.nRatings)} ratings • ${stub.releaseType}`),
      );
    }
    if (totalPages > 1) {
      container.addActionRowComponents(
        buildPaginatorRow('rymartist', safePage - 1, totalPages, encodeURIComponent(artist.rymId)),
      );
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildSongResponse(song: RymSong, accentColor?: number, coverUrl?: string | null): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    const headerText = `### [${song.title}](${song.url})\n-# **${song.artist}** • Released ${song.released || '—'}\n## ${starsRow(song.rating)}\n-# ${fmtCount(song.nRatings)} ratings`;
    if (coverUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(coverUrl)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }
    if (song.appearsOn.length > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      const shown = song.appearsOn.slice(0, 3);
      const suffix = song.appearsOn.length > 3 ? `, +${song.appearsOn.length - 3} more` : '';
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# **Appears on:** ${shown.map((r) => `[${r.title}](${r.url})`).join(' • ')}${suffix}`,
        ),
      );
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildReleaseResponse(release: RymRelease, accentColor?: number, coverUrl?: string | null): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    const headerText = `### [${release.title}](${release.url})\n-# **${release.artist}** • ${release.releaseType} • ${release.date || (release.year ?? '?')}\n## ${starsRow(release.rating)}\n-# ${fmtCount(release.nRatings)} ratings • ${fmtCount(release.nReviews)} reviews`;
    const cover = coverUrl || release.coverUrl;
    if (cover) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(cover)),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));
    }
    if (release.primaryGenres.length + release.secondaryGenres.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# Genres: ${genresLine(release.primaryGenres, release.secondaryGenres)}`,
        ),
      );
    }
    if (release.descriptors.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# Descriptors: ${release.descriptors.slice(0, 12).join(', ')}`,
        ),
      );
    }
    if (release.tracklist.length > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Tracklist** (${release.tracklist.length})`),
      );
      for (const track of release.tracklist.slice(0, 12)) {
        const dur = track.duration ? ` (${track.duration})` : '';
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`- ${track.position}. ${track.title}${dur}`),
        );
      }
      if (release.tracklist.length > 12) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# …and ${release.tracklist.length - 12} more`),
        );
      }
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
