import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';

import { TimePeriod } from '@domain/enums/timePeriod';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { ChartSettings } from '@bot/models/chartModels';
import type { ChartResult } from '@bot/services/charts/chartService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { NotEnoughAlbumsError } from '@bot/services/charts/chartService';

const PERIOD_TOKENS: Partial<Record<TimePeriod, string>> = {
  [TimePeriod.Weekly]: 'weekly',
  [TimePeriod.Monthly]: 'monthly',
  [TimePeriod.Quarterly]: 'quarterly',
  [TimePeriod.HalfYearly]: 'halfyearly',
  [TimePeriod.Yearly]: 'yearly',
  [TimePeriod.AllTime]: 'overall',
};

const MAX_MEDIA_DESCRIPTION_LENGTH = 340;

const lastfmUserUrl = (userName: string): string =>
  `https://www.last.fm/user/${encodeURIComponent(userName)}`;

/**
 * The Edit button's custom id carries the creator's Discord id, and
 * `ChartInteractions.handleEditButton` refuses anyone whose `interaction.user.id`
 * does not equal it. A card that ships a button nobody can ever press is a
 * control that lies, so the builder only offers the button when the author object
 * actually carries a Discord user id — a snowflake. `chartSlashCommands` builds
 * that author from `{ userNameLastFm, totalPlayCount }` alone, so the id is
 * genuinely absent in production and the button must not appear.
 */
const CREATOR_ID_PATTERN = /^\d{5,}$/;

const creatorIdOf = (user: User): string | null => {
  const id = user.discordUserId;
  return typeof id === 'string' && CREATOR_ID_PATTERN.test(id) ? id : null;
};

const libraryUrl = (userName: string, chartSettings: ChartSettings): string => {
  const preset = chartSettings.timeSettings?.urlParameter;
  const sub = chartSettings.trackChart
    ? 'tracks'
    : chartSettings.artistChart
    ? 'music'
    : 'albums';
  const base = `${lastfmUserUrl(userName)}/library/${sub}`;
  return preset && preset !== 'ALL'
    ? `${base}?date_preset=${preset}`
    : base;
};

const buildTopEntitiesDescription = (
  entities: Array<{ name: string; artistName?: string }>,
): string => {
  const lines = entities.map((entity, index) => {
    const label = entity.artistName
      ? `${entity.name} by ${entity.artistName}`
      : entity.name;
    return `#${index + 1} ${label}`;
  });

  let description = '';
  for (const line of lines) {
    if (description.length + line.length + 2 > MAX_MEDIA_DESCRIPTION_LENGTH) {
      break;
    }
    description = description ? `${description}, ${line}` : line;
  }
  return description;
};

export class ChartBuilders {
  public static buildAlbumChartResponse(
    user: User,
    discordDisplayName: string | undefined,
    result: ChartResult,
    chartSettings: ChartSettings,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    this.applyV2Container(response, user, discordDisplayName, result, chartSettings, 'album', accentColor);
    return response;
  }

  public static buildArtistChartResponse(
    user: User,
    discordDisplayName: string | undefined,
    result: ChartResult,
    chartSettings: ChartSettings,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    this.applyV2Container(response, user, discordDisplayName, result, chartSettings, 'artist', accentColor);
    return response;
  }

  public static buildTrackChartResponse(
    user: User,
    discordDisplayName: string | undefined,
    result: ChartResult,
    chartSettings: ChartSettings,
    accentColor?: number,
  ): ResponseModel {
    const response = new ResponseModel(accentColor);
    this.applyV2Container(response, user, discordDisplayName, result, chartSettings, 'track', accentColor);
    return response;
  }

  private static applyV2Container(
    response: ResponseModel,
    user: User,
    discordDisplayName: string | undefined,
    result: ChartResult,
    chartSettings: ChartSettings,
    chartType: 'album' | 'artist' | 'track',
    accentColor?: number,
  ): void {
    const displayName = (discordDisplayName ?? user.userNameLastFm).toLowerCase();
    const timespanLower = chartSettings.timespanString.toLowerCase();
    const sizeLabel = `${chartSettings.width}x${chartSettings.height}`;
    const periodToken = PERIOD_TOKENS[chartSettings.timeSettings?.timePeriod ?? TimePeriod.AllTime];

    const titleText =
      `**[${sizeLabel} ${timespanLower} chart]` +
      `(${libraryUrl(user.userNameLastFm, chartSettings)}) for ${displayName}**`;

    // Presence, not magnitude. `totalPlayCount` is `number | undefined` on the
    // user row, and an unread count must not become "has 0 scrobbles". It is
    // still rendered when a real count — including a real zero — was supplied.
    const scrobblesText =
      user.totalPlayCount !== undefined
        ? `-# ${user.userNameLastFm} has ${user.totalPlayCount.toLocaleString()} scrobbles`
        : '-# Scrobble total unavailable';

    const typeCode = chartSettings.trackChart ? 't' : chartSettings.artistChart ? 'r' : 'a';
    const creatorId = creatorIdOf(user);
    const editButton = creatorId
      ? new ButtonBuilder()
        .setCustomId(
          `chart-edit:${creatorId}:${typeCode}:` +
            `${sizeLabel}:${periodToken}:1:0:0:0:0:0:0:${user.userNameLastFm}`,
        )
        .setLabel('Edit')
        .setStyle(ButtonStyle.Secondary)
      : null;

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    const used = chartSettings.trackChart
      ? result.tracksUsed
      : chartSettings.artistChart
      ? result.artistsUsed
      : result.albumsUsed;

    if (result.imageUrl) {
      const galleryItem = new MediaGalleryItemBuilder().setURL(result.imageUrl);
      if (used && used.length > 0) {
        galleryItem.setDescription(buildTopEntitiesDescription(used));
      }
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(galleryItem),
      );
    } else if (result.buffer) {
      const galleryItem = new MediaGalleryItemBuilder().setURL('attachment://chart.png');
      if (used && used.length > 0) {
        galleryItem.setDescription(buildTopEntitiesDescription(used));
      }
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(galleryItem),
      );
      response.setFile(
        result.buffer,
        'chart.png',
        `${chartSettings.width}x${chartSettings.height} ${chartType} chart`,
      );
    } else {
      // No image and no upload. Say so: a card with a heading and an Edit button
      // and no chart reads as a chart the user is being shown.
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '-# The chart image could not be generated. Try a smaller size, or a different time period.',
        ),
      );
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));

    // A Section needs both an accessory and at least one text component, so the
    // scrobble line is a plain text block whenever the Edit button is absent.
    if (editButton) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(scrobblesText))
          .setButtonAccessory(editButton),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(scrobblesText));
    }

    response.setComponentsV2Container(container);
  }

  /**
   * The shortfall is reported as one of three different facts, and the lead
   * sentence has to be one of the three too.
   *
   * `available` is a count of what was left AT the stage named by
   * `shortfallCause` — for `covers` that is the number with artwork, not the
   * number listened to. The old fixed "You have listened to N X in this time
   * period" was therefore a fabricated claim on two of the three causes: a user
   * with thirty albums and three covers was told they had listened to three.
   */
  public static buildNotEnoughAlbumsError(
    error: NotEnoughAlbumsError,
    chartType: 'album' | 'artist' | 'track' | boolean = 'album',
  ): ResponseModel {
    const itemType =
      chartType === 'track'
        ? 'tracks'
        : chartType === 'artist' || chartType === true
        ? 'artists'
        : 'albums';
    const available = `**${error.available}**`;
    const required = `**${error.required}**`;

    let description: string;
    let advice: string;

    switch (error.shortfallCause) {
      case 'filters':
        description =
          `Only ${available} of your ${itemType} matched the filters on this chart, ` +
          `but a chart of ${required} images was requested.`;
        advice =
          'Nothing was missing — your filters removed the rest. Widen or clear the artist, ' +
          'release year/decade or singles filter, or use a smaller size.';
        break;
      case 'covers':
        description =
          `Only ${available} of the ${itemType} Last.fm returned had a usable cover, ` +
          `but a chart of ${required} images was requested.`;
        advice =
          'This is a cover problem, not a filter one. Turn off `skip`/`ns`, which requires a ' +
          'cover for every tile and leaves gaps when there are none, or use a smaller size.';
        break;
      case 'upstream':
      default:
        description =
          `You have listened to ${available} ${itemType} in this time period, ` +
          `but a chart of ${required} images was requested.`;
        advice =
          'Try a smaller chart size, or use a different time period like `weekly`, `monthly`, `overall`.';
        break;
    }

    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.WrongInput,
      `${description}\n\n${advice}`,
    );
  }
}
