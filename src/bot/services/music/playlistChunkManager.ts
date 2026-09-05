import { Logger } from '@domain/logger';
import type { Manager, Player } from 'moonlink.js';
import type { SpotifyScraperService } from './spotifyScraperService';
import type { MoonlinkManager } from './moonlinkManager';

interface ChunkState {
  playlistId: string;
  playlistName: string;
  nextOffset: number;
  total: number;
  isFetching: boolean;
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

  constructor(moonlinkManager: MoonlinkManager, scraper: SpotifyScraperService) {
    this.moonlinkManager = moonlinkManager;
    this.manager = moonlinkManager.getManager();
    this.scraper = scraper;
  }

  public bindEvents(): void {
    if (this.bound) return;
    this.bound = true;

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
      guildId,
      requesterId,
      textChannelId,
    });

    Logger.info({ guildId, playlistId, nextOffset, total }, 'Playlist chunk manager registered');
  }

  public clear(guildId: string): void {
    this.chunks.delete(guildId);
  }

  private async fetchNext(guildId: string): Promise<void> {
    const state = this.chunks.get(guildId);
    if (!state || state.isFetching) return;
    if (state.nextOffset >= state.total) {
      this.chunks.delete(guildId);
      Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist fully loaded');
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

      Logger.info({ guildId, playlistId: state.playlistId, offset: state.nextOffset }, 'Fetching next playlist chunk');

      const page = await this.scraper.fetchPlaylistPage(state.playlistId, state.nextOffset, 100);
      if (!page || page.tracks.length === 0) {
        Logger.warn({ guildId, playlistId: state.playlistId }, 'Scraper returned no more tracks');
        this.chunks.delete(guildId);
        return;
      }

      // Convert scraper tracks → Lavalink YouTube tracks (5 concurrency, same as MusicService)
      const BATCH_SIZE = 5;
      let added = 0;

      for (let i = 0; i < page.tracks.length; i += BATCH_SIZE) {
        const batch = page.tracks.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(t =>
            manager
              .search({ query: `${t.artist} - ${t.name}`, source: 'youtube' })
              .then(r => ({ r, t }))
              .catch(() => null),
          ),
        );

        for (const item of results) {
          if (!item?.r?.tracks?.[0]) continue;
          const lavalinkTrack = item.r.tracks[0];
          const trackRecord = lavalinkTrack as unknown as Record<string, unknown>;
          trackRecord.requester = { id: state.requesterId } as unknown as string;
          trackRecord.title = item.t.name;
          trackRecord.author = item.t.artist;
          if (item.t.artworkUrl) {
            trackRecord.artworkUrl = item.t.artworkUrl;
          }
          if (item.t.spotifyUri) {
            trackRecord.uri = item.t.spotifyUri;
          }
          trackRecord.sourceName = 'spotify';
          trackRecord.source = 'spotify';
          player.queue.add(lavalinkTrack);
          added++;
        }
      }

      Logger.info({ guildId, added, nextOffset: page.nextOffset, total: state.total }, 'Chunk appended to queue');

      if (page.nextOffset === null || page.nextOffset >= state.total) {
        this.chunks.delete(guildId);
        Logger.info({ guildId, playlistId: state.playlistId }, 'Playlist chunk streaming complete');
      } else {
        state.nextOffset = page.nextOffset;
        state.isFetching = false;

        // If still low, chain next
        if (player.queue.size < 20) {
          await this.fetchNext(guildId);
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
