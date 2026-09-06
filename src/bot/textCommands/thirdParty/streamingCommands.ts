import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { AppleMusicService } from '@bot/services/appleMusicService';
import { DiscogsAndImportBuilders } from '@bot/builders/discogsAndImportBuilders';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import { GenericEmbedService } from '@bot/services/genericEmbedService';

@injectable()
export class StreamingCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    @inject(UserService) private readonly userService: UserService,
    @inject(SpotifySearchApi) private readonly spotifySearchApi: SpotifySearchApi,
    @inject(AppleMusicService) private readonly appleMusicService: AppleMusicService,
    @inject(PrefixService) private readonly prefixService: PrefixService,
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(ColorService) private readonly colorService?: ColorService,
  ) {
    this.commands = [
      {
        name: 'spotify',
        aliases: ['sp', 's', 'spotifyfind', 'spotifysearch'],
        executeAsync: (ctx, args) => this.spotifyTrackAsync(ctx, args),
      },
      {
        name: 'spotifyalbum',
        aliases: ['spalbum', 'salbum'],
        executeAsync: (ctx, args) => this.spotifyAlbumAsync(ctx, args),
      },
      {
        name: 'spotifyartist',
        aliases: ['spartist', 'sartist'],
        executeAsync: (ctx, args) => this.spotifyArtistAsync(ctx, args),
      },
      {
        name: 'applemusic',
        aliases: ['am', 'apple'],
        executeAsync: (ctx, args) => this.appleMusicAsync(ctx, args),
      },
    ];
  }

  private async getAccentColor(ctx: ContextModel, defaultColor: number): Promise<number> {
    if (this.colorService) {
      const color = await this.colorService.getAccentColorAsync(ctx.guildId);
      if (color) return color;
    }
    return defaultColor;
  }

  private async resolveQuery(
    ctx: ContextModel,
    args: string[],
    cmdName: string,
  ): Promise<{ query: string } | { errorResponse: ResponseModel }> {
    const raw = args.join(' ').trim();
    if (raw) return { query: raw };

    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return {
        errorResponse: GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Link your account with \`${ctx.prefix}login\` or specify a track name (e.g. \`${ctx.prefix}${cmdName} <song / artist>\`).`,
        ),
      };
    }

    try {
      const recents = await this.lastFmRepository.getUserRecentTracks(user.userNameLastFm, 2, 1);
      if (!recents || recents.length === 0 || !recents[0]) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify a track name (e.g. \`${ctx.prefix}${cmdName} <song / artist>\`).`,
          ),
        };
      }

      const track = recents.find((t) => t.nowPlaying) ?? recents[0]!;
      const artist = track.artistName ?? (track as any).artist?.name ?? '';
      const name = track.name ?? '';
      const query = `${artist} ${name}`.trim();
      if (!query) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not determine track details from your recent scrobbles. Specify a track name (e.g. \`${ctx.prefix}${cmdName} <song / artist>\`).`,
          ),
        };
      }
      return { query };
    } catch (err: any) {
      return {
        errorResponse: GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.Error,
          `Failed to fetch your recent tracks from Last.fm: ${err?.message || 'Unknown error'}.`,
        ),
      };
    }
  }

  public async spotifyTrackAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx, 0x1DB954);
    const resolved = await this.resolveQuery(ctx, args, 'spotify');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    try {
      const tracks = await this.spotifySearchApi.searchTracks(query, 1);
      if (!tracks || tracks.length === 0 || !tracks[0]) {
        const container = new ContainerBuilder();
        container.setAccentColor(accentColor);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`No Spotify track found for **"${query}"**.`),
        );
        const res = new ResponseModel(accentColor);
        res.commandResponse = CommandResponse.Ok;
        res.setComponentsV2Container(container);
        return res;
      }

      return DiscogsAndImportBuilders.buildSpotifyTrackResponse({ track: tracks[0], accentColor });
    } catch (err: any) {
      const container = new ContainerBuilder();
      container.setAccentColor(DiscordConstants.ErrorColorRed);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`Spotify search failed: ${err?.message || 'Unknown error'}`),
      );
      const res = new ResponseModel(DiscordConstants.ErrorColorRed);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }
  }

  public async spotifyAlbumAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx, 0x1DB954);
    const query = args.join(' ').trim();

    if (!query) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🟢 Spotify Album Search\n` +
          `**Usage:** \`${ctx.prefix}spotifyalbum <album name>\``,
        ),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    try {
      const albums = await this.spotifySearchApi.searchAlbums(query, 1);
      if (!albums || albums.length === 0 || !albums[0]) {
        const container = new ContainerBuilder();
        container.setAccentColor(accentColor);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`No Spotify album found for **"${query}"**.`),
        );
        const res = new ResponseModel(accentColor);
        res.commandResponse = CommandResponse.Ok;
        res.setComponentsV2Container(container);
        return res;
      }

      return DiscogsAndImportBuilders.buildSpotifyAlbumResponse({ album: albums[0], accentColor });
    } catch (err: any) {
      const container = new ContainerBuilder();
      container.setAccentColor(DiscordConstants.ErrorColorRed);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`Spotify album search failed: ${err?.message || 'Unknown error'}`),
      );
      const res = new ResponseModel(DiscordConstants.ErrorColorRed);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }
  }

  public async spotifyArtistAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx, 0x1DB954);
    const query = args.join(' ').trim();

    if (!query) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🟢 Spotify Artist Search\n` +
          `**Usage:** \`${ctx.prefix}spotifyartist <artist name>\``,
        ),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    try {
      const artists = await this.spotifySearchApi.searchArtists(query, 1);
      if (!artists || artists.length === 0 || !artists[0]) {
        const container = new ContainerBuilder();
        container.setAccentColor(accentColor);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`No Spotify artist found for **"${query}"**.`),
        );
        const res = new ResponseModel(accentColor);
        res.commandResponse = CommandResponse.Ok;
        res.setComponentsV2Container(container);
        return res;
      }

      return DiscogsAndImportBuilders.buildSpotifyArtistResponse({ artist: artists[0], accentColor });
    } catch (err: any) {
      const container = new ContainerBuilder();
      container.setAccentColor(DiscordConstants.ErrorColorRed);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`Spotify artist search failed: ${err?.message || 'Unknown error'}`),
      );
      const res = new ResponseModel(DiscordConstants.ErrorColorRed);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }
  }

  public async appleMusicAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const accentColor = await this.getAccentColor(ctx, 0xFA2D48);
    const resolved = await this.resolveQuery(ctx, args, 'applemusic');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    const item = await this.appleMusicService.searchSong(query);
    if (!item) {
      const container = new ContainerBuilder();
      container.setAccentColor(accentColor);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`No Apple Music release found for **"${query}"**.`),
      );
      const res = new ResponseModel(accentColor);
      res.commandResponse = CommandResponse.Ok;
      res.setComponentsV2Container(container);
      return res;
    }

    return DiscogsAndImportBuilders.buildAppleMusicResponse({ item, accentColor });
  }
}
