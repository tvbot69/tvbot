import {
  SeparatorBuilder,
  SeparatorSpacingSize,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { RymArtist, RymRelease, RymReleaseStub, RymSong } from '@rateyourmusic/models/rymModels';

const fmtRating = (rating: number | null): string =>
  rating === null ? '—' : `${rating.toFixed(2)}/5`;

const fmtCount = (count: number | null): string =>
  count === null ? '—' : count.toLocaleString('en-US');

const genresLine = (primary: string[], secondary: string[]): string => {
  const all = [...primary, ...secondary];
  return all.length === 0 ? '—' : all.slice(0, 6).join(', ');
};

const coverGallery = (url: string): MediaGalleryBuilder | null => {
  if (!url) {
    return null;
  }
  return new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url));
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
      new TextDisplayBuilder().setContent(`### Rate Your Music — ${label}`),
    );
    if (stubs.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('No entries found.'),
      );
    }
    for (const stub of stubs.slice(0, 25)) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      const line = `**${stub.position ?? '-'}. [${stub.title}](${stub.url})** by **${stub.artist}** (${stub.year ?? '?'})`;
      const detail = `-# ${stub.releaseType} • ${fmtRating(stub.rating)} • ${fmtCount(stub.nRatings)} ratings • ${fmtCount(stub.nReviews)} reviews • ${genresLine(stub.primaryGenres, stub.secondaryGenres)}`;
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`${line}\n${detail}`),
      );
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildArtistResponse(artist: RymArtist, accentColor?: number): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### [${artist.name}](${artist.url})\n-# Formed: ${artist.formed || '—'} • Located: ${artist.located || '—'}`,
      ),
    );
    if (artist.genres.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Genres: ${artist.genres.slice(0, 8).join(', ')}`),
      );
    }
    if (artist.members.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Members: ${artist.members.slice(0, 10).join(', ')}`),
      );
    }
    if (artist.aliases.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Aliases: ${artist.aliases.slice(0, 6).join(', ')}`),
      );
    }
    if (artist.notes) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${artist.notes.slice(0, 400)}`),
      );
    }
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Discography** (${artist.discography.length} releases)`),
    );
    for (const stub of artist.discography.slice(0, 15)) {
      const line = `**[${stub.title}](${stub.url})** (${stub.year ?? '?'}) — ${fmtRating(stub.rating)} • ${fmtCount(stub.nRatings)} ratings • ${stub.releaseType}`;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`- ${line}`));
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildSongResponse(song: RymSong, accentColor?: number): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### [${song.title}](${song.url})\n-# **${song.artist}** • Released ${song.released || '—'}`,
      ),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Rating:** ${fmtRating(song.rating)} • ${fmtCount(song.nRatings)} ratings`,
      ),
    );
    if (song.appearsOn.length > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Appears on** (${song.appearsOn.length})`),
      );
      for (const release of song.appearsOn.slice(0, 10)) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`- [${release.title}](${release.url}) • ${release.releaseType}`),
        );
      }
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildReleaseResponse(release: RymRelease, accentColor?: number): ResponseModel {
    const container = new ContainerBuilder();
    if (accentColor) {
      container.setAccentColor(accentColor);
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### [${release.title}](${release.url})\n-# **${release.artist}** • ${release.releaseType} • ${release.date || (release.year ?? '?')}`,
      ),
    );
    const gallery = coverGallery(release.coverUrl);
    if (gallery) {
      container.addMediaGalleryComponents(gallery);
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Rating:** ${fmtRating(release.rating)} • ${fmtCount(release.nRatings)} ratings • ${fmtCount(release.nReviews)} reviews`,
      ),
    );
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
      for (const track of release.tracklist.slice(0, 15)) {
        const dur = track.duration ? ` (${track.duration})` : '';
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`- ${track.position}. ${track.title}${dur}`),
        );
      }
      if (release.tracklist.length > 15) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# …and ${release.tracklist.length - 15} more`),
        );
      }
    }
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
