import {
  SeparatorBuilder,
  SeparatorSpacingSize,
  ContainerBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { EMOJI } from '@bot/resources/emojis';
import type { RymArtist, RymRelease, RymReleaseStub, RymSong } from '@rateyourmusic/models/rymModels';

const star = (e: { id: string; name: string }): string => `<:${e.name}:${e.id}>`;

/** A 0-5 RYM rating rendered on five stars: full per whole star, half for the
 *  .5 band and quarter for the .25 band; '·' fills the remainder so the width
 *  of the row is stable. */
export const starsFor = (rating: number | null): string => {
  if (rating === null) {
    return '· · · · ·';
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
      } else {
        out.push('·');
      }
    }
  }
  return out.join('');
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
    for (const stub of stubs.slice(0, 15)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${stub.position ?? '-'}. [${stub.title}](${stub.url})** — ${stub.artist} • ${stub.year ?? '?'}`),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${starsFor(stub.rating)}  ${fmtRating(stub.rating)} • ${fmtCount(stub.nRatings)} ratings`),
      );
    }
    if (stubs.length > 15) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# …and ${stubs.length - 15} more`));
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistResponse(artist: RymArtist, accentColor?: number, coverUrl?: string | null): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    const bits: string[] = [];
    if (artist.formed) bits.push(`Formed ${artist.formed}`);
    if (artist.located) bits.push(artist.located);
    if (artist.genres.length > 0) bits.push(artist.genres.slice(0, 4).join(', '));
    const headerText = `### [${artist.name}](${artist.url})${bits.length ? `\n-# ${bits.join(' • ')}` : ''}`;
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
    for (const stub of artist.discography.slice(0, 10)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**[${stub.title}](${stub.url})** — ${stub.year ?? '?'}`),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${starsFor(stub.rating)}  ${fmtRating(stub.rating)} • ${fmtCount(stub.nRatings)} ratings • ${stub.releaseType}`),
      );
    }
    if (artist.discography.length > 10) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# …and ${artist.discography.length - 10} more`));
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
    const headerText = `### [${song.title}](${song.url})\n-# **${song.artist}** • Released ${song.released || '—'}\n## ${starsFor(song.rating)}  ${fmtRating(song.rating)}\n-# ${fmtCount(song.nRatings)} ratings`;
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
    const headerText = `### [${release.title}](${release.url})\n-# **${release.artist}** • ${release.releaseType} • ${release.date || (release.year ?? '?')}\n## ${starsFor(release.rating)}  ${fmtRating(release.rating)}\n-# ${fmtCount(release.nRatings)} ratings • ${fmtCount(release.nReviews)} reviews`;
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
