import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import type { WhoKnowsUser, FilterStats } from '@bot/models/whoKnowsModels';
import { DiscordConstants } from '@bot/resources/discordConstants';

import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ArtistsService } from '@bot/services/artistsService';
import { AlbumService } from '@bot/services/albumService';
import { ArtworkService, matchesArtistName } from '@bot/services/artworkService';
import { UserService } from '@bot/services/userService';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { Logger } from '@domain/logger';

export class WhoKnowsBuilders {
  public static async buildWhoKnowsResponse(
    context: ContextModel,
    title: string,
    url: string,
    thumbnailUrl: string | null | undefined,
    users: WhoKnowsUser[],
    filterStats?: FilterStats,
    guildAlsoPlaying?: string | null,
    genres?: string[],
    closeFriendUserIds?: Set<number>,
    mode: WhoKnowsMode = WhoKnowsMode.Default,
    footerExtra?: string,
    mediaType?: 'Artist' | 'Track' | 'Album',
    accentColor?: number,
    metadata?: {
      globalPlays?: number;
      globalListeners?: number;
      topItemLabel?: string;
      topItemValue?: string;
      topItemExtra?: string;
      topTracks?: string[];
    },
  ): Promise<ResponseModel> {
    const resolvedAccent = accentColor ?? DiscordConstants.LastFmColorRed;
    const caller = users.find((u) => u.discordUserId === context.discordUserId);
    const requestedUserId = caller?.userId ?? 0;

    // Build footer lines — match fmbot style: genres line + "Artist/Track/Album - X listeners - Y plays - Z avg"
    const footerLines: string[] = [];
    if (genres && genres.length > 0) {
      footerLines.push(genres.slice(0, 5).join(' - '));
    }

    if (filterStats) {
      const filterItems: string[] = [];
      if (filterStats.blockedFiltered && filterStats.blockedFiltered > 0) {
        filterItems.push(`${filterStats.blockedFiltered} blocked`);
      }
      if (filterStats.activityThresholdFiltered && filterStats.activityThresholdFiltered > 0) {
        filterItems.push(`${filterStats.activityThresholdFiltered} inactive`);
      }
      if (filterItems.length > 0) {
        footerLines.push(`Filtered: ${filterItems.join(', ')}`);
      }
    }

    const distinctUsers = users.filter((u, i, arr) => arr.findIndex((x) => x.userId === u.userId) === i);
    const totalListeners = distinctUsers.filter((u) => u.playcount > 0).length;
    const totalPlays = distinctUsers.reduce((sum, u) => sum + u.playcount, 0);
    const avgPlays = totalListeners > 0 ? Math.round(totalPlays / totalListeners) : 0;

    let type = mediaType;
    if (!type) {
      if (url.includes('/_/')) {
        type = 'Track';
      } else if (url.includes('/music/')) {
        const afterMusic = url.split('/music/')[1]?.split('?')[0]?.replace(/\/$/, '') || '';
        const parts = afterMusic.split('/').filter(Boolean);
        type = parts.length >= 2 ? 'Album' : 'Artist';
      } else {
        type = title.toLowerCase().includes(' by ') ? 'Track' : 'Artist';
      }
    }

    const listenersWord = totalListeners === 1 ? 'listener' : 'listeners';
    const playsWord = totalPlays === 1 ? 'play' : 'plays';
    const baseLine = `${type} - ${totalListeners} ${listenersWord} - ${totalPlays.toLocaleString()} ${playsWord}`;
    footerLines.push(totalListeners > 1 ? `${baseLine} - ${avgPlays.toLocaleString()} avg` : baseLine);

    if (guildAlsoPlaying) {
      footerLines.push(guildAlsoPlaying);
    }

    const fullFooter = footerLines.join('\n');

    // === Image Mode ===
    if (mode === WhoKnowsMode.Image) {
      let imageBuffer: Buffer | null = null;
      try {
        if (container.isRegistered(WhoKnowsGenerator)) {
          const generator = container.resolve(WhoKnowsGenerator);
          const location = context.guild?.name ?? 'Server';

          // Extract artist and album names
          let resolvedArtistName = '';
          let resolvedAlbumName = '';
          if (url.includes('/music/')) {
            const segment = url.split('/music/')[1]?.split('?')[0] ?? '';
            const parts = segment.split('/').filter(Boolean);
            if (parts[0]) resolvedArtistName = decodeURIComponent(parts[0].replace(/\+/g, ' ')).trim();
            if (parts[1] && parts[1] !== '_') resolvedAlbumName = decodeURIComponent(parts[1].replace(/\+/g, ' ')).trim();
          }
          if (!resolvedArtistName && title) {
            resolvedArtistName = title.split(' in ')[0]?.split(' by ')[1] || title.split(' in ')[0] || '';
          }
          if (!resolvedAlbumName && title && type === 'Album') {
            resolvedAlbumName = title.split(' in ')[0]?.split(' by ')[0] || '';
          }

          let effectiveCallerId = requestedUserId;
          if (!effectiveCallerId && context.discordUserId && container.isRegistered(UserService)) {
            try {
              const userSvc = container.resolve(UserService);
              const u = await userSvc.getUserByDiscordId(context.discordUserId);
              if (u) effectiveCallerId = u.userId;
            } catch {
              // ignore
            }
          }

          // Resolve top tracks for Album: caller's plays first -> global plays -> fallback metadata/Spotify
          if (type === 'Album' && resolvedAlbumName) {
            try {
              const albumTracks: string[] = [];
              if (resolvedArtistName && container.isRegistered(AlbumService)) {
                const albumService = container.resolve(AlbumService);
                // 1. Caller's personalized top tracks for this album
                if (effectiveCallerId) {
                  const userTracks = await albumService.getTopTracksForAlbum(resolvedArtistName, resolvedAlbumName, 3, effectiveCallerId);
                  for (const t of userTracks) {
                    if (t && !albumTracks.includes(t)) albumTracks.push(t);
                  }
                }
                // 2. Global plays in DB for this album
                if (albumTracks.length < 3) {
                  const globalTracks = await albumService.getTopTracksForAlbum(resolvedArtistName, resolvedAlbumName, 5);
                  for (const t of globalTracks) {
                    if (t && !albumTracks.includes(t)) {
                      albumTracks.push(t);
                      if (albumTracks.length >= 3) break;
                    }
                  }
                }
              }

              // 3. Fallback from metadata (e.g. Last.fm tracklist)
              if (albumTracks.length < 3 && metadata?.topTracks) {
                for (const t of metadata.topTracks) {
                  if (t && !albumTracks.includes(t)) {
                    albumTracks.push(t);
                    if (albumTracks.length >= 3) break;
                  }
                }
              }

              // 4. Fallback from Spotify
              if (albumTracks.length < 3 && container.isRegistered(SpotifySearchApi)) {
                const spotifyApi = container.resolve(SpotifySearchApi);
                const spTracks = await spotifyApi.getAlbumTrackNames(resolvedAlbumName, resolvedArtistName, 5);
                for (const t of spTracks) {
                  if (t && !albumTracks.includes(t)) {
                    albumTracks.push(t);
                    if (albumTracks.length >= 3) break;
                  }
                }
              }

              if (albumTracks.length > 0) {
                if (!metadata) metadata = {};
                metadata.topTracks = albumTracks.slice(0, 3);
                metadata.topItemLabel = 'Top Track';
                metadata.topItemValue = albumTracks[0];
              }
            } catch {
              // ignore
            }
          }

          // Fetch caller's top albums for this artist
          let backgroundCovers: string[] = [];
          if (resolvedArtistName && container.isRegistered(ArtistsService) && container.isRegistered(ArtworkService)) {
            try {
              const artistsService = container.resolve(ArtistsService);
              const artworkService = container.resolve(ArtworkService);

              const candidateAlbums: Array<{ name: string; artistName: string; directImage?: string; isTrack?: boolean }> = [];
              const existing = new Set<string>();
              let sampleTrackName: string | undefined;

              // 1. Caller's personalized top albums and top tracks for this artist from DB
              const artistTopTrackNames: string[] = [];
              if (effectiveCallerId) {
                try {
                  const [callerAlbums, callerTracks] = await Promise.all([
                    artistsService.getTopAlbumsForArtist(effectiveCallerId, resolvedArtistName),
                    artistsService.getTopTracksForArtist(effectiveCallerId, resolvedArtistName),
                  ]);
                  for (const t of callerTracks) {
                    if (t.name && !artistTopTrackNames.includes(t.name)) {
                      artistTopTrackNames.push(t.name);
                    }
                  }
                  for (const a of callerAlbums) {
                    const norm = a.name.toLowerCase().trim();
                    if (!existing.has(norm)) {
                      existing.add(norm);
                      candidateAlbums.push(a);
                    }
                  }
                  for (const t of callerTracks) {
                    if (!sampleTrackName) sampleTrackName = t.name;
                    const norm = t.name.toLowerCase().trim();
                    if (!existing.has(norm)) {
                      existing.add(norm);
                      candidateAlbums.push({ name: t.name, artistName: resolvedArtistName, isTrack: true });
                    }
                  }
                } catch {
                  // ignore
                }
              }

              // Supplement top tracks from global database if caller has fewer than 3 (Artist mode only)
              if (type === 'Artist' && artistTopTrackNames.length < 3) {
                try {
                  const globalTracks = await artistsService.getTopTracksForArtistGlobal(resolvedArtistName, 5);
                  for (const gt of globalTracks) {
                    if (gt.name && !artistTopTrackNames.some((t) => t.toLowerCase() === gt.name.toLowerCase())) {
                      artistTopTrackNames.push(gt.name);
                      if (artistTopTrackNames.length >= 3) break;
                    }
                  }
                } catch {
                  // ignore
                }
              }

              // Populate topTracks (top 3) and topItemValue FOR ARTIST MODE ONLY
              if (type === 'Artist') {
                if (artistTopTrackNames.length > 0) {
                  if (!metadata) metadata = {};
                  metadata.topTracks = artistTopTrackNames.slice(0, 3);
                  if (!metadata.topItemValue) {
                    metadata.topItemLabel = 'Top Track';
                    metadata.topItemValue = artistTopTrackNames[0];
                  }
                } else if (!metadata?.topItemValue && candidateAlbums.length > 0) {
                  if (!metadata) metadata = {};
                  metadata.topItemLabel = 'Top Track';
                  metadata.topItemValue = sampleTrackName || candidateAlbums[0]!.name;
                }
              }

              const distinctCovers: string[] = [];
              const seenCovers = new Set<string>();

              // 2. Query Spotify verified official discography for this artist (albums, singles, appears_on/features)
              if (container.isRegistered(SpotifySearchApi)) {
                try {
                  const spotifyApi = container.resolve(SpotifySearchApi);
                  const trackHint = sampleTrackName || candidateAlbums[0]?.name;
                  const spotifyCovers = await spotifyApi.getArtistDiscographyCovers(resolvedArtistName, trackHint, 25);
                  for (const c of spotifyCovers) {
                    if (c && !seenCovers.has(c)) {
                      seenCovers.add(c);
                      distinctCovers.push(c);
                    }
                  }
                } catch {
                  // ignore
                }
              }

              // 3. Global DB plays for this artist
              try {
                const globalAlbums = await artistsService.getTopAlbumsForArtistGlobal(resolvedArtistName, 25);
                for (const ga of globalAlbums) {
                  const norm = ga.name.toLowerCase().trim();
                  if (!existing.has(norm)) {
                    existing.add(norm);
                    candidateAlbums.push(ga);
                  }
                }
              } catch {
                // ignore
              }

              // 4. If we have verified covers from Spotify (even 3-10), WE ARE DONE!
              // Do NOT pollute with Last.fm's multi-artist search!
              if (distinctCovers.length < 5 && candidateAlbums.length > 0) {
                const BATCH_SIZE = 6;
                for (let i = 0; i < candidateAlbums.length && distinctCovers.length < 21; i += BATCH_SIZE) {
                  const batch = candidateAlbums.slice(i, i + BATCH_SIZE);
                  const resolvedBatch = await Promise.all(
                    batch.map(async (alb) => {
                      try {
                        const cover = alb.isTrack
                          ? await artworkService.getTrackCoverUrl(alb.name, alb.artistName || resolvedArtistName)
                          : await artworkService.getAlbumCoverUrl(alb.name, alb.artistName || resolvedArtistName);
                        if (cover) return cover;
                        if (alb.directImage && !alb.directImage.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
                          return alb.directImage;
                        }
                        return null;
                      } catch {
                        return null;
                      }
                    }),
                  );

                  for (let j = 0; j < batch.length; j++) {
                    const url = resolvedBatch[j];
                    if (url && !seenCovers.has(url)) {
                      seenCovers.add(url);
                      distinctCovers.push(url);
                      if (distinctCovers.length >= 21) break;
                    }
                  }
                }
              }

              backgroundCovers = distinctCovers;
            } catch (err) {
              Logger.warn({ err }, 'Failed to fetch album covers for WhoKnows background collage');
            }
          }

          imageBuffer = await generator.generateWhoKnowsImage({
            type: `Who Knows ${type}`,
            title,
            location,
            imageUrl: thumbnailUrl ?? undefined,
            users,
            callerUserId: requestedUserId,
            callerDiscordId: context.discordUserId,
            crownText:
              footerExtra &&
              (footerExtra.toLowerCase().includes('crown') ||
                footerExtra.toLowerCase().includes('claimed') ||
                footerExtra.toLowerCase().includes('stolen'))
                ? footerExtra
                : undefined,
            backgroundCovers: backgroundCovers.length > 0 ? backgroundCovers : undefined,
            tags: type === 'Track' ? undefined : genres,
            globalPlays: metadata?.globalPlays,
            globalListeners: metadata?.globalListeners,
            topItemLabel: metadata?.topItemLabel,
            topItemValue: metadata?.topItemValue,
            topItemExtra: metadata?.topItemExtra,
            topTracks: metadata?.topTracks,
          });
        }
      } catch (err) {
        Logger.error({ err }, 'Failed to generate WhoKnows image, falling back to embed');
      }

      if (imageBuffer) {
        const response = new ResponseModel(resolvedAccent);
        response.commandResponse = CommandResponse.Ok;
        response.setFile(imageBuffer, 'whoknows.png');
        return response;
      }
    }

    // === Pagination Mode (Components V2) ===
    if (mode === WhoKnowsMode.Pagination) {
      const pages = WhoKnowsService.generatePages(
        users,
        requestedUserId,
        closeFriendUserIds,
        10,
        context.discordUserId,
      );

      const response = new ResponseModel(accentColor);
      response.commandResponse = CommandResponse.Ok;

      const firstPage = pages[0]!;
      let pageContent = firstPage.lines;
      if (footerExtra) {
        pageContent += `\n\n${footerExtra}`;
      }
      const container = new ContainerBuilder();
      container.setAccentColor(resolvedAccent);

      if (thumbnailUrl) {
        const titleSection = new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### [${title}](<${url}>)`))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
        container.addSectionComponents(titleSection);
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### [${title}](<${url}>)`));
      }

      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(pageContent));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

      let footerText = `Page 1/${pages.length}`;
      if (fullFooter) {
        footerText += `\n-# ${fullFooter.replace(/\n/g, '\n-# ')}`;
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerText}`));

      if (pages.length > 1) {
        const prevBtn = new ButtonBuilder()
          .setCustomId('wk-page:prev:0')
          .setLabel('<')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);
        const nextBtn = new ButtonBuilder()
          .setCustomId('wk-page:next:0')
          .setLabel('>')
          .setStyle(ButtonStyle.Secondary);
        container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn));
      }

      response.setComponentsV2Container(container);
      return response;
    }

    // === Default Mode (Standard Discord Rich Embed) ===
    const response = new ResponseModel(resolvedAccent);
    response.commandResponse = CommandResponse.Ok;

    const listText = WhoKnowsService.whoKnowsListToString(
      users,
      requestedUserId,
      closeFriendUserIds,
      context.discordUserId,
    );

    let description = listText;
    if (footerExtra) {
      description += `\n\n${footerExtra}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(title.length > 255 ? `${title.slice(0, 252)}...` : title)
      .setURL(url)
      .setDescription(description);

    embed.setColor(resolvedAccent);

    if (thumbnailUrl) {
      embed.setThumbnail(thumbnailUrl);
    }

    if (fullFooter) {
      embed.setFooter({ text: fullFooter });
    }

    response.embed = embed;
    return response;
  }
}
