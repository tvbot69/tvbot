import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';
import { DiscordConstants } from '@bot/resources/discordConstants';
import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import { ResponseMode } from '@domain/enums/responseMode';
import { CommandResponse } from '@domain/enums/commandResponse';
import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ArtworkService } from '@bot/services/artworkService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { Logger } from '@domain/logger';

const lastfmArtistUrl = (artist: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;
const lastfmAlbumUrl = (artist: string, album: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;
const lastfmTrackUrl = (artist: string, track: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

function buildPaginatorRow(page: number, totalPages: number, prefix: string, userNameLastFm?: string, timeKey?: string): ActionRowBuilder<ButtonBuilder> {
  const safeUser = userNameLastFm ? encodeURIComponent(userNameLastFm) : 'self';
  const safeTime = timeKey ? encodeURIComponent(timeKey) : 'weekly';
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:first:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508633182208', name: 'pages_first' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:prev:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508507336704', name: 'pages_previous' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:next:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508087922739', name: 'pages_next' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:last:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '883825508482183258', name: 'pages_last' } as any).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:jump:${page}:${safeUser}:${safeTime}`).setEmoji({ id: '1138849626234036264', name: 'pages_goto' } as any).setStyle(ButtonStyle.Secondary),
  );
  return row;
}

async function resolveBackgroundCovers(
  userNameLastFm: string,
  timeSettings: TimeSettingsModel,
  preferredCovers: string[],
  artistNames?: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const covers: string[] = [];

  for (const c of preferredCovers) {
    if (c && !c.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(c)) {
      seen.add(c);
      covers.push(c);
      if (covers.length >= 21) return covers;
    }
  }

  // 1. PRIMARY: Query Spotify official discography for the top artist (up to 25 covers in ONE single call)
  if (covers.length < 21 && artistNames && artistNames.length > 0) {
    try {
      const { SpotifySearchApi } = await import('@spotify/api/spotifySearchApi');
      if (container.isRegistered(SpotifySearchApi)) {
        const spotifyApi = container.resolve(SpotifySearchApi);
        const topArtist = artistNames[0];
        if (topArtist) {
          const spotifyCovers = await spotifyApi.getArtistDiscographyCovers(topArtist, undefined, 25);
          for (const c of spotifyCovers) {
            if (c && !c.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(c)) {
              seen.add(c);
              covers.push(c);
              if (covers.length >= 21) return covers;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Supplement from database indexed album covers for top artists (0 HTTP calls)
  if (covers.length < 21 && artistNames && artistNames.length > 0) {
    try {
      const { ArtistsService } = await import('@bot/services/artistsService');
      if (container.isRegistered(ArtistsService)) {
        const artistsService = container.resolve(ArtistsService);
        for (const name of artistNames) {
          if (covers.length >= 21) break;
          const dbCovers = await artistsService.getIndexedAlbumCoversForArtist(name, 5);
          for (const c of dbCovers) {
            if (c && !c.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(c)) {
              seen.add(c);
              covers.push(c);
              if (covers.length >= 21) return covers;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback: query Deezer for the top artists (unlimited, no rate limits, high-res)
  if (covers.length < 21 && artistNames && artistNames.length > 0) {
    try {
      const { DeezerApi } = await import('@deezer/apis/deezerApi');
      if (container.isRegistered(DeezerApi)) {
        const deezerApi = container.resolve(DeezerApi);
        for (const name of artistNames.slice(0, 5)) {
          if (covers.length >= 21) break;
          const deezerAlbums = await deezerApi.searchAlbums(name, 5).catch(() => []);
          for (const da of deezerAlbums) {
            const cover = da.cover_xl ?? da.cover_big ?? da.cover_medium ?? da.cover;
            if (cover && !seen.has(cover)) {
              seen.add(cover);
              covers.push(cover);
              if (covers.length >= 21) break;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Emergency Last Resort Fallback ONLY: Last.fm user top albums
  if (covers.length < 21) {
    try {
      const { LastFmRepository } = await import('@lastfm/repositories/lastFmRepository');
      if (container.isRegistered(LastFmRepository)) {
        const lastfmRepo = container.resolve(LastFmRepository);
        const albums = await lastfmRepo.getTopAlbums(
          userNameLastFm,
          timeSettings.timePeriod as any,
          25,
          1,
        ).catch(() => []);

        for (const alb of albums) {
          if (alb.imageUrl && !alb.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(alb.imageUrl)) {
            seen.add(alb.imageUrl);
            covers.push(alb.imageUrl);
            if (covers.length >= 21) return covers;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return covers;
}

async function resolveArtistImages(
  topArtists: TopArtist[],
  seedImage?: string,
): Promise<string[]> {
  const images: string[] = [];
  const seen = new Set<string>();

  if (seedImage && !seedImage.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
    seen.add(seedImage);
    images.push(seedImage);
  }

  // 1. Seed with any valid non-placeholder images already on topArtists
  for (const a of topArtists) {
    if (a.imageUrl && !a.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(a.imageUrl)) {
      seen.add(a.imageUrl);
      images.push(a.imageUrl);
      if (images.length >= 21) return images;
    }
  }

  // 2. Query ArtistsService.fillArtistImages (batch queries DB and ArtworkService)
  try {
    const { ArtistsService } = await import('@bot/services/artistsService');
    if (container.isRegistered(ArtistsService)) {
      const artistsService = container.resolve(ArtistsService);
      const hydrated = await artistsService.fillArtistImages(topArtists.slice(0, 21));
      for (const a of hydrated) {
        if (a.imageUrl && !a.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(a.imageUrl)) {
          seen.add(a.imageUrl);
          images.push(a.imageUrl);
          if (images.length >= 21) return images;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Fallback: resolve missing artist images directly via ArtworkService
  if (images.length < 15 && container.isRegistered(ArtworkService)) {
    try {
      const artworkService = container.resolve(ArtworkService);
      for (const a of topArtists.slice(0, 15)) {
        if (images.length >= 21) break;
        if (a.imageUrl && seen.has(a.imageUrl)) continue;
        const img = await artworkService.getArtistImageUrl(a.name);
        if (img && !img.includes('2a96cbd8b46e442fc41c2b86b821562f') && !seen.has(img)) {
          seen.add(img);
          images.push(img);
        }
      }
    } catch {
      // ignore
    }
  }

  return images;
}


export class TopBuilders {
  public static async buildTopArtistsResponse(
    userNameLastFm: string,
    displayName: string,
    topArtists: TopArtist[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topArtists.length > 0 && container.isRegistered(WhoKnowsGenerator)) {
      try {
        const generator = container.resolve(WhoKnowsGenerator);
        const topItem = topArtists[0]!;
        let targetImage: string | undefined = undefined;
        if (container.isRegistered(ArtworkService)) {
          targetImage = (await container.resolve(ArtworkService).getArtistImageUrl(topItem.name)) ?? undefined;
        }
        if (!targetImage || targetImage.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
          targetImage = topItem.imageUrl && !topItem.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') ? topItem.imageUrl : undefined;
        }

        const users: WhoKnowsUser[] = topArtists.slice(0, 10).map((a, idx) => ({
          userId: idx + 1,
          discordUserId: '0',
          discordName: a.name,
          lastFmUsername: a.name,
          playcount: a.playcount,
          hasCrown: idx === 0,
        }));

        const backgroundCovers = await resolveArtistImages(
          topArtists.slice(0, 21),
          targetImage,
        );

        const totalPlays = topArtists.reduce((sum, a) => sum + a.playcount, 0);
        const avgPlays = topArtists.length > 0 ? Math.floor(totalPlays / topArtists.length) : 0;

        const stats = [
          { value: totalPlays, label: `${timeSettings.description} Plays` },
          { value: topArtists.length, label: 'Artists' },
          { value: avgPlays, label: 'Avg / Artist' },
        ];

        const topTracks = topArtists.slice(0, 3).map((a) => `${a.name} (${a.playcount.toLocaleString()})`);

        const imageBuffer = await generator.generateWhoKnowsImage({
          type: `Top ${timeSettings.description} Artists`,
          title: displayName,
          location: timeSettings.description,
          imageUrl: targetImage,
          users,
          backgroundCovers: backgroundCovers.length > 0 ? backgroundCovers : undefined,
          topItemLabel: '#1 Artist',
          topItemValue: topItem.name,
          topItemExtra: `${topItem.playcount.toLocaleString()} plays`,
          stats,
          topTracks,
          topListHeader: 'Top 3 Artists',
          footerItemLabel: 'artists',
        });

        const response = new ResponseModel(accentColor);
        response.commandResponse = CommandResponse.Ok;
        response.setFile(imageBuffer, 'topartists.png');
        return response;
      } catch (err) {
        Logger.error({ err }, 'Failed to generate Top Artists image, falling back to embed');
      }
    }

    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topArtists.length / perPage));
    const slice = topArtists.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topArtists.length;

    const description = slice.map((a, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **[${a.name}](${lastfmArtistUrl(a.name)})** - *${a.playcount} ${a.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} artists for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/artists?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No artists found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different artists` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'topartists', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'artists', userNameLastFm, displayName, timeSettings, items: topArtists, accentColor };
    return response;
  }

  public static async buildTopAlbumsResponse(
    userNameLastFm: string,
    displayName: string,
    topAlbums: TopAlbum[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topAlbums.length > 0 && container.isRegistered(WhoKnowsGenerator)) {
      try {
        const generator = container.resolve(WhoKnowsGenerator);
        const topItem = topAlbums[0]!;
        let targetImage: string | undefined = undefined;
        if (container.isRegistered(ArtworkService)) {
          targetImage = (await container.resolve(ArtworkService).getAlbumCoverUrl(topItem.name, topItem.artistName)) ?? undefined;
        }
        if (!targetImage || targetImage.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
          targetImage = topItem.imageUrl && !topItem.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') ? topItem.imageUrl : undefined;
        }

        const users: WhoKnowsUser[] = topAlbums.slice(0, 10).map((a, idx) => ({
          userId: idx + 1,
          discordUserId: '0',
          discordName: `${a.artistName} - ${a.name}`,
          lastFmUsername: `${a.artistName} - ${a.name}`,
          playcount: a.playcount,
          hasCrown: idx === 0,
        }));

        const backgroundCovers = await resolveBackgroundCovers(
          userNameLastFm,
          timeSettings,
          targetImage ? [targetImage] : [],
          topAlbums.slice(0, 5).map((a) => a.artistName),
        );

        const totalPlays = topAlbums.reduce((sum, a) => sum + a.playcount, 0);
        const avgPlays = topAlbums.length > 0 ? Math.floor(totalPlays / topAlbums.length) : 0;

        const stats = [
          { value: totalPlays, label: `${timeSettings.description} Plays` },
          { value: topAlbums.length, label: 'Albums' },
          { value: avgPlays, label: 'Avg / Album' },
        ];

        const topTracks = topAlbums.slice(0, 3).map((a) => `${a.name} (${a.playcount.toLocaleString()})`);

        const imageBuffer = await generator.generateWhoKnowsImage({
          type: `Top ${timeSettings.description} Albums`,
          title: displayName,
          location: timeSettings.description,
          imageUrl: targetImage,
          users,
          backgroundCovers: backgroundCovers.length > 0 ? backgroundCovers : undefined,
          topItemLabel: '#1 Album',
          topItemValue: `${topItem.artistName} - ${topItem.name}`,
          topItemExtra: `${topItem.playcount.toLocaleString()} plays`,
          stats,
          topTracks,
          topListHeader: 'Top 3 Albums',
          footerItemLabel: 'albums',
        });

        const response = new ResponseModel(accentColor);
        response.commandResponse = CommandResponse.Ok;
        response.setFile(imageBuffer, 'topalbums.png');
        return response;
      } catch (err) {
        Logger.error({ err }, 'Failed to generate Top Albums image, falling back to embed');
      }
    }

    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topAlbums.length / perPage));
    const slice = topAlbums.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topAlbums.length;

    const description = slice.map((a, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **${a.artistName}** - **[${a.name}](${lastfmAlbumUrl(a.artistName, a.name)})** - *${a.playcount} ${a.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} albums for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/albums?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No albums found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different albums` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'topalbums', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'albums', userNameLastFm, displayName, timeSettings, items: topAlbums, accentColor };
    return response;
  }

  public static async buildTopTracksResponse(
    userNameLastFm: string,
    displayName: string,
    topTracks: TopTrack[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topTracks.length > 0 && container.isRegistered(WhoKnowsGenerator)) {
      try {
        const generator = container.resolve(WhoKnowsGenerator);
        const topItem = topTracks[0]!;
        let targetImage: string | undefined = undefined;
        if (container.isRegistered(ArtworkService)) {
          targetImage = (await container.resolve(ArtworkService).getTrackCoverUrl(topItem.name, topItem.artistName)) ?? undefined;
        }
        if (!targetImage || targetImage.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
          targetImage = topItem.imageUrl && !topItem.imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') ? topItem.imageUrl : undefined;
        }

        const users: WhoKnowsUser[] = topTracks.slice(0, 10).map((t, idx) => ({
          userId: idx + 1,
          discordUserId: '0',
          discordName: `${t.artistName} - ${t.name}`,
          lastFmUsername: `${t.artistName} - ${t.name}`,
          playcount: t.playcount,
          hasCrown: idx === 0,
        }));

        const backgroundCovers = await resolveBackgroundCovers(
          userNameLastFm,
          timeSettings,
          targetImage ? [targetImage] : [],
          topTracks.slice(0, 5).map((t) => t.artistName),
        );

        const totalPlays = topTracks.reduce((sum, t) => sum + t.playcount, 0);
        const avgPlays = topTracks.length > 0 ? Math.floor(totalPlays / topTracks.length) : 0;

        const stats = [
          { value: totalPlays, label: `${timeSettings.description} Plays` },
          { value: topTracks.length, label: 'Tracks' },
          { value: avgPlays, label: 'Avg / Track' },
        ];

        const topTracksSummary = topTracks.slice(0, 3).map((t) => `${t.name} (${t.playcount.toLocaleString()})`);

        const imageBuffer = await generator.generateWhoKnowsImage({
          type: `Top ${timeSettings.description} Tracks`,
          title: displayName,
          location: timeSettings.description,
          imageUrl: targetImage,
          users,
          backgroundCovers: backgroundCovers.length > 0 ? backgroundCovers : undefined,
          topItemLabel: '#1 Track',
          topItemValue: `${topItem.artistName} - ${topItem.name}`,
          topItemExtra: `${topItem.playcount.toLocaleString()} plays`,
          stats,
          topTracks: topTracksSummary,
          topListHeader: 'Top 3 Tracks',
          footerItemLabel: 'tracks',
        });

        const response = new ResponseModel(accentColor);
        response.commandResponse = CommandResponse.Ok;
        response.setFile(imageBuffer, 'toptracks.png');
        return response;
      } catch (err) {
        Logger.error({ err }, 'Failed to generate Top Tracks image, falling back to embed');
      }
    }

    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(topTracks.length / perPage));
    const slice = topTracks.slice(page * perPage, (page + 1) * perPage);
    const totalAmount = topTracks.length;

    const description = slice.map((t, idx) => {
      const rank = page * perPage + idx + 1;
      return `${rank}. **${t.artistName}** - **[${t.name}](${lastfmTrackUrl(t.artistName, t.name)})** - *${t.playcount} ${t.playcount === 1 ? 'play' : 'plays'}*`;
    }).join('\n');

    const response = new ResponseModel(accentColor);
    response.embed = new EmbedBuilder()
      .setAuthor({ name: `Top ${timeSettings.description.toLowerCase()} tracks for ${displayName}`, url: `https://www.last.fm/user/${encodeURIComponent(userNameLastFm)}/library/tracks?date_preset=${timeSettings.urlParameter || 'LAST_7_DAYS'}` })
      .setDescription(description || 'No tracks found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} - ${totalAmount} different tracks` });
    if (accentColor !== undefined && accentColor !== null) {
      response.embed.setColor(accentColor);
    }

    response.addButtonRow(0, buildPaginatorRow(page, totalPages, 'toptracks', userNameLastFm, timeSettings.description));
    (response as any)._paginatorData = { type: 'tracks', userNameLastFm, displayName, timeSettings, items: topTracks, accentColor };
    return response;
  }
}
