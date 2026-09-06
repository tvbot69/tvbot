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
import { DiscordConstants } from '@bot/resources/discordConstants';
import {
  OrderType,
  GuildRankingItem,
  GuildRankingSettings,
} from '@bot/services/guildRankingService';

export const BillboardEmotes = {
  fiveOrMoreUp: '<:five_or_more_up:1545948477807132692>',
  oneToFiveUp: '<:one_to_five_up:1545948422643912795>',
  samePosition: '<:same_pose:1545948359133626458>',
  oneToFiveDown: '<:one_to_five_down:1545948554160373831>',
  fiveOrMoreDown: '<:five_or_more_down:1545948315890225213>',
  new: '<:new:1545948649555496960>',
};

export type ServerRankingType = 'artists' | 'albums' | 'tracks' | 'genres';

export interface BuildServerRankingOptions {
  type: ServerRankingType;
  serverName: string;
  items: GuildRankingItem[];
  previousItems: GuildRankingItem[] | null;
  settings: GuildRankingSettings;
  pageIndex: number;
  cacheKey: string;
  callerDiscordUserId: string;
  accentColor?: number | null;
  artistFilter?: string | null;
}

function toTitleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
}

export function getBillboardMovementBadge(
  newPosition: number,
  oldPosition: number | null,
): string {
  if (oldPosition === null || oldPosition === undefined) {
    return BillboardEmotes.new;
  }
  const diff = Math.abs(oldPosition - newPosition);
  if (oldPosition < newPosition) {
    return diff < 5 ? BillboardEmotes.oneToFiveDown : BillboardEmotes.fiveOrMoreDown;
  }
  if (oldPosition > newPosition) {
    return diff < 5 ? BillboardEmotes.oneToFiveUp : BillboardEmotes.fiveOrMoreUp;
  }
  return BillboardEmotes.samePosition;
}

export function formatRankingItemLine(
  type: ServerRankingType,
  item: GuildRankingItem,
  orderType: OrderType,
  badge?: string | null,
  artistFilter?: string | null,
): string {
  const badgePrefix = badge ? `${badge} ` : '';
  const listenersFormatted = item.listenerCount.toLocaleString();
  const playsFormatted = item.totalPlaycount.toLocaleString();
  const playLabel = item.totalPlaycount === 1 ? 'play' : 'plays';
  const listenerLabel = item.listenerCount === 1 ? 'listener' : 'listeners';

  if (type === 'artists') {
    if (orderType === OrderType.Listeners) {
      return `${badgePrefix}\`${listenersFormatted}\` · **${item.name}** · *${playsFormatted} ${playLabel}*`;
    }
    return `${badgePrefix}\`${playsFormatted}\` · **${item.name}** · *${listenersFormatted} ${listenerLabel}*`;
  }

  if (type === 'albums') {
    const albumDisplay = artistFilter && artistFilter.trim()
      ? `**${item.name}**`
      : `**${item.secondaryName ?? 'Unknown'}** - **${item.name}**`;

    if (orderType === OrderType.Listeners) {
      return `${badgePrefix}\`${listenersFormatted}\` · ${albumDisplay} · *${playsFormatted} ${playLabel}*`;
    }
    return `${badgePrefix}\`${playsFormatted}\` · ${albumDisplay} · *${listenersFormatted} ${listenerLabel}*`;
  }

  if (type === 'tracks') {
    const trackDisplay = artistFilter && artistFilter.trim()
      ? `**${item.name}**`
      : `**${item.secondaryName ?? 'Unknown'}** - **${item.name}**`;

    if (orderType === OrderType.Listeners) {
      return `${badgePrefix}\`${listenersFormatted}\` · ${trackDisplay} · *${playsFormatted} ${playLabel}*`;
    }
    return `${badgePrefix}\`${playsFormatted}\` · ${trackDisplay} · *${listenersFormatted} ${listenerLabel}*`;
  }

  // genres
  const genreName = toTitleCase(item.name);
  if (orderType === OrderType.Listeners) {
    return `${badgePrefix}\`${listenersFormatted}\` · **${genreName}** - *${playsFormatted} ${playLabel}*`;
  }
  return `${badgePrefix}\`${playsFormatted}\` · **${genreName}** - *${listenersFormatted} ${listenerLabel}*`;
}

export class ServerBuilders {
  public static buildServerLeaderboardResponse(options: BuildServerRankingOptions): ResponseModel {
    const {
      type,
      serverName,
      items,
      previousItems,
      settings,
      pageIndex,
      cacheKey,
      callerDiscordUserId,
      accentColor,
      artistFilter,
    } = options;

    const response = new ResponseModel(accentColor);

    // Empty state
    if (!items || items.length === 0) {
      response.commandResponse = CommandResponse.NotFound;
      const warningContainer = new ContainerBuilder().setAccentColor(DiscordConstants.WarningColorOrange);

      let noResultsMsg = `Sorry, there are no registered top ${type} on this server in the time period you selected.`;
      if (artistFilter && (type === 'albums' || type === 'tracks')) {
        noResultsMsg = `Sorry, there are no registered top ${type} for artist \`${artistFilter}\` on this server in the time period you selected.`;
      }

      warningContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent(noResultsMsg));
      response.setComponentsV2Container(warningContainer);
      return response;
    }

    // Build title
    let title: string;
    if (artistFilter && (type === 'albums' || type === 'tracks')) {
      title = `Top ${settings.timeDescription} '${artistFilter}' ${type} in ${serverName}`;
    } else {
      title = `Top ${settings.timeDescription} ${type} in ${serverName}`;
    }

    // Format all lines
    const formattedLines: string[] = [];
    const hasBillboard = previousItems !== null && previousItems !== undefined && previousItems.length > 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      let badge: string | null = null;

      if (hasBillboard) {
        let prevIndex: number | null = null;
        if (type === 'artists' || type === 'genres') {
          const found = previousItems!.findIndex((p) => p.name.toLowerCase() === item.name.toLowerCase());
          prevIndex = found >= 0 ? found : null;
        } else {
          // For albums and tracks, match both item name and artist (secondaryName)
          const found = previousItems!.findIndex(
            (p) =>
              p.name.toLowerCase() === item.name.toLowerCase() &&
              (p.secondaryName ?? '').toLowerCase() === (item.secondaryName ?? '').toLowerCase(),
          );
          prevIndex = found >= 0 ? found : null;
        }
        badge = getBillboardMovementBadge(i, prevIndex);
      }

      formattedLines.push(formatRankingItemLine(type, item, settings.orderType, badge, artistFilter));
    }

    // Chunk 12 items per page
    const pageSize = 12;
    const pages: string[][] = [];
    for (let i = 0; i < formattedLines.length; i += pageSize) {
      pages.push(formattedLines.slice(i, i + pageSize));
    }

    const totalPages = Math.max(1, pages.length);
    const currentPageClamped = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const currentPageLines = pages[currentPageClamped] ?? [];

    const container = new ContainerBuilder();
    if (accentColor !== undefined && accentColor !== null) {
      container.setAccentColor(accentColor);
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(currentPageLines.join('\n')),
    );

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    const footerLabel = settings.orderType === OrderType.Listeners ? 'Listener count' : 'Play count';
    const footerText = `-# ${footerLabel} - Page ${currentPageClamped + 1}/${totalPages}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText));

    if (totalPages > 1) {
      const row = new ActionRowBuilder<ButtonBuilder>();

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`server:page:first:${type}:${cacheKey}:0:${callerDiscordUserId}`)
          .setLabel('⏮')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPageClamped === 0),
        new ButtonBuilder()
          .setCustomId(`server:page:prev:${type}:${cacheKey}:${Math.max(0, currentPageClamped - 1)}:${callerDiscordUserId}`)
          .setLabel('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPageClamped === 0),
        new ButtonBuilder()
          .setCustomId(`server:page:next:${type}:${cacheKey}:${Math.min(totalPages - 1, currentPageClamped + 1)}:${callerDiscordUserId}`)
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPageClamped >= totalPages - 1),
        new ButtonBuilder()
          .setCustomId(`server:page:last:${type}:${cacheKey}:${totalPages - 1}:${callerDiscordUserId}`)
          .setLabel('⏭')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPageClamped >= totalPages - 1),
      );

      container.addActionRowComponents(row);
    }

    response.setComponentsV2Container(container);
    return response;
  }
}
