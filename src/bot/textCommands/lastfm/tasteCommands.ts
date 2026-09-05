import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { TasteService } from '@bot/services/tasteService';
import { TasteBuilders } from '@bot/builders/tasteBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

export class TasteCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly tasteService: TasteService,
    private readonly lastfmRepo: ILastfmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        name: 'taste',
        aliases: ['compare', 'compat'],
        executeAsync: (context, args) => this.tasteAsync(context, args),
      },
    ];
  }

  private async tasteAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    if (!args || args.length === 0) {
      return GenericEmbedService.buildWrongInputResponse(
        `Please mention a user or specify a Last.fm username to compare with:\n\`${context.prefix}taste @user\` or \`${context.prefix}taste username\``,
      );
    }

    const firstArg = args[0]!.trim();
    let targetDiscordId: string | null = null;
    let targetLastFmUsername: string | null = null;
    let targetDisplayName: string = firstArg;

    const mentionMatch = firstArg.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
      targetDiscordId = mentionMatch[1]!;
      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      targetLastFmUsername = targetUser.userNameLastFm;
      try {
        const member = await context.message?.guild?.members.fetch(targetDiscordId).catch(() => null);
        targetDisplayName = member?.displayName ?? targetUser.userNameLastFm;
      } catch {
        targetDisplayName = targetUser.userNameLastFm;
      }

      if (UpdateService.needsUpdate(targetUser, 2)) {
        void this.updateService.updateUser(targetUser.userId, { accurateTotal: true });
      }
    } else if (firstArg.toLowerCase().startsWith('lfm:')) {
      targetLastFmUsername = firstArg.slice(4).trim();
      targetDisplayName = targetLastFmUsername;
    } else {
      // Check if it's a registered user by username, or direct Last.fm username
      const possibleUser = await this.userService.getUserByLastFmName(firstArg);
      if (possibleUser) {
        targetDiscordId = possibleUser.discordUserId;
        targetLastFmUsername = possibleUser.userNameLastFm;
        try {
          const member = await context.message?.guild?.members.fetch(possibleUser.discordUserId).catch(() => null);
          targetDisplayName = member?.displayName ?? possibleUser.userNameLastFm;
        } catch {
          targetDisplayName = possibleUser.userNameLastFm;
        }
      } else {
        targetLastFmUsername = firstArg;
        targetDisplayName = firstArg;
      }
    }

    if (!targetLastFmUsername) {
      return GenericEmbedService.buildNotFoundResponse('Could not find that user.');
    }

    const callerDisplayName = context.message?.member?.displayName ?? caller.userNameLastFm;

    const tasteData = await this.tasteService.getTasteData(
      {
        discordUserId: caller.discordUserId,
        displayName: callerDisplayName,
        userNameLastFm: caller.userNameLastFm,
      },
      {
        discordUserId: targetDiscordId ?? '0',
        displayName: targetDisplayName,
        userNameLastFm: targetLastFmUsername,
      },
      'two-year',
    );

    return TasteBuilders.buildTasteResponse(tasteData, 0, 14, context.accentColor);
  }
}
