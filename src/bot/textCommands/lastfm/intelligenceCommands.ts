import { injectable, inject, container } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/user/userService';
import { SettingService } from '@bot/services/system/settingService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { ColorService } from '@bot/services/system/colorService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { GenericEmbedService } from '@bot/services/system/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import {
  MusicIntelligenceService,
  GapEntityType,
} from '@bot/services/library/musicIntelligenceService';
import { IntelligenceBuilders } from '@bot/builders/intelligence/intelligenceBuilders';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { User } from '@domain/interfaces/ports/iuserRepository';

interface TargetResolution {
  callerUser: User;
  targetUser: User;
  displayName: string;
  cleanSearchValue: string;
  /**
   * False when `targetUser` is a Last.fm name the bot holds no indexed history
   * for - the `lfm:` prefix with no registered match. `getListeningGaps`,
   * `getDiscoveries` and `getGuildAffinity` are all keyed on `userId`, so
   * asking them about a name we never indexed would answer with the CALLER's
   * rows under a stranger's name (`.gaps`/`.discoveries`), or score every
   * neighbour in the server against an empty target profile and print "nobody
   * here has a similar taste" (`.affinity`).
   */
  hasIndexedHistory: boolean;
}

import { IcebergGenerator } from '@images/generators/icebergGenerator';
import { Logger } from '@domain/logging/logger';

@injectable()
export class IntelligenceCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SettingService) private readonly settingService: SettingService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(MusicIntelligenceService) private readonly intelligenceService: MusicIntelligenceService,
    @inject(ColorService) private readonly colorService?: ColorService,
    @inject(IcebergGenerator) private readonly icebergGenerator?: IcebergGenerator,
    @inject(ArtworkService) private readonly artworkService?: ArtworkService,
  ) {
    this.commands = [
      {
        name: 'artistgaps',
        aliases: ['gaps', 'gap', 'agaps', 'artistgap'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'artist'),
      },
      {
        name: 'albumgaps',
        aliases: ['abgaps', 'algaps'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'album'),
      },
      {
        name: 'trackgaps',
        aliases: ['tgaps', 'songgaps'],
        executeAsync: (ctx, args) => this.listeningGapsAsync(ctx, args?.join(' ') ?? '', 'track'),
      },
      {
        name: 'discoveries',
        aliases: ['d', 'discovered', 'discovery', 'newartists'],
        executeAsync: (ctx, args) => this.discoveriesAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'iceberg',
        aliases: ['ice', 'icebergify', 'berg'],
        executeAsync: (ctx, args) => this.icebergAsync(ctx, args?.join(' ') ?? ''),
      },
      {
        name: 'affinity',
        aliases: ['n', 'aff', 'neighbors', 'soulmates', 'neighbours'],
        executeAsync: (ctx, args) => this.affinityAsync(ctx, args?.join(' ') ?? ''),
      },
    ];
  }

  private async resolveTarget(
    context: ContextModel,
    rawOptions: string,
  ): Promise<TargetResolution | ResponseModel> {
    const callerUser = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!callerUser) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use the \`${context.prefix}register\` command first.`,
      );
    }

    let cleanSearchValue = rawOptions.trim();
    let targetUser = callerUser;
    let displayName = context.discordDisplayName;
    let hasIndexedHistory = true;

    const mentionMatch = cleanSearchValue.match(/<@!?(\d+)>/);
    if (mentionMatch && mentionMatch[1]) {
      const mentionedDiscordId = mentionMatch[1];
      const foundUser = await this.userService.getUserByDiscordId(mentionedDiscordId);
      if (!foundUser) {
        return GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `<@${mentionedDiscordId}> hasn't connected their Last.fm account yet.`,
        );
      }
      targetUser = foundUser;
      displayName = foundUser.userNameLastFm;
      cleanSearchValue = cleanSearchValue.replace(mentionMatch[0], '').trim();
    } else {
      // Same prefix grammar as `playcountCommands`: the name runs to the next
      // whitespace, so `lfm:john.smith` is one name rather than `john` plus a
      // leftover `.smith` that the period parser would read as part of it.
      const lfmMatch = cleanSearchValue.match(/\blfm:(\S+)/i);
      if (lfmMatch && lfmMatch[1]) {
        const lfmName = lfmMatch[1];
        const foundUser = await this.userService.getUserByLastFmName(lfmName);
        if (foundUser) {
          targetUser = foundUser;
          displayName = foundUser.userNameLastFm;
        } else {
          // `userId: 0` is a sentinel, not a real account: nothing is indexed
          // under it, so no per-user query can silently read the caller's rows.
          // `icebergAsync` is unaffected - `getIceberg` classifies artists by
          // catalogue popularity and never looks at the user id at all. The
          // commands that DO read a user id refuse below.
          targetUser = {
            ...callerUser,
            userId: 0,
            userNameLastFm: lfmName,
            discordUserId: '0',
          } as User;
          displayName = lfmName;
          hasIndexedHistory = false;
        }
        cleanSearchValue = cleanSearchValue.replace(lfmMatch[0], '').trim();
      }
    }

    return {
      callerUser,
      targetUser,
      displayName,
      cleanSearchValue,
      hasIndexedHistory,
    };
  }

  /**
   * The three commands below read the bot's own index, which exists only for
   * accounts somebody here has linked. A `lfm:` name nobody has linked has no
   * history to read, and saying so beats the honest-looking empty card - that
   * card is a claim about a whole listening history we have never seen, and for
   * `.affinity` it is a claim about a server full of real people.
   *
   * `.iceberg` is deliberately NOT in this set: `getIceberg` classifies artists
   * by catalogue popularity and never reads a user id, so an unlinked `lfm:`
   * name is a real Last.fm account to it and `.iceberg lfm:stranger` answers
   * correctly.
   */
  private noIndexedHistoryResponse(displayName: string): ResponseModel {
    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.NotFound,
      `I have no indexed listening history for **${displayName}**. This is computed from the bot's own index, which only covers accounts that have linked it - so an unlinked account has nothing to show here.`,
    );
  }

  private async listeningGapsAsync(
    context: ContextModel,
    rawOptions: string,
    defaultType: GapEntityType,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;
    if (!target.hasIndexedHistory) return this.noIndexedHistoryResponse(target.displayName);

    let entityType: GapEntityType = defaultType;
    let clean = target.cleanSearchValue;
    if (/\b(album|albums)\b/i.test(clean)) {
      entityType = 'album';
      clean = clean.replace(/\b(album|albums)\b/i, '').trim();
    } else if (/\b(track|tracks|song|songs)\b/i.test(clean)) {
      entityType = 'track';
      clean = clean.replace(/\b(track|tracks|song|songs)\b/i, '').trim();
    } else if (/\b(artist|artists)\b/i.test(clean)) {
      entityType = 'artist';
      clean = clean.replace(/\b(artist|artists)\b/i, '').trim();
    }

    const items = await this.intelligenceService.getListeningGaps(target.targetUser.userId, entityType, 90);

    const artSvc = this.artworkService ?? container.resolve(ArtworkService);
    const clrSvc = this.colorService ?? container.resolve(ColorService);
    let accentColor = DiscordConstants.LastFmColorRed;
    if (items.length > 0 && items[0]) {
      const top = items[0];
      let artUrl: string | null = null;
      if (entityType === 'artist') {
        artUrl = await artSvc.getArtistImageUrl(top.name);
      } else if (entityType === 'album') {
        artUrl = await artSvc.getAlbumCoverUrl(top.name, top.artistName ?? '');
      } else {
        artUrl = await artSvc.getTrackCoverUrl(top.name, top.artistName ?? '');
      }
      if (artUrl) {
        accentColor = await clrSvc.getColorFromImageUrl(artUrl);
      }
    }

    const targetDiscordId = target.targetUser.discordUserId.toString();

    return IntelligenceBuilders.buildListeningGapsResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      entityType,
      items,
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

  private async discoveriesAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    if (!target.hasIndexedHistory) return this.noIndexedHistoryResponse(target.displayName);

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);
    const start = timeSettings.startDateTime ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const end = timeSettings.endDateTime ?? new Date();
    const periodDesc = timeSettings.timePeriod === TimePeriod.AllTime ? 'the past 90 days' : timeSettings.description;

    const items = await this.intelligenceService.getDiscoveries(target.targetUser.userId, start, end);

    const artSvc = this.artworkService ?? container.resolve(ArtworkService);
    const clrSvc = this.colorService ?? container.resolve(ColorService);
    let accentColor = DiscordConstants.LastFmColorRed;
    if (items.length > 0 && items[0]?.artistName) {
      const artUrl = await artSvc.getArtistImageUrl(items[0].artistName);
      if (artUrl) {
        accentColor = await clrSvc.getColorFromImageUrl(artUrl);
      }
    }

    const targetDiscordId = target.targetUser.discordUserId.toString();

    return IntelligenceBuilders.buildDiscoveriesResponse({
      displayName: target.displayName,
      userNameLastFm: target.targetUser.userNameLastFm,
      periodDescription: periodDesc,
      items,
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

  private async icebergAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    const timeSettings = this.settingService.getTimePeriod(target.cleanSearchValue);

    const topArtists = await this.lastfmRepository.getTopArtists(
      target.targetUser.userNameLastFm,
      timeSettings.timePeriod,
      100,
      1,
      target.targetUser.sessionKey ?? undefined,
    );

    if (!topArtists || topArtists.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No top artists found for ${target.displayName} in ${timeSettings.description}.`,
      );
    }

    const icebergData = await this.intelligenceService.getIceberg(
      target.targetUser.userId,
      topArtists.map((a) => ({ name: a.name, playcount: a.playcount })),
      target.displayName,
      target.targetUser.userNameLastFm,
      timeSettings.description,
    );

    let imageBuffer: Buffer | null = null;
    if (this.icebergGenerator) {
      try {
        imageBuffer = await this.icebergGenerator.generateIceberg(icebergData);
      } catch (err) {
        Logger.warn({ err }, 'Failed to generate iceberg image');
      }
    }

    const clrSvc = this.colorService ?? container.resolve(ColorService);
    let accentColor = DiscordConstants.LastFmColorRed;
    if (imageBuffer) {
      accentColor = await clrSvc.extractAccentColor(imageBuffer);
    }
    if (accentColor === DiscordConstants.LastFmColorRed && topArtists.length > 0 && topArtists[0]?.name) {
      const artSvc = this.artworkService ?? container.resolve(ArtworkService);
      const artUrl = await artSvc.getArtistImageUrl(topArtists[0].name);
      if (artUrl) {
        accentColor = await clrSvc.getColorFromImageUrl(artUrl);
      }
    }

    return IntelligenceBuilders.buildIcebergResponse({
      data: icebergData,
      imageBuffer,
      accentColor,
    });
  }

  private async affinityAsync(
    context: ContextModel,
    rawOptions: string,
  ): Promise<ResponseModel> {
    if (!context.guildId) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'The affinity command can only be used in a server.',
      );
    }

    const target = await this.resolveTarget(context, rawOptions);
    if ('commandResponse' in target) return target;

    // The refusal `.gaps` and `.discoveries` make, for the same reason and in
    // the same shape. `getGuildAffinity` excludes the target BY `userId` and
    // reads the target's top artists by `userId`, so the `userId: 0` sentinel
    // is what stopped the leak of the caller's rows — and it is also why the
    // card is now unsupported: every neighbour scores 0% against an empty target
    // profile and the card reads "nobody in this server has a similar taste",
    // which is a claim about real people built on a target we never indexed.
    if (!target.hasIndexedHistory) return this.noIndexedHistoryResponse(target.displayName);

    const guildName = context.guild?.name || 'this server';

    const affinityData = await this.intelligenceService.getGuildAffinity(
      context.guildId,
      target.targetUser.userId,
      target.displayName,
      target.targetUser.userNameLastFm,
      guildName,
    );

    const clrSvc = this.colorService ?? container.resolve(ColorService);
    const iconUrl = context.guild?.iconURL({ size: 256 }) ?? undefined;
    let accentColor = iconUrl ? await clrSvc.getColorFromImageUrl(iconUrl) : DiscordConstants.LastFmColorRed;
    if (accentColor === DiscordConstants.LastFmColorRed && affinityData.neighbors.length > 0 && affinityData.neighbors[0]?.sharedArtists[0]) {
      const artSvc = this.artworkService ?? container.resolve(ArtworkService);
      const artUrl = await artSvc.getArtistImageUrl(affinityData.neighbors[0].sharedArtists[0]);
      if (artUrl) {
        accentColor = await clrSvc.getColorFromImageUrl(artUrl);
      }
    }

    const targetDiscordId = target.targetUser.discordUserId.toString();

    return IntelligenceBuilders.buildAffinityResponse({
      data: affinityData,
      callerDiscordId: context.discordUserId,
      targetDiscordId,
      accentColor,
    });
  }

}
