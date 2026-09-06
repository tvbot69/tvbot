import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { Guild } from '@persistence/domain/models/guild';
import type {
  GuildMemberOverviewItem,
  RefreshResult,
} from '@bot/services/guildAdminService';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';

export class GuildAdminBuilders {
  public static buildGuildDashboard(params: {
    guild: Guild;
    prefix: string;
    blockedCount: number;
    memberCount: number;
    accentColor?: number | null;
  }): ResponseModel {
    const { guild } = params;
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? guild.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### ⚙️ Server Configuration for **${guild.guildName}**\n-# Server settings and crown management dashboard`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const crownStatus = guild.crownsDisabled ? '🔴 **Disabled**' : '🟢 **Enabled**';
    const crownThreshold = guild.crownsMinimumPlaycountThreshold ?? 30;
    const crownActivity = guild.crownsActivityThresholdDays ? `${guild.crownsActivityThresholdDays} days` : 'No expiration';

    const sections = [
      `**⚙️ General**\n> • Prefix: \`${params.prefix}\`\n> • Accent Color: \`${guild.accentColor ? `#${guild.accentColor.toString(16)}` : 'Default Red'}\`\n> • Commands: ${guild.commandsDisabled ? '🔴 Disabled' : '🟢 Enabled'}`,
      `**👑 Crowns Configuration**\n> • Status: ${crownStatus}\n> • Minimum Playcount Threshold: **${crownThreshold} plays**\n> • Activity Expiration: **${crownActivity}**`,
      `**👥 Server Members**\n> • Indexed Last.fm Members: **${params.memberCount.toLocaleString()}**\n> • Blocked from Crowns & WhoKnows: **${params.blockedCount.toLocaleString()}**`,
    ];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(sections.join('\n\n')));

    const response = new ResponseModel(params.accentColor ?? guild.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildMembersOverviewResponse(params: {
    guildName: string;
    members: GuildMemberOverviewItem[];
    page?: number;
    pageSize?: number;
    accentColor?: number | null;
  }): ResponseModel {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = params.pageSize ?? 12;
    const totalPages = Math.max(1, Math.ceil(params.members.length / pageSize));
    const startIndex = (page - 1) * pageSize;
    const currentItems = params.members.slice(startIndex, startIndex + pageSize);

    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### 👥 Last.fm Members in **${params.guildName}** (${params.members.length.toLocaleString()} total)\n-# Ranked by total Last.fm scrobbles`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.members.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '*No indexed Last.fm members found in this server. Run `.refreshmembers` to index server members.*',
        ),
      );
    } else {
      const lines = currentItems.map((m, idx) => {
        const rank = startIndex + idx + 1;
        const userUrl = `https://www.last.fm/user/${encodeURIComponent(m.userNameLastFm)}`;
        const crownsStr = m.crownsCount > 0 ? ` · 👑 **${m.crownsCount}** crowns` : '';
        const blockedStr = m.whoKnowsBanned ? ' *(🚫 Blocked)*' : '';
        return `${rank}. <@${m.discordUserId}> (**[${m.userNameLastFm}](${userUrl})**) — **${m.totalPlayCount.toLocaleString()}** plays${crownsStr}${blockedStr}`;
      });

      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

      if (totalPages > 1) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# Page ${page} of ${totalPages} • Total: ${params.members.length} members`),
        );
      }
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildBlockedUsersResponse(params: {
    guildName: string;
    blocked: FullGuildUserDetails[];
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### 🚫 Blocked Users in **${params.guildName}** (${params.blocked.length.toLocaleString()} total)\n-# Users excluded from Crowns and WhoKnows leaderboards`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    if (params.blocked.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('*No users are currently blocked in this server.*'),
      );
    } else {
      const lines = params.blocked.map((u, idx) => {
        const userUrl = `https://www.last.fm/user/${encodeURIComponent(u.userNameLastFm)}`;
        return `${idx + 1}. <@${u.discordUserId}> (**[${u.userNameLastFm}](${userUrl})**)`;
      });
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildRefreshResultResponse(params: {
    guildName: string;
    result: RefreshResult;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const titleText = `### 🔄 Server Members Refreshed for **${params.guildName}**`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(titleText));
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

    const content =
      `• **${params.result.indexedCount.toLocaleString()}** registered Last.fm accounts linked to this server\n` +
      `• **${params.result.newlyAddedCount.toLocaleString()}** newly discovered accounts indexed\n` +
      `• Scanned **${params.result.totalServerMembers.toLocaleString()}** total Discord members in the server cache`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildBlockSuccessResponse(params: {
    discordUserId: string;
    userNameLastFm: string;
    blocked: boolean;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const statusStr = params.blocked
      ? `🚫 Successfully blocked <@${params.discordUserId}> (\`${params.userNameLastFm}\`) from Crowns and WhoKnows rankings in this server.`
      : `✅ Successfully unblocked <@${params.discordUserId}> (\`${params.userNameLastFm}\`). They can now participate in Crowns and WhoKnows rankings.`;

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusStr));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }

  public static buildCrownSettingSuccessResponse(params: {
    settingName: string;
    value: string | number;
    accentColor?: number | null;
  }): ResponseModel {
    const container = new ContainerBuilder();
    container.setAccentColor(params.accentColor ?? DiscordConstants.LastFmColorRed);

    const content = `👑 Successfully updated **${params.settingName}** to **${params.value}**!`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

    const response = new ResponseModel(params.accentColor ?? DiscordConstants.LastFmColorRed);
    response.commandResponse = CommandResponse.Ok;
    response.setComponentsV2Container(container);
    return response;
  }
}
