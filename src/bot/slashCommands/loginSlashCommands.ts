import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import { type ISlashCommandModule } from '@bot/models/commandModels';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { LoginService, LoginStatus } from '@bot/services/loginService';
import { UserService } from '@bot/services/userService';
import { ComponentInteractionTracker } from '@bot/services/componentInteractionTracker';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';

const buildLoginResponse = (
  authUrl: string,
  discordUserId: string,
  existingUserName: string | null,
  accentColor?: number,
): ResponseModel => {
  const response = new ResponseModel(accentColor);

  const intro = existingUserName
    ? `You are currently connected as **[${existingUserName}](https://www.last.fm/user/${existingUserName})**.\n\nClick below to reconnect or switch accounts.`
    : 'Connecting takes less than a minute:\n\n1. Click **Connect Last.fm** and authorize on Last.fm\n2. Come back here and press **Confirm session**\n\nYour library will be fully indexed in the background after connecting.';

  response.embed.setDescription(intro);
  response.addButtonRow(1, linkRow(authUrl));
  response.addButtonRow(
    2,
    confirmRow(discordUserId),
  );
  return response;
};

const linkRow = (url: string): ActionRowBuilder<MessageActionRowComponentBuilder> => {
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

export class LoginSlashCommands implements ISlashCommandModule {
  public commands: ISlashCommandModule['commands'];

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

    const data = new SlashCommandBuilder()
      .setName('login')
      .setDescription('Gives you a link to connect your Last.fm account to the bot');

    const logout = new SlashCommandBuilder()
      .setName('logout')
      .setDescription('Disconnects your Last.fm session from the bot');

    this.commands = [
      {
        data: data,
        executeAsync: (context) => this.loginAsync(context),
        ephemeral: true,
      },
      {
        data: logout,
        executeAsync: (context) => this.logoutAsync(context),
        ephemeral: true,
      },
    ];
  }

  private registerConfirmHandler(discordUserId: string): void {
    void this.componentTracker.register(
      `login-confirm:${discordUserId}`,
      async (interaction) => {
        if (interaction.user.id !== discordUserId) {
          await interaction.reply({
            content: 'This login session belongs to someone else.',
            ephemeral: true,
          });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const result = await this.loginService.confirmLogin(discordUserId);

        if (result.status === LoginStatus.Success) {
          await interaction.editReply(
            `Connected as **${result.userName}**! Your library is now being fully indexed in the background - this can take a few minutes.`,
          );
          return;
        }
        if (result.status === LoginStatus.NoPendingLogin) {
          await interaction.editReply('This login link expired. Run `/login` again.');
          return;
        }
        await interaction.editReply(
          'Last.fm does not show an authorized session yet. Did you click **Allow access** on their page? Wait a few seconds and try Confirm again.',
        );
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

    return buildLoginResponse(
      authUrl,
      context.discordUserId,
      existingUser?.userNameLastFm ?? null,
      context.accentColor,
    );
  }

  private async logoutAsync(context: ContextModel): Promise<ResponseModel> {
    const loggedOut = await this.loginService.logout(context.discordUserId);
    if (!loggedOut) {
      return GenericEmbedService.buildNotFoundResponse('You are not registered with the bot.');
    }

    const response = new ResponseModel(context.accentColor);
    response.embed.setDescription(
      'Your Last.fm session has been disconnected from the bot.',
    );
    return response;
  }
}
