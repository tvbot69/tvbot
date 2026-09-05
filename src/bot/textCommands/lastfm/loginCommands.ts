import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { LoginService, LoginStatus } from '@bot/services/loginService';
import { UserService } from '@bot/services/userService';
import { ComponentInteractionTracker } from '@bot/services/componentInteractionTracker';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';

const linkRow = (
  url: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  row.addComponents(
    new ButtonBuilder()
      .setLabel('Connect Last.fm')
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
  return row;
};

const confirmRow = (
  discordUserId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`login-confirm:${discordUserId}`)
      .setLabel('Confirm session')
      .setStyle(ButtonStyle.Primary),
  );
  return row;
};

export class LoginCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  private readonly loginService: LoginService;
  private readonly userService: UserService;
  private readonly componentTracker: ComponentInteractionTracker;

  constructor(
    loginService: LoginService,
    userService: UserService,
    componentTracker: ComponentInteractionTracker,
  ) {
    this.loginService = loginService;
    this.userService = userService;
    this.componentTracker = componentTracker;

    this.commands = [
      {
        name: 'login',
        aliases: ['connect'],
        executeAsync: (context, _args) => this.loginAsync(context),
      },
      {
        name: 'logout',
        aliases: ['disconnect'],
        executeAsync: (context, _args) => this.logoutAsync(context),
      },
    ];
  }

  private registerConfirmHandler(discordUserId: string): void {
    void this.componentTracker.register(
      `login-confirm:${discordUserId}`,
      async (interaction) => {
        if (interaction.user.id !== discordUserId) {
          try {
            await interaction.reply({ content: 'This login session belongs to someone else.', ephemeral: true });
          } catch { /* ignore Unknown interaction */ }
          return;
        }
        // Defer immediately — must ack within 3s or Discord returns 10062 Unknown interaction
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch (err: any) {
          // 10062 = Unknown interaction (expired / already acked) — don't spam ERROR
          if (err?.code === 10062 || String(err?.message).includes('Unknown interaction')) return;
          throw err;
        }

        const result = await this.loginService.confirmLogin(discordUserId);

        try {
          if (result.status === LoginStatus.Success) {
            await interaction.editReply(
              `Connected as **${result.userName}**! Your library is now being fully indexed in the background - this can take a few minutes.`,
            );
            return;
          }
          if (result.status === LoginStatus.NoPendingLogin) {
            await interaction.editReply('This login link expired. Run the login command again.');
            return;
          }
          await interaction.editReply(
            'Last.fm does not show an authorized session yet. Did you click **Allow access** on their page? Wait a few seconds and try Confirm again.',
          );
        } catch (err: any) {
          if (err?.code === 10062 || String(err?.message).includes('Unknown interaction')) return;
          throw err;
        }
      },
      3300000,
    );
  }

  private async loginAsync(context: ContextModel): Promise<ResponseModel> {
    const existingUser = await this.userService.getUserByDiscordId(context.discordUserId);

    const authUrl = await this.loginService.startLogin(context.discordUserId);
    if (!authUrl) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Could not reach Last.fm to start the login flow. Try again in a moment.',
      );
    }

    this.registerConfirmHandler(context.discordUserId);

    const response = new ResponseModel(context.accentColor);
    const intro = existingUser
      ? `You are currently connected as **${existingUser.userNameLastFm}**.\n\nClick **Connect Last.fm** to reconnect or switch accounts, then press **Confirm session**.`
      : 'Connecting takes less than a minute:\n1. Click **Connect Last.fm** and authorize on Last.fm\n2. Come back and press **Confirm session**\n\nYour library will be fully indexed in the background after connecting.';
    response.embed.setDescription(intro);
    response.addButtonRow(1, linkRow(authUrl));
    response.addButtonRow(2, confirmRow(context.discordUserId));
    return response;
  }

  private async logoutAsync(context: ContextModel): Promise<ResponseModel> {
    const loggedOut = await this.loginService.logout(context.discordUserId);
    if (!loggedOut) {
      return GenericEmbedService.buildNotFoundResponse('You are not registered with the bot.');
    }

    const response = new ResponseModel(context.accentColor);
    response.embed.setDescription('Your Last.fm session has been disconnected from the bot.');
    return response;
  }
}
