import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { buildSettingsPage } from '@bot/interactions/user/settingsInteractions';
import { UserSettingsBuilders } from '@bot/builders/user/userSettingsBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { PrefixService } from '@bot/services/user/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { UserService } from '@bot/services/user/userService';
import { GuildService } from '@bot/services/guild/guildService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ensureLinkedUser } from '@bot/handlers/commands/commandGuards';

@injectable()
export class SettingsCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService: ColorService,
    @inject(UserService) private readonly userService: UserService,
    @inject(GuildService) private readonly guildService: GuildService,
  ) {
    this.commands = [
      {
        name: 'settings',
        aliases: ['userconfig', 'usersettings', 'usersetting', 'setting', 'config', 'prefix'],
        executeAsync: (context) => this.settingsAsync(context),
      },
      {
        name: 'mode',
        aliases: ['md', 'customize'],
        executeAsync: (context) => this.modePickAsync(context),
      },
      {
        name: 'responsemode',
        aliases: ['wkmode', 'topmode', 'toplistmode'],
        executeAsync: (context) => this.responseModeAsync(context),
      },
      {
        name: 'covermode',
        aliases: ['covertype'],
        executeAsync: (context) => this.coverModeAsync(context),
      },
      {
        name: 'selfblock',
        aliases: ['hidefromserver'],
        executeAsync: (context) => this.selfBlockAsync(context, true),
      },
      {
        name: 'selfunblock',
        aliases: ['unhidefromserver'],
        executeAsync: (context) => this.selfBlockAsync(context, false),
      },
    ];
  }

  private async settingsAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    const accentColor = context.accentColor;

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
      accentColor,
    );
  }

  private async modePickAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildModePickResponse(context, context.accentColor);
  }

  private async responseModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildResponseModeResponse(context, user, context.accentColor);
  }

  private async coverModeAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;
    return UserSettingsBuilders.buildCoverModeResponse(context, user, context.accentColor);
  }

  private async selfBlockAsync(context: ContextModel, block: boolean): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'This command can only be used in a server.',
      );
    }

    const user = await ensureLinkedUser(this.userService, context.discordUserId, { prefix: context.prefix });
    if ('commandResponse' in user) return user;

    const success = block
      ? await this.guildService.selfBlockGuildUserAsync(context.guildId, user.userId)
      : await this.guildService.selfUnblockGuildUserAsync(context.guildId, user.userId);

    if (!success) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Something went wrong while updating your selfblock status.',
      );
    }

    const guildName = context.message?.guild?.name ?? 'this server';
    const prefix = await this.prefixService.getPrefix(context.guildId);
    return UserSettingsBuilders.buildSelfBlockResponse(guildName, block, prefix, context.accentColor);
  }
}
