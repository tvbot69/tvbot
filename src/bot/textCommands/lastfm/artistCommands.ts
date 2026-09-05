import type { ITextCommandModule, TextCommandDefinition } from '@bot/models/commandModels';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import { UserService } from '@bot/services/userService';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { MusicBrainzService } from '@bot/services/musicBrainzService';
import { GenreService } from '@bot/services/genreService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { ArtistBuilders } from '@bot/builders/artistBuilders';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UpdateService } from '@bot/services/updateService';
import { prisma } from '@persistence/prismaClient';

export class ArtistCommands implements ITextCommandModule {
  public commands: TextCommandDefinition[];

  constructor(
    private readonly userService: UserService,
    private readonly artistTrackService: ArtistTrackService,
    private readonly musicBrainzService: MusicBrainzService,
    private readonly genreService: GenreService,
    private readonly spotifySearchApi: SpotifySearchApi,
    private readonly lastfmRepository: LastFmRepository,
    private readonly updateService: UpdateService,
  ) {
    this.commands = [
      {
        name: 'artist',
        aliases: ['a'],
        executeAsync: (ctx, args) => this.artistInfoAsync(ctx, args.join(' ')),
      },
      {
        name: 'artistoverview',
        aliases: ['ao', 'artistov', 'aov'],
        executeAsync: (ctx, args) => this.artistOverviewAsync(ctx, args.join(' ')),
      },
      {
        name: 'artistalbums',
        aliases: ['aab', 'artistalbum'],
        executeAsync: (ctx, args) => this.artistAlbumsAsync(ctx, args.join(' ')),
      },
    ];
  }

  private async artistInfoAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const { artistName, targetUser } = await this.resolveArtistAndUser(context, user, raw);
    if (!artistName) return GenericEmbedService.buildNotFoundResponse('No recent tracks found.');

    const resolvedArtist = await this.getOrCreateArtist(artistName);
    const [mbData, lfmInfo, serverStats, totalPlays, recentPlays, genres, imageUrl] = await Promise.all([
      this.musicBrainzService.getArtistData(resolvedArtist.name),
      this.lastfmRepository.getArtistInfo(resolvedArtist.name),
      context.guildId ? this.artistTrackService.getServerArtistStats(context.guildId, resolvedArtist.name) : { serverPlays: 0, serverListeners: 0 },
      this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name),
      this.artistTrackService.getArtistRecentPlays(targetUser.userId, resolvedArtist.name),
      this.genreService.getGenresForArtist(resolvedArtist.name),
      this.getArtistImage(resolvedArtist),
    ]);

    const userPercentage = targetUser.totalPlayCount && targetUser.totalPlayCount > 0 && totalPlays > 0
      ? (totalPlays / targetUser.totalPlayCount) * 100
      : 0;

    const globalStats = {
      globalPlays: lfmInfo?.playCount ?? 0,
      globalListeners: lfmInfo?.listeners ?? 0,
    };

    const displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? targetUser.userNameLastFm;

    return ArtistBuilders.buildArtistInfoResponse(
      resolvedArtist.name,
      resolvedArtist.artistId,
      displayName,
      context.discordUserId,
      context.discordUserId,
      mbData,
      lfmInfo?.summary ?? '',
      serverStats,
      globalStats,
      { userPlays: totalPlays, lastMonthPlays: recentPlays.month, userPercentage },
      genres,
      imageUrl,
      context.accentColor,
    );
  }

  private async artistOverviewAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const { artistName, targetUser } = await this.resolveArtistAndUser(context, user, raw);
    if (!artistName) return GenericEmbedService.buildNotFoundResponse('No recent tracks found.');

    const resolvedArtist = await this.getOrCreateArtist(artistName);
    const [topTracks, topAlbums, totalPlays, recentPlays, genres, imageUrl] = await Promise.all([
      this.artistTrackService.getTopTracksForArtist(targetUser.userId, resolvedArtist.name),
      this.artistTrackService.getTopAlbumsForArtist(targetUser.userId, resolvedArtist.name),
      this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name),
      this.artistTrackService.getArtistRecentPlays(targetUser.userId, resolvedArtist.name),
      this.genreService.getGenresForArtist(resolvedArtist.name),
      this.getArtistImage(resolvedArtist),
    ]);

    const displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? targetUser.userNameLastFm;

    return ArtistBuilders.buildArtistOverviewResponse(
      resolvedArtist.name,
      resolvedArtist.artistId,
      displayName,
      context.discordUserId,
      context.discordUserId,
      totalPlays,
      recentPlays.month,
      topTracks,
      topAlbums,
      genres,
      imageUrl,
      context.accentColor,
    );
  }

  private async artistAlbumsAsync(context: ContextModel, raw: string): Promise<ResponseModel> {
    const user = await this.userService.getUserByDiscordId(context.discordUserId);
    if (!user) {
      return GenericEmbedService.buildCommandErrorResponse(
        CommandResponse.NotFound,
        'You have not connected your Last.fm account yet. Use the register command first.',
      );
    }

    if (UpdateService.needsUpdate(user, 2)) {
      void this.updateService.updateUser(user.userId, { accurateTotal: true });
    }

    const { artistName, targetUser } = await this.resolveArtistAndUser(context, user, raw);
    if (!artistName) return GenericEmbedService.buildNotFoundResponse('No recent tracks found.');

    const resolvedArtist = await this.getOrCreateArtist(artistName);
    const albums = await this.artistTrackService.getTopAlbumsForArtist(targetUser.userId, resolvedArtist.name);
    const totalArtistPlays = await this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name);
    const distinct = albums.length;
    const displayName = context.guild?.members.cache.get(context.discordUserId)?.displayName ?? targetUser.userNameLastFm;

    return ArtistBuilders.buildArtistTopAlbumsResponse(
      resolvedArtist.name,
      resolvedArtist.artistId,
      displayName,
      context.discordUserId,
      context.discordUserId,
      albums,
      totalArtistPlays,
      distinct,
      0,
      context.accentColor,
    );
  }

  private async resolveArtistAndUser(context: ContextModel, selfUser: any, raw: string): Promise<{ artistName: string; targetUser: any }> {
    let artistName = raw.trim();
    const targetUser = selfUser;

    if (!artistName) {
      const recent = await this.lastfmRepository.getUserRecentTracks(selfUser.userNameLastFm, 1, 1, undefined, selfUser.sessionKey);
      if (recent && recent.length > 0) {
        artistName = recent[0]!.artistName;
      }
    } else {
      const search = await this.lastfmRepository.searchArtists(artistName);
      if (search.length > 0) artistName = search[0]!.name;
    }

    return { artistName, targetUser };
  }

  private async getOrCreateArtist(name: string): Promise<{ artistId: number; name: string; spotifyImageUrl?: string | null; deezerImageUrl?: string | null }> {
    const existing = await prisma.artist.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { artistId: true, name: true, spotifyImageUrl: true, deezerImageUrl: true },
    });
    if (existing) return existing;

    try {
      return await prisma.artist.create({
        data: { name: name.toLowerCase() },
        select: { artistId: true, name: true, spotifyImageUrl: true, deezerImageUrl: true },
      });
    } catch {
      return { artistId: 0, name };
    }
  }

  private async getArtistImage(artist: { artistId: number; name: string; spotifyImageUrl?: string | null; deezerImageUrl?: string | null }): Promise<string | null> {
    if (artist.spotifyImageUrl) return artist.spotifyImageUrl;
    if (artist.deezerImageUrl) return artist.deezerImageUrl;

    try {
      const spotifyArtists = await this.spotifySearchApi.searchArtists(artist.name, 1);
      const firstArtist = spotifyArtists?.[0];
      if (firstArtist?.images && firstArtist.images.length > 0 && firstArtist.images[0]?.url) {
        const url = firstArtist.images[0].url;
        if (artist.artistId > 0) {
          await prisma.artist.update({
            where: { artistId: artist.artistId },
            data: { spotifyImageUrl: url, spotifyImageDate: new Date() },
          }).catch(() => undefined);
        }
        return url;
      }
    } catch {
      // Ignore
    }

    return null;
  }
}
