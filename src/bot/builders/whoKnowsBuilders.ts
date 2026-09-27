import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import type { WhoKnowsUser, FilterStats } from '@bot/models/whoKnowsModels';
import { DiscordConstants } from '@bot/resources/discordConstants';










import { buildWhoKnowsImageResponse } from './whoKnowsImageBuilder';
import { resolveWhoKnowsImageDeps } from './whoKnowsImageDeps';

export class WhoKnowsBuilders {
  public static async buildWhoKnowsResponse(
    context: ContextModel,
    title: string,
    url: string,
    thumbnailUrl: string | null | undefined,
    users: WhoKnowsUser[],
    filterStats?: FilterStats,
    guildAlsoPlaying?: string | null,
    genres?: string[],
    closeFriendUserIds?: Set<number>,
    mode: WhoKnowsMode = WhoKnowsMode.Default,
    footerExtra?: string,
    mediaType?: 'Artist' | 'Track' | 'Album',
    accentColor?: number,
    metadata?: {
      globalPlays?: number;
      globalListeners?: number;
      topItemLabel?: string;
      topItemValue?: string;
      topItemExtra?: string;
      topTracks?: string[];
    },
  ): Promise<ResponseModel> {
    const resolvedAccent = accentColor ?? DiscordConstants.LastFmColorRed;
    const caller = users.find((u) => u.discordUserId === context.discordUserId);
    const requestedUserId = caller?.userId ?? 0;

    // Build footer lines — match fmbot style: genres line + "Artist/Track/Album - X listeners - Y plays - Z avg"
    const footerLines: string[] = [];
    if (genres && genres.length > 0) {
      footerLines.push(genres.slice(0, 5).join(' - '));
    }

    if (filterStats) {
      const filterItems: string[] = [];
      if (filterStats.blockedFiltered && filterStats.blockedFiltered > 0) {
        filterItems.push(`${filterStats.blockedFiltered} blocked`);
      }
      if (filterStats.activityThresholdFiltered && filterStats.activityThresholdFiltered > 0) {
        filterItems.push(`${filterStats.activityThresholdFiltered} inactive`);
      }
      if (filterItems.length > 0) {
        footerLines.push(`Filtered: ${filterItems.join(', ')}`);
      }
    }

    const distinctUsers = users.filter((u, i, arr) => arr.findIndex((x) => x.userId === u.userId) === i);
    const totalListeners = distinctUsers.filter((u) => u.playcount > 0).length;
    const totalPlays = distinctUsers.reduce((sum, u) => sum + u.playcount, 0);
    const avgPlays = totalListeners > 0 ? Math.floor(totalPlays / totalListeners) : 0;

    let type = mediaType;
    if (!type) {
      if (url.includes('/_/')) {
        type = 'Track';
      } else if (url.includes('/music/')) {
        const afterMusic = url.split('/music/')[1]?.split('?')[0]?.replace(/\/$/, '') || '';
        const parts = afterMusic.split('/').filter(Boolean);
        type = parts.length >= 2 ? 'Album' : 'Artist';
      } else {
        type = title.toLowerCase().includes(' by ') ? 'Track' : 'Artist';
      }
    }

    const listenersWord = totalListeners === 1 ? 'listener' : 'listeners';
    const playsWord = totalPlays === 1 ? 'play' : 'plays';
    const baseLine = `${type} - ${totalListeners} ${listenersWord} - ${totalPlays.toLocaleString()} ${playsWord}`;
    footerLines.push(totalListeners > 1 ? `${baseLine} - ${avgPlays.toLocaleString()} avg` : baseLine);

    if (guildAlsoPlaying) {
      footerLines.push(guildAlsoPlaying);
    }

    const fullFooter = footerLines.join('\n');

    // === Image Mode ===
    if (mode === WhoKnowsMode.Image) {
      // Dependencies are resolved once, here, and passed in. The builder no
      // longer reaches into the container, which is what makes it testable.
      const image = await buildWhoKnowsImageResponse(
        {
          context,
          title,
          url,
          thumbnailUrl,
          users,
          genres,
          resolvedAccent,
          type,
          requestedUserId,
          footerExtra,
          metadata,
        },
        resolveWhoKnowsImageDeps(),
      );
      if (image) return image;
    }

    // === Pagination Mode (Components V2) ===
    if (mode === WhoKnowsMode.Pagination) {
      const pages = WhoKnowsService.generatePages(
        users,
        requestedUserId,
        closeFriendUserIds,
        10,
        context.discordUserId,
      );

      const response = new ResponseModel();
      response.commandResponse = CommandResponse.Ok;

      const statsLine = totalListeners > 1
        ? `${baseLine} - ${avgPlays.toLocaleString()} avg`
        : baseLine;

      const extraFooterLines: string[] = [];
      if (filterStats) {
        const filterItems: string[] = [];
        if (filterStats.blockedFiltered && filterStats.blockedFiltered > 0) {
          filterItems.push(`${filterStats.blockedFiltered} blocked`);
        }
        if (filterStats.activityThresholdFiltered && filterStats.activityThresholdFiltered > 0) {
          filterItems.push(`${filterStats.activityThresholdFiltered} inactive`);
        }
        if (filterItems.length > 0) {
          extraFooterLines.push(`Filtered: ${filterItems.join(', ')}`);
        }
      }
      if (guildAlsoPlaying) {
        extraFooterLines.push(guildAlsoPlaying);
      }

      const buildContainerForPage = (pageIdx: number): ContainerBuilder => {
        const container = new ContainerBuilder();

        // 0: Header (clean plain text title, no link, no section/thumbnail accessory)
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`### ${title}`)
        );

        // 1: Separator
        container.addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

        // 2: Leaderboard content
        const page = pages[pageIdx]!;
        let pageContent = page.lines;
        if (pageIdx === 0 && footerExtra) {
          pageContent += `\n\n${footerExtra}`;
        }
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(pageContent)
        );

        // 3: Separator
        container.addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

        // 4: Footer
        const footerParts = [
          `-# Page ${pageIdx + 1}/${pages.length}`,
          `-# ${statsLine}`,
        ];
        for (const line of extraFooterLines) {
          footerParts.push(`-# ${line}`);
        }
        footerParts.push("-# Spotify not tracking properly? Check '.outofsync'");
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(footerParts.join('\n'))
        );

        // 5: Action Row with 5 pagination buttons
        const isOnePage = pages.length <= 1;
        const isFirst = isOnePage || pageIdx === 0;
        const isLast = isOnePage || pageIdx === pages.length - 1;

        const firstBtn = new ButtonBuilder()
          .setCustomId('component_paginator_first')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji({ id: '883825508633182208', name: 'pages_first' })
          .setDisabled(isFirst);

        const prevBtn = new ButtonBuilder()
          .setCustomId('component_paginator_previous')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji({ id: '883825508507336704', name: 'pages_previous' })
          .setDisabled(isFirst);

        const nextBtn = new ButtonBuilder()
          .setCustomId('component_paginator_next')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji({ id: '883825508087922739', name: 'pages_next' })
          .setDisabled(isLast);

        const lastBtn = new ButtonBuilder()
          .setCustomId('component_paginator_last')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji({ id: '883825508482183258', name: 'pages_last' })
          .setDisabled(isLast);

        const jumpBtn = new ButtonBuilder()
          .setCustomId('component_paginator_jump')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji({ id: '1138849626234036264', name: 'pages_goto' })
          .setDisabled(isOnePage);

        container.addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            firstBtn,
            prevBtn,
            nextBtn,
            lastBtn,
            jumpBtn,
          )
        );

        return container;
      };

      const initialContainer = buildContainerForPage(0);
      response.setComponentsV2Container(initialContainer);

      (response as any)._paginatorSession = {
        currentPage: 0,
        totalPages: pages.length,
        renderPage: (pageIdx: number) => buildContainerForPage(pageIdx),
        authorDiscordId: context.discordUserId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      return response;
    }

    // === Default Mode (Standard Discord Rich Embed) ===
    const response = new ResponseModel(resolvedAccent);
    response.commandResponse = CommandResponse.Ok;

    const listText = WhoKnowsService.whoKnowsListToString(
      users,
      requestedUserId,
      closeFriendUserIds,
      context.discordUserId,
    );

    let description = listText;
    if (footerExtra) {
      description += `\n\n${footerExtra}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(title.length > 255 ? `${title.slice(0, 252)}...` : title)
      .setURL(url)
      .setDescription(description);

    embed.setColor(resolvedAccent);

    if (thumbnailUrl) {
      embed.setThumbnail(thumbnailUrl);
    }

    if (fullFooter) {
      embed.setFooter({ text: fullFooter });
    }

    response.embed = embed;
    return response;
  }
}
