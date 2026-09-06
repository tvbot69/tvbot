import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { GameService, JumbleSession } from '@bot/services/gameService';
import { GameBuilders } from '@bot/builders/gameBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { ColorService } from '@bot/services/colorService';

@injectable()
export class GameSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(LastFmRepository) private readonly lastfmRepository: LastFmRepository,
    @inject(GameService) private readonly gameService: GameService,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        data: new SlashCommandBuilder()
          .setName('game')
          .setDescription('Interactive music games')
          .addSubcommand((sub) =>
            sub
              .setName('jumble')
              .setDescription('Artist name anagram scramble game')
              .addBooleanOption((opt) =>
                opt
                  .setName('stats')
                  .setDescription('Show your personal game statistics instead of starting a game')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('pixel')
              .setDescription('Album cover pixelation guessing game')
              .addBooleanOption((opt) =>
                opt
                  .setName('stats')
                  .setDescription('Show your personal game statistics instead of starting a game')
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('stats')
              .setDescription('View your Jumble and Pixelation game statistics')
              .addUserOption((opt) =>
                opt
                  .setName('user')
                  .setDescription('Target user (defaults to yourself)')
                  .setRequired(false),
              ),
          ),
        executeAsync: (ctx) => this.handleGameCommand(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('jumble')
          .setDescription('Play the artist anagram scramble game')
          .addBooleanOption((opt) =>
            opt
              .setName('stats')
              .setDescription('Show your personal game statistics instead of starting a game')
              .setRequired(false),
          ),
        executeAsync: (ctx) => this.handleJumbleCommand(ctx),
      },
      {
        data: new SlashCommandBuilder()
          .setName('pixel')
          .setDescription('Play the album cover pixelation guessing game')
          .addBooleanOption((opt) =>
            opt
              .setName('stats')
              .setDescription('Show your personal game statistics instead of starting a game')
              .setRequired(false),
          ),
        executeAsync: (ctx) => this.handlePixelCommand(ctx),
      },
    ];
  }

  private async handleGameCommand(context: ContextModel): Promise<ResponseModel> {
    const sub = context.interaction?.options.getSubcommand();
    if (sub === 'pixel') {
      return this.handlePixelCommand(context);
    }
    if (sub === 'stats') {
      return this.handleStatsCommand(context);
    }
    return this.handleJumbleCommand(context);
  }

  private async handleStatsCommand(context: ContextModel): Promise<ResponseModel> {
    const targetUser = context.interaction?.options.getUser('user') ?? context.interaction?.user;
    const targetId = targetUser?.id ?? context.discordUserId;
    const displayName = targetUser?.displayName ?? context.discordDisplayName ?? 'User';

    const accentColor = context.guild?.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    const stats = this.gameService.getUserStats(targetId);
    return GameBuilders.buildGameStatsResponse(displayName, stats, accentColor);
  }

  private async handleJumbleCommand(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'Jumble can only be played inside a server channel.',
      );
    }

    const showStats = context.interaction?.options.getBoolean('stats') ?? false;
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use \`/register\` first.`,
      );
    }

    const accentColor = context.guild.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    if (showStats) {
      const stats = this.gameService.getUserStats(context.discordUserId);
      return GameBuilders.buildGameStatsResponse(
        context.discordDisplayName ?? caller.userNameLastFm,
        stats,
        accentColor,
      );
    }

    const active = this.gameService.getActiveGame(context.channelId);
    if (active && !active.ended) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Cooldown,
        'A game is already in progress in this channel! Guess the answer or type give up.',
      );
    }

    const topArtists = await this.lastfmRepository.getTopArtists(caller.userNameLastFm, undefined, 250);
    if (!topArtists || topArtists.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'Could not find enough top artists in your library to start a Jumble game.',
      );
    }

    const eligible = topArtists.filter(
      (a) => a.name.length >= 3 && a.name.length <= 35 && !a.name.startsWith(context.prefix),
    );

    if (eligible.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'Could not find suitable artists for a Jumble game.',
      );
    }

    const chosen = eligible[Math.floor(Math.random() * eligible.length)]!;
    const artistName = chosen.name;

    const onExpire = async (session: JumbleSession) => {
      try {
        const channel = context.channel;
        if (channel && 'send' in channel) {
          const expiredResp = GameBuilders.buildGameExpiredResponse(session, accentColor);
          if (expiredResp.componentsV2Container) {
            await (channel as any).send({
              components: [expiredResp.componentsV2Container as any],
            });
          }
        }
      } catch {
        // ignore
      }
    };

    const session = this.gameService.startGame({
      channelId: context.channelId,
      guildId: context.guild.id,
      starterUserId: caller.userNameLastFm,
      starterDiscordId: context.discordUserId,
      type: 'artist',
      correctAnswer: artistName,
      artistName,
      onExpire,
    });

    return GameBuilders.buildJumbleStartResponse(session, accentColor);
  }

  private async handlePixelCommand(context: ContextModel): Promise<ResponseModel> {
    if (!context.guild) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotSupportedInDm,
        'Pixelation can only be played inside a server channel.',
      );
    }

    const showStats = context.interaction?.options.getBoolean('stats') ?? false;
    const caller = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!caller) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `You have not connected your Last.fm account yet. Use \`/register\` first.`,
      );
    }

    const accentColor = context.guild.id && this.colorService
      ? await this.colorService.getAccentColorAsync(context.guild.id)
      : null;

    if (showStats) {
      const stats = this.gameService.getUserStats(context.discordUserId);
      return GameBuilders.buildGameStatsResponse(
        context.discordDisplayName ?? caller.userNameLastFm,
        stats,
        accentColor,
      );
    }

    const active = this.gameService.getActiveGame(context.channelId);
    if (active && !active.ended) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Cooldown,
        'A game is already in progress in this channel! Guess the answer or click Give Up.',
      );
    }

    const topAlbums = await this.lastfmRepository.getTopAlbums(caller.userNameLastFm, undefined, 100);
    const eligible = (topAlbums || []).filter(
      (a) =>
        a.imageUrl &&
        a.name &&
        a.name.length >= 2 &&
        a.name.length <= 40 &&
        !a.name.startsWith(context.prefix),
    );

    if (eligible.length === 0) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'Could not find enough albums with cover artwork in your library to start Pixelation.',
      );
    }

    const chosen = eligible[Math.floor(Math.random() * eligible.length)]!;
    const albumName = chosen.name;
    const artistName = chosen.artistName ?? 'Unknown Artist';
    const coverUrl = chosen.imageUrl!;

    const pixelatedBuffer = await this.gameService.pixelateCover(coverUrl, 0.04);

    const onExpire = async (session: JumbleSession) => {
      try {
        const channel = context.channel;
        if (channel && 'send' in channel) {
          const expiredResp = GameBuilders.buildGameExpiredResponse(session, accentColor);
          if (expiredResp.componentsV2Container) {
            await (channel as any).send({
              components: [expiredResp.componentsV2Container as any],
            });
          }
        }
      } catch {
        // ignore
      }
    };

    const session = this.gameService.startGame({
      channelId: context.channelId,
      guildId: context.guild.id,
      starterUserId: caller.userNameLastFm,
      starterDiscordId: context.discordUserId,
      type: 'pixel',
      correctAnswer: albumName,
      artistName,
      albumName,
      coverUrl,
      onExpire,
    });

    return GameBuilders.buildPixelStartResponse(session, pixelatedBuffer, accentColor);
  }
}
