import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { ResponseModel } from '@bot/models/responseModel';

import type { TopAlbum, TopArtist, TopTrack } from '@domain/models/topLists';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import { ResponseMode } from '@domain/enums/responseMode';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { TopBuildersDeps } from './topBuildersDeps';
import { matchesArtistName, isPlaceholderImageUrl } from '@bot/services/artworkService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { Logger } from '@domain/logger';
import { EMOJI } from '@bot/resources/emojis';

const lastfmArtistUrl = (artist: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}`;
const lastfmAlbumUrl = (artist: string, album: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;
const lastfmTrackUrl = (artist: string, track: string) => `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/_/${encodeURIComponent(track).replace(/%20/g, '+')}`;

function buildPaginatorRow(page: number, totalPages: number, prefix: string, userNameLastFm?: string, timeKey?: string): ActionRowBuilder<ButtonBuilder> {
  const safeUser = userNameLastFm ? encodeURIComponent(userNameLastFm) : 'self';
  const safeTime = timeKey ? encodeURIComponent(timeKey) : 'weekly';
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:first:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageFirst).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:prev:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pagePrevious).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:next:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageNext).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:last:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageLast).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`${prefix}:jump:${page}:${safeUser}:${safeTime}`).setEmoji(EMOJI.pageGoto).setStyle(ButtonStyle.Secondary),
  );
  return row;
}

// Mosaic wallpaper target: 10 large tiles (5 columns x 2 rows).
const MOSAIC_COVER_TARGET = 10;

async function resolveBackgroundCovers(
  deps: TopBuildersDeps,
  userNameLastFm: string,
  timeSettings: TimeSettingsModel,
  preferredCovers: string[],
  artistNames?: string[],
  sampleTrackHint?: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const covers: string[] = [];

  for (const c of preferredCovers) {
    if (c && !isPlaceholderImageUrl(c) && !seen.has(c)) {
      seen.add(c);
      covers.push(c);
      if (covers.length >= MOSAIC_COVER_TARGET) return covers;
    }
  }

  // 1. PRIMARY: Query Spotify official discography for the top artist.
  // Anchored with a track hint when available so same-name artists resolve to
  // the right entity (bare name search picks the most popular namesake).
  if (covers.length < MOSAIC_COVER_TARGET && artistNames && artistNames.length > 0) {
    try {
      if (deps.spotifyApi) {
        const spotifyApi = deps.spotifyApi;
        const topArtist = artistNames[0];
        if (topArtist) {
          let hint = sampleTrackHint;
          if (!hint && deps.artistsService) {
            try {
              const artistsService = deps.artistsService;
              const globalTop = await artistsService.getTopTracksForArtistGlobal(topArtist, 1);
              hint = globalTop[0]?.name;
            } catch {
              // ignore — name-only discography lookup below
            }
          }
          const spotifyCovers = await spotifyApi.getArtistDiscographyCovers(topArtist, hint, 15);
          for (const c of spotifyCovers) {
            if (c && !isPlaceholderImageUrl(c) && !seen.has(c)) {
              seen.add(c);
              covers.push(c);
              if (covers.length >= MOSAIC_COVER_TARGET) return covers;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Supplement from database indexed album covers for top artists (0 HTTP calls)
  if (covers.length < MOSAIC_COVER_TARGET && artistNames && artistNames.length > 0) {
    try {
      if (deps.artistsService) {
        const artistsService = deps.artistsService;
        for (const name of artistNames) {
          if (covers.length >= MOSAIC_COVER_TARGET) break;
          const dbCovers = await artistsService.getIndexedAlbumCoversForArtist(name, 5);
          for (const c of dbCovers) {
            if (c && !isPlaceholderImageUrl(c) && !seen.has(c)) {
              seen.add(c);
              covers.push(c);
              if (covers.length >= MOSAIC_COVER_TARGET) return covers;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback: query Deezer for the top artists (unlimited, no rate limits, high-res).
  // Deezer search is fuzzy — only accept albums actually credited to the artist,
  // otherwise same-name/wrong-artist covers leak into the mosaic.
  if (covers.length < MOSAIC_COVER_TARGET && artistNames && artistNames.length > 0) {
    try {
      if (deps.deezerApi) {
        const deezerApi = deps.deezerApi;
        for (const name of artistNames.slice(0, 5)) {
          if (covers.length >= MOSAIC_COVER_TARGET) break;
          const deezerAlbums = await deezerApi.searchAlbums(name, 5).catch(() => []);
          for (const da of deezerAlbums) {
            if (!matchesArtistName(da.artist?.name ?? '', name)) continue;
            const cover = da.cover_xl ?? da.cover_big ?? da.cover_medium ?? da.cover;
            if (cover && !seen.has(cover)) {
              seen.add(cover);
              covers.push(cover);
              if (covers.length >= MOSAIC_COVER_TARGET) break;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Emergency Last Resort Fallback ONLY: Last.fm user top albums
  if (covers.length < MOSAIC_COVER_TARGET) {
    try {
      if (deps.lastfmRepo) {
        const lastfmRepo = deps.lastfmRepo;
        const albums = await lastfmRepo.getTopAlbums(
          userNameLastFm,
          timeSettings.timePeriod,
          25,
          1,
        ).catch(() => []);

        for (const alb of albums) {
          if (alb.imageUrl && !isPlaceholderImageUrl(alb.imageUrl) && !seen.has(alb.imageUrl)) {
            seen.add(alb.imageUrl);
            covers.push(alb.imageUrl);
            if (covers.length >= MOSAIC_COVER_TARGET) return covers;
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
  deps: TopBuildersDeps,
  topArtists: TopArtist[],
  seedImage?: string,
): Promise<string[]> {
  const images: string[] = [];
  const seen = new Set<string>();

  if (seedImage && !isPlaceholderImageUrl(seedImage)) {
    seen.add(seedImage);
    images.push(seedImage);
  }

  // 1. Seed with any valid non-placeholder images already on topArtists
  for (const a of topArtists) {
    if (a.imageUrl && !isPlaceholderImageUrl(a.imageUrl) && !seen.has(a.imageUrl)) {
      seen.add(a.imageUrl);
      images.push(a.imageUrl);
      if (images.length >= MOSAIC_COVER_TARGET) return images;
    }
  }

  // 2. Query ArtistsService.fillArtistImages (batch queries DB and ArtworkService)
  try {
    if (deps.artistsService) {
      const artistsService = deps.artistsService;
      const hydrated = await artistsService.fillArtistImages(topArtists.slice(0, MOSAIC_COVER_TARGET));
      for (const a of hydrated) {
        if (a.imageUrl && !isPlaceholderImageUrl(a.imageUrl) && !seen.has(a.imageUrl)) {
          seen.add(a.imageUrl);
          images.push(a.imageUrl);
          if (images.length >= MOSAIC_COVER_TARGET) return images;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Fallback: resolve missing artist images directly via ArtworkService
  if (images.length < MOSAIC_COVER_TARGET && deps.artworkService) {
    try {
      const artworkService = deps.artworkService;
      for (const a of topArtists.slice(0, MOSAIC_COVER_TARGET)) {
        if (images.length >= MOSAIC_COVER_TARGET) break;
        if (a.imageUrl && seen.has(a.imageUrl)) continue;
        const img = await artworkService.getArtistImageUrl(a.name);
        if (img && !isPlaceholderImageUrl(img) && !seen.has(img)) {
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
    deps: TopBuildersDeps,
    userNameLastFm: string,
    displayName: string,
    topArtists: TopArtist[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topArtists.length > 0 && deps.generator) {
      try {
        const generator = deps.generator;
        const topItem = topArtists[0]!;
        let targetImage: string | undefined = undefined;
        if (deps.artworkService) {
          targetImage = (await deps.artworkService.getArtistImageUrl(topItem.name)) ?? undefined;
        }
        if (!targetImage || isPlaceholderImageUrl(targetImage)) {
          targetImage = topItem.imageUrl && !isPlaceholderImageUrl(topItem.imageUrl) ? topItem.imageUrl : undefined;
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
      deps,
          topArtists.slice(0, 10),
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
    response._paginatorData = { type: 'artists', userNameLastFm, displayName, timeSettings, items: topArtists, accentColor };
    return response;
  }

  public static async buildTopAlbumsResponse(
    deps: TopBuildersDeps,
    userNameLastFm: string,
    displayName: string,
    topAlbums: TopAlbum[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topAlbums.length > 0 && deps.generator) {
      try {
        const generator = deps.generator;
        const topItem = topAlbums[0]!;
        let targetImage: string | undefined = undefined;
        if (deps.artworkService) {
          targetImage = (await deps.artworkService.getAlbumCoverUrl(topItem.name, topItem.artistName)) ?? undefined;
        }
        if (!targetImage || isPlaceholderImageUrl(targetImage)) {
          targetImage = topItem.imageUrl && !isPlaceholderImageUrl(topItem.imageUrl) ? topItem.imageUrl : undefined;
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
      deps,
          userNameLastFm,
          timeSettings,
          targetImage ? [targetImage] : [],
          topAlbums.slice(0, 5).map((a) => a.artistName),
          topAlbums[0]?.name,
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
    response._paginatorData = { type: 'albums', userNameLastFm, displayName, timeSettings, items: topAlbums, accentColor };
    return response;
  }

  public static async buildTopTracksResponse(
    deps: TopBuildersDeps,
    userNameLastFm: string,
    displayName: string,
    topTracks: TopTrack[],
    timeSettings: TimeSettingsModel,
    page: number = 0,
    accentColor?: number,
    mode?: ResponseMode,
  ): Promise<ResponseModel> {
    if (mode === ResponseMode.Image && topTracks.length > 0 && deps.generator) {
      try {
        const generator = deps.generator;
        const topItem = topTracks[0]!;
        let targetImage: string | undefined = undefined;
        if (deps.artworkService) {
          targetImage = (await deps.artworkService.getTrackCoverUrl(topItem.name, topItem.artistName)) ?? undefined;
        }
        if (!targetImage || isPlaceholderImageUrl(targetImage)) {
          targetImage = topItem.imageUrl && !isPlaceholderImageUrl(topItem.imageUrl) ? topItem.imageUrl : undefined;
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
      deps,
          userNameLastFm,
          timeSettings,
          targetImage ? [targetImage] : [],
          topTracks.slice(0, 5).map((t) => t.artistName),
          topTracks[0]?.name,
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
    response._paginatorData = { type: 'tracks', userNameLastFm, displayName, timeSettings, items: topTracks, accentColor };
    return response;
  }
}
