import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IPlayRepository, PlayInsert } from '@domain/interfaces/iplayRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { CacheService } from './cacheService';
import { Logger } from '@domain/logger';
import type { GenreService } from './genreService';

const UPDATE_DEDUP_TTL_SECONDS = 2;
const STALE_THRESHOLD_HOURS = 48;
const OVERLAP_HOURS = 3;
const BACKOFF_HOURS = 2;

export interface UpdateResult {
  newPlays: number;
  removedPlays: number;
  totalScrobbles?: number;
}

export class UpdateService {
  private readonly userRepository: IUserRepository;
  private readonly playRepository: IPlayRepository;
  private readonly lastfmRepository: ILastfmRepository;
  private readonly cache: CacheService;
  private readonly recalculateTopLists: (userId: number) => Promise<void>;
  private readonly artistRepository?: IArtistRepository;
  private readonly albumRepository?: IAlbumRepository;
  private readonly trackRepository?: ITrackRepository;
  private readonly genreService?: GenreService;

  constructor(
    userRepository: IUserRepository,
    playRepository: IPlayRepository,
    lastfmRepository: ILastfmRepository,
    cache: CacheService,
    recalculateTopLists: (userId: number) => Promise<void>,
    artistRepository?: IArtistRepository,
    albumRepository?: IAlbumRepository,
    trackRepository?: ITrackRepository,
    genreService?: GenreService,
  ) {
    this.userRepository = userRepository;
    this.playRepository = playRepository;
    this.lastfmRepository = lastfmRepository;
    this.cache = cache;
    this.recalculateTopLists = recalculateTopLists;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.trackRepository = trackRepository;
    this.genreService = genreService;
  }

  /**
   * Mirrors fmbot UpdateService.UpdateUserAndGetRecentTracks.
   * If full index is running returns early. Otherwise performs delta sync,
   * then slices the same fetch result — no extra Last.fm call.
   */
  public async updateUserAndGetRecentTracks(
    user: User,
    bypassIndexPending = false,
  ): Promise<{ recentTracks: RecentTrack[]; updateResult: UpdateResult }> {
    const indexKey = `index-started-${user.userId}`;
    if (!bypassIndexPending && (await this.cache.get<boolean>(indexKey))) {
      Logger.debug(`Delta sync skipped for ${user.userNameLastFm} — full index in progress`);
      // Still need something to display — single lightweight fetch
      const recent = await this.lastfmRepository.getUserRecentTracks(
        user.userNameLastFm, 5, 1, undefined, user.sessionKey,
      );
      return { recentTracks: recent, updateResult: { newPlays: 0, removedPlays: 0 } };
    }

    // Perform delta sync and reuse its fetched tracks as the recent list
    // Do not run via queue path (accurateTotal true for fresh total)
    const sync = await this.performDeltaSyncWithTracks(user, { accurateTotal: true });

    // Return up to 5 most recent non-nowPlaying from the same fetch
    const recentTracks = sync.recentTracks
      .filter((t) => !t.nowPlaying)
      .slice(0, 5);

    // If delta fetch was empty (e.g. capped), fallback to a tiny fresh fetch so commands still show something
    if (recentTracks.length === 0) {
      const fallback = await this.lastfmRepository.getUserRecentTracks(
        user.userNameLastFm, 5, 1, undefined, user.sessionKey,
      );
      return { recentTracks: fallback, updateResult: sync.updateResult };
    }

    return { recentTracks, updateResult: sync.updateResult };
  }

  // Internal entry that returns both delta result + raw recent tracks for reuse
  private async performDeltaSyncWithTracks(
    user: User,
    opts?: { accurateTotal?: boolean },
  ): Promise<{ updateResult: UpdateResult; recentTracks: RecentTrack[] }> {
    // Queue-concurrency guard shared with updateUser
    const dedupKey = `user-${user.userId}-update-in-progress`;
    if (await this.cache.get<boolean>(dedupKey)) {
      const recent = await this.lastfmRepository.getUserRecentTracks(
        user.userNameLastFm, 5, 1, undefined, user.sessionKey,
      );
      return { updateResult: { newPlays: 0, removedPlays: 0 }, recentTracks: recent };
    }
    await this.cache.set(dedupKey, true, UPDATE_DEDUP_TTL_SECONDS);
    try {
      // Reuse performDeltaSync but capture tracks — call the core that also writes DB
      const { updateResult, recentTracks } = await this.performDeltaSyncCore(user, opts);
      return { updateResult, recentTracks };
    } finally {
      await this.cache.delete(dedupKey);
    }
  }

  /**
   * Core delta sync — mirrors fmbot's UpdateService.UpdateUser.
   * Fetches recent scrobbles, diffs against stored plays, inserts new, removes deleted.
   * No pruning — unlimited retention.
   */
  public async updateUser(
    userId: number,
    opts?: { accurateTotal?: boolean; queue?: boolean },
  ): Promise<UpdateResult> {
    const user = await this.userRepository.getUserById(userId);
    if (!user) {
      return { newPlays: 0, removedPlays: 0 };
    }

    // Queue mode: skip if recently updated
    if (opts?.queue && user.lastUpdate) {
      const lastUpdate = user.lastUpdate instanceof Date
        ? user.lastUpdate
        : new Date(user.lastUpdate as unknown as string);
      if (!Number.isNaN(lastUpdate.getTime())) {
        const hoursSinceUpdate = (Date.now() - lastUpdate.getTime()) / (3600 * 1000);
        if (hoursSinceUpdate < STALE_THRESHOLD_HOURS) {
          Logger.debug(`Delta sync skipped for ${user.userNameLastFm} — updated ${hoursSinceUpdate.toFixed(1)}h ago`);
          return { newPlays: 0, removedPlays: 0 };
        }
      }
    }

    // Concurrency guard: check if full index is running
    const indexKey = `index-started-${userId}`;
    if (await this.cache.get<boolean>(indexKey)) {
      Logger.info(`Delta sync blocked for ${user.userNameLastFm} — full index in progress`);
      return { newPlays: 0, removedPlays: 0 };
    }

    // Dedup guard: prevent concurrent delta syncs for same user
    const dedupKey = `user-${userId}-update-in-progress`;
    if (await this.cache.get<boolean>(dedupKey)) {
      return { newPlays: 0, removedPlays: 0 };
    }
    await this.cache.set(dedupKey, true, UPDATE_DEDUP_TTL_SECONDS);

    try {
      return await this.performDeltaSync(user, opts);
    } catch (err) {
      Logger.error({ err }, `Delta sync failed for ${user.userNameLastFm}`);
      // Backoff: set lastUpdate to now-2h so we don't retry too aggressively
      await this.userRepository.setLastUpdate(
        userId,
        new Date(Date.now() - BACKOFF_HOURS * 3600 * 1000),
      ).catch(() => undefined);
      return { newPlays: 0, removedPlays: 0 };
    } finally {
      await this.cache.delete(dedupKey);
    }
  }

  private async performDeltaSync(
    user: User,
    opts?: { accurateTotal?: boolean },
  ): Promise<UpdateResult> {
    const { updateResult } = await this.performDeltaSyncCore(user, opts);
    return updateResult;
  }

  private async performDeltaSyncCore(
    user: User,
    opts?: { accurateTotal?: boolean },
  ): Promise<{ updateResult: UpdateResult; recentTracks: RecentTrack[] }> {
    const sessionKey = user.sessionKey;

    // If user.lastScrobbleUpdate is not set, resolve from latest stored play in DB
    if (!user.lastScrobbleUpdate) {
      try {
        const latestStored = await this.playRepository.getRecentPlays(user.userId, 1);
        if (latestStored[0]?.timePlayed) {
          user.lastScrobbleUpdate = latestStored[0].timePlayed;
          void this.userRepository.setLastScrobbleUpdate(user.userId, latestStored[0].timePlayed).catch(() => undefined);
        }
      } catch { /* ignore */ }
    }

    // Calculate fetch window — mirror fmbot's dateFromFilter logic
    let dateFromFilter: Date;
    const lastScrobbleDate = user.lastScrobbleUpdate
      ? (user.lastScrobbleUpdate instanceof Date ? user.lastScrobbleUpdate : new Date(user.lastScrobbleUpdate as unknown as string))
      : null;

    if (lastScrobbleDate && !Number.isNaN(lastScrobbleDate.getTime())) {
      dateFromFilter = new Date(lastScrobbleDate.getTime() - OVERLAP_HOURS * 3600 * 1000);
    } else {
      dateFromFilter = new Date(Date.now() - 24 * 3600 * 1000);
    }
    let timeFrom: number | undefined = Math.floor(dateFromFilter.getTime() / 1000);
    let totalPlaycountCorrect = false;

    // Fast adaptive count & pages for responsive live syncing
    // Last.fm user.getRecentTracks maximum standard page size is 200
    let count = 200;
    let pages = 1;

    const now = Date.now();
    const hoursSinceLastScrobble = (now - dateFromFilter.getTime()) / (3600 * 1000);

    if (opts?.accurateTotal && hoursSinceLastScrobble < 24) {
      // fmbot accurateTotal path: recent update + accurate count requested
      const playsToGet = Math.floor((now - dateFromFilter.getTime()) / (3 * 60 * 1000));
      count = Math.min(200, Math.max(50, 100 + playsToGet));
      pages = 1;
      timeFrom = undefined;
      totalPlaycountCorrect = true;
    } else if (hoursSinceLastScrobble > 72) {
      // More than 3 days stale: fetch 2 pages of 200 (up to 400 tracks)
      pages = 2;
    }

    // Fetch recent tracks from Last.fm (multi-page)
    const allTracks: RecentTrack[] = [];
    let totalScrobbles: number | undefined;

    for (let page = 1; page <= pages; page++) {
      const list = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        user.userNameLastFm,
        count,
        page,
        timeFrom,
        sessionKey,
        2, // retries
      );

      if (page === 1) {
        totalScrobbles = list.totalScrobbles;
      }

      if (list.tracks.length === 0) {
        break;
      }

      allTracks.push(...list.tracks);

      // Stop if we've fetched all pages or this page was short
      if (list.totalPages > 0 && page >= list.totalPages) break;
      if (list.tracks.length < count - 5) break;
    }

    // Filter: only non-nowPlaying tracks with valid timestamps
    const incomingPlays = allTracks.filter(
      (t) => !t.nowPlaying && t.timePlayed,
    );

    if (incomingPlays.length === 0) {
      // No plays fetched — update timestamp and return
      await this.userRepository.setLastUpdate(user.userId, new Date());
      return {
        updateResult: { newPlays: 0, removedPlays: 0, totalScrobbles },
        recentTracks: allTracks,
      };
    }

    // === InsertLatestPlays equivalent ===

    // Load existing plays window (LastFm only)
    const windowSize = incomingPlays.length + 250;
    const existingPlays = await this.playRepository.getRecentPlays(user.userId, windowSize);

    // Find the earliest existing play timestamp
    let firstExistingTime: Date | undefined;
    for (const play of existingPlays) {
      if (!firstExistingTime || play.timePlayed < firstExistingTime) {
        firstExistingTime = play.timePlayed;
      }
    }

    // Drop incoming plays older than the existing window
    const relevantPlays = firstExistingTime
      ? incomingPlays.filter((t) => t.timePlayed! >= firstExistingTime!)
      : incomingPlays;

    // Build timestamp sets for O(1) lookups
    const existingTimeSet = new Set(
      existingPlays.map((p) => p.timePlayed.getTime()),
    );
    const incomingTimeSet = new Set(
      relevantPlays.map((t) => t.timePlayed!.getTime()),
    );

    // New plays = incoming where no existing play has same timestamp
    const newPlays: PlayInsert[] = relevantPlays
      .filter((t) => !existingTimeSet.has(t.timePlayed!.getTime()))
      .map((t) => ({
        userId: user.userId,
        artistName: t.artistName,
        albumName: t.albumName || undefined,
        trackName: t.name,
        timePlayed: t.timePlayed!,
        playSource: 'LastFm' as const,
      }));

    // Removed plays = existing plays >= first new play's timestamp
    // where no incoming play has same timestamp
    let removedPlayIds: bigint[] = [];
    if (relevantPlays.length > 0) {
      const firstNewTime = Math.min(
        ...relevantPlays.map((t) => t.timePlayed!.getTime()),
      );
      removedPlayIds = existingPlays
        .filter(
          (p) =>
            p.timePlayed.getTime() >= firstNewTime &&
            !incomingTimeSet.has(p.timePlayed.getTime()),
        )
        .map((p) => p.userPlayId);
    }

    // Write changes
    if (removedPlayIds.length > 0) {
      const removed = await this.playRepository.removePlaysByIds(removedPlayIds);
      Logger.info(`Delta sync: removed ${removed} plays for ${user.userNameLastFm}`);
    }

    if (newPlays.length > 0) {
      const inserted = await this.playRepository.batchInsertPlays(newPlays);
      Logger.info(`Delta sync: inserted ${inserted} new plays for ${user.userNameLastFm}`);
      // Cache Last.fm tags for new artists (fire-and-forget, throttled)
      if (this.genreService) {
        const distinctArtists = [...new Set(newPlays.map(p => p.artistName))].slice(0, 8);
        for (const artistName of distinctArtists) {
          void this.genreService.getGenresForArtist(artistName).catch(() => undefined);
        }
      }
    }

    // Update top-lists if any changes — incremental for small deltas (<200), full recalc fallback
    if (newPlays.length > 0 || removedPlayIds.length > 0) {
      const useIncremental =
        this.artistRepository &&
        this.albumRepository &&
        this.trackRepository &&
        newPlays.length + removedPlayIds.length < 400 &&
        newPlays.length < 200 &&
        removedPlayIds.length < 200;
      if (useIncremental) {
        try {
          await this.applyIncrementalTopLists(user.userId, newPlays, removedPlayIds, existingPlays);
        } catch (err) {
          Logger.warn({ err }, `Incremental top-list failed for ${user.userNameLastFm}, falling back to full recalc`);
          await this.recalculateTopLists(user.userId);
        }
      } else {
        try {
          await this.recalculateTopLists(user.userId);
        } catch (err) {
          Logger.warn({ err }, `Failed to recalculate top lists for ${user.userNameLastFm}`);
        }
      }
    }

    // Update metadata
    if (newPlays.length > 0) {
      const latestScrobble = newPlays.reduce(
        (max, p) => (p.timePlayed > max ? p.timePlayed : max),
        newPlays[0]!.timePlayed,
      );
      await this.userRepository.setLastScrobbleUpdate(user.userId, latestScrobble);
    }

    await this.userRepository.setLastUpdate(user.userId, new Date());

    // Update play count — mirror fmbot: trust totalScrobbles only when totalPlaycountCorrect,
    // otherwise netDelta or fallback to totalScrobbles if no existing count
    const netDelta = newPlays.length - removedPlayIds.length;
    if (totalPlaycountCorrect && totalScrobbles !== undefined) {
      await this.userRepository.updateUserStats(user.userId, totalScrobbles, new Date());
    } else if (netDelta !== 0 && user.totalPlayCount !== undefined) {
      await this.userRepository.incrementTotalPlayCount(user.userId, netDelta);
    } else if (totalScrobbles !== undefined) {
      await this.userRepository.updateUserStats(user.userId, totalScrobbles, new Date());
    }

    // Invalidate cached stats
    await this.cache.delete(`user-${user.userId}-topartists-alltime`);

    Logger.info(
      `Delta sync complete for ${user.userNameLastFm}: +${newPlays.length} -${removedPlayIds.length} (total: ${totalScrobbles ?? 'unknown'})`,
    );

    return {
      updateResult: {
        newPlays: newPlays.length,
        removedPlays: removedPlayIds.length,
        totalScrobbles,
      },
      recentTracks: allTracks,
    };
  }

  private async applyIncrementalTopLists(
    userId: number,
    newPlays: PlayInsert[],
    removedPlayIds: bigint[],
    existingPlays: Array<{ userPlayId: bigint; artistName: string; albumName?: string; trackName?: string }>,
  ): Promise<void> {
    // Build delta maps
    const artistDelta = new Map<string, { name: string; delta: number }>();
    const albumDelta = new Map<string, { artistName: string; albumName: string; delta: number }>();
    const trackDelta = new Map<string, { artistName: string; trackName: string; delta: number }>();

    for (const p of newPlays) {
      const aKey = p.artistName.toLowerCase();
      const curA = artistDelta.get(aKey);
      artistDelta.set(aKey, { name: p.artistName, delta: (curA?.delta ?? 0) + 1 });
      if (p.albumName) {
        const alKey = `${aKey}|${p.albumName.toLowerCase()}`;
        const curAl = albumDelta.get(alKey);
        albumDelta.set(alKey, { artistName: p.artistName, albumName: p.albumName, delta: (curAl?.delta ?? 0) + 1 });
      }
      if (p.trackName) {
        const tKey = `${aKey}|${p.trackName.toLowerCase()}`;
        const curT = trackDelta.get(tKey);
        trackDelta.set(tKey, { artistName: p.artistName, trackName: p.trackName, delta: (curT?.delta ?? 0) + 1 });
      }
    }

    const removedSet = new Set(removedPlayIds.map(String));
    for (const p of existingPlays) {
      if (!removedSet.has(String(p.userPlayId))) continue;
      const aKey = p.artistName.toLowerCase();
      const curA = artistDelta.get(aKey);
      artistDelta.set(aKey, { name: p.artistName, delta: (curA?.delta ?? 0) - 1 });
      if (p.albumName) {
        const alKey = `${aKey}|${p.albumName.toLowerCase()}`;
        const curAl = albumDelta.get(alKey);
        albumDelta.set(alKey, { artistName: p.artistName, albumName: p.albumName, delta: (curAl?.delta ?? 0) - 1 });
      }
      if (p.trackName) {
        const tKey = `${aKey}|${p.trackName.toLowerCase()}`;
        const curT = trackDelta.get(tKey);
        trackDelta.set(tKey, { artistName: p.artistName, trackName: p.trackName, delta: (curT?.delta ?? 0) - 1 });
      }
    }

    // Resolve artist IDs
    if (artistDelta.size > 0) {
      const names = [...artistDelta.values()].map((v) => v.name);
      const map = await this.artistRepository!.getOrCreateArtistsBulk(names);
      const deltas = [...artistDelta.entries()]
        .map(([k, v]) => {
          const id = map.get(k);
          return id ? { name: v.name, artistId: id, delta: v.delta } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null && x.delta !== 0);
      if (deltas.length) await this.playRepository.applyArtistDeltas(userId, deltas);
    }

    if (albumDelta.size > 0) {
      const entries = [...albumDelta.values()];
      const artistNames = [...new Set(entries.map((e) => e.artistName))];
      const artistMap = await this.artistRepository!.getOrCreateArtistsBulk(artistNames);
      const albumInputs = entries
        .map((e) => {
          const aid = artistMap.get(e.artistName.toLowerCase());
          return aid ? { albumName: e.albumName, artistId: aid } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const albumMap = await this.albumRepository!.getOrCreateAlbumsBulk(albumInputs);
      const deltas = entries
        .map((e) => {
          const aid = artistMap.get(e.artistName.toLowerCase())!;
          const albumId = albumMap.get(`${aid}|${e.albumName.toLowerCase()}`);
          return albumId ? { name: e.albumName, artistId: aid, albumId, delta: e.delta } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null && x.delta !== 0);
      if (deltas.length) await this.playRepository.applyAlbumDeltas(userId, deltas);
    }

    if (trackDelta.size > 0) {
      const entries = [...trackDelta.values()];
      const artistNames = [...new Set(entries.map((e) => e.artistName))];
      const artistMap = await this.artistRepository!.getOrCreateArtistsBulk(artistNames);
      const trackInputs = entries
        .map((e) => {
          const aid = artistMap.get(e.artistName.toLowerCase());
          return aid ? { trackName: e.trackName, artistId: aid } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const trackMap = await this.trackRepository!.getOrCreateTracksBulk(trackInputs);
      const deltas = entries
        .map((e) => {
          const aid = artistMap.get(e.artistName.toLowerCase())!;
          const trackId = trackMap.get(`${aid}|${e.trackName.toLowerCase()}`);
          return trackId ? { name: e.trackName, artistId: aid, trackId, delta: e.delta } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null && x.delta !== 0);
      if (deltas.length) await this.playRepository.applyTrackDeltas(userId, deltas);
    }
  }

  /**
   * Check if a user needs delta sync (stale by threshold).
   * Used by command handlers to decide whether to trigger sync.
   */
  public static needsUpdate(user: User, thresholdMinutes: number = 5): boolean {
    if (!user.lastUpdate) return true;
    // Cache backends serialize Date fields as strings. Treat an unreadable value as
    // stale rather than letting a now-playing command fail on `getTime`.
    const lastUpdate = user.lastUpdate instanceof Date
      ? user.lastUpdate
      : new Date(user.lastUpdate as unknown as string);
    if (Number.isNaN(lastUpdate.getTime())) return true;
    const minutesSince = (Date.now() - lastUpdate.getTime()) / (60 * 1000);
    return minutesSince >= thresholdMinutes;
  }
}
