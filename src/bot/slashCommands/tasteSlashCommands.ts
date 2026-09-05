import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { TasteService } from '@bot/services/tasteService';
import { TasteBuilders } from '@bot/builders/tasteBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';

export class TasteSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly tasteService: TasteService,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('taste')
          .setDescription('Compares music taste between two users')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Discord user to compare with').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('username').setDescription('Last.fm username to compare with').setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.tasteAsync(ctx),
      },
    ];
  }

  private async tasteAsync(context: ContextModel): Promise<ResponseModel> {
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    const targetUserOpt = context.interaction?.options.getUser('user');
    const targetUsernameOpt = context.interaction?.options.getString('username')?.trim();

    if (!targetUserOpt && !targetUsernameOpt) {
      return GenericEmbedService.buildWrongInputResponse('Please specify either a Discord user or a Last.fm username to compare with.');
    }

    let targetDiscordId: string | null = null;
    let targetLastFmUsername: string | null = null;
    let targetDisplayName: string = '';

    if (targetUserOpt) {
      targetDiscordId = targetUserOpt.id;
      const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
      if (!targetUser) {
        return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
      }
      targetLastFmUsername = targetUser.userNameLastFm;
      targetDisplayName = context.guild?.members.cache.get(targetDiscordId)?.displayName ?? targetUserOpt.username;

      if (UpdateService.needsUpdate(targetUser, 2)) {
        void this.updateService.updateUser(targetUser.userId, { accurateTotal: true });
      }
    } else if (targetUsernameOpt) {
      const possibleUser = await this.userService.getUserByLastFmName(targetUsernameOpt);
      if (possibleUser) {
        targetDiscordId = possibleUser.discordUserId;
        targetLastFmUsername = possibleUser.userNameLastFm;
        targetDisplayName = context.guild?.members.cache.get(possibleUser.discordUserId)?.displayName ?? possibleUser.userNameLastFm;
      } else {
        targetLastFmUsername = targetUsernameOpt;
        targetDisplayName = targetUsernameOpt;
      }
    }

    if (!targetLastFmUsername) {
      return GenericEmbedService.buildNotFoundResponse('Could not resolve user to compare with.');
    }

    const callerDisplayName = context.member?.displayName ?? caller.userNameLastFm;

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
