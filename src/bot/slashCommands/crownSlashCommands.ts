import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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

export class CrownSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly crownService: CrownService,
    private readonly lastfmRepo: ILastfmRepository,
    private readonly artistsService: ArtistsService,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('crowns')
          .setDescription('Displays your or another user\'s crowns in this server')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User whose crowns you want to view').setRequired(false),
          )
          .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.crownsAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crown')
          .setDescription('Shows the crown holder and stats for an artist in this server')
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User to duel or compare with').setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.crownAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crownlb')
          .setDescription('Shows the crown leaderboard for this server')
          .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.crownLbAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crownseed')
          .setDescription('Seeds crowns for this server based on existing indexed plays (Admin)')
          .addIntegerOption((opt) =>
            opt.setName('min_plays').setDescription('Minimum playcount threshold (default: 30)').setMinValue(1).setRequired(false),
          ) as any,
        executeAsync: (ctx) => this.crownSeedAsync(ctx),
      },
    ];
  }

  private async crownsAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    const targetUserOpt = context.interaction?.options.getUser('user');
    const targetDiscordId = targetUserOpt?.id ?? context.discordUserId;
    const targetUser = targetUserOpt
      ? await this.userService.getUserByDiscordId(targetDiscordId)
      : caller;

    if (!targetUser) {
      return GenericEmbedService.buildNotFoundResponse('That user has not registered with the bot yet.');
    }

    if (targetUser.userId !== caller.userId && UpdateService.needsUpdate(targetUser, 2)) {
      void this.updateService.updateUser(targetUser.userId, { accurateTotal: true });
    }

    const page = Math.max(1, context.interaction?.options.getInteger('page') ?? 1);
    const member = context.guild?.members.cache.get(targetDiscordId);
    const displayName = member?.displayName ?? targetUser.userNameLastFm;

    const crowns = await this.crownService.getUserCrowns(context.guildId, targetUser.userId, 'Playcount');

    return CrownBuilders.buildCrownsResponse(
      displayName,
      context.discordUserId,
      targetDiscordId,
      crowns,
      page,
      'Playcount',
      context.accentColor,
    );
  }

  private async crownAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use `/register` first.',
      );
    }

    if (UpdateService.needsUpdate(caller, 2)) {
      void this.updateService.updateUser(caller.userId, { accurateTotal: true });
    }

    let artistName = context.interaction?.options.getString('artist')?.trim();
    const challengerOpt = context.interaction?.options.getUser('user');
    let challengerUser = caller;

    if (challengerOpt) {
      const other = await this.userService.getUserByDiscordId(challengerOpt.id);
      if (other) challengerUser = other;
    }

    if (!artistName) {
      const recent = await this.lastfmRepo.getUserRecentTracks(caller.userNameLastFm, 1, 1, undefined, caller.sessionKey);
      if (!recent || recent.length === 0) {
        return GenericEmbedService.buildNotFoundResponse('No recent tracks found on your Last.fm profile. Specify an artist: `/crown artist:<name>`.');
      }
      artistName = recent[0]!.artistName;
    }

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

    return CrownBuilders.buildCrownDuelResponse(
      resolvedName,
      currentCrown,
      holderDisplayName,
      challengerPayload,
      history,
      context.accentColor,
    );
  }

  private async crownLbAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    const page = Math.max(1, context.interaction?.options.getInteger('page') ?? 1);
    const guildName = context.guild?.name ?? 'Server';

    const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(context.guildId);

    for (const item of entries) {
      const m = context.guild?.members.cache.get(item.discordUserId);
      if (m) item.displayName = m.displayName;
    }

    return CrownBuilders.buildCrownLeaderboardResponse(
      guildName,
      entries,
      caller?.userId,
      page,
      totalActiveCrowns,
      context.accentColor,
    );
  }

  private async crownSeedAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }

    const minPlays = context.interaction?.options.getInteger('min_plays') ?? 30;
    const count = await this.crownService.seedCrowns(context.guildId, minPlays);

    return GenericEmbedService.buildSuccessResponse(
      `👑 Successfully seeded **${count.toLocaleString()}** crowns for this server (minimum **${minPlays} plays** threshold)!`,
    );
  }
}
