import { container } from 'tsyringe';
import type { User } from '@domain/interfaces/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import { ArtistsService } from './artistsService';
import { AlbumService } from './albumService';
import { TrackService } from './trackService';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { FmFooterRepository } from '@persistence/repositories/fmFooterRepository';

export interface FmFooterData {
  artistPlays?: number;
  albumPlays?: number;
  trackPlays?: number;
  artistPlaysThisWeek?: number;
  serverArtistListeners?: number;
  serverAlbumListeners?: number;
  serverTrackListeners?: number;
  isLoved?: boolean;
  crownHolder?: string | null;
}

export class FmFooterResolver {
  private static readonly NON_SCROBBLE_MASK =
    BigInt(FmFooterOption.Loved) |
    BigInt(FmFooterOption.ArtistPlays) |
    BigInt(FmFooterOption.AlbumPlays) |
    BigInt(FmFooterOption.TrackPlays) |
    BigInt(FmFooterOption.ArtistPlaysThisWeek) |
    BigInt(FmFooterOption.ServerArtistListeners) |
    BigInt(FmFooterOption.ServerAlbumListeners) |
    BigInt(FmFooterOption.ServerTrackListeners) |
    BigInt(FmFooterOption.CrownHolder);

  public static async resolveFooterData(
    user: User,
    track: RecentTrack | null | undefined,
    footerOptions: bigint,
    guildId?: string | null,
  ): Promise<FmFooterData> {
    if (!track || !track.artistName) {
      return {};
    }

    if ((footerOptions & this.NON_SCROBBLE_MASK) === BigInt(0)) {
      return {};
    }

    const has = (f: FmFooterOption) => (footerOptions & BigInt(f)) !== BigInt(0);
    const result: FmFooterData = {};
    const tasks: Promise<void>[] = [];

    // 1. Artist plays
    if (has(FmFooterOption.ArtistPlays)) {
      tasks.push(
        (async () => {
          try {
            const artistsService = container.resolve(ArtistsService);
            const info = await artistsService.getArtistInfo(track.artistName, user.userNameLastFm);
            if (info?.userPlayCount !== undefined) {
              result.artistPlays = info.userPlayCount;
            } else {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserArtistPlaycount(user.userId, track.artistName)) ?? 0;
              if (total > 0) result.artistPlays = total;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 2. Album plays
    if (has(FmFooterOption.AlbumPlays) && track.albumName) {
      tasks.push(
        (async () => {
          try {
            const albumService = container.resolve(AlbumService);
            const info = await albumService.getAlbumInfo(track.artistName, track.albumName!, user.userNameLastFm);
            if (info?.userPlayCount !== undefined) {
              result.albumPlays = info.userPlayCount;
            } else {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserAlbumPlaycount(user.userId, track.albumName)) ?? 0;
              if (total > 0) result.albumPlays = total;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 3. Track plays & Loved
    if (has(FmFooterOption.TrackPlays) || has(FmFooterOption.Loved)) {
      tasks.push(
        (async () => {
          try {
            const trackService = container.resolve(TrackService);
            const info = await trackService.getTrackInfo(track.name, track.artistName, user.userNameLastFm);
            if (info) {
              if (info.userPlayCount !== undefined) {
                result.trackPlays = info.userPlayCount;
              }
              if (info.userLoved !== undefined) {
                result.isLoved = info.userLoved;
              }
            }
            if (result.trackPlays === undefined && has(FmFooterOption.TrackPlays)) {
              const footerRepo = container.resolve(FmFooterRepository);
              const total = (await footerRepo.getUserTrackPlaycount(user.userId, track.name)) ?? 0;
              if (total > 0) result.trackPlays = total;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 4. Artist plays this week
    if (has(FmFooterOption.ArtistPlaysThisWeek)) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            result.artistPlaysThisWeek = await footerRepo.countUserArtistPlaysSince(
              user.userId,
              track.artistName,
              weekAgo,
            );
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 5. Server Artist listeners
    if (has(FmFooterOption.ServerArtistListeners) && guildId) {
      tasks.push(
        (async () => {
          try {
            const whoKnowsRepo = container.resolve(WhoKnowsRepository);
            const rows = await whoKnowsRepo.getIndexedUsersForArtist(guildId, track.artistName);
            result.serverArtistListeners = rows.filter((r) => r.playcount > 0).length;
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 6. Server Album listeners
    if (has(FmFooterOption.ServerAlbumListeners) && guildId && track.albumName) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const album = await footerRepo.findAlbumByNameAndArtist(track.albumName, track.artistName);
            if (album) {
              const whoKnowsRepo = container.resolve(WhoKnowsRepository);
              const rows = await whoKnowsRepo.getIndexedUsersForAlbum(guildId, album.albumId);
              result.serverAlbumListeners = rows.filter((r) => r.playcount > 0).length;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 7. Server Track listeners
    if (has(FmFooterOption.ServerTrackListeners) && guildId) {
      tasks.push(
        (async () => {
          try {
            const footerRepo = container.resolve(FmFooterRepository);
            const dbTrack = await footerRepo.findTrackByNameAndArtist(track.name, track.artistName);
            if (dbTrack) {
              const whoKnowsRepo = container.resolve(WhoKnowsRepository);
              const rows = await whoKnowsRepo.getIndexedUsersForTrack(guildId, dbTrack.trackId);
              result.serverTrackListeners = rows.filter((r) => r.playcount > 0).length;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    // 8. Crown holder
    if (has(FmFooterOption.CrownHolder) && guildId) {
      tasks.push(
        (async () => {
          try {
            const crownRepo = container.resolve(CrownRepository);
            const crown = await crownRepo.getCurrentCrown(guildId, track.artistName);
            if (crown?.userNameLastFm) {
              result.crownHolder = crown.userNameLastFm;
            }
          } catch {
            // graceful fallback
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return result;
  }
}
