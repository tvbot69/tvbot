import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { OverviewService } from '@bot/services/overviewService';
import { OverviewBuilders } from '@bot/builders/overviewBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateService } from '@bot/services/updateService';

import { ColorService } from '@bot/services/colorService';

export class OverviewCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];
  constructor(
    private readonly userService: UserService,
    private readonly overviewService: OverviewService,
    private readonly updateService: UpdateService,
    private readonly colorService?: ColorService,
  ) {
    this.commands = [
      { name: 'overview', aliases: ['o', 'ov'], executeAsync: (ctx, args) => this.overviewAsync(ctx, args.join(' ')) },
    ];
  }

  private async overviewAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const userStr = raw.trim();
    let userNameLastFm: string;
    let displayName: string;
    let targetUserId: number | undefined;
    let targetUserObj: any = null;

    if (userStr) {
      const mentionMatch = userStr.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const u = await this.userService.getUserByDiscordId(mentionMatch[1]!);
        if (!u) return GenericEmbedService.buildNotFoundResponse(`<@${mentionMatch[1]}> is not registered.`);
        userNameLastFm = u.userNameLastFm;
        displayName = context.guild?.members.cache.get(mentionMatch[1]!)?.displayName ?? u.userNameLastFm;
        targetUserId = u.userId;
        targetUserObj = u;
      } else {
        const lfm = userStr.toLowerCase().startsWith('lfm:') ? userStr.slice(4).trim().split(/\s+/)[0]! : userStr;
        const byLfm = await this.userService.getUserByLastFmName(lfm);
        if (byLfm) {
          userNameLastFm = byLfm.userNameLastFm;
          displayName = lfm;
          targetUserId = byLfm.userId;
          targetUserObj = byLfm;
        } else {
          const self = await this.userService.getUserByDiscordId(context.discordUserId);
          if (!self) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet.');
          userNameLastFm = self.userNameLastFm;
          displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? self.userNameLastFm;
          targetUserId = self.userId;
          targetUserObj = self;
        }
      }
    } else {
      const self = await this.userService.getUserByDiscordId(context.discordUserId);
      if (!self) return GenericEmbedService.buildCommandErrorResponse(CommandResponse.NotFound, 'You have not connected your Last.fm account yet.');
      userNameLastFm = self.userNameLastFm;
      displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? self.userNameLastFm;
      targetUserId = self.userId;
      targetUserObj = self;
    }

    // Sync newest scrobbles live from Last.fm to database if stale
    if (targetUserObj && targetUserId && UpdateService.needsUpdate(targetUserObj, 2)) {
      void this.updateService.updateUser(targetUserId, { accurateTotal: true });
    }

    const targetDiscordId = targetUserObj?.discordUserId ? String(targetUserObj.discordUserId) : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService?.getAccentColorAsync(targetDiscordId))
      : (userStr ? undefined : context.accentColor);

    const overview = await this.overviewService.getOverview(userNameLastFm);
    if (!overview || overview.dailyBlocks.length === 0) return GenericEmbedService.buildNotFoundResponse('No recent plays found for overview.');
    return OverviewBuilders.buildOverviewResponse(userNameLastFm, displayName, 'Weekly', overview, 0, accentColor);
  }
}

