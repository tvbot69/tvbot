import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { ProfileService } from '@bot/services/user/profileService';
import { ProfileBuilders } from '@bot/builders/user/profileBuilders';
import { ColorService } from '@bot/services/system/colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

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
    const callerUser = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in callerUser) return callerUser;

    let targetUser: User = callerUser;
    let displayName = context.member?.displayName ?? callerUser.userNameLastFm;
    const cleanOptions = rawOptions.trim();

    if (cleanOptions.length > 0) {
      // Check for @mention or raw Discord ID snowflake
      const mentionMatch = cleanOptions.match(/<@!?(\d+)>/);
      const isDiscordSnowflake = !mentionMatch && /^\d{17,20}$/.test(cleanOptions);
      const discordUserId = mentionMatch ? mentionMatch[1] : (isDiscordSnowflake ? cleanOptions : null);

      if (discordUserId) {
        const mentioned = await this.userService.getUserByDiscordId(discordUserId);
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
            const member = await context.guild.members.fetch(discordUserId);
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
            discordUserId: '',
          } as User;
          displayName = lfmClean;
        }
      }
    }

    const stats = await this.profileService.getProfileStats(displayName, targetUser);
    if (!stats) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Could not load this profile due to a Last.fm error, please try again later.',
      );
    }

    let accentColor = await this.colorService.getColorFromImageUrl(stats.lastFmUser.imageUrl);
    if (accentColor === DiscordConstants.LastFmColorRed && targetUser.discordUserId) {
      // CORRECT AS IS, the twin of `profileSlashCommands.profileAsync` and for
      // the same reason: an ACCENT COLOUR, already holding the Last.fm red
      // fallback. A missing avatar costs the border colour on this card and no
      // figure on it - `getProfileStats` has already returned, and its own
      // degraded reads are documented at their sites.
      try {
        const discordUser = await context.message?.client.users.fetch(targetUser.discordUserId.toString());
        const avatarUrl = discordUser?.displayAvatarURL({ size: 256 });
        if (avatarUrl) {
          accentColor = await this.colorService.getColorFromImageUrl(avatarUrl);
        }
      } catch {
        // Fallback
      }
    }
    stats.accentColor = accentColor;

    return ProfileBuilders.buildProfileResponse(stats, context.discordUserId);
  }
}
