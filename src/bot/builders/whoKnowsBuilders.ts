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

export class WhoKnowsBuilders {
  public static buildWhoKnowsResponse(
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
  ): ResponseModel {
    const accentColor = context.accentColor;
    const requestedUserId = Number(context.discordUserId);

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

    if (users.length > 0) {
      const distinctUsers = users.filter((u, i, arr) => arr.findIndex((x) => x.userId === u.userId) === i);
      const totalListeners = distinctUsers.filter((u) => u.playcount > 0).length;
      const totalPlays = distinctUsers.reduce((sum, u) => sum + u.playcount, 0);
      const avgPlays = totalListeners > 0 ? Math.round(totalPlays / totalListeners) : 0;
      let typeLabel = 'Artist';
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes(' by ') && lowerTitle.includes(' in ')) typeLabel = 'Track';
      else if (url.includes('/music/') && url.split('/').length > 5) typeLabel = 'Album';
      const baseLine = `${typeLabel} - ${totalListeners} listener${totalListeners !== 1 ? 's' : ''} - ${totalPlays.toLocaleString()} play${totalPlays !== 1 ? 's' : ''}`;
      footerLines.push(totalListeners > 1 ? `${baseLine} - ${avgPlays.toLocaleString()} avg` : baseLine);
    }

    if (guildAlsoPlaying) {
      footerLines.push(guildAlsoPlaying);
    }

    const fullFooter = footerLines.join('\n');

    // === Pagination Mode (Components V2) ===
    if (mode === WhoKnowsMode.Pagination) {
      const pages = WhoKnowsService.generatePages(
        users,
        requestedUserId,
        closeFriendUserIds,
        10,
      );

      const response = new ResponseModel(accentColor);
      response.commandResponse = CommandResponse.Ok;

      const firstPage = pages[0]!;
      let pageContent = firstPage.lines;
      if (footerExtra) {
        pageContent += `\n\n${footerExtra}`;
      }
      const container = new ContainerBuilder().setAccentColor(accentColor);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(pageContent));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

      let footerText = `Page 1/${pages.length}`;
      if (fullFooter) {
        footerText += `\n-# ${fullFooter.replace(/\n/g, '\n-# ')}`;
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerText}`));

      if (pages.length > 1) {
        const prevBtn = new ButtonBuilder()
          .setCustomId('wk-page:prev:0')
          .setLabel('<')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);
        const nextBtn = new ButtonBuilder()
          .setCustomId('wk-page:next:0')
          .setLabel('>')
          .setStyle(ButtonStyle.Secondary);
        container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn));
      }

      response.setComponentsV2Container(container);
      return response;
    }

    // === Default Embed Mode ===
    const response = new ResponseModel(accentColor);
    response.commandResponse = CommandResponse.Ok;

    const listText = WhoKnowsService.whoKnowsListToString(
      users,
      requestedUserId,
      closeFriendUserIds,
    );

    let description = listText;
    if (footerExtra) {
      description += `\n\n${footerExtra}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(title.length > 255 ? `${title.slice(0, 252)}...` : title)
      .setURL(url)
      .setDescription(description);
    if (accentColor !== undefined && accentColor !== null) {
      embed.setColor(accentColor);
    }
    response.embed = embed;

    if (thumbnailUrl) {
      response.embed.setThumbnail(thumbnailUrl);
    }

    if (fullFooter) {
      response.embed.setFooter({ text: fullFooter });
    }

    return response;
  }
}
