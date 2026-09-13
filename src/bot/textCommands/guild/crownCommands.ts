import { PermissionsBitField } from 'discord.js';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { CrownService } from '@bot/services/crown/crownService';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { UpdateService } from '@bot/services/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { ArtistsService } from '@bot/services/artistsService';

import { container } from 'tsyringe';
import { ColorService } from '@bot/services/colorService';
import { ArtworkService } from '@bot/services/artworkService';

export class CrownCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly crownService: CrownService,
    private readonly lastfmRepo: ILastfmRepository,
    private readonly artistsService: ArtistsService,
    private readonly updateService: UpdateService,
    private readonly colorService?: ColorService,
    private readonly artworkService?: ArtworkService,
  ) {
    this.commands = [
      {
        name: 'crowns',
        aliases: ['cw', 'crownlist', 'mycrowns'],
        executeAsync: (context, args) => this.crownsAsync(context, args),
      },
      {
        name: 'crown',
        aliases: ['c', 'artistcrown'],
        executeAsync: (context, args) => this.crownAsync(context, args),
      },
      {
        name: 'crownlb',
        aliases: ['cwlb', 'crownleaderboard', 'clb'],
        executeAsync: (context, args) => this.crownLbAsync(context, args),
      },
      {
        name: 'crownseed',
        executeAsync: (context, args) => this.crownSeedAsync(context, args),
      },
      {
        name: 'killcrown',
        aliases: ['kc', 'resetcrown'],
        executeAsync: (context, args) => this.killCrownAsync(context, args),
      },
      {
        name: 'removeusercrowns',
        aliases: ['removecrowns', 'deleteusercrowns'],
        executeAsync: (context, args) => this.removeUserCrownsAsync(context, args),
      },
      {
        name: 'crownblock',
        aliases: ['cwblock', 'blockcrowns'],
        executeAsync: (context, args) => this.crownBlockAsync(context, args, true),
      },
      {
        name: 'crownunblock',
        aliases: ['cwunblock', 'unblockcrowns'],
        executeAsync: (context, args) => this.crownBlockAsync(context, args, false),
      },
      {
        name: 'crownblockedusers',
        aliases: ['cwblocked', 'crownblocked'],
        executeAsync: (context) => this.crownBlockedUsersAsync(context),
      },
      {
        name: 'crownroles',
        aliases: ['setcrownrole', 'crownrole', 'cwrole', 'cwroles'],
        executeAsync: (context, args) => this.crownRolesAsync(context, args),
      },
      {
        name: 'killallcrowns',
        aliases: ['resetallcrowns'],
        executeAsync: (context, args) => this.killAllCrownsAsync(context, args),
      },
    ];
  }

  private async crownsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    let targetDiscordId = context.discordUserId;
    let targetUser = caller;
    let page = 1;

    for (const arg of args) {
      const trimmed = arg.trim();
      const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        targetDiscordId = mentionMatch[1]!;
        const other = await this.userService.getUserByDiscordId(targetDiscordId);
        if (other) {
          targetUser = other;
          if (UpdateService.needsUpdate(other, 2)) {
            void this.updateService.updateUser(other.userId, { accurateTotal: true });
          }
        }
      } else if (/^\d+$/.test(trimmed)) {
        page = Math.max(1, parseInt(trimmed, 10));
      } else {
        const other = await this.userService.getUserByLastFmName(trimmed);
        if (other) {
          targetDiscordId = other.discordUserId;
          targetUser = other;
          if (UpdateService.needsUpdate(other, 2)) {
            void this.updateService.updateUser(other.userId, { accurateTotal: true });
          }
        }
      }
    }

    const member = context.message?.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;

    const crowns = await this.crownService.getUserCrowns(context.guildId, targetUser.userId, 'Playcount');
    const topArtist = crowns[0]?.artistName;
    const artService = this.artworkService ?? container.resolve(ArtworkService);
    const colorService = this.colorService ?? container.resolve(ColorService);
    const imgUrl = topArtist ? await artService.getArtistImageUrl(topArtist) : null;
    const accentColor = await colorService.getColorFromImageUrl(imgUrl);

    return CrownBuilders.buildCrownsResponse(
      displayName,
      context.discordUserId,
      targetDiscordId,
      crowns,
      page,
      'Playcount',
      accentColor,
    );
  }

  public async crownAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    let artistName = '';
    let challengerDiscordId: string | null = null;
    let challengerUser = caller;

    // Parse arguments
    const remainingArgs: string[] = [];
    for (const arg of args) {
      const mentionMatch = arg.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        challengerDiscordId = mentionMatch[1]!;
        const other = await this.userService.getUserByDiscordId(challengerDiscordId);
        if (other) challengerUser = other;
      } else {
        remainingArgs.push(arg);
      }
    }

    artistName = remainingArgs.join(' ').trim();

    if (!artistName) {
      const recent = await this.lastfmRepo.getUserRecentTracks(caller.userNameLastFm, 1, 1, undefined, caller.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile. Specify an artist: `.crown <artist>`.');
      }
      artistName = recent[0]!.artistName;
    }

    // Artist info for resolved artist name
    const artistInfo = await this.artistsService.getArtistInfo(artistName, challengerUser.userNameLastFm);
    const resolvedName = artistInfo?.name ?? artistName;

    const [currentCrown, history] = await Promise.all([
      this.crownService.getCurrentCrown(context.guildId, resolvedName),
      this.crownService.getCrownHistory(context.guildId, resolvedName),
    ]);

    let holderDisplayName: string | undefined;
    if (currentCrown) {
      const holderMember = context.guild?.members.cache.get(currentCrown.discordUserId ?? '');
      holderDisplayName = holderMember?.displayName ?? currentCrown.userNameLastFm;
    }

    const challengerMember = context.guild?.members.cache.get(challengerUser.discordUserId);
    const challengerDisplayName = challengerMember?.displayName ?? challengerUser.userNameLastFm;

    let challengerPayload: { displayName: string; userNameLastFm: string; playcount: number } | null = null;
    if (artistInfo?.userPlayCount !== undefined) {
      challengerPayload = {
        displayName: challengerDisplayName,
        userNameLastFm: challengerUser.userNameLastFm,
        playcount: artistInfo.userPlayCount,
      };
    }

    const artService = this.artworkService ?? container.resolve(ArtworkService);
    const colorService = this.colorService ?? container.resolve(ColorService);
    const imgUrl = await artService.getArtistImageUrl(resolvedName);
    const accentColor = await colorService.getColorFromImageUrl(imgUrl);

    return CrownBuilders.buildCrownDuelResponse(
      resolvedName,
      currentCrown,
      holderDisplayName,
      challengerPayload,
      history,
      accentColor,
    );
  }

  private async crownLbAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    let page = 1;
    if (args.length > 0 && /^\d+$/.test(args[0]!.trim())) {
      page = Math.max(1, parseInt(args[0]!.trim(), 10));
    }

    const guildName = context.message?.guild?.name ?? 'Server';
    const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(context.guildId);

    for (const item of entries) {
      const m = context.message?.guild?.members.cache.get(item.discordUserId);
      if (m) item.displayName = m.displayName;
    }

    const guildIcon = context.message?.guild?.iconURL({ extension: 'png', size: 256 });
    const colorService = this.colorService ?? container.resolve(ColorService);
    const accentColor = await colorService.getColorFromImageUrl(guildIcon);

    return CrownBuilders.buildCrownLeaderboardResponse(
      guildName,
      entries,
      caller?.userId,
      page,
      totalActiveCrowns,
      accentColor,
    );
  }

  private async crownSeedAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    let minPlays = 30;
    if (args.length > 0 && /^\d+$/.test(args[0]!.trim())) {
      minPlays = Math.max(1, parseInt(args[0]!.trim(), 10));
    }

    const count = await this.crownService.seedCrowns(context.guildId, minPlays);
    return GenericEmbedService.buildSuccessResponse(
      `👑 Successfully seeded **${count.toLocaleString()}** crowns for this server (minimum **${minPlays} plays** threshold)!`,
    );
  }

  private async killCrownAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to kill crowns.');
    }

    const artistName = args.join(' ').trim();
    if (!artistName) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}killcrown <artist name>\``);
    }

    const killed = await this.crownService.killCrown(context.guildId, artistName);
    if (!killed) {
      return GenericEmbedService.buildNotFoundResponse(`No active crown was found for **${artistName}** in this server.`);
    }

    return GenericEmbedService.buildSuccessResponse(`👑 The crown for **${artistName}** has been revoked and reset.`);
  }

  private async removeUserCrownsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to remove crowns.');
    }

    const targetInput = args.join(' ').trim();
    if (!targetInput) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}removeusercrowns <@user|username>\``);
    }

    const mentionMatch = targetInput.match(/<@!?(\d+)>/) || targetInput.match(/^(\d+)$/);
    const targetUser = mentionMatch
      ? await this.userService.getUserByDiscordId(mentionMatch[1]!)
      : await this.userService.getUserByLastFmName(targetInput);

    if (!targetUser) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find a registered user matching **${targetInput}**.`);
    }

    const count = await this.crownService.removeUserCrowns(context.guildId, targetUser.userId);
    return GenericEmbedService.buildSuccessResponse(
      `👑 Removed **${count.toLocaleString()}** active crown(s) from **${targetUser.userNameLastFm}** in this server.`,
    );
  }

  private async crownBlockAsync(context: ContextModel, args: string[], block: boolean): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to block users from crowns.');
    }

    const targetInput = args.join(' ').trim();
    if (!targetInput) {
      return GenericEmbedService.buildWrongInputResponse(`Usage: \`${context.prefix}${block ? 'crownblock' : 'crownunblock'} <@user|username>\``);
    }

    const mentionMatch = targetInput.match(/<@!?(\d+)>/) || targetInput.match(/^(\d+)$/);
    const targetUser = mentionMatch
      ? await this.userService.getUserByDiscordId(mentionMatch[1]!)
      : await this.userService.getUserByLastFmName(targetInput);

    if (!targetUser) {
      return GenericEmbedService.buildNotFoundResponse(`Could not find a registered user matching **${targetInput}**.`);
    }

    await this.crownService.setCrownBlock(context.guildId, targetUser.userId, block);

    if (block) {
      return GenericEmbedService.buildSuccessResponse(
        `🚫 **${targetUser.userNameLastFm}** (<@${targetUser.discordUserId}>) is now **blocked** from earning crowns in this server. Any held crowns were revoked.`,
      );
    } else {
      return GenericEmbedService.buildSuccessResponse(
        `✅ **${targetUser.userNameLastFm}** (<@${targetUser.discordUserId}>) has been **unblocked** and can now earn crowns in this server again.`,
      );
    }
  }

  private async crownBlockedUsersAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const blocked = await this.crownService.getBlockedCrownUsers(context.guildId);
    if (blocked.length === 0) {
      return GenericEmbedService.buildSuccessResponse('No users are currently blocked from earning crowns in this server.');
    }

    const lines = blocked.map((u, i) => `${i + 1}. **${u.userNameLastFm}** (<@${u.discordUserId}>)`);
    return GenericEmbedService.buildCustomEmbedResponse(
      `🚫 Crown Blocked Users (${blocked.length})`,
      lines.join('\n'),
    );
  }

  private async crownRolesAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    if (args.length === 0) {
      const roles = await this.crownService.getCrownRoles(context.guildId);
      if (roles.length === 0) {
        return GenericEmbedService.buildCustomEmbedResponse(
          '👑 Crown Role Configuration',
          `No crown role is configured for this server.\n\nSet a crown role:\n\`${context.prefix}crownroles <@role|roleID>\``,
        );
      }
      return GenericEmbedService.buildCustomEmbedResponse(
        '👑 Crown Role Configuration',
        `Current crown role: <@&${roles[0]}>\n\nTo remove: \`${context.prefix}crownroles none\``,
      );
    }

    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to configure crown roles.');
    }

    const input = args[0]!.toLowerCase();
    if (input === 'none' || input === 'remove' || input === 'clear') {
      await this.crownService.setCrownRole(context.guildId, null);
      return GenericEmbedService.buildSuccessResponse('👑 Crown role has been removed.');
    }

    const roleMatch = args[0]!.match(/<@&(\d+)>/) || args[0]!.match(/^(\d+)$/);
    if (!roleMatch) {
      return GenericEmbedService.buildWrongInputResponse('Please mention a role or provide a valid role ID.');
    }

    const roleId = roleMatch[1]!;
    await this.crownService.setCrownRole(context.guildId, roleId);
    return GenericEmbedService.buildSuccessResponse(`👑 Crown role set to <@&${roleId}>!`);
  }

  private async killAllCrownsAsync(context: ContextModel, args: string[]): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to reset all crowns.');
    }

    if (args[0]?.toLowerCase() !== 'confirm') {
      return GenericEmbedService.buildWrongInputResponse(
        `⚠️ **Warning**: This will deactivate **ALL** crowns held in this server!\nTo proceed, run: \`${context.prefix}killallcrowns confirm\``,
      );
    }

    const count = await this.crownService.killAllCrowns(context.guildId);
    return GenericEmbedService.buildSuccessResponse(`👑 Reset complete. Revoked **${count.toLocaleString()}** crowns for this server.`);
  }
}
