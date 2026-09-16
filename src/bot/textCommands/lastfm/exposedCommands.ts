import { injectable, inject } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ExposedService } from '@bot/services/exposedService';
import { ExposedBuilders } from '@bot/builders/exposedBuilders';

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
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

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
