import { injectable, inject } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ExposedService } from '@bot/services/social/exposedService';
import { ExposedBuilders } from '@bot/builders/social/exposedBuilders';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

@injectable()
export class ExposedCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ExposedService) private readonly exposedService: ExposedService,
  ) {
    this.commands = [
      {
        name: 'exposed',
        aliases: ['caughtin4k', 'c4k', 'guiltypleasures', 'guiltypleasure', 'expose'],
        executeAsync: (ctx, args) => this.exposedAsync(ctx, args?.join(' ') ?? ''),
      },
    ];
  }

  public async exposedAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const callerUser = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in callerUser) return callerUser;

    let targetUser = callerUser;
    let displayName = context.discordDisplayName;
    let avatarUrl = context.message?.author?.displayAvatarURL() ?? null;

    const mentionMatch = rawOptions.match(/<@!?(\d+)>/);
    if (mentionMatch && mentionMatch[1]) {
      const targetDiscordId = mentionMatch[1];
      const foundTarget = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!foundTarget) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${targetDiscordId}> has not connected their Last.fm account yet.`,
        );
      }
      targetUser = foundTarget;

      // Try fetching target guild member for accurate display name & avatar
      if (context.guild) {
        try {
          const member = await context.guild.members.fetch(targetDiscordId);
          displayName = member.displayName;
          avatarUrl = member.user.displayAvatarURL();
        } catch {
          displayName = targetUser.userNameLastFm;
        }
      } else {
        displayName = targetUser.userNameLastFm;
      }
    }

    const report = await this.exposedService.generateReport(targetUser, displayName);
    if (!report) {
      return ExposedBuilders.buildCleanRecordResponse(displayName);
    }

    return ExposedBuilders.buildExposedResponse(report, avatarUrl);
  }
}
