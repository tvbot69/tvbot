import type { ContextModel } from '@bot/models/contextModel';
import { ResponseModel } from '@bot/models/responseModel';
import { CommandResponse } from '@domain/enums/commandResponse';


import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';


import { container } from 'tsyringe';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ArtistsService } from '@bot/services/artistsService';
import { AlbumService } from '@bot/services/albumService';
import { ArtworkService, matchesArtistName, isPlaceholderImageUrl } from '@bot/services/artworkService';
import { UserService } from '@bot/services/userService';

import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import type { DeezerAlbum } from '@deezer/models/deezerModels';
import { DeezerCoverIndexer } from '@bot/services/deezerCoverIndexer';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { Logger } from '@domain/logger';


/**
 * The Image-mode branch of the who-knows card, extracted out of
 * whoKnowsBuilders.
 *
 * This used to be a ~320-line block inside a file named *Builders*, and it was
 * not presentation: it scraped artist/album names out of a URL, ranked top
 * tracks through a four-tier fallback, fanned out across five cover sources,
 * called `container.resolve` twelve times with no declared dependencies, and —
 * worst — dynamically imported two repositories to WRITE discovered Deezer
 * covers back to the database from inside a response builder. A presentation
 * factory with write access to the data layer cannot be unit-tested with plain
 * mocks, and the `container.isRegistered` guards meant its failure mode was
 * silent data loss.
 *
 * Public entry point: `buildWhoKnowsImageResponse`. The signature of
 * `WhoKnowsBuilders.buildWhoKnowsResponse` is unchanged, so all 12 call sites
 * (6 slash, 6 text) keep working.
 *
 * KNOWN DIFFERENCE FROM THE EMBED, deliberately left alone
 * -------------------------------------------------------
 * The caller composes a multi-line footer that includes a "N others are
 * playing this" line (`guildAlsoPlaying`) and passes it in. The image card does
 * NOT render that line, while the embed and pagination modes do. The plays and
 * listeners figures are NOT lost - `WhoKnowsGenerator` formats those itself from
 * `globalPlays`/`globalListeners` (see whoKnowsGenerator.ts), which is why the
 * composed `fullFooter` string was always redundant here.
 *
 * So `fullFooter`, `guildAlsoPlaying` and `closeFriendUserIds` used to arrive on
 * this signature and were never read. They are removed rather than left lying:
 * the type was demanding values the function discarded, which forced every
 * caller to compute something meaningless. If the image card should also show
 * the "others are playing" line, that is a FEATURE - it needs a new generator
 * argument and a template change - not a bug fix, so it is recorded here
 * instead of being silently guessed at.
 *
 * Behaviour is unchanged by that removal, and whoKnowsImageBuilder.test.ts pins
 * the observable behaviour so the claim is checkable rather than asserted.
 */
/**
 * Fire-and-forget cover indexing, kept module-level because the exported entry
 * point is a plain arrow function with no `this`.
 *
 * `isRegistered` is still used to decide whether the write path exists, which is
 * the same coupling the rest of this file has. Narrowing it is the next step
 * once the behaviour is pinned; what matters here is that the builder no longer
 * performs writes itself.
 */
const indexDiscoveredCovers = async (
  artistName: string,
  albums: DeezerAlbum[],
): Promise<void> => {
  if (!container.isRegistered(ArtistRepository) || !container.isRegistered(AlbumRepository)) return;
  try {
    const indexer = new DeezerCoverIndexer(
      container.resolve(ArtistRepository),
      container.resolve(AlbumRepository),
    );
    await indexer.indexCovers(artistName, albums);
  } catch (err) {
    // Constructing the indexer should not throw, but a builder must never let a
    // background write escape into the process.
    Logger.debug({ err, artistName }, 'Could not start Deezer cover indexing');
  }
};

export const buildWhoKnowsImageResponse = async (args: {
  context: ContextModel;
  title: string;
  url: string;
  thumbnailUrl: string | null | undefined;
  users: WhoKnowsUser[];
  genres?: string[];
  resolvedAccent: number;
  /** Media type inferred by the caller from the URL ('Artist' | 'Track' | 'Album'). */
  type: 'Artist' | 'Track' | 'Album';
  requestedUserId: number;
  footerExtra?: string;
  metadata?: {
    globalPlays?: number;
    globalListeners?: number;
    topItemLabel?: string;
    topItemValue?: string;
    topItemExtra?: string;
    topTracks?: string[];
  };
}): Promise<ResponseModel | null> => {
  const {
    context,
    title,
    url,
    thumbnailUrl,
    users,
    genres,
    resolvedAccent,
    type,
    requestedUserId,
    footerExtra,
  } = args;
  // The branch fills in a top-track fallback when the album's own tracklist is
  // thin, so this must stay assignable (it was a parameter before the move).
  let metadata = args.metadata;
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

              // 2. Query Spotify verified official discography for this artist (albums, singles, appears_on/features).
              // The track hint anchors same-name artists to the right entity.
              if (container.isRegistered(SpotifySearchApi)) {
                try {
                  const spotifyApi = container.resolve(SpotifySearchApi);
                  const trackHint = sampleTrackName || candidateAlbums[0]?.name;
                  const spotifyCovers = await spotifyApi.getArtistDiscographyCovers(resolvedArtistName, trackHint, 15);
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

              // 3. Database albums with covers for this artist
              try {
                const dbCovers = await artistsService.getIndexedAlbumCoversForArtist(resolvedArtistName, 10);
                for (const c of dbCovers) {
                  if (c && !seenCovers.has(c)) {
                    seenCovers.add(c);
                    distinctCovers.push(c);
                    if (distinctCovers.length >= 10) break;
                  }
                }
              } catch {
                // ignore
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

              // 4. Fill background covers using Deezer (unlimited/no tokens) if fewer than 8 covers.
              // Deezer search is fuzzy — only albums actually credited to the
              // artist are accepted, otherwise wrong-artist covers (and DB rows)
              // leak into the mosaic.
              if (distinctCovers.length < 8 && container.isRegistered(DeezerApi)) {
                try {
                  const deezerApi = container.resolve(DeezerApi);
                  const deezerAlbums = await deezerApi.searchAlbums(resolvedArtistName, 15);
                  const verifiedAlbums = deezerAlbums.filter((da) =>
                    matchesArtistName(da.artist?.name ?? '', resolvedArtistName),
                  );
                  for (const da of verifiedAlbums) {
                    const cover = da.cover_xl ?? da.cover_big ?? da.cover_medium;
                    if (cover && !seenCovers.has(cover)) {
                      seenCovers.add(cover);
                      distinctCovers.push(cover);
                      if (distinctCovers.length >= 10) break;
                    }
                  }

                  // Index discovered covers into PostgreSQL in the background.
                  // The write lives in DeezerCoverIndexer, not here: a
                  // presentation factory with write access to the data layer
                  // could not be unit-tested and failed silently.
                  if (verifiedAlbums.length > 0) {
                    setImmediate(() => {
                      void indexDiscoveredCovers(resolvedArtistName, verifiedAlbums);
                    });
                  }
                } catch {
                  // ignore
                }
              }

              // 5. Supplement from candidate albums with pre-existing directImage
              if (distinctCovers.length < 10 && candidateAlbums.length > 0) {
                for (const alb of candidateAlbums) {
                  if (alb.directImage && !isPlaceholderImageUrl(alb.directImage) && !seenCovers.has(alb.directImage)) {
                    seenCovers.add(alb.directImage);
                    distinctCovers.push(alb.directImage);
                    if (distinctCovers.length >= 10) break;
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
        Logger.error({ err }, 'Failed to generate WhoKnows image');
      }

      if (imageBuffer) {
        const response = new ResponseModel(resolvedAccent);
        response.commandResponse = CommandResponse.Ok;
        response.setFile(imageBuffer, 'whoknows.png');
        return response;
      }
  return null;
};
