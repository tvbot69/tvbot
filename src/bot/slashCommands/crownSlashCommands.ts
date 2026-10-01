import { SlashCommandBuilder } from 'discord.js';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { CrownService } from '@bot/services/crown/crownService';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { ArtistsService } from '@bot/services/library/artistsService';

import { container } from 'tsyringe';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';

export class CrownSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

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
        data: new SlashCommandBuilder()
          .setName('crowns')
          .setDescription('Displays your or another user\'s crowns in this server')
          .addUserOption((opt) =>
            opt.setName('user').setDescription('User whose crowns you want to view').setRequired(false),
          )
          .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
          ) as SlashCommandBuilder,
        executeAsync: (ctx) => this.crownsAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crown')
          .setDescription('Shows the crown holder and stats for an artist in this server')
          .addStringOption((opt) =>
            opt.setName('artist').setDescription('Artist name (defaults to currently playing)').setRequired(false),
          )
          .addUserOption((opt) =>
            opt.setName('user').setDescription('Compare with a specific user').setRequired(false),
          ) as SlashCommandBuilder,
        executeAsync: (ctx) => this.crownAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crownlb')
          .setDescription('Leaderboard of top crown holders in this server')
          .addIntegerOption((opt) =>
            opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
          ) as SlashCommandBuilder,
        executeAsync: (ctx) => this.crownLbAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('crownseed')
          .setDescription('Admin command to seed/refresh crowns for this server')
          .addIntegerOption((opt) =>
            opt.setName('min_plays').setDescription('Minimum playcount threshold (default 30)').setMinValue(1).setRequired(false),
          ) as SlashCommandBuilder,
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

    let targetDiscordId = context.discordUserId;
    let targetUser = caller;

    const userOpt = context.interaction?.options.getUser('user');
    if (userOpt) {
      const other = await this.userService.getUserByDiscordId(userOpt.id);
      if (!other) {
        // There is no `else` here any more. `targetDiscordId` had already been
        // overwritten with the stranger's id while `targetUser` stayed the
        // caller, so the card was the caller's crowns under the caller's own
        // name with a STRANGER's id in every pagination `customId` — rows true,
        // buttons wrong, and no error anywhere. `intelligenceSlashCommands
        // .resolveTarget` refuses the identical case in the identical shape,
        // which is what makes this a defect rather than a policy; the same
        // builder and the same `CommandResponse.NotFound` are used here so the
        // two twins cannot drift apart again.
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${userOpt.id}> hasn't connected their Last.fm account yet.`,
        );
      }
      targetDiscordId = userOpt.id;
      targetUser = other;
      if (UpdateService.needsUpdate(other, 2)) {
        void this.updateService.updateUser(other.userId, { accurateTotal: true });
      }
    }

    const page = Math.max(1, context.interaction?.options.getInteger('page') ?? 1);
    const member = context.guild?.members.cache.get(targetDiscordId);
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
      // THE SAME DEFECT, the branch the `/crowns` fix above used to share: a
      // named challenger who has not registered was silently dropped and the
      // card compared the artist against the CALLER's playcount, printing a gap
      // nobody asked for. Left in, it is the third instance of a bug class that
      // is already been fixed twice in this repo, so it goes the same way.
      if (!other) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${challengerOpt.id}> hasn't connected their Last.fm account yet.`,
        );
      }
      challengerUser = other;
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

    const guildIcon = context.guild?.iconURL({ extension: 'png', size: 256 });
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

  private async crownSeedAsync(context: ContextModel): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildWrongInputResponse('This command can only be used in a server.');
    }
    // The description on this command has always said "Admin command", and the
    // repository behind it DELETEs every seeded crown for the guild before
    // re-inserting, so the gate has to be real. The text twin
    // (`.crownseed` in textCommands/guild/crownCommands.ts) is gated the same way.
    if (!context.userIsGuildAdmin) {
      return GenericEmbedService.buildWrongInputResponse('You need the **Manage Server** permission to seed crowns.');
    }

    const minPlays = context.interaction?.options.getInteger('min_plays') ?? 30;
    const count = await this.crownService.seedCrowns(context.guildId, minPlays);

    return GenericEmbedService.buildSuccessResponse(
      `👑 Successfully seeded **${count.toLocaleString()}** crowns for this server (minimum **${minPlays} plays** threshold)!`,
    );
  }
}
