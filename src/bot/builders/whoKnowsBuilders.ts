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










import { buildWhoKnowsImageResponse } from '@bot/builders/whoKnowsImageBuilder';
import { resolveWhoKnowsImageDeps } from '@bot/builders/whoKnowsImageDeps';
import { EMOJI } from '@bot/resources/emojis';

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
      // Genres go in here, not only in the default mode's `footerLines`. They used
      // to be pushed to `footerLines` alone, which nothing in this branch reads, so
      // pagination mode silently dropped a caller-supplied genre list while default
      // mode printed it — same data, two modes, one lying by omission. Capped at
      // five, matching the default-mode footer.
      if (genres && genres.length > 0) {
        extraFooterLines.push(genres.slice(0, 5).join(' - '));
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
          extraFooterLines.push(`Filtered: ${filterItems.join(', ')}`);
        }
      }
      if (guildAlsoPlaying) {
        extraFooterLines.push(guildAlsoPlaying);
      }

      const buildContainerForPage = (pageIdx: number): ContainerBuilder => {
        // `renderPage` is installed on the paginator session, so this is a
        // dynamic entry point: a stale session can hand us an index outside
        // `pages`. A non-null assertion here would throw on `page.lines` and
        // take the whole message down, so say the page is gone instead.
        const page = pages[pageIdx];
        if (!page) {
          const gone = new ContainerBuilder();
          gone.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
          gone.addTextDisplayComponents(
            new TextDisplayBuilder().setContent('This page of the leaderboard is no longer available.'),
          );
          return gone;
        }

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
          .setEmoji(EMOJI.pageFirst)
          .setDisabled(isFirst);

        const prevBtn = new ButtonBuilder()
          .setCustomId('component_paginator_previous')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(EMOJI.pagePrevious)
          .setDisabled(isFirst);

        const nextBtn = new ButtonBuilder()
          .setCustomId('component_paginator_next')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(EMOJI.pageNext)
          .setDisabled(isLast);

        const lastBtn = new ButtonBuilder()
          .setCustomId('component_paginator_last')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(EMOJI.pageLast)
          .setDisabled(isLast);

        const jumpBtn = new ButtonBuilder()
          .setCustomId('component_paginator_jump')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(EMOJI.pageGoto)
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

      response._paginatorSession = {
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
    // `EmbedBuilder.setDescription('')` throws, so an empty list would take the
    // whole card down instead of rendering it. Every current caller supplies a
    // non-empty list, but the guard is what makes that a fact rather than an
    // assumption.
    if (!description) {
      description = '*Nobody has played this yet.*';
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
