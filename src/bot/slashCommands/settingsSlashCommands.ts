import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type {
  ISlashCommandModule,
  SlashCommandData,
  SlashCommandDefinition,
} from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { buildSettingsPage } from '@bot/interactions/settingsInteractions';
import { UserSettingsBuilders } from '@bot/builders/userSettingsBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { UserService } from '@bot/services/userService';
import { CommandResponse } from '@domain/enums/commandResponse';

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
          .setDescription('Configure your timezone and number format in tvbot')
          .addStringOption((opt) =>
            opt
              .setName('timezone')
              .setDescription('Your timezone (e.g. Europe/London, America/New_York, UTC)')
              .setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('numberformat')
              .setDescription('Number formatting style')
              .setRequired(false)
              .addChoices(
                { name: 'Comma (1,234,567)', value: 'comma' },
                { name: 'Period (1.234.567)', value: 'period' },
                { name: 'Space (1 234 567)', value: 'space' },
              ),
          ) as SlashCommandData,
        executeAsync: (context) => this.localizationAsync(context),
      },
    ];
  }

  private async settingsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      if (context.userIsGuildAdmin) {
        return buildSettingsPage(context, this.prefixService);
      }
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` or `.login` first.',
      );
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
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` or `.login` first.',
      );
    }
    return UserSettingsBuilders.buildModePickResponse(context, context.accentColor);
  }

  private async responseModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` or `.login` first.',
      );
    }
    return UserSettingsBuilders.buildResponseModeResponse(context, user, context.accentColor);
  }

  private async coverModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` or `.login` first.',
      );
    }
    return UserSettingsBuilders.buildCoverModeResponse(context, user, context.accentColor);
  }

  private async localizationAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not registered with tvbot yet. Use `/login` or `.login` first.',
      );
    }

    const tzOption = context.interaction?.isChatInputCommand()
      ? context.interaction.options.getString('timezone')
      : null;
    const nfOption = context.interaction?.isChatInputCommand()
      ? context.interaction.options.getString('numberformat')
      : null;

    if (!tzOption && !nfOption) {
      return UserSettingsBuilders.buildLocalizationResponse(context, user, context.accentColor);
    }

    const updates: string[] = [];
    if (tzOption) {
      const resolved = await this.userService.setTimeZone(user.userId, tzOption);
      updates.push(`Timezone updated to \`${resolved}\``);
    }
    if (nfOption) {
      const resolvedNf = await this.userService.setNumberFormat(user.userId, nfOption);
      updates.push(`Number format updated to \`${resolvedNf}\``);
    }

    return GenericEmbedService.buildSuccessResponse(
      `### Localization Updated\n${updates.join('\n')}`,
    );
  }
}
