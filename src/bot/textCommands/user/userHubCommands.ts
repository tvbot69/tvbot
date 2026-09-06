import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { TimePeriod } from '@domain/enums/timePeriod';
import { AiJudgeService, type JudgeMode } from '@bot/services/aiJudgeService';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { FeaturedService } from '@bot/services/featuredService';
import { ShortcutService } from '@bot/services/shortcutService';
import { UserHubBuilders } from '@bot/builders/userHubBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

@injectable()
export class UserHubCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(AiJudgeService) private readonly aiJudgeService: AiJudgeService,
    @inject(BotScrobblingService) private readonly botScrobblingService: BotScrobblingService,
    @inject(FeaturedService) private readonly featuredService: FeaturedService,
    @inject(ShortcutService) private readonly shortcutService: ShortcutService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'judge',
        aliases: [],
        executeAsync: (ctx, args) => this.judgeAsync(ctx, args, 'judge'),
      },
      {
        name: 'roast',
        aliases: [],
        executeAsync: (ctx, args) => this.judgeAsync(ctx, args, 'roast'),
      },
      {
        name: 'compliment',
        aliases: [],
        executeAsync: (ctx, args) => this.judgeAsync(ctx, args, 'compliment'),
      },
      {
        name: 'botscrobbling',
        aliases: ['botscrobble', 'bottracking'],
        executeAsync: (ctx, args) => this.botScrobblingAsync(ctx, args),
      },
      {
        name: 'bottrack',
        aliases: [],
        executeAsync: (ctx) => this.botTrackAsync(ctx),
      },
      {
        name: 'featured',
        aliases: ['featuredavatar', 'featureduser', 'featuredalbum', 'avatar', 'ftrd', 'ftd', 'feat', 'pǝɹnʇɐǝɟ'],
        executeAsync: (ctx) => this.featuredAsync(ctx),
      },
      {
        name: 'featuredlog',
        aliases: ['featuredhistory', 'recentfeatured', 'rf', 'recentlyfeatured', 'fl', 'flog'],
        executeAsync: (ctx) => this.featuredLogAsync(ctx),
      },
      {
        name: 'rateyourmusic',
        aliases: ['rym'],
        executeAsync: (ctx, args) => this.rateYourMusicAsync(ctx, args),
      },
      {
        name: 'youtube',
        aliases: ['yt', 'y', 'youtubesearch', 'ytsearch', 'yts'],
        executeAsync: (ctx, args) => this.youtubeAsync(ctx, args),
      },
      {
        name: 'shortcuts',
        aliases: ['shortcut', 'sc', 'scs'],
        executeAsync: (ctx, args) => this.shortcutsAsync(ctx, args),
      },
    ];
  }

  private async judgeAsync(
    context: ContextModel,
    args: string[],
    mode: JudgeMode,
  ): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    const prefix = await this.prefixService.getPrefix(context.guildId);
    if (!user) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${prefix}login\`.`,
      );
    }

    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    const result = await this.aiJudgeService.evaluateTaste({
      userNameLastFm: user.userNameLastFm,
      discordUserId: context.discordUserId,
      mode,
      period: TimePeriod.Quarterly,
    });

    return UserHubBuilders.buildJudgeResponse({
      result,
      displayName: context.discordDisplayName,
      accentColor,
    });
  }

  private async botScrobblingAsync(
    context: ContextModel,
    args: string[],
  ): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    const prefix = await this.prefixService.getPrefix(context.guildId);
    if (!user) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${prefix}login\`.`,
      );
    }

    const firstArg = args[0]?.toLowerCase();
    if (firstArg === 'enable' || firstArg === 'on' || firstArg === 'true') {
      this.botScrobblingService.toggleUserOptIn(context.discordUserId, true);
    } else if (firstArg === 'disable' || firstArg === 'off' || firstArg === 'false') {
      this.botScrobblingService.toggleUserOptIn(context.discordUserId, false);
    }

    const optedIn = this.botScrobblingService.isUserOptedIn(context.discordUserId);
    const nowPlaying = context.guildId ? this.botScrobblingService.getNowPlaying(context.guildId) : undefined;
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildBotScrobblingResponse({
      optedIn,
      nowPlaying,
      accentColor,
    });
  }

  private async botTrackAsync(context: ContextModel): Promise<ResponseModel> {
    const track = context.guildId ? this.botScrobblingService.getNowPlaying(context.guildId) : undefined;
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildBotTrackResponse({
      track,
      accentColor,
    });
  }

  private async featuredAsync(context: ContextModel): Promise<ResponseModel> {
    const featured = await this.featuredService.getFeatured();
    if (!featured) {
      return GenericEmbedService.buildInfoResponse('No featured user is currently available. Please try again soon!');
    }

    const prefix = await this.prefixService.getPrefix(context.guildId);
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildFeaturedResponse({
      featured,
      prefix,
      accentColor,
    });
  }

  private async featuredLogAsync(context: ContextModel): Promise<ResponseModel> {
    const log = this.featuredService.getFeaturedLog();
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildFeaturedLogResponse({
      log,
      accentColor,
    });
  }

  private async rateYourMusicAsync(
    context: ContextModel,
    args: string[],
  ): Promise<ResponseModel> {
    let query = args.join(' ').trim();

    if (!query) {
      const user = await this.userService.getUserByDiscordId(context.discordUserId);
      if (user) {
        const recent = await this.lastFmRepository.getUserRecentTracks(user.userNameLastFm, 1).catch(() => []);
        if (recent.length > 0 && recent[0]) {
          const t = recent[0];
          query = `${t.artistName} ${t.name}`;
        }
      }
    }

    if (!query) {
      return GenericEmbedService.buildWrongInputResponse('Please specify an artist, album, or track to search for on RateYourMusic.');
    }

    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildRateYourMusicResponse({
      query,
      accentColor,
    });
  }

  private async youtubeAsync(
    context: ContextModel,
    args: string[],
  ): Promise<ResponseModel> {
    let query = args.join(' ').trim();

    if (!query) {
      const user = await this.userService.getUserByDiscordId(context.discordUserId);
      if (user) {
        const recent = await this.lastFmRepository.getUserRecentTracks(user.userNameLastFm, 1).catch(() => []);
        if (recent.length > 0 && recent[0]) {
          const t = recent[0];
          query = `${t.artistName} ${t.name}`;
        }
      }
    }

    if (!query) {
      return GenericEmbedService.buildWrongInputResponse('Please specify a song title or artist to search on YouTube.');
    }

    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildYoutubeResponse({
      query,
      accentColor,
    });
  }

  private async shortcutsAsync(
    context: ContextModel,
    args: string[],
  ): Promise<ResponseModel> {
    const sub = args[0]?.toLowerCase();
    const prefix = await this.prefixService.getPrefix(context.guildId);

    if (sub === 'add' || sub === 'set') {
      const shortcutName = args[1]?.toLowerCase();
      const targetCommand = args.slice(2).join(' ');

      if (!shortcutName || !targetCommand) {
        return GenericEmbedService.buildInfoResponse(
          `Usage: \`${prefix}shortcut add <name> <command>\`\nExample: \`${prefix}shortcut add mytop top artists 1m\``,
        );
      }

      this.shortcutService.setShortcut(context.discordUserId, shortcutName, targetCommand);
      return GenericEmbedService.buildSuccessResponse(
        `Successfully created shortcut: \`${prefix}${shortcutName}\` ➔ \`${prefix}${targetCommand}\``,
      );
    }

    if (sub === 'remove' || sub === 'del' || sub === 'delete') {
      const shortcutName = args[1]?.toLowerCase();
      if (!shortcutName) {
        return GenericEmbedService.buildInfoResponse(`Usage: \`${prefix}shortcut remove <name>\``);
      }

      const deleted = this.shortcutService.removeShortcut(context.discordUserId, shortcutName);
      if (deleted) {
        return GenericEmbedService.buildSuccessResponse(`Successfully deleted shortcut \`${prefix}${shortcutName}\`.`);
      } else {
        return GenericEmbedService.buildWrongInputResponse(`No shortcut found with name \`${shortcutName}\`.`);
      }
    }

    // List shortcuts
    const shortcuts = this.shortcutService.getShortcuts(context.discordUserId);
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildShortcutsResponse({
      displayName: context.discordDisplayName,
      shortcuts,
      prefix,
      accentColor,
    });
  }
}
