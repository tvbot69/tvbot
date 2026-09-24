import { inject, injectable } from 'tsyringe';
import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { PrefixService } from '@bot/services/prefixService';
import { ColorService } from '@bot/services/colorService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { AppleMusicService } from '@bot/services/appleMusicService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
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
        aliases: ['sp', 'spotifyfind', 'spotifysearch'],
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
      {
        name: 'applemusicalbum',
        aliases: ['amalbum', 'applealbum'],
        executeAsync: (ctx, args) => this.appleMusicAlbumAsync(ctx, args),
      },
      {
        name: 'applemusicartist',
        aliases: ['amartist'],
        executeAsync: (ctx, args) => this.appleMusicArtistAsync(ctx, args),
      },
    ];
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
      const recents = await this.lastFmRepository.getUserRecentTracks(
        user.userNameLastFm,
        2,
        1,
        undefined,
        user.sessionKey ?? undefined,
      );
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

  private async resolveAlbumQuery(
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
          `You have not connected your Last.fm account yet. Link your account with \`${ctx.prefix}login\` or specify an album name (e.g. \`${ctx.prefix}${cmdName} <album>\`).`,
        ),
      };
    }

    try {
      const recents = await this.lastFmRepository.getUserRecentTracks(
        user.userNameLastFm,
        2,
        1,
        undefined,
        user.sessionKey ?? undefined,
      );
      if (!recents || recents.length === 0 || !recents[0]) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify an album name (e.g. \`${ctx.prefix}${cmdName} <album>\`).`,
          ),
        };
      }

      const track = recents.find((t) => t.nowPlaying) ?? recents[0]!;
      const artist = track.artistName ?? (track as any).artist?.name ?? '';
      const album = track.albumName ?? '';
      const query = album ? `${artist} ${album}`.trim() : `${artist}`.trim();
      if (!query) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not determine album details from your recent scrobbles. Specify an album name (e.g. \`${ctx.prefix}${cmdName} <album>\`).`,
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

  private async resolveArtistQuery(
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
          `You have not connected your Last.fm account yet. Link your account with \`${ctx.prefix}login\` or specify an artist name (e.g. \`${ctx.prefix}${cmdName} <artist>\`).`,
        ),
      };
    }

    try {
      const recents = await this.lastFmRepository.getUserRecentTracks(
        user.userNameLastFm,
        2,
        1,
        undefined,
        user.sessionKey ?? undefined,
      );
      if (!recents || recents.length === 0 || !recents[0]) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify an artist name (e.g. \`${ctx.prefix}${cmdName} <artist>\`).`,
          ),
        };
      }

      const track = recents.find((t) => t.nowPlaying) ?? recents[0]!;
      const artist = track.artistName ?? (track as any).artist?.name ?? '';
      if (!artist) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not determine artist details from your recent scrobbles. Specify an artist name (e.g. \`${ctx.prefix}${cmdName} <artist>\`).`,
          ),
        };
      }
      return { query: artist };
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
    const raw = args.join(' ').trim();
    if (raw.toLowerCase().startsWith('album ')) {
      return this.spotifyAlbumAsync(ctx, [raw.slice(6).trim()]);
    }
    if (raw.toLowerCase().startsWith('artist ')) {
      return this.spotifyArtistAsync(ctx, [raw.slice(7).trim()]);
    }

    const resolved = await this.resolveQuery(ctx, args, 'spotify');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    try {
      const tracks = await this.spotifySearchApi.searchTracks(query, 1);
      if (tracks && tracks.length > 0 && tracks[0]?.external_urls?.spotify) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(tracks[0].external_urls.spotify);
        return res;
      }

      // Fallback: search albums if track not found
      const albums = await this.spotifySearchApi.searchAlbums(query, 1);
      if (albums && albums.length > 0 && albums[0]?.external_urls?.spotify) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(albums[0].external_urls.spotify);
        return res;
      }

      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No Spotify link found for **"${query}"**.`,
      );
    } catch (err: any) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Spotify search failed: ${err?.message || 'Unknown error'}`,
      );
    }
  }

  public async spotifyAlbumAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const resolved = await this.resolveAlbumQuery(ctx, args, 'spotifyalbum');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    try {
      const albums = await this.spotifySearchApi.searchAlbums(query, 1);
      if (albums && albums.length > 0 && albums[0]?.external_urls?.spotify) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(albums[0].external_urls.spotify);
        return res;
      }

      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No Spotify album link found for **"${query}"**.`,
      );
    } catch (err: any) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Spotify album search failed: ${err?.message || 'Unknown error'}`,
      );
    }
  }

  public async spotifyArtistAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const resolved = await this.resolveArtistQuery(ctx, args, 'spotifyartist');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    try {
      const artists = await this.spotifySearchApi.searchArtists(query, 1);
      if (artists && artists.length > 0 && artists[0]?.external_urls?.spotify) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(artists[0].external_urls.spotify);
        return res;
      }

      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No Spotify artist link found for **"${query}"**.`,
      );
    } catch (err: any) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.Error,
        `Spotify artist search failed: ${err?.message || 'Unknown error'}`,
      );
    }
  }

  public async appleMusicAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const raw = args.join(' ').trim();
    if (raw.toLowerCase().startsWith('album ')) {
      return this.appleMusicAlbumAsync(ctx, [raw.slice(6).trim()]);
    }
    if (raw.toLowerCase().startsWith('artist ')) {
      return this.appleMusicArtistAsync(ctx, [raw.slice(7).trim()]);
    }

    const resolved = await this.resolveQuery(ctx, args, 'applemusic');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    const item = await this.appleMusicService.searchSong(query);
    if (item?.url) {
      const res = new ResponseModel();
      res.commandResponse = CommandResponse.Ok;
      res.setContent(item.url);
      return res;
    }

    // Fallback: search album if song not found
    const albumUrl = await this.appleMusicService.searchAlbum(query);
    if (albumUrl) {
      const res = new ResponseModel();
      res.commandResponse = CommandResponse.Ok;
      res.setContent(albumUrl);
      return res;
    }

    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.NotFound,
      `No Apple Music release found for **"${query}"**.`,
    );
  }

  public async appleMusicAlbumAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const resolved = await this.resolveAlbumQuery(ctx, args, 'applemusicalbum');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    const albumUrl = await this.appleMusicService.searchAlbum(query);
    if (albumUrl) {
      const res = new ResponseModel();
      res.commandResponse = CommandResponse.Ok;
      res.setContent(albumUrl);
      return res;
    }

    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.NotFound,
      `No Apple Music album link found for **"${query}"**.`,
    );
  }

  public async appleMusicArtistAsync(ctx: ContextModel, args: string[]): Promise<ResponseModel> {
    const resolved = await this.resolveArtistQuery(ctx, args, 'applemusicartist');
    if ('errorResponse' in resolved) {
      return resolved.errorResponse;
    }
    const query = resolved.query;

    const artistUrl = await this.appleMusicService.searchArtist(query);
    if (artistUrl) {
      const res = new ResponseModel();
      res.commandResponse = CommandResponse.Ok;
      res.setContent(artistUrl);
      return res;
    }

    return GenericEmbedService.buildCommandErrorResponse(
      CommandResponse.NotFound,
      `No Apple Music artist link found for **"${query}"**.`,
    );
  }
}
