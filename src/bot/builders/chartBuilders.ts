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
import { DiscordConstants } from '@bot/resources/discordConstants';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ChartSettings } from '@bot/models/chartModels';
import type { ChartResult } from '@bot/services/chartService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { NotEnoughAlbumsError } from '@bot/services/chartService';

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

    const scrobblesText =
      `-# ${user.userNameLastFm} has ${(user.totalPlayCount ?? 0).toLocaleString()} scrobbles`;

    const typeCode = chartSettings.trackChart ? 't' : chartSettings.artistChart ? 'r' : 'a';
    const editButton = new ButtonBuilder()
      .setCustomId(
        `chart-edit:${user.discordUserId}:${typeCode}:` +
          `${sizeLabel}:${periodToken}:1:0:0:0:0:0:0:${user.userNameLastFm}`,
      )
      .setLabel('Edit')
      .setStyle(ButtonStyle.Secondary);

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
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(scrobblesText))
        .setButtonAccessory(editButton),
    );

    response.setComponentsV2Container(container);
  }

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
    let description = `You have listened to **${error.available}** ${itemType} in this time period, but a chart of **${error.required}** images was requested.`;

    if (error.afterFilters) {
      description +=
        `\n\nNot enough ${itemType} remained after filters or missing covers. Try disabling \`skip\`/\`ns\`, widening the release filter, or choosing a smaller size.`;
    } else {
      description +=
        '\n\nTry a smaller chart size, or use a different time period like `weekly`, `monthly`, `overall`.';
    }

    return GenericEmbedService.buildCommandErrorResponse(CommandResponse.WrongInput, description);
  }
}
