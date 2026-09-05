import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { ProfileService } from '@bot/services/profileService';
import { ProfileBuilders } from '@bot/builders/profileBuilders';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { User } from '@domain/interfaces/iuserRepository';

@injectable()
export class ProfileCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(ProfileService) private readonly profileService: ProfileService,
    @inject(ColorService) private readonly colorService: ColorService,
  ) {
    this.commands = [
      {
        name: 'profile',
        aliases: ['stats', 'user'],
        executeAsync: (context, args) => this.profileAsync(context, args?.join(' ') ?? ''),
      },
    ];
  }

  private async profileAsync(context: ContextModel, rawOptions: string): Promise<ResponseModel> {
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

    const stats = await this.profileService.getProfileStats(displayName, targetUser, accentColor);
    if (!stats) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Could not load this profile due to a Last.fm error, please try again later.',
      );
    }

    return ProfileBuilders.buildProfileResponse(stats, context.discordUserId);
  }
}
