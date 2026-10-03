import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type {
  ISlashCommandModule,
  SlashCommandData,
  SlashCommandDefinition,
} from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { buildSettingsPage } from '@bot/interactions/user/settingsInteractions';
import { UserSettingsBuilders } from '@bot/builders/user/userSettingsBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { PrefixService } from '@bot/services/user/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { UserService } from '@bot/services/user/userService';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

@injectable()
export class SettingsSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject(UserService) private readonly userService: UserService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('settings')
          .setDescription('Your user settings and server configuration in tvbot') as SlashCommandData,
        executeAsync: (context) => this.settingsAsync(context),
      },
      {
        data: new SlashCommandBuilder()
          .setName('mode')
          .setDescription('Quickly customize your .fm mode, response mode, or cover type') as SlashCommandData,
        executeAsync: (context) => this.modeAsync(context),
      },
      {
        data: new SlashCommandBuilder()
          .setName('responsemode')
          .setDescription('Change your default WhoKnows and top list modes') as SlashCommandData,
        executeAsync: (context) => this.responseModeAsync(context),
      },
      {
        data: new SlashCommandBuilder()
          .setName('covermode')
          .setDescription('Set whether album covers animate or always show as still') as SlashCommandData,
        executeAsync: (context) => this.coverModeAsync(context),
      },
      {
        data: new SlashCommandBuilder()
          .setName('localization')
          .setDescription('Configure your timezone in tvbot')
          .addStringOption((opt) =>
            opt
              .setName('timezone')
              .setDescription('Your timezone (e.g. Europe/London, America/New_York, UTC)')
              .setRequired(false),
          ) as SlashCommandData,
        executeAsync: (context) => this.localizationAsync(context),
      },
    ];
  }

  private async settingsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) {
      if (context.userIsGuildAdmin) {
        return buildSettingsPage(context, this.prefixService);
      }
      return user;
    }

    return UserSettingsBuilders.buildUserSettingsResponse(
      context,
      user,
      context.userIsGuildAdmin,
      'user',
      context.accentColor,
    );
  }

  private async modeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildModePickResponse(context, context.accentColor);
  }

  private async responseModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildResponseModeResponse(context, user, context.accentColor);
  }

  private async coverModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildCoverModeResponse(context, user, context.accentColor);
  }

  private async localizationAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { slash: true });
    if ('commandResponse' in user) return user;

    const tzOption = context.interaction?.isChatInputCommand()
      ? context.interaction.options.getString('timezone')
      : null;

    if (!tzOption) {
      return UserSettingsBuilders.buildLocalizationResponse(context, user, context.accentColor);
    }

    const resolved = await this.userService.setTimeZone(user.userId, tzOption);

    return GenericEmbedService.buildSuccessResponse(
      `### Timezone Updated\nTimezone updated to \`${resolved}\``,
    );
  }
}
