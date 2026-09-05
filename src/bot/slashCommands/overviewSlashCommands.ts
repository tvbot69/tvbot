import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { OverviewService } from '@bot/services/overviewService';
import { OverviewBuilders } from '@bot/builders/overviewBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateService } from '@bot/services/updateService';

import { ColorService } from '@bot/services/colorService';

export class OverviewSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];
  constructor(
    private readonly userService: UserService,
    private readonly overviewService: OverviewService,
    private readonly updateService: UpdateService,
    private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder().setName('overview').setDescription('Daily overview').addStringOption(o => o.setName('user').setDescription('User to show').setRequired(false)) as any,
        executeAsync: (ctx) => this.overviewAsync(ctx),
      },
    ];
  }

  private async overviewAsync(context: ContextModel): Promise<ResponseModel> {
    const rawUser = context.interaction?.options.getString('user') ?? null;
    let userNameLastFm: string;
    let displayName: string;
    let targetUserId: number | undefined;
    let targetUserObj: any = null;

    if (rawUser) {
      const mentionMatch = rawUser.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const u = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!u) return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered.`);
        userNameLastFm = u.userNameLastFm;
        displayName = context.guild?.members.cache.get(mentionMatch[1]!)?.displayName ?? u.userNameLastFm;
        targetUserId = u.userId;
        targetUserObj = u;
      } else {
        const lfm = rawUser.toLowerCase().startsWith('lfm:') ? rawUser.slice(4).trim() : rawUser;
        const info = await this.userService.getUserByLastFmName(lfm);
        if (info) {
          userNameLastFm = info.userNameLastFm;
          displayName = lfm;
          targetUserId = info.userId;
          targetUserObj = info;
        } else {
          const u = await this.userService.getUserByDiscordId(context.discordUserId);
          if (!u) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet.');
          userNameLastFm = u.userNameLastFm;
          displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? u.userNameLastFm;
          targetUserId = u.userId;
          targetUserObj = u;
        }
      }
    } else {
      const u = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!u) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet.');
      userNameLastFm = u.userNameLastFm;
      displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? u.userNameLastFm;
      targetUserId = u.userId;
      targetUserObj = u;
    }

    if (targetUserObj && targetUserId && UpdateService.needsUpdate(targetUserObj, 2)) {
      void this.updateService.updateUser(targetUserId, { accurateTotal: true });
    }

    const targetDiscordId = targetUserObj?.discordUserId ? String(targetUserObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (rawUser ? undefined : context.accentColor);

    const overview = await this.overviewService.getOverview(userNameLastFm);
    if (!overview || overview.dailyBlocks.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent plays found for overview.');
    return OverviewBuilders.buildOverviewResponse(userNameLastFm, displayName, 'Weekly', overview, 0, accentColor);
  }
}

