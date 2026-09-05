import type { IUserIndexQueue, IndexUserQueueItem } from '@domain/interfaces/iuserIndexQueue';
import type { IPlayRepository } from '@domain/interfaces/iplayRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type {
  IUserRepository,
} from '@domain/interfaces/iuserRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { CacheService } from './cacheService';
import { UpdateType } from '@domain/enums/updateType';
import { Logger } from '@domain/logger';
import { prisma } from '@persistence/prismaClient';
import { TimePeriod } from '@domain/enums/timePeriod';

const RECENT_TRACKS_PAGE_SIZE = 1000;
const RECENT_TRACKS_ERROR_RETRIES = 5;
const FLUSH_EVERY_PAGES = 10;
const MAX_INDEX_PAGES = 1000;

export interface IndexedUserStats {
  artistCount?: number;
  albumCount?: number;
  trackCount?: number;
  playCount?: number;
  totalScrobbles?: number;
  durationSec: string;
  error?: boolean;
}

export class IndexService {
  private readonly indexQueue: IUserIndexQueue;
  private readonly cache: CacheService;
  private readonly userRepository: IUserRepository;
  private readonly artistRepository: IArtistRepository;
  private readonly albumRepository: IAlbumRepository;
  private readonly trackRepository: ITrackRepository;
  private readonly playRepository: IPlayRepository;
  private readonly lastfmRepository: ILastfmRepository;

  constructor(
    indexQueue: IUserIndexQueue,
    cache: CacheService,
    userRepository: IUserRepository,
    artistRepository: IArtistRepository,
    albumRepository: IAlbumRepository,
    trackRepository: ITrackRepository,
    playRepository: IPlayRepository,
    lastfmRepository: ILastfmRepository,
  ) {
    this.indexQueue = indexQueue;
    this.cache = cache;
    this.userRepository = userRepository;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.trackRepository = trackRepository;
    this.playRepository = playRepository;
    this.lastfmRepository = lastfmRepository;
    indexQueue.registerProcessor((item) => this.processQueuedItem(item));
  }

  public enqueueUser(userId: number): boolean {
    return this.indexQueue.enqueue({ userId: userId, indexQueue: true });
  }

  public async processQueuedItem(item: IndexUserQueueItem): Promise<void> {
    const user = await this.userRepository.getUserById(item.userId);
    if (!user) {
      return;
    }

    if (
      item.indexQueue &&
      user.lastIndexed &&
      user.lastIndexed > new Date(Date.now() - 24 * 3600 * 1000)
    ) {
      Logger.debug(`Index skipped for ${user.userId} | ${user.userNameLastFm}, indexed recently`);
      return;
    }

    await this.modularUpdate(user, UpdateType.Automatic);
  }

  public async indexUser(userId: number): Promise<void> {
    const cacheKey = this.concurrencyKey(userId);
    if (await this.cache.get<boolean>(cacheKey)) {
      Logger.info(`Index already in progress for user ${userId}, skipping`);
      return;
    }
    await this.cache.set(cacheKey, true, 180);
    try {
      const user = await this.userRepository.getUserById(userId);
      if (!user) {
        return;
      }
      await this.modularUpdate(user, UpdateType.Command);
    } finally {
      await this.cache.delete(cacheKey);
    }
  }

  public async modularUpdate(
    user: { userId: number; userNameLastFm: string },
    updateType: UpdateType,
  ): Promise<IndexedUserStats> {
    const startedAt = Date.now();
    Logger.info(`Index: starting modular update (${updateType}) for ${user.userNameLastFm}`);

    const freshUser = await this.userRepository.getUserById(user.userId);
    if (!freshUser) {
      return { durationSec: '0.0', error: true };
    }
    const sessionKey = freshUser.sessionKey;

    const stats: IndexedUserStats = { durationSec: '0.0' };

    // 1) AllPlays / Full / Command
    if ((updateType & (UpdateType.AllPlays | UpdateType.Full | UpdateType.Command)) !== 0) {
      try {
        await this.playRepository.deleteAllPlaysForUser(user.userId);
        const result = await this.fetchAndStorePlays(
          user.userId,
          user.userNameLastFm,
          sessionKey,
        );
        stats.playCount = result.inserted;
      } catch (err) {
        Logger.error({ err }, `Index: failed fetching all plays for ${user.userNameLastFm}`);
        stats.error = true;
      }
    }

    // 2) Top Artists
    if ((updateType & (UpdateType.Artists | UpdateType.Full)) !== 0) {
      try {
        const topArtists = await this.lastfmRepository.getTopArtists(user.userNameLastFm, TimePeriod.AllTime as any, 1000);
        if (topArtists && topArtists.length > 0) {
          const artistMap = await this.artistRepository.getOrCreateArtistsBulk(topArtists.map(a => a.name));
          const rows = topArtists
            .map(a => {
              const artistId = artistMap.get(a.name.toLowerCase());
              if (!artistId) return null;
              return { userId: user.userId, artistId, name: a.name, playcount: a.playcount };
            })
            .filter(Boolean) as Array<{ userId: number; artistId: number; name: string; playcount: number }>;

          await prisma.$transaction([
            prisma.userArtist.deleteMany({ where: { userId: user.userId } }),
            prisma.userArtist.createMany({ data: rows, skipDuplicates: true }),
          ]);
          stats.artistCount = rows.length;
        }
      } catch (err) {
        Logger.error({ err }, `Index: failed updating top artists for ${user.userNameLastFm}`);
        stats.error = true;
      }
    }

    // 3) Top Albums
    if ((updateType & (UpdateType.Albums | UpdateType.Full)) !== 0) {
      try {
        const topAlbums = await this.lastfmRepository.getTopAlbums(user.userNameLastFm, TimePeriod.AllTime as any, 1000);
        if (topAlbums && topAlbums.length > 0) {
          const artistMap = await this.artistRepository.getOrCreateArtistsBulk(topAlbums.map(a => a.artistName));
          const albumMap = await this.albumRepository.getOrCreateAlbumsBulk(
            topAlbums.map(a => ({ albumName: a.name, artistId: artistMap.get(a.artistName.toLowerCase()) ?? 0 })).filter(a => a.artistId > 0),
          );

          const rows = topAlbums
            .map(a => {
              const artistId = artistMap.get(a.artistName.toLowerCase());
              if (!artistId) return null;
              const albumId = albumMap.get(`${artistId}|${a.name.toLowerCase()}`);
              if (!albumId) return null;
              return { userId: user.userId, albumId, name: a.name, playcount: a.playcount };
            })
            .filter(Boolean) as Array<{ userId: number; albumId: number; name: string; playcount: number }>;

          await prisma.$transaction([
            prisma.userAlbum.deleteMany({ where: { userId: user.userId } }),
            prisma.userAlbum.createMany({ data: rows, skipDuplicates: true }),
          ]);
          stats.albumCount = rows.length;
        }
      } catch (err) {
        Logger.error({ err }, `Index: failed updating top albums for ${user.userNameLastFm}`);
        stats.error = true;
      }
    }

    // 4) Top Tracks
    if ((updateType & (UpdateType.Tracks | UpdateType.Full)) !== 0) {
      try {
        const topTracks = await this.lastfmRepository.getTopTracks(user.userNameLastFm, TimePeriod.AllTime as any, 1000);
        if (topTracks && topTracks.length > 0) {
          const artistMap = await this.artistRepository.getOrCreateArtistsBulk(topTracks.map(t => t.artistName));
          const trackMap = await this.trackRepository.getOrCreateTracksBulk(
            topTracks.map(t => ({ trackName: t.name, artistId: artistMap.get(t.artistName.toLowerCase()) ?? 0 })).filter(t => t.artistId > 0),
          );

          const rows = topTracks
            .map(t => {
              const artistId = artistMap.get(t.artistName.toLowerCase());
              if (!artistId) return null;
              const trackId = trackMap.get(`${artistId}|${t.name.toLowerCase()}`);
              if (!trackId) return null;
              return { userId: user.userId, trackId, name: t.name, playcount: t.playcount };
            })
            .filter(Boolean) as Array<{ userId: number; trackId: number; name: string; playcount: number }>;

          await prisma.$transaction([
            prisma.userTrack.deleteMany({ where: { userId: user.userId } }),
            prisma.userTrack.createMany({ data: rows, skipDuplicates: true }),
          ]);
          stats.trackCount = rows.length;
        }
      } catch (err) {
        Logger.error({ err }, `Index: failed updating top tracks for ${user.userNameLastFm}`);
        stats.error = true;
      }
    }

    // Update user stats & timestamp
    const lastFmUser = await this.lastfmRepository.getUserInfo(user.userNameLastFm);
    if (lastFmUser) {
      stats.totalScrobbles = lastFmUser.playCount;
      await this.userRepository.updateUserStats(user.userId, lastFmUser.playCount, new Date());
      if (!freshUser.registeredLastFm && lastFmUser.registeredAt) {
        await this.userRepository.setUserRegisteredLfm(user.userId, lastFmUser.registeredAt);
      }
    }
    await this.touchLastIndexed(user.userId);

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    stats.durationSec = durationSec;
    Logger.info(
      `Index: finished modular update for ${user.userNameLastFm} | took ${durationSec}s`,
    );
    return stats;
  }

  private async fetchAndStorePlays(
    userId: number,
    userName: string,
    sessionKey?: string,
  ): Promise<{ inserted: number; pages: number; seen: number }> {
    // Full index: always fetch from scratch (no fromUnix) — matches fmbot GetPlaysForUserFromLastFm.
    // fromUnix is only for delta path in UpdateService.
    const pendingPlays: Array<{
      userId: number;
      artistName: string;
      albumName?: string;
      trackName?: string;
      timePlayed: Date;
      playSource: 'LastFm';
    }> = [];

    let page = 1;
    let seen = 0;
    let totalInserted = 0;
    let pagesSinceFlush = 0;

    while (page <= MAX_INDEX_PAGES) {
      const list = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        userName,
        RECENT_TRACKS_PAGE_SIZE,
        page,
        undefined,
        sessionKey,
        RECENT_TRACKS_ERROR_RETRIES,
      );
      const tracks = list.tracks;

      if (tracks.length === 0) {
        if (list.totalPages === 0) {
          Logger.warn(
            `Index: no recent tracks returned for ${userName} - library may be private or empty`,
          );
        }
        break;
      }
      seen += tracks.length;

      for (const track of tracks) {
        if (!track.timePlayed || track.nowPlaying) {
          continue;
        }
        pendingPlays.push({
          userId: userId,
          artistName: track.artistName,
          albumName: track.albumName || undefined,
          trackName: track.name,
          timePlayed: track.timePlayed,
          playSource: 'LastFm',
        });
      }

      Logger.debug(
        `Index: ${userName} fetched page ${page}/${list.totalPages || "?"} (+${tracks.length} plays)`,
      );

      page++;
      pagesSinceFlush++;

      if (pagesSinceFlush >= FLUSH_EVERY_PAGES) {
        const flushed = await this.playRepository.batchInsertPlays(pendingPlays);
        totalInserted += flushed;
        pendingPlays.length = 0;
        pagesSinceFlush = 0;
        Logger.info(
          `Index: ${userName} progress | page ${page - 1}/${list.totalPages || "?"} | inserted so far: ${totalInserted}`,
        );
      }

      if (list.totalPages > 0 && page > list.totalPages) {
        break;
      }
      if (tracks.length < RECENT_TRACKS_PAGE_SIZE - 2) {
        break;
      }
    }

    if (pendingPlays.length > 0) {
      totalInserted += await this.playRepository.batchInsertPlays(pendingPlays);
    }

    Logger.info(
      `Index: ${userName} fetch complete | pages: ${page - 1} | plays received: ${seen} | rows inserted: ${totalInserted}`,
    );

    return { inserted: totalInserted, pages: page - 1, seen: seen };
  }
  public async recalculateTopLists(userId: number): Promise<void> {
    const recalcStart = Date.now();
    const [rawArtists, rawAlbums, rawTracks] = await Promise.all([
      this.playRepository.getRawTopArtistNames(userId),
      this.playRepository.getRawTopAlbumEntries(userId),
      this.playRepository.getRawTopTrackEntries(userId),
    ]);

    const artistMap = await this.artistRepository.getOrCreateArtistsBulk([
      ...rawArtists.map((a) => a.name),
      ...rawAlbums.map((a) => a.artistName),
      ...rawTracks.map((t) => t.artistName),
    ]);

    const artistEntries = rawArtists
      .map((entry) => ({
        artistId: artistMap.get(entry.name.toLowerCase()),
        name: entry.name,
        playcount: entry.playcount,
      }))
      .filter(
        (
          e,
        ): e is { artistId: number; name: string; playcount: number } =>
          e.artistId !== undefined,
      );

    const albumEntries = rawAlbums
      .map((entry) => {
        const artistId = artistMap.get(entry.artistName.toLowerCase());
        return artistId === undefined
          ? null
          : {
              albumName: entry.name,
              artistId: artistId,
              name: entry.name,
              playcount: entry.playcount,
            };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const albumMap = await this.albumRepository.getOrCreateAlbumsBulk(
      albumEntries.map((e) => ({ albumName: e.albumName, artistId: e.artistId })),
    );

    const trackEntries = rawTracks
      .map((entry) => {
        const artistId = artistMap.get(entry.artistName.toLowerCase());
        return artistId === undefined
          ? null
          : {
              trackName: entry.name,
              artistId: artistId,
              name: entry.name,
              playcount: entry.playcount,
            };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const trackMap = await this.trackRepository.getOrCreateTracksBulk(
      trackEntries.map((e) => ({ trackName: e.trackName, artistId: e.artistId })),
    );

    const finalAlbums = albumEntries
      .map((e) => {
        const albumId = albumMap.get(`${e.artistId}|${e.albumName.toLowerCase()}`);
        return albumId === undefined
          ? null
          : { albumId: albumId, name: e.name, playcount: e.playcount };
      })
      .filter((e): e is { albumId: number; name: string; playcount: number } => e !== null);

    const finalTracks = trackEntries
      .map((e) => {
        const trackId = trackMap.get(`${e.artistId}|${e.trackName.toLowerCase()}`);
        return trackId === undefined
          ? null
          : { trackId: trackId, name: e.name, playcount: e.playcount };
      })
      .filter((e): e is { trackId: number; name: string; playcount: number } => e !== null);

    await Promise.all([
      this.playRepository.replaceUserArtists(userId, artistEntries),
      this.playRepository.replaceUserAlbums(userId, finalAlbums),
      this.playRepository.replaceUserTracks(userId, finalTracks),
    ]);

    Logger.info(
      `Index: recalculated top lists | artists: ${artistEntries.length} | albums: ${finalAlbums.length} | tracks: ${finalTracks.length} | took ${((Date.now() - recalcStart) / 1000).toFixed(1)}s`,
    );
  }
  private async touchLastIndexed(userId: number): Promise<void> {
    await this.userRepository.updateLastIndexed(userId, new Date());
  }

  private concurrencyKey(userId: number): string {
    return `index-started-${userId}`;
  }
}
