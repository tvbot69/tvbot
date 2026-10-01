import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildAdminService } from '@bot/services/guildAdminService';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/system/colorService';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GuildAdminBuilders } from '@bot/builders/guildAdminBuilders';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { isProtectedCommandName } from '@bot/services/guild/protectedCommandNames';

@injectable()
export class GuildAdminSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(GuildService) private readonly guildService: GuildService,
    @inject(GuildAdminService) private readonly guildAdminService: GuildAdminService,
    @inject(UserService) private readonly userService: UserService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject(ColorService) private readonly colorService: ColorService,
    // Both writers were optional "so the existing 4- and 5-argument construction
    // sites keep compiling" — which is precisely how the channel-disable gate
    // came to be enforced on every message and yet never able to fire: the only
    // writer of '*' had no production caller, and the gate read a service that
    // could be absent. `startup.ts` constructs and registers both, so the tokens
    // are always bound. A writer that resolved to nothing must now fail loudly
    // at construction, not answer "disabled" and change nothing.
    @inject(ChannelToggledCommandService) private readonly channelToggledCommandService: ChannelToggledCommandService,
    @inject(DisabledChannelService) private readonly disabledChannelService: DisabledChannelService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('serversettings')
          .setDescription('View server configuration and crown dashboard')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => this.serverSettingsSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('members')
          .setDescription('View server members that have connected a Last.fm account')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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
          .setName('blocklist')
          .setDescription('Manage or view users blocked from Crowns and WhoKnows leaderboards in this server')
          .addSubcommand((sub) =>
            sub
              .setName('add')
              .setDescription('Block a member from Crowns and WhoKnows leaderboards')
              .addUserOption((opt) => opt.setName('user').setDescription('User to block').setRequired(true)),
          )
          .addSubcommand((sub) =>
            sub
              .setName('remove')
              .setDescription('Unblock a member from Crowns and WhoKnows leaderboards')
              .addUserOption((opt) => opt.setName('user').setDescription('User to unblock').setRequired(true)),
          )
          .addSubcommand((sub) =>
            sub
              .setName('list')
              .setDescription('List all users blocked from Crowns and WhoKnows in this server'),
          )
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const sub = ctx.interaction?.options.getSubcommand() || 'list';
          if (sub === 'add') {
            const user = ctx.interaction?.options.getUser('user', true);
            return this.setBlockSlashAsync(ctx, user?.id ?? '', true);
          }
          if (sub === 'remove') {
            const user = ctx.interaction?.options.getUser('user', true);
            return this.setBlockSlashAsync(ctx, user?.id ?? '', false);
          }
          return this.blockedUsersSlashAsync(ctx);
        },
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
      {
        data: new SlashCommandBuilder()
          .setName('channeltogglecommand')
          .setDescription('Turn one command off or on in this channel only')
          .addStringOption((opt) =>
            opt
              .setName('command')
              .setDescription('Name of the command to toggle, e.g. who')
              .setRequired(true),
          )
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const command = ctx.interaction?.options.getString('command', true) ?? '';
          return this.channelToggleCommandSlashAsync(ctx, command);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('disabledchannel')
          .setDescription('Turn all bot commands off or on in this channel')
          .addSubcommand((sub) =>
            sub
              .setName('disable')
              .setDescription('Turn every bot command off in this channel'),
          )
          .addSubcommand((sub) =>
            sub
              .setName('enable')
              .setDescription('Turn every bot command back on in this channel'),
          )
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        executeAsync: (ctx) => {
          const sub = ctx.interaction?.options.getSubcommand() || 'disable';
          return this.disabledChannelSlashAsync(ctx, sub !== 'enable');
        },
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

  private async serverSettingsSlashAsync(context: ContextModel): Promise<ResponseModel> {
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

  private async membersSlashAsync(context: ContextModel): Promise<ResponseModel> {
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

    const fetchedMembers = await context.guild.members.fetch().catch(() => null);
    const memberIds = Array.from((fetchedMembers ?? context.guild.members.cache).keys());

    // A failed fetch over an empty cache is an UNREADABLE member list - a
    // missing intent, a lost permission, a Discord outage. Reporting that as
    // "Scanned 0 total Discord members" states a fact about the server that
    // nobody measured, and the two counts beneath it (indexed, newly added)
    // fall out of that same unread list. So there is nothing to report.
    if (!fetchedMembers && memberIds.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        'Could not read the member list for this server, so there is nothing to refresh. Check that the bot has the Server Members Intent and permission to view members, then try again.',
      );
    }

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

    // `setDefaultMemberPermissions(ManageGuild)` at the builder is a client-side
    // convenience, not a security boundary. Every sibling re-checks here.
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to view the blocklist.',
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

  /**
   * Slash twin of the text `channeltogglecommand`. Same guards, same reply, same
   * reason the reply names the channel - the slash family exists so the feature
   * is not half-built across the two registries.
   */
  private async channelToggleCommandSlashAsync(context: ContextModel, rawCommand: string): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to toggle commands in this channel.',
      );
    }

    const channelId = context.channelId;
    if (!channelId) {
      return GenericEmbedService.buildWrongInputResponse(
        'Run this command in the channel you want to change; it has no channel to apply to here.',
      );
    }

    const commandName = rawCommand.trim().toLowerCase();
    if (!commandName) {
      return GenericEmbedService.buildWrongInputResponse('Please name the command to toggle in this channel.');
    }

    if (isProtectedCommandName(commandName)) {
      return GenericEmbedService.buildWrongInputResponse(`The command \`${commandName}\` cannot be disabled.`);
    }

    const nowDisabled = await this.channelToggledCommandService.toggleCommand(
      context.guildId,
      channelId,
      commandName,
    );

    return GenericEmbedService.buildSuccessResponse(
      nowDisabled
        ? `🔴 Command \`${commandName}\` has been **disabled** in <#${channelId}>.`
        : `🟢 Command \`${commandName}\` has been **enabled** in <#${channelId}>.`,
    );
  }

  private async disabledChannelSlashAsync(context: ContextModel, disable: boolean): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'This command can only be used in a server.',
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NoPermission,
        'You need the Manage Server permission to turn bot commands off in this channel.',
      );
    }

    const channelId = context.channelId;
    if (!channelId) {
      return GenericEmbedService.buildWrongInputResponse(
        'Run this command in the channel you want to change; it has no channel to apply to here.',
      );
    }

    await this.disabledChannelService.setChannelDisabled(context.guildId, channelId, disable);

    return GenericEmbedService.buildSuccessResponse(
      disable
        ? `🔴 Bot commands are now **disabled** in <#${channelId}>.`
        : `🟢 Bot commands are now **enabled** in <#${channelId}>.`,
    );
  }
}
