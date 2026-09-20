import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildAdminService } from '@bot/services/guildAdminService';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GuildAdminBuilders } from '@bot/builders/guildAdminBuilders';

import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';

@injectable()
export class GuildAdminCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(GuildService) private readonly guildService: GuildService,
    @inject(GuildAdminService) private readonly guildAdminService: GuildAdminService,
    @inject(UserService) private readonly userService: UserService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(GuildDisabledCommandService) private readonly guildDisabledCommandService: GuildDisabledCommandService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'serversettings',
        aliases: ['ss', 'configuration', 'config', 'serverconfig'],
        executeAsync: (ctx) => this.serverSettingsAsync(ctx),
      },
      {
        name: 'members',
        aliases: ['mb', 'users', 'memberoverview', 'mo'],
        executeAsync: (ctx) => this.membersAsync(ctx),
      },
      {
        name: 'refreshmembers',
        aliases: ['index', 'refresh', 'cachemembers'],
        executeAsync: (ctx) => this.refreshMembersAsync(ctx),
      },
      {
        name: 'block',
        executeAsync: (ctx, args) => this.setBlockAsync(ctx, args.join(' '), true),
      },
      {
        name: 'unblock',
        executeAsync: (ctx, args) => this.setBlockAsync(ctx, args.join(' '), false),
      },
      {
        name: 'blockedusers',
        aliases: ['blocked', 'guildblocked'],
        executeAsync: (ctx) => this.blockedUsersAsync(ctx),
      },
      {
        name: 'crownthreshold',
        aliases: ['setcrownthreshold', 'cwthreshold'],
        executeAsync: (ctx, args) => this.crownThresholdAsync(ctx, args.join(' ')),
      },
      {
        name: 'crownactivitythreshold',
        aliases: ['cwactivitythreshold'],
        executeAsync: (ctx, args) => this.crownActivityThresholdAsync(ctx, args.join(' ')),
      },
      {
        name: 'togglecrowns',
        aliases: ['disablecrowns', 'enablecrowns'],
        executeAsync: (ctx) => this.toggleCrownsAsync(ctx),
      },
      {
        name: 'prefix',
        aliases: ['setprefix'],
        executeAsync: (ctx, args) => this.prefixAsync(ctx, args.join(' ')),
      },
      {
        name: 'togglecommand',
        aliases: ['toggleservercommand', 'togglecmd'],
        executeAsync: (ctx, args) => this.toggleCommandAsync(ctx, args.join(' ')),
      },
      {
        name: 'disabledcommands',
        aliases: ['serverdisabledcommands', 'listdisabledcommands'],
        executeAsync: (ctx) => this.disabledCommandsAsync(ctx),
      },
    ];
  }

  private requireGuildAdmin(context: ContextModel): ResponseModel | null {
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to view server admin info.',
      );
    }
    return null;
  }

  private async serverSettingsAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const adminBlock = this.requireGuildAdmin(context);
    if (adminBlock) return adminBlock;

    const guild = await this.guildService.getGuild(context.guildId);
    if (!guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'Server not found in the database.',
      );
    }

    const prefix = await this.prefixService.getPrefix(context.guildId);
    const members = await this.guildAdminService.getMembersOverview(context.guildId);
    const blocked = await this.guildAdminService.getBlockedUsers(context.guildId);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildGuildDashboard({
      guild,
      prefix,
      memberCount: members.length,
      blockedCount: blocked.length,
      accentColor,
    });
  }

  private async membersAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const adminBlock = this.requireGuildAdmin(context);
    if (adminBlock) return adminBlock;

    const guildName = context.guild?.name || 'this server';
    const members = await this.guildAdminService.getMembersOverview(context.guildId);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildMembersOverviewResponse({
      guildName,
      members,
      accentColor,
    });
  }

  private async refreshMembersAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId || !context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to refresh members.',
      );
    }

    const members = await context.guild.members.fetch().catch(() => context.guild?.members.cache);
    const memberIds = members ? Array.from(members.keys()) : [];

    const result = await this.guildAdminService.refreshGuildMembers(context.guildId, memberIds);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildRefreshResultResponse({
      guildName: context.guild.name,
      result,
      accentColor,
    });
  }

  private async setBlockAsync(
    context: ContextModel,
    rawOptions: string,
    blocked: boolean,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        `You need the Manage Server permission to ${blocked ? 'block' : 'unblock'} users.`,
      );
    }

    const clean = rawOptions.trim();
    const mentionMatch = clean.match(/<@!?(\d+)>/);
    let targetDiscordId = mentionMatch ? mentionMatch[1] : null;

    if (!targetDiscordId && /^\d+$/.test(clean)) {
      targetDiscordId = clean;
    }

    if (!targetDiscordId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        `Please mention a user or specify their Discord ID to ${blocked ? 'block' : 'unblock'}.`,
      );
    }

    const targetUser = await this.userService.getUserByDiscordId(targetDiscordId);
    if (!targetUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'That user has not connected their Last.fm account with the bot.',
      );
    }

    await this.guildAdminService.setBlockUser(context.guildId, targetUser.userId, blocked);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildBlockSuccessResponse({
      discordUserId: targetDiscordId,
      userNameLastFm: targetUser.userNameLastFm,
      blocked,
      accentColor,
    });
  }

  private async blockedUsersAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const adminBlock = this.requireGuildAdmin(context);
    if (adminBlock) return adminBlock;

    const guildName = context.guild?.name || 'this server';
    const blocked = await this.guildAdminService.getBlockedUsers(context.guildId);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildBlockedUsersResponse({
      guildName,
      blocked,
      accentColor,
    });
  }

  private async crownThresholdAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to change crown settings.',
      );
    }

    const threshold = parseInt(rawOptions.trim(), 10);
    if (isNaN(threshold) || threshold < 1 || threshold > 100000) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.WrongInput,
        'Please provide a valid threshold number between 1 and 100,000.',
      );
    }

    await this.guildAdminService.setCrownThreshold(context.guildId, threshold);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildCrownSettingSuccessResponse({
      settingName: 'Minimum Crown Playcount Threshold',
      value: `${threshold.toLocaleString()} plays`,
      accentColor,
    });
  }

  private async crownActivityThresholdAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to change crown settings.',
      );
    }

    const clean = rawOptions.trim().toLowerCase();
    let days: number | null = null;
    if (clean !== '0' && clean !== 'none' && clean !== 'off' && clean !== 'disable') {
      days = parseInt(clean, 10);
      if (isNaN(days) || days < 1 || days > 3650) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.WrongInput,
          'Please provide a valid number of days between 1 and 3650, or "none" to disable inactivity expiration.',
        );
      }
    }

    await this.guildAdminService.setCrownActivityThreshold(context.guildId, days);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildCrownSettingSuccessResponse({
      settingName: 'Crown Activity Expiration Threshold',
      value: days ? `${days} days` : 'Disabled (no expiration)',
      accentColor,
    });
  }

  private async toggleCrownsAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to change crown settings.',
      );
    }

    const guild = await this.guildService.getGuild(context.guildId);
    const newDisabled = !guild?.crownsDisabled;

    await this.guildAdminService.toggleCrowns(context.guildId, newDisabled);

    const accentColor = context.guildId
      ? await this.colorService?.getAccentColorAsync(context.guildId)
      : undefined;

    return GuildAdminBuilders.buildCrownSettingSuccessResponse({
      settingName: 'Crowns Feature',
      value: newDisabled ? 'Disabled' : 'Enabled',
      accentColor,
    });
  }

  private async prefixAsync(context: ContextModel, newPrefix: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const currentPrefix = await this.prefixService.getPrefix(context.guildId);
    const trimmed = newPrefix.trim();

    if (!trimmed) {
      return GenericEmbedService.buildCustomEmbedResponse(
        '⚙️ Server Prefix',
        `The current server prefix is \`${currentPrefix}\`.\n\nTo change it: \`${currentPrefix}prefix <newPrefix>\``,
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to change the server prefix.',
      );
    }

    if (trimmed.length > 10) {
      return GenericEmbedService.buildWrongInputResponse('The prefix must be 10 characters or less.');
    }

    await this.prefixService.setPrefix(context.guildId, trimmed);
    return GenericEmbedService.buildSuccessResponse(`✅ Server prefix has been updated to \`${trimmed}\`!`);
  }

  private async toggleCommandAsync(context: ContextModel, rawCommand: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to toggle server commands.',
      );
    }

    const commandName = rawCommand.trim().toLowerCase();
    if (!commandName) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}togglecommand <commandName>\``);
    }

    if (['serversettings', 'togglecommand', 'prefix', 'settings'].includes(commandName)) {
      return GenericEmbedService.buildWrongInputResponse(`The command \`${commandName}\` cannot be disabled.`);
    }

    const isCurrentlyDisabled = await this.guildDisabledCommandService.isCommandDisabled(context.guildId, commandName);
    if (isCurrentlyDisabled) {
      await this.guildDisabledCommandService.removeDisabledCommand(context.guildId, commandName);
      return GenericEmbedService.buildSuccessResponse(`🟢 Command \`${commandName}\` has been **enabled** for this server.`);
    } else {
      await this.guildDisabledCommandService.addDisabledCommand(context.guildId, commandName);
      return GenericEmbedService.buildSuccessResponse(`🔴 Command \`${commandName}\` has been **disabled** for this server.`);
    }
  }

  private async disabledCommandsAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    const disabled = await this.guildDisabledCommandService.getDisabledCommands(context.guildId);
    if (disabled.length === 0) {
      return GenericEmbedService.buildSuccessResponse('No commands are currently disabled in this server.');
    }

    return GenericEmbedService.buildCustomEmbedResponse(
      `🚫 Disabled Commands (${disabled.length})`,
      disabled.map((c) => `• \`${c}\``).join('\n'),
    );
  }
}
