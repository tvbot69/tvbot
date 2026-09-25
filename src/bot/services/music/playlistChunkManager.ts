import { Logger } from '@domain/logger';
import { spotifyUriToUrl } from '@domain/models/music/musicTrack';
import type { Manager, Player, Track } from 'moonlink.js';
import { MAX_QUEUE_TRACKS } from './musicService';
import type { SpotifyScraperService, ScrapedTrack } from './spotifyScraperService';
import type { SpotifyResolvedTrack } from './spotifyResolver';
import type { Rung } from './youtubeHealth';
import type { MoonlinkManager } from './moonlinkManager';

/**
 * Resolves one scraper track through the health ladder (same contract as
 * MusicService.resolvePlaylistTrack). Injected by MusicService to avoid a
 * service↔manager dependency cycle; without it chunks fall back to raw
 * YouTube search (pre-resolver behavior).
 */
export type ChunkTrackResolver = (
  player: Player,
  spTrack: SpotifyResolvedTrack,
) => Promise<{ lavalinkTrack: Track; rung: Rung } | null>;

interface ChunkState {
  playlistId: string;
  playlistName: string;
  nextOffset: number;
  total: number;
  isFetching: boolean;
  skipped: number;
  guildId: string;
  requesterId: string;
  textChannelId: string;
}

/**
 * Master-class chunk loader for Spotify playlists.
 * Queues first 100 instantly, then watches `trackEnd` / `queue low watermark` (20)
 * to fetch next 100 in background, converting each scraper track → YouTube via Lavalink.
 * No upfront 500-search lag, no sound drop.
 */
export class PlaylistChunkManager {
  private readonly manager: Manager;
  private readonly scraper: SpotifyScraperService;
  private readonly moonlinkManager: MoonlinkManager;
  private readonly chunks = new Map<string, ChunkState>();
  private bound = false;
  private trackResolver: ChunkTrackResolver | null = null;
  /** Wired at startup — best-effort one-line notice in the now-playing channel. */
  private unavailableNotifier: ((guildId: string, message: string) => void) | null = null;

  public setUnavailableNotifier(notifier: (guildId: string, message: string) => void): void {
    this.unavailableNotifier = notifier;
  }

  private notifyUnavailable(guildId: string, message: string): void {
    try {
      this.unavailableNotifier?.(guildId, message);
    } catch {
      // A notice must never break the flow that produced it.
    }
  }

  /** Warns the channel when a playlist finished with unresolvable tracks. */
  private notifySkipped(state: ChunkState): void {
    if (state.skipped <= 0) return;
    const verb = state.skipped === 1 ? 'was' : 'were';
    const unit = state.skipped === 1 ? '1 track' : `${state.skipped} tracks`;
    this.notifyUnavailable(
      state.guildId,
      `⚠️ **${state.playlistName}**: ${unit} could not be resolved and ${verb} skipped.`,
    );
  }

  /** Wires ladder resolution (resolver-first, gated, backfilled). */
  public setTrackResolver(resolver: ChunkTrackResolver): void {
    this.trackResolver = resolver;
  }

  constructor(moonlinkManager: MoonlinkManager, scraper: SpotifyScraperService) {
    this.moonlinkManager = moonlinkManager;
    this.manager = moonlinkManager.getManager();
    this.scraper = scraper;
  }

  public bindEvents(): void {
    if (this.bound) return;
    this.bound = true;

    // Player gone (destroy, kick-timeout, guild removal) — drop chunk state so
    // a stale entry can't append to a future player or leak forever.
    this.manager.on('playerDestroy', (player: Player) => {
      this.clear(player.guildId);
    });

    // When a track ends, check if we should prefetch next chunk
    this.manager.on('trackEnd', async (player: Player) => {
      const state = this.chunks.get(player.guildId);
      if (!state) return;
      const remaining = player.queue.size;
      if (remaining < 20) {
        await this.fetchNext(player.guildId);
      }
    });

    // Also hook trackStart as secondary trigger (in case trackEnd missed)
    this.manager.on('trackStart', async (player: Player) => {
      const state = this.chunks.get(player.guildId);
      if (!state) return;
      if (player.queue.size < 20) {
        await this.fetchNext(player.guildId);
      }
    });

    // Queue drained while chunks remain (a whole chunk failed to resolve, or
    // the last track ended before prefetch landed). Pull the next chunk now
    // with a bounded retry — otherwise the guild sits in silence forever,
    // because nothing else will ever trigger fetchNext again.
    this.manager.on('queueEnd', async (player: Player) => {
      if (!this.chunks.has(player.guildId)) return;
      await this.drainOnQueueEnd(player.guildId);
    });
  }

  /**
   * Bounded drain loop after queueEnd: fetch the next chunk immediately and
   * resume playback the moment anything lands. A fetch that lands nothing
   * playable backs off 15s and retries (max 3 fetches, 60s overall) so one
   * bad page can't spin or stall forever. `timing` is injectable for tests.
   */
  private async drainOnQueueEnd(
    guildId: string,
    timing = { maxFetchAttempts: 3, retryDelayMs: 15000, inFlightPollMs: 2000, overallDeadlineMs: 60000 },
  ): Promise<void> {
    const deadline = Date.now() + timing.overallDeadlineMs;
    let fetchAttempts = 0;
    for (;;) {
      const state = this.chunks.get(guildId);
      if (!state) return;
      const player = this.manager.players.get(guildId);
      if (!player) {
        this.clear(guildId);
        return;
      }
      if (player.queue.size > 0) {
        if (!player.playing && !player.paused) {
          await player.play().catch(() => undefined);
        }
        return;
      }
      if (Date.now() > deadline) {
        Logger.warn({ guildId, playlistId: state.playlistId }, 'Playlist drain gave up — deadline exceeded');
        return;
      }
      if (state.isFetching) {
        // A trackEnd/trackStart-triggered fetch is already in flight;
        // fetchNext no-ops while fetching, so wait for it to land.
        await new Promise((resolve) => setTimeout(resolve, timing.inFlightPollMs));
        continue;
      }
      if (fetchAttempts >= timing.maxFetchAttempts) {
        Logger.warn({ guildId, playlistId: state.playlistId }, 'Playlist drain gave up — retries exhausted');
        return;
      }
      if (fetchAttempts > 0) {
        // Previous fetch landed nothing playable — back off before retrying.
        await new Promise((resolve) => setTimeout(resolve, timing.retryDelayMs));
      }
      fetchAttempts++;
      await this.fetchNext(guildId);
      const landed = this.manager.players.get(guildId);
      if (landed && landed.queue.size > 0 && !landed.playing && !landed.paused) {
        await landed.play().catch(() => undefined);
      }
    }
  }

  public register(guildId: string, playlistId: string, playlistName: string, total: number, nextOffset: number, requesterId: string, textChannelId: string): void {
    if (nextOffset === null || nextOffset >= total) {
      this.chunks.delete(guildId);
      return;
    }

    this.chunks.set(guildId, {
      playlistId,
      playlistName,
      nextOffset,
      total,
      isFetching: false,
      skipped: 0,
      guildId,
      requesterId,
      textChannelId,
    });

    Logger.info({ guildId, playlistId, nextOffset, total }, 'Playlist chunk manager registered');
  }

  public clear(guildId: string): void {
    this.chunks.delete(guildId);
  }

  private isPlayerAlive(guildId: string): boolean {
    const player = this.manager.players.get(guildId);
    return !!player && !(player as unknown as { destroyed?: boolean }).destroyed;
  }

  /** True when `state` is still the registered entry — guards every long await. */
  private isCurrentState(state: ChunkState): boolean {
    return this.chunks.get(state.guildId) === state;
  }

  private async fetchNext(guildId: string, chainDepth = 0): Promise<void> {
    const state = this.chunks.get(guildId);
    if (!state || state.isFetching) return;
    if (state.nextOffset >= state.total) {
      this.chunks.delete(guildId);
      Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist fully loaded');
      this.notifySkipped(state);
      return;
    }

    state.isFetching = true;

    try {
      const manager = this.manager;
      const player = manager.players.get(guildId);
      if (!player) {
        this.chunks.delete(guildId);
        return;
      }
      if (player.queue.size >= MAX_QUEUE_TRACKS) {
        this.chunks.delete(guildId);
        Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist chunk stopped — queue sanity cap reached');
        this.notifyUnavailable(guildId, `⚠️ Queue cap reached — stopped loading **${state.playlistName}**.`);
        return;
      }

      Logger.info({ guildId, playlistId: state.playlistId, offset: state.nextOffset }, 'Fetching next playlist chunk');

      const page = await this.scraper.fetchPlaylistPage(state.playlistId, state.nextOffset, 100);
      if (!this.isCurrentState(state)) {
        // A new playlist was registered (or the session cleared) while this
        // page was in flight — never delete a registration we don't own and
        // never append old-playlist tracks to it.
        Logger.info({ guildId }, 'Playlist chunk aborted — registration replaced mid-fetch');
        return;
      }
      if (!this.isPlayerAlive(guildId)) {
        this.chunks.delete(guildId);
        Logger.info({ guildId }, 'Playlist chunk aborted — player destroyed mid-fetch');
        return;
      }
      if (!page || page.tracks.length === 0) {
        Logger.warn({ guildId, playlistId: state.playlistId }, 'Scraper returned no more tracks');
        this.chunks.delete(guildId);
        return;
      }

      // Convert scraper tracks → playable tracks (5 concurrency, same as MusicService).
      // With a resolver wired, each goes through the health ladder
      // (resolver-first, duration-gated, artwork-backfilled); otherwise raw
      // YouTube search as before.
      const BATCH_SIZE = 5;
      let added = 0;

      for (let i = 0; i < page.tracks.length; i += BATCH_SIZE) {
        if (!this.isCurrentState(state)) {
          Logger.info({ guildId }, 'Playlist chunk aborted — registration replaced mid-fetch');
          return;
        }
        if (!this.isPlayerAlive(guildId)) {
          this.chunks.delete(guildId);
          Logger.info({ guildId }, 'Playlist chunk aborted — player destroyed mid-fetch');
          return;
        }
        const batchPlayer = manager.players.get(guildId);
        if (batchPlayer && batchPlayer.queue.size >= MAX_QUEUE_TRACKS) {
          this.chunks.delete(guildId);
          Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist chunk stopped — queue sanity cap reached');
          this.notifyUnavailable(guildId, `⚠️ Queue cap reached — stopped loading **${state.playlistName}**.`);
          return;
        }
        const batch = page.tracks.slice(i, i + BATCH_SIZE);
        const resolver = this.trackResolver;
        const results = await Promise.all(
          batch.map(
            async (
              t,
            ): Promise<
              | { t: ScrapedTrack; found: { lavalinkTrack: Track; rung: Rung }; r?: undefined }
              | { t: ScrapedTrack; found?: undefined; r: { tracks?: Track[] } | null }
              | null
            > => {
              if (resolver) {
                try {
                  const batchPlayer = manager.players.get(guildId);
                  if (!batchPlayer) return null;
                  const found = await resolver(batchPlayer, {
                    searchQuery: `${t.artist} - ${t.name}`,
                    name: t.name,
                    artist: t.artist,
                    durationMs: t.durationMs ?? 0,
                    artworkUrl: t.artworkUrl,
                    spotifyUri: t.spotifyUri,
                  });
                  return found ? { t, found } : null;
                } catch {
                  return null;
                }
              }
              try {
                const r = await manager.search({ query: `${t.artist} - ${t.name}`, source: 'youtube' });
                return { t, r };
              } catch {
                return null;
              }
            },
          ),
        );

        if (!this.isCurrentState(state)) {
          Logger.info({ guildId }, 'Playlist chunk aborted — registration replaced mid-fetch');
          return;
        }
        const livePlayer = manager.players.get(guildId);
        if (!livePlayer || (livePlayer as unknown as { destroyed?: boolean }).destroyed) {
          this.chunks.delete(guildId);
          Logger.info({ guildId }, 'Playlist chunk aborted — player destroyed mid-fetch');
          return;
        }
        for (const item of results) {
          if (!item) {
            state.skipped++;
            continue;
          }
          if (item.found) {
            const lavalinkTrack = item.found.lavalinkTrack;
            const trackRecord = lavalinkTrack as unknown as Record<string, unknown>;
            if (typeof trackRecord._rawVideoTitle !== 'string' && lavalinkTrack.title) {
              trackRecord._rawVideoTitle = lavalinkTrack.title;
            }
            if (typeof trackRecord._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(lavalinkTrack.identifier ?? '')) {
              const src = String(trackRecord.sourceName ?? '');
              if (src === 'youtube' || src === '') trackRecord._sourceVideoId = lavalinkTrack.identifier;
            }
            trackRecord.requester = { id: state.requesterId } as unknown as string;
            trackRecord.title = item.t.name;
            trackRecord.author = item.t.artist;
            if (item.t.artworkUrl) {
              trackRecord.artworkUrl = item.t.artworkUrl;
            }
            if (item.t.spotifyUri) {
              trackRecord.uri = spotifyUriToUrl(item.t.spotifyUri);
            }
            // Resolver output stays 'local' so failure handling never
            // mistakes it for plugin output (same convention as MusicService).
            const backend = item.found.rung === 'resolver' ? 'local' : 'spotify';
            trackRecord.sourceName = backend;
            trackRecord.source = backend;
            livePlayer.queue.add(lavalinkTrack);
            added++;
            continue;
          }
          if (!item?.r?.tracks?.[0]) {
            state.skipped++;
            continue;
          }
          const lavalinkTrack = item.r.tracks[0];
          const trackRecord = lavalinkTrack as unknown as Record<string, unknown>;
          if (typeof trackRecord._rawVideoTitle !== 'string' && lavalinkTrack.title) {
            trackRecord._rawVideoTitle = lavalinkTrack.title;
          }
          if (typeof trackRecord._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(lavalinkTrack.identifier ?? '')) {
            trackRecord._sourceVideoId = lavalinkTrack.identifier;
          }
          trackRecord.requester = { id: state.requesterId } as unknown as string;
          trackRecord.title = item.t.name;
          trackRecord.author = item.t.artist;
          if (item.t.artworkUrl) {
            trackRecord.artworkUrl = item.t.artworkUrl;
          }
          if (item.t.spotifyUri) {
            trackRecord.uri = spotifyUriToUrl(item.t.spotifyUri);
          }
          trackRecord.sourceName = 'spotify';
          trackRecord.source = 'spotify';
          livePlayer.queue.add(lavalinkTrack);
          added++;
        }
      }

      Logger.info({ guildId, added, nextOffset: page.nextOffset, total: state.total }, 'Chunk appended to queue');

      if (page.nextOffset === null || page.nextOffset >= state.total) {
        this.chunks.delete(guildId);
        Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist chunk streaming complete');
        this.notifySkipped(state);
      } else {
        state.nextOffset = page.nextOffset;
        state.isFetching = false;

        // If still low, chain at most one more chunk per event — deep chains
        // inside a single trackEnd starve the event loop on huge playlists.
        const chainedPlayer = manager.players.get(guildId);
        if (chainDepth < 1 && chainedPlayer && chainedPlayer.queue.size < 20) {
          await this.fetchNext(guildId, chainDepth + 1);
        }
        return;
      }
    } catch (err) {
      Logger.warn({ err, guildId }, 'Playlist chunk fetch failed');
    }

    const s = this.chunks.get(guildId);
    if (s) s.isFetching = false;
  }

  public getState(guildId: string): ChunkState | undefined {
    return this.chunks.get(guildId);
  }
}
