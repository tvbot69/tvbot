import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ExposedService } from '@bot/services/exposedService';
import { ExposedBuilders } from '@bot/builders/exposedBuilders';

@injectable()
export class ExposedSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ExposedService) private readonly exposedService: ExposedService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('exposed')
          .setDescription('Investigate a user and expose their secret guilty pleasure scrobbles in 4K')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Target user to expose').setRequired(false),
          ),
        executeAsync: (ctx) => this.exposedSlashAsync(ctx),
      },
    ];
  }

  private async exposedSlashAsync(context: ContextModel): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`/register\` command first.`,
      );
    }

    const targetOption = context.interaction?.isChatInputCommand()
      ? context.interaction.options.getUser('user')
      : null;

    let targetUser = callerUser;
    let displayName = context.discordDisplayName;
    let avatarUrl = context.interaction?.user.displayAvatarURL() ?? null;

    if (targetOption) {
      const found = await this.userService.getUserByDiscordId(targetOption.id);
      if (!found) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${targetOption.id}> has not connected their Last.fm account yet.`,
        );
      }
      targetUser = found;
      displayName = targetOption.displayName || targetOption.username;
      avatarUrl = targetOption.displayAvatarURL();
    }

    const report = await this.exposedService.generateReport(targetUser, displayName);
    if (!report) {
      return ExposedBuilders.buildCleanRecordResponse(displayName);
    }

    return ExposedBuilders.buildExposedResponse(report, avatarUrl);
  }
}
