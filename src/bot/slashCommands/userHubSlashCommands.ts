import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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
export class UserHubSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

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
        data: new SlashCommandBuilder()
          .setName('judge')
          .setDescription('Evaluate, roast, or compliment your music taste')
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Critique mode')
              .setRequired(false)
              .addChoices(
                { name: '⚖️ Balanced Verdict', value: 'judge' },
                { name: '🔥 Savage Roast', value: 'roast' },
                { name: '🙂 Sincere Compliment', value: 'compliment' },
              ),
          ),
        executeAsync: (ctx) => this.judgeSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('botscrobbling')
          .setDescription('Configure automatic scrobbling for music played by TVBot in voice channels')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('Enable or disable bot scrobbling')
              .setRequired(false)
              .addChoices(
                { name: '🟢 Enable', value: 'enable' },
                { name: '🔴 Disable', value: 'disable' },
              ),
          ),
        executeAsync: (ctx) => this.botScrobblingSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('featured')
          .setDescription('View the current featured community listener and their favorite release'),
        executeAsync: (ctx) => this.featuredSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('featuredlog')
          .setDescription('View the history log of recently featured community listeners'),
        executeAsync: (ctx) => this.featuredLogSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('rateyourmusic')
          .setDescription('Search for an artist, album, or track on RateYourMusic')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Artist or release name to search').setRequired(false),
          ),
        executeAsync: (ctx) => this.rateYourMusicSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('youtube')
          .setDescription('Search YouTube for a track or artist')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Music query to search').setRequired(false),
          ),
        executeAsync: (ctx) => this.youtubeSlashAsync(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('shortcuts')
          .setDescription('View your custom command macros and shortcuts'),
        executeAsync: (ctx) => this.shortcutsSlashAsync(ctx),
      },
    ];
  }

  private async judgeSlashAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    const prefix = await this.prefixService.getPrefix(context.guildId);
    if (!user) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${prefix}login\`.`,
      );
    }

    const mode = (context.interaction?.options.getString('mode') as JudgeMode) || 'judge';
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

  private async botScrobblingSlashAsync(context: ContextModel): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    const prefix = await this.prefixService.getPrefix(context.guildId);
    if (!user) {
      return GenericEmbedService.buildWrongInputResponse(
        `You have not connected your Last.fm account yet. Connect it with \`${prefix}login\`.`,
      );
    }

    const action = context.interaction?.options.getString('action');
    if (action === 'enable') {
      this.botScrobblingService.toggleUserOptIn(context.discordUserId, true);
    } else if (action === 'disable') {
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

  private async featuredSlashAsync(context: ContextModel): Promise<ResponseModel> {
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

  private async featuredLogSlashAsync(context: ContextModel): Promise<ResponseModel> {
    const log = this.featuredService.getFeaturedLog();
    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildFeaturedLogResponse({
      log,
      accentColor,
    });
  }

  private async rateYourMusicSlashAsync(context: ContextModel): Promise<ResponseModel> {
    let query = context.interaction?.options.getString('query')?.trim();

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
      return GenericEmbedService.buildWrongInputResponse('Please specify an artist or album name.');
    }

    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildRateYourMusicResponse({
      query,
      accentColor,
    });
  }

  private async youtubeSlashAsync(context: ContextModel): Promise<ResponseModel> {
    let query = context.interaction?.options.getString('query')?.trim();

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
      return GenericEmbedService.buildWrongInputResponse('Please specify a song or artist to search.');
    }

    const accentColor = this.colorService
      ? await this.colorService.getAccentColorAsync(context.guildId)
      : undefined;

    return UserHubBuilders.buildYoutubeResponse({
      query,
      accentColor,
    });
  }

  private async shortcutsSlashAsync(context: ContextModel): Promise<ResponseModel> {
    const shortcuts = this.shortcutService.getShortcuts(context.discordUserId);
    const prefix = await this.prefixService.getPrefix(context.guildId);
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
