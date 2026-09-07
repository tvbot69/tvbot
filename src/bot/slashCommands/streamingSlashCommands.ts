import { SlashCommandBuilder } from 'discord.js';
import { inject, injectable } from 'tsyringe';
import type { ISlashCommandModule, SlashCommandDefinition } from '@bot/models/commandModels';
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
export class StreamingSlashCommands implements ISlashCommandModule {
  public commands: SlashCommandDefinition[];

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
        data: new SlashCommandBuilder()
          .setName('spotify')
          .setDescription('Get Spotify links for tracks, albums, or your currently playing music')
          .addSubcommand((sub) =>
            sub
              .setName('track')
              .setDescription('Get Spotify link for a track or your currently playing track')
              .addStringOption((opt) =>
                opt.setName('query').setDescription('Song name or artist (leave empty for current song)').setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('album')
              .setDescription('Get Spotify link for an album or your currently playing album')
              .addStringOption((opt) =>
                opt.setName('query').setDescription('Album name or artist (leave empty for current album)').setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName('artist')
              .setDescription('Get Spotify link for an artist')
              .addStringOption((opt) =>
                opt.setName('query').setDescription('Artist name (leave empty for current artist)').setRequired(false),
              ),
          ),
        executeAsync: (ctx) => {
          const sub = ctx.interaction?.options.getSubcommand() || 'track';
          if (sub === 'album') return this.spotifyAlbumSlashAsync(ctx);
          if (sub === 'artist') return this.spotifyArtistSlashAsync(ctx);
          return this.spotifyTrackSlashAsync(ctx);
        },
      },
      {
        data: new SlashCommandBuilder()
          .setName('applemusic')
          .setDescription('Get Apple Music links for songs, albums, or your currently playing music')
          .addStringOption((opt) =>
            opt.setName('query').setDescription('Song, album, or artist name (leave empty for current song)').setRequired(false),
          )
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Search type (default: Song)')
              .setRequired(false)
              .addChoices(
                { name: 'Song / Track', value: 'song' },
                { name: 'Album', value: 'album' },
                { name: 'Artist', value: 'artist' },
              ),
          ),
        executeAsync: (ctx) => this.appleMusicSlashAsync(ctx),
      },
    ];
  }

  private async resolveQuery(
    ctx: ContextModel,
    cmdSlash: string,
  ): Promise<{ query: string } | { errorResponse: ResponseModel }> {
    const raw = ctx.interaction?.options.getString('query')?.trim();
    if (raw) return { query: raw };

    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return {
        errorResponse: GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Link your account with \`/login\` or specify a track name (\`${cmdSlash}\`).`,
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
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify a track name (\`${cmdSlash}\`).`,
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
            `Could not determine track details from your recent scrobbles. Specify a track name (\`${cmdSlash}\`).`,
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
    cmdSlash: string,
  ): Promise<{ query: string } | { errorResponse: ResponseModel }> {
    const raw = ctx.interaction?.options.getString('query')?.trim();
    if (raw) return { query: raw };

    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return {
        errorResponse: GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Link your account with \`/login\` or specify an album name (\`${cmdSlash}\`).`,
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
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify an album name (\`${cmdSlash}\`).`,
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
            `Could not determine album details from your recent scrobbles. Specify an album name (\`${cmdSlash}\`).`,
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
    cmdSlash: string,
  ): Promise<{ query: string } | { errorResponse: ResponseModel }> {
    const raw = ctx.interaction?.options.getString('query')?.trim();
    if (raw) return { query: raw };

    const user = await this.userService.getUserByDiscordId(ctx.discordUserId);
    if (!user || !user.userNameLastFm) {
      return {
        errorResponse: GenericEmbedService.buildCommandErrorResponse(
          CommandResponse.NotFound,
          `You have not connected your Last.fm account yet. Link your account with \`/login\` or specify an artist name (\`${cmdSlash}\`).`,
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
            `No recent tracks found for Last.fm user **${user.userNameLastFm}**. Specify an artist name (\`${cmdSlash}\`).`,
          ),
        };
      }

      const track = recents.find((t) => t.nowPlaying) ?? recents[0]!;
      const artist = track.artistName ?? (track as any).artist?.name ?? '';
      if (!artist) {
        return {
          errorResponse: GenericEmbedService.buildCommandErrorResponse(
            CommandResponse.NotFound,
            `Could not determine artist details from your recent scrobbles. Specify an artist name (\`${cmdSlash}\`).`,
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

  public async spotifyTrackSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveQuery(ctx, '/spotify track query:<song name>');
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

      // Fallback to album search
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

  public async spotifyAlbumSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveAlbumQuery(ctx, '/spotify album query:<album name>');
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

  public async spotifyArtistSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const resolved = await this.resolveArtistQuery(ctx, '/spotify artist query:<artist name>');
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

  public async appleMusicSlashAsync(ctx: ContextModel): Promise<ResponseModel> {
    const type = ctx.interaction?.options.getString('type') ?? 'song';

    if (type === 'album') {
      const resolved = await this.resolveAlbumQuery(ctx, '/applemusic query:<album name>');
      if ('errorResponse' in resolved) return resolved.errorResponse;
      const albumUrl = await this.appleMusicService.searchAlbum(resolved.query);
      if (albumUrl) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(albumUrl);
        return res;
      }
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No Apple Music album found for **"${resolved.query}"**.`,
      );
    }

    if (type === 'artist') {
      const resolved = await this.resolveArtistQuery(ctx, '/applemusic query:<artist name>');
      if ('errorResponse' in resolved) return resolved.errorResponse;
      const artistUrl = await this.appleMusicService.searchArtist(resolved.query);
      if (artistUrl) {
        const res = new ResponseModel();
        res.commandResponse = CommandResponse.Ok;
        res.setContent(artistUrl);
        return res;
      }
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        `No Apple Music artist found for **"${resolved.query}"**.`,
      );
    }

    const resolved = await this.resolveQuery(ctx, '/applemusic query:<song name>');
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
}
