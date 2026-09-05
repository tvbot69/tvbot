import { ButtonInteraction, MessageFlags } from 'discord.js';
import { ArtistBuilders } from '@bot/builders/artistBuilders';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { MusicBrainzService } from '@bot/services/musicBrainzService';
import { GenreService } from '@bot/services/genreService';
import { UserService } from '@bot/services/userService';
import { ColorService } from '@bot/services/colorService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { prisma } from '@persistence/prismaClient';
import { container } from 'tsyringe';
import { Logger } from '@domain/logger';

export class ArtistInteractions {
  private readonly artistTrackService: ArtistTrackService;
  private readonly musicBrainzService: MusicBrainzService;
  private readonly genreService: GenreService;
  private readonly userService: UserService;
  private readonly colorService: ColorService;
  private readonly spotifySearchApi: SpotifySearchApi;
  private readonly lastfmRepository: LastFmRepository;

  constructor() {
    this.artistTrackService = container.resolve(ArtistTrackService);
    this.musicBrainzService = container.resolve(MusicBrainzService);
    this.genreService = container.resolve(GenreService);
    this.userService = container.resolve(UserService);
    this.colorService = container.resolve(ColorService);
    this.spotifySearchApi = container.resolve(SpotifySearchApi);
    this.lastfmRepository = container.resolve(LastFmRepository);
  }

  public async handle(interaction: ButtonInteraction): Promise<void> {
    const id = interaction.customId;
    if (
      !id.startsWith('artist-overview') &&
      !id.startsWith('artist-info') &&
      !id.startsWith('artist-tracks') &&
      !id.startsWith('artist-albums') &&
      !id.startsWith('aab:')
    ) {
      return;
    }

    try {
      const parts = id.split(':');
      const actionType = parts[0]!;

      // 1) Handle .aab (All Albums) Pagination
      if (actionType === 'aab') {
        const action = parts[1]!;
        const currentPage = Number(parts[2] ?? 0);
        const artistIdentifier = decodeURIComponent(parts[3] ?? '');
        const targetUserId = parts[4] ?? interaction.user.id;
        const authorUserId = parts[5] ?? interaction.user.id;

        const resolvedArtist = await this.resolveArtist(artistIdentifier);
        if (!resolvedArtist) {
          await interaction.deferUpdate().catch(() => undefined);
          return;
        }

        const targetUser = await this.resolveTargetUser(targetUserId, interaction.user.id);
        if (!targetUser) {
          await interaction.deferUpdate().catch(() => undefined);
          return;
        }

        const albums = await this.artistTrackService.getTopAlbumsForArtist(targetUser.userId, resolvedArtist.name);
        const totalArtistPlays = await this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name);
        const perPage = 10;
        const totalPages = Math.max(1, Math.ceil(albums.length / perPage));

        let targetPage = currentPage;
        if (action === 'first') targetPage = 0;
        else if (action === 'prev') targetPage = Math.max(0, currentPage - 1);
        else if (action === 'next') targetPage = Math.min(totalPages - 1, currentPage + 1);
        else if (action === 'last') targetPage = totalPages - 1;

        const displayName = (interaction.guild as any)?.members.cache.get(targetUserId)?.displayName ?? targetUser.userNameLastFm;
        const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

        const response = ArtistBuilders.buildArtistTopAlbumsResponse(
          resolvedArtist.name,
          resolvedArtist.artistId,
          displayName,
          targetUserId,
          authorUserId,
          albums,
          totalArtistPlays,
          albums.length,
          targetPage,
          accentColor,
        );

        await interaction.update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
        return;
      }

      // 2) Handle Artist Nav Views (artist-overview, artist-info, artist-tracks, artist-albums)
      const artistIdentifier = decodeURIComponent(parts[1] ?? '');
      const targetUserId = parts[2] && parts[2] !== '0' ? parts[2] : interaction.user.id;
      const authorUserId = parts[3] && parts[3] !== '0' ? parts[3] : interaction.user.id;

      const resolvedArtist = await this.resolveArtist(artistIdentifier);
      if (!resolvedArtist) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const targetUser = await this.resolveTargetUser(targetUserId, interaction.user.id);
      if (!targetUser) {
        await interaction.deferUpdate().catch(() => undefined);
        return;
      }

      const displayName = (interaction.guild as any)?.members.cache.get(targetUserId)?.displayName ?? targetUser.userNameLastFm;
      const accentColor = await this.colorService.getAccentColorAsync(interaction.guildId);

      // Branch 1: Artist Overview (📊)
      if (actionType === 'artist-overview') {
        const [topTracks, topAlbums, totalPlays, recentPlays, genres, imageUrl] = await Promise.all([
          this.artistTrackService.getTopTracksForArtist(targetUser.userId, resolvedArtist.name),
          this.artistTrackService.getTopAlbumsForArtist(targetUser.userId, resolvedArtist.name),
          this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name),
          this.artistTrackService.getArtistRecentPlays(targetUser.userId, resolvedArtist.name),
          this.genreService.getGenresForArtist(resolvedArtist.name),
          this.getArtistImage(resolvedArtist),
        ]);

        const response = ArtistBuilders.buildArtistOverviewResponse(
          resolvedArtist.name,
          resolvedArtist.artistId,
          displayName,
          targetUserId,
          authorUserId,
          totalPlays,
          recentPlays.month,
          topTracks,
          topAlbums,
          genres,
          imageUrl,
          accentColor,
        );

        await interaction.update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
        return;
      }

      // Branch 2: Artist Info (ℹ️)
      if (actionType === 'artist-info') {
        const [mbData, lfmInfo, serverStats, totalPlays, recentPlays, genres, imageUrl] = await Promise.all([
          this.musicBrainzService.getArtistData(resolvedArtist.name),
          this.lastfmRepository.getArtistInfo(resolvedArtist.name),
          interaction.guildId ? this.artistTrackService.getServerArtistStats(interaction.guildId, resolvedArtist.name) : { serverPlays: 0, serverListeners: 0 },
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

        const response = ArtistBuilders.buildArtistInfoResponse(
          resolvedArtist.name,
          resolvedArtist.artistId,
          displayName,
          targetUserId,
          authorUserId,
          mbData,
          lfmInfo?.summary ?? '',
          serverStats,
          globalStats,
          { userPlays: totalPlays, lastMonthPlays: recentPlays.month, userPercentage },
          genres,
          imageUrl,
          accentColor,
        );

        await interaction.update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
        return;
      }

      // Branch 3: All Tracks (🎶)
      if (actionType === 'artist-tracks') {
        const tracks = await this.artistTrackService.getTopTracksForArtist(targetUser.userId, resolvedArtist.name);
        const totalPlays = await this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name);
        const distinct = tracks.length;

        const response = ArtistTrackBuilders.buildArtistTopTracksResponse(
          resolvedArtist.name,
          displayName,
          tracks,
          totalPlays,
          distinct,
          0,
          accentColor,
          resolvedArtist.artistId,
          targetUserId,
          authorUserId,
        );

        await interaction.update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
        return;
      }

      // Branch 4: All Albums (💽)
      if (actionType === 'artist-albums') {
        const albums = await this.artistTrackService.getTopAlbumsForArtist(targetUser.userId, resolvedArtist.name);
        const totalPlays = await this.artistTrackService.getTotalArtistPlays(targetUser.userId, resolvedArtist.name);
        const distinct = albums.length;

        const response = ArtistBuilders.buildArtistTopAlbumsResponse(
          resolvedArtist.name,
          resolvedArtist.artistId,
          displayName,
          targetUserId,
          authorUserId,
          albums,
          totalPlays,
          distinct,
          0,
          accentColor,
        );

        await interaction.update({
          components: [response.componentsV2Container as any],
          flags: MessageFlags.IsComponentsV2,
        } as any).catch(() => undefined);
        return;
      }
    } catch (err) {
      Logger.error({ err }, 'Artist interaction failed');
      await interaction.deferUpdate().catch(() => undefined);
    }
  }

  private async resolveArtist(identifier: string): Promise<{ artistId: number; name: string } | null> {
    const isNum = !isNaN(Number(identifier)) && Number(identifier) > 0;
    if (isNum) {
      const art = await prisma.artist.findUnique({
        where: { artistId: Number(identifier) },
        select: { artistId: true, name: true, spotifyImageUrl: true, deezerImageUrl: true },
      });
      if (art) return art;
    }

    const name = identifier;
    const art = await prisma.artist.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { artistId: true, name: true, spotifyImageUrl: true, deezerImageUrl: true },
    });
    if (art) return art;

    // Create artist if not found
    try {
      const created = await prisma.artist.create({
        data: { name: name.toLowerCase() },
        select: { artistId: true, name: true, spotifyImageUrl: true, deezerImageUrl: true },
      });
      return created;
    } catch {
      return { artistId: 0, name };
    }
  }

  private async resolveTargetUser(targetDiscordId: string, fallbackDiscordId: string): Promise<any> {
    const user = await this.userService.getUserByDiscordId(targetDiscordId);
    if (user) return user;
    return this.userService.getUserByDiscordId(fallbackDiscordId);
  }

  private async getArtistImage(artist: { artistId: number; name: string; spotifyImageUrl?: string | null; deezerImageUrl?: string | null }): Promise<string | null> {
    if (artist.spotifyImageUrl) return artist.spotifyImageUrl;
    if (artist.deezerImageUrl) return artist.deezerImageUrl;

    // Try to fetch from Spotify API and cache
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
