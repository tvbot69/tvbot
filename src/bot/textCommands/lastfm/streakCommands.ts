import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
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
export class StreakCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(StreakService) private readonly streakService: StreakService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        name: 'streak',
        aliases: ['str', 'combo', 'cb'],
        executeAsync: (context, args) => this.streakAsync(context, args?.join(' ') ?? ''),
      },
      {
        name: 'streaks',
        aliases: ['strs', 'combos', 'cbs', 'streakhistory', 'combohistory', 'combolist', 'streaklist'],
        executeAsync: (context, args) => this.streakAsync(context, args?.join(' ') ?? ''),
      },
    ];
  }

  private async streakAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    let targetUser: User = callerUser;
    let displayName = context.member?.displayName ?? callerUser.userNameLastFm;
    const cleanOptions = rawOptions.trim();

    if (cleanOptions.length > 0) {
      // Check for @mention
      const mentionMatch = cleanOptions.match(/<@!?(\d+)>/);
      if (mentionMatch) {
        const mentionedDiscordId = mentionMatch[1]!;
        const mentioned = await this.userService.getUserByDiscordId(mentionedDiscordId);
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
            const member = await context.guild.members.fetch(mentionedDiscordId);
            if (member) displayName = member.displayName;
          } catch {
            displayName = mentioned.userNameLastFm;
          }
        }
      } else {
        // Check for lfm:username or username
        const lfmClean = cleanOptions.replace(/^lfm:/i, '').trim();
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
    }

    const targetDiscordId = targetUser.discordUserId ? targetUser.discordUserId.toString() : undefined;
    const accentColor = targetDiscordId
      ? (targetDiscordId === context.discordUserId ? context.accentColor : await this.colorService.getAccentColorAsync(targetDiscordId))
      : context.accentColor;

    const streak = await this.streakService.getCurrentStreak(targetUser.userId, targetUser.userNameLastFm);
    return StreakBuilders.buildStreakResponse(displayName, targetUser.userNameLastFm, streak, accentColor);
  }
}
