import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { StreakService } from '@bot/services/streakService';
import { StreakBuilders } from '@bot/builders/streakBuilders';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { User } from '@domain/interfaces/iuserRepository';

@injectable()
export class StreakSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(StreakService) private readonly streakService: StreakService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('streak')
          .setDescription("Shows you or someone else's current listening streak.")
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Discord user to check streak for').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('username').setDescription('Last.fm username to check streak for').setRequired(false),
          ),
        executeAsync: (context) => {
          const targetUser = context.interaction?.options.getUser('user');
          const targetUsername = context.interaction?.options.getString('username');
          return this.streakSlashAsync(context, targetUser?.id, targetUsername ?? undefined);
        },
      },
    ];
  }

  private async streakSlashAsync(
    context: ContextModel,
    targetDiscordUserId?: string,
    targetUsername?: string,
  ): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    let targetUser: User = callerUser;
    let displayName = context.member?.displayName ?? callerUser.userNameLastFm;

    if (targetDiscordUserId && targetDiscordUserId !== context.discordUserId) {
      const mentioned = await this.userService.getUserByDiscordId(targetDiscordUserId);
      if (!mentioned) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.WrongInput,
          'That user is not registered in tvbot.',
        );
      }
      targetUser = mentioned;
      displayName = mentioned.userNameLastFm;
      if (context.guild) {
        try {
          const member = await context.guild.members.fetch(targetDiscordUserId);
          if (member) displayName = member.displayName;
        } catch {
          displayName = mentioned.userNameLastFm;
        }
      }
    } else if (targetUsername) {
      const lfmClean = targetUsername.replace(/^lfm:/i, '').trim();
      const existing = await this.userService.getUserByLastFmName(lfmClean);
      if (existing) {
        targetUser = existing;
        displayName = existing.userNameLastFm;
        if (context.guild && existing.discordUserId) {
          try {
            const member = await context.guild.members.fetch(existing.discordUserId.toString());
            if (member) displayName = member.displayName;
          } catch {
            displayName = existing.userNameLastFm;
          }
        }
      } else {
        targetUser = {
          ...callerUser,
          userId: 0,
          userNameLastFm: lfmClean,
          discordUserId: undefined,
        } as unknown as User;
        displayName = lfmClean;
      }
    }

    const targetDiscordId = targetUser.discordUserId ? targetUser.discordUserId.toString() : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    const streak = await this.streakService.getCurrentStreak(
      targetUser.userId,
      targetUser.userNameLastFm,
      targetUser.sessionKey,
    );
    return StreakBuilders.buildStreakResponse(displayName, targetUser.userNameLastFm, streak, accentColor);
  }
}
