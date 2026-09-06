import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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

@injectable()
export class GuildAdminSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(GuildService) private readonly guildService: GuildService,
    @inject(GuildAdminService) private readonly guildAdminService: GuildAdminService,
    @inject(UserService) private readonly userService: UserService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('serversettings')
          .setDescription('View server configuration and crown dashboard'),
        executeAsync: (ctx) => this.serverSettingsSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('members')
          .setDescription('View server members that have connected a Last.fm account'),
        executeAsync: (ctx) => this.membersSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('refreshmembers')
          .setDescription('Re-indexes and synchronizes Discord server members into the bot cache')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => this.refreshMembersSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('block')
          .setDescription('Block a member from Crowns and WhoKnows leaderboards in this server')
          .addUserOption((opt) => opt.setName('user').setDescription('User to block').setRequired(true))
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const user = ctx.interaction?.options.getUser('user', true);
          return this.setBlockSlashAsync(ctx, user?.id ?? '', true);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('unblock')
          .setDescription('Unblock a member from Crowns and WhoKnows leaderboards in this server')
          .addUserOption((opt) => opt.setName('user').setDescription('User to unblock').setRequired(true))
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const user = ctx.interaction?.options.getUser('user', true);
          return this.setBlockSlashAsync(ctx, user?.id ?? '', false);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('blockedusers')
          .setDescription('List all users blocked from Crowns and WhoKnows in this server'),
        executeAsync: (ctx) => this.blockedUsersSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crownthreshold')
          .setDescription('Set the minimum playcount required to claim a crown in this server')
          .addIntegerOption((opt) =>
            opt
              .setName('threshold')
              .setDescription('Minimum playcount threshold (1 - 100,000)')
              .setMinValue(1)
              .setMaxValue(100000)
              .setRequired(true),
          )
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const threshold = ctx.interaction?.options.getInteger('threshold', true) ?? 30;
          return this.crownThresholdSlashAsync(ctx, threshold);
        },
      },
    ];
  }

  private async serverSettingsSlashAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

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

  private async membersSlashAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

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

  private async refreshMembersSlashAsync(context: ContextModel): Promise<ResponseModel> {
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

  private async setBlockSlashAsync(
    context: ContextModel,
    targetDiscordId: string,
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

  private async blockedUsersSlashAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

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

  private async crownThresholdSlashAsync(
    context: ContextModel,
    threshold: number,
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
}
