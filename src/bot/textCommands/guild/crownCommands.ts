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

export class CrownCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly crownService: CrownService,
    private readonly lastfmRepo: ILastfmRepository,
    private readonly artistsService: ArtistsService,
    private readonly updateService: UpdateService,
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

    return CrownBuilders.buildCrownDuelResponse(
      resolvedName,
      currentCrown,
      holderDisplayName,
      challengerPayload,
      history,
      context.accentColor,
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

    return CrownBuilders.buildCrownLeaderboardResponse(
      guildName,
      entries,
      caller?.userId,
      page,
      totalActiveCrowns,
      context.accentColor,
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
}
