import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { EMOJI } from '@bot/resources/emojis';
import { pluralise } from '@bot/builders/pluralise';
import type {
  ListeningGapItem,
  GapEntityType,
  DiscoveryItem,
  IcebergData,
  AffinityData,
} from '@bot/services/library/musicIntelligenceService';

/**
 * THE PAGE NO LONGER EXISTS.
 *
 * `whoKnowsBuilders.buildContainerForPage` guards its lazy page lookup with
 * `if (!page)` and prints this. The same condition arrives here by a different
 * route and ends in the same `TextDisplayBuilder.setContent('')` ->
 * "Invalid string length" raise:
 *
 *   `IntelligenceInteractions` parses `totalPages` out of the ORIGINAL customId
 *   (`intelligenceInteractions.ts:190` for gaps, `:127` for discoveries, `:63`
 *   for affinity), clamps `last` to THAT number (`:196`/`:133`/`:69`), and only
 *   THEN re-reads the data fresh (`:205`/`:144`/`:81`). So pressing "last" hands
 *   the builder a page index taken from the card while the list is whatever came
 *   back on the second read. A list that came back shorter — the rolling 90-day
 *   discovery window slid, a gap dropped under the threshold once the user
 *   scrobbled again, a guild lost an indexed member — leaves `page` past the end
 *   of a list the builder is holding, `currentItems` empty and `lines.join('\n')`
 *   the empty string. Nothing between there and
 *   `interactionHandler.onInteractionCreated` catches it, so the press crashes.
 *
 * A page is a thing that can stop existing between a card being posted and a
 * button being pressed. The honest answer is that the page is gone.
 */
const PAGE_IS_GONE = 'This page of the list is no longer available.';

/**
 * A page past the end of a NON-EMPTY list.
 *
 * `Math.max(1, page)` already rules out a page before the first; what it cannot
 * rule out is a page after the last. Keyed on the SLICE rather than on
 * `page > totalPages` so it also holds for a `pageSize` that slices to nothing,
 * and stated so the genuine-empty direction — an empty list, which has its own
 * honest sentence at each call site — can never take this branch. Both facts
 * are load-bearing: without the first the four cards throw, and without the
 * second a real "nothing found" would be reported as a vanished page.
 */
function pageIsGone(listLength: number, sliceLength: number): boolean {
  return listLength > 0 && sliceLength === 0;
}

/**
 * The one card-assembly tail, shared by every paginated builder here.
 *
 * Four identical blocks, and the fix needs a second return path in each of the
 * four, so the two shapes are stated once rather than eight times.
 */
function cv2Response(container: ContainerBuilder, accentColor?: number | null): ResponseModel {
  const response = new ResponseModel(accentColor ?? DiscordConstants.LastFmColorRed);
  response.commandResponse = CommandResponse.Ok;
  response.setComponentsV2Container(container);
  return response;
}

export class IntelligenceBuilders {
  public static buildListeningGapsResponse(params: {
    displayName: string;
    userNameLastFm: string;
    entityType: GapEntityType;
    items: ListeningGapItem[];
    page?: number;
    pageSize?: number;
    callerDiscordId?: string;
    targetDiscordId?: string;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = params.items.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const typeLabel = params.entityType.charAt(0).toUpperCase() + params.entityType.slice(1);
    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library`;
    const titleText = `### ⏱️ ${typeLabel} listening gaps for [${params.displayName}](${userUrl})\n-# Showing items you returned to after a hiatus of at least 90 days`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `*No ${params.entityType} listening gaps of 90+ days found in your listening history.*`,
        ),
      );
    } else if (pageIsGone(params.items.length, currentItems.length)) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(PAGE_IS_GONE));
    } else {
      const lines = currentItems.map((item, idx) => {
        const rank = startIndex + idx + 1;
        const resumeTimestamp = Math.floor(item.resumeDate.getTime() / 1000);
        let link: string;
        if (params.entityType === 'artist') {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.name)})**`;
        } else if (params.entityType === 'album' && item.artistName) {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.artistName)}/${encodeURIComponent(item.name)})** by **[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        } else if (item.artistName) {
          link = `**[${item.name}](https://www.last.fm/music/${encodeURIComponent(item.artistName)}/_/${encodeURIComponent(item.name)})** by **[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        } else {
          link = `**${item.name}**`;
        }

        return `${rank}. ${link} — Resumed <t:${resumeTimestamp}:D> after **${item.gapDays.toLocaleString()} days** (*${item.totalPlays.toLocaleString()} total plays*)`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# Page ${page}/${totalPages} • Total: ${params.items.length} gaps`),
        );

        const callerId = params.callerDiscordId ?? '0';
        const targetId = params.targetDiscordId ?? '0';
        const paginatorRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gaps-page:first:${callerId}:${targetId}:${params.entityType}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pageFirst),
          new ButtonBuilder()
            .setCustomId(`gaps-page:prev:${callerId}:${targetId}:${params.entityType}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pagePrevious),
          new ButtonBuilder()
            .setCustomId(`gaps-page:next:${callerId}:${targetId}:${params.entityType}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageNext),
          new ButtonBuilder()
            .setCustomId(`gaps-page:last:${callerId}:${targetId}:${params.entityType}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageLast),
        );
        container.addActionRowComponents(paginatorRow);
      }
    }

    return cv2Response(container, params.accentColor);
  }

  public static buildDiscoveriesResponse(params: {
    displayName: string;
    userNameLastFm: string;
    periodDescription: string;
    items: DiscoveryItem[];
    page?: number;
    pageSize?: number;
    callerDiscordId?: string;
    targetDiscordId?: string;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.items.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = params.items.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(params.userNameLastFm)}/library/artists`;
    const titleText = `### ✨ Discovered artists in ${params.periodDescription} for [${params.displayName}](${userUrl})\n-# Artists listened to for the very first time in this period`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `*No newly discovered artists found in ${params.periodDescription}.*`,
        ),
      );
    } else if (pageIsGone(params.items.length, currentItems.length)) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(PAGE_IS_GONE));
    } else {
      const lines = currentItems.map((item, idx) => {
        const rank = startIndex + idx + 1;
        const firstTimestamp = Math.floor(item.firstPlay.getTime() / 1000);
        const artistLink = `**[${item.artistName}](https://www.last.fm/music/${encodeURIComponent(item.artistName)})**`;
        const playStr = item.playcount === 1 ? '1 play' : `${item.playcount.toLocaleString()} plays`;
        return `${rank}. ${artistLink} — *${playStr}* — first played on <t:${firstTimestamp}:D>`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Page ${page}/${totalPages} • Total: ${params.items.length} discovered ${pluralise(params.items.length, 'artist')}`,
          ),
        );

        const callerId = params.callerDiscordId ?? '0';
        const targetId = params.targetDiscordId ?? '0';
        const paginatorRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`discoveries-page:first:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pageFirst),
          new ButtonBuilder()
            .setCustomId(`discoveries-page:prev:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pagePrevious),
          new ButtonBuilder()
            .setCustomId(`discoveries-page:next:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageNext),
          new ButtonBuilder()
            .setCustomId(`discoveries-page:last:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageLast),
        );
        container.addActionRowComponents(paginatorRow);
      }
    }

    return cv2Response(container, params.accentColor);
  }

  public static buildIcebergResponse(params: {
    data: IcebergData;
    imageBuffer?: Buffer | null;
    accentColor?: number | null;
  }): ResponseModel {
    const { data } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const userUrl = `https://www.last.fm/user/${encodeURIComponent(data.userNameLastFm)}/library/artists`;
    const titleText = `### 🧊 Taste Iceberg for [${data.displayName}](${userUrl}) (${data.timePeriodDescription})\n-# Tier classification of your top ${data.totalArtists} artists by popularity`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;

    if (params.imageBuffer) {
      const mediaGallery = new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL('attachment://iceberg.png'),
      );
      container.addMediaGalleryComponents(mediaGallery);
      response.setFile(params.imageBuffer, 'iceberg.png', 'Your taste iceberg');
    } else {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      const tierSections: string[] = [];
      for (const tier of data.tiers) {
        if (tier.artists.length === 0) continue;
        const topArtistsStr = tier.artists
          .slice(0, 8)
          .map((a) => `[${a.name}](https://www.last.fm/music/${encodeURIComponent(a.name)})`)
          .join(', ');
        const extraCount = tier.artists.length > 8 ? ` *+${tier.artists.length - 8} more*` : '';
        tierSections.push(
          `**${tier.emoji} Tier ${tier.tierNumber}: ${tier.name}** (${tier.artists.length} artists)\n> ${topArtistsStr}${extraCount}`,
        );
      }

      if (tierSections.length === 0) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent('*No artists found to classify in the selected time period.*'),
        );
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(tierSections.join('\n\n')));
      }
    }

    response.setComponentsV2Container(container);
    return response;
  }

  public static buildAffinityResponse(params: {
    data: AffinityData;
    page?: number;
    pageSize?: number;
    callerDiscordId?: string;
    targetDiscordId?: string;
    accentColor?: number | null;
  }): ResponseModel {
    const { data } = params;
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 12;
    const totalPages = Math.max(1, Math.ceil(data.neighbors.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = data.neighbors.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### Server neighbors for ${data.userDisplayName}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (data.neighbors.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '*Could not find indexed users with a similar music taste in this server.*',
        ),
      );
    } else if (pageIsGone(data.neighbors.length, currentItems.length)) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(PAGE_IS_GONE));
    } else {
      const lines = currentItems.map((n) => {
        const targetUrl = `https://last.fm/user/${encodeURIComponent(n.userNameLastFm)}`;
        const nameLabel = n.displayName || n.userNameLastFm;
        return (
          `**${n.totalPercentage}%** — **[${nameLabel}](${targetUrl})** — ` +
          `\`${n.artistPercentage}%\` artists, \`${n.genrePercentage}%\` genres, \`${n.countryPercentage}%\` countries`
        );
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      const totalMembers = data.totalGuildUsers || data.neighbors.length;
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# Page ${page}/${totalPages} - ${totalMembers} tvbot members in this server`,
        ),
      );

      if (totalPages > 1) {
        const callerId = params.callerDiscordId ?? '0';
        const targetId = params.targetDiscordId ?? '0';
        const paginatorRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`affinity-page:first:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pageFirst),
          new ButtonBuilder()
            .setCustomId(`affinity-page:prev:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1)
            .setEmoji(EMOJI.pagePrevious),
          new ButtonBuilder()
            .setCustomId(`affinity-page:next:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageNext),
          new ButtonBuilder()
            .setCustomId(`affinity-page:last:${callerId}:${targetId}:${page}:${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
            .setEmoji(EMOJI.pageLast),
        );
        container.addActionRowComponents(paginatorRow);
      }
    }

    return cv2Response(container, params.accentColor);
  }
}
