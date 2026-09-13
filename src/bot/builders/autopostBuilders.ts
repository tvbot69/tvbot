import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { AutopostConfig } from '@bot/services/autopostService';

export class AutopostBuilders {
  public static buildAutopostOverview(params: {
    guildName: string;
    autoposts: AutopostConfig[];
    prefix: string;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    const accent = params.accentColor ?? DiscordConstants.LastFmColorBlue;
    container.setAccentColor(accent);

    const titleText = `### ⏰ Scheduled Autoposts for **${params.guildName}**\n-# Automatically post server music recaps and crown leaderboards`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.autoposts.length === 0) {
      const emptyText = `No autoposts are currently set up for this server.\n\n**To add an autopost:**\n\`${params.prefix}autopost add <topartists|topalbums|toptracks|crowns> <daily|weekly|monthly> [#channel]\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(emptyText));
    } else {
      const lines = params.autoposts.map((ap) => {
        const status = ap.enabled ? '🟢 Active' : '⏸️ Paused';
        const lastPostedStr = ap.lastPosted
          ? `<t:${Math.floor(new Date(ap.lastPosted).getTime() / 1000)}:R>`
          : 'Never';
        return `**#${ap.id} • ${ap.contentType.replace('Top', 'Top ')}** (${ap.schedule})\n> Channel: <#${ap.channelId}>\n> Status: ${status} • Last posted: ${lastPostedStr}`;
      });

      const usageHelp = `\n-# Manage: \`${params.prefix}autopost toggle <id>\` • \`${params.prefix}autopost remove <id>\` • \`${params.prefix}autopost send <id>\``;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n') + usageHelp));
    }

    const response = new ResponseModel(accent);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
