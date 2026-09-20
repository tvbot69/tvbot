import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { cleanTrackTitle, isSpotifyMatchValid, mapMoonlinkTrack, type MusicTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import { MoonlinkManager, type LavalinkNodeStats } from './moonlinkManager';
import { SpotifyResolver, type SpotifyResolvedTrack } from './spotifyResolver';
import { QueueService } from './queueService';
import type { PlaylistChunkManager } from './playlistChunkManager';

export interface PlayResult {
  loadType: 'track' | 'playlist' | 'spotify_album' | 'spotify_playlist' | 'spotify_artist' | 'empty' | 'error';
  track?: MusicTrack;
  tracks?: MusicTrack[];
  playlistName?: string;
  artworkUrl?: string;
  totalTracksAdded: number;
  positionInQueue: number;
  /** True when fewer tracks resolved than the source listed (blocked/missing). */
  partial?: boolean;
  errorReason?: 'no-nodes' | 'voice' | 'search' | 'empty-spotify';
}

export const playErrorMessage = (reason?: PlayResult['errorReason']): string => {
  switch (reason) {
    case 'no-nodes':
      return 'All music nodes are rate-limited right now. Try again in 30–60 seconds.';
    case 'voice':
      return 'I could not join your voice channel. Check my permissions and try again.';
    case 'empty-spotify':
      return 'Could not resolve that Spotify link (private, deleted, or region-locked?).';
    default:
      return 'An error occurred while communicating with the music node. Try again in a few seconds.';
  }
};

export class MusicService {
  public readonly moonlinkManager: MoonlinkManager;
  private readonly spotifyResolver: SpotifyResolver;
  private readonly queueService: QueueService;
  private readonly playlistChunkManager?: PlaylistChunkManager;

  constructor(
    moonlinkManager: MoonlinkManager,
    spotifyResolver: SpotifyResolver,
    queueService: QueueService,
    playlistChunkManager?: PlaylistChunkManager,
  ) {
    this.moonlinkManager = moonlinkManager;
    this.spotifyResolver = spotifyResolver;
    this.queueService = queueService;
    this.playlistChunkManager = playlistChunkManager;
    this.playlistChunkManager?.bindEvents();
  }

  public getPlayer(guildId: string): Player | undefined {
    const manager = this.moonlinkManager.getManager();
    return manager.players.get(guildId);
  }

  public getOrCreatePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Player {
    const manager = this.moonlinkManager.getManager();
    let player = manager.players.get(guildId);
    if (!player) {
      // Re-apply persisted guild prefs so a recreate (rejoin, failover,
      // restart) doesn't reset volume/loop/autoplay/filters.
      const prefs = this.queueService.getSettings(guildId);
      player = manager.players.create({
        guildId,
        voiceChannelId,
        textChannelId,
        autoPlay: prefs.autoplay,
        volume: prefs.volume,
        selfDeaf: true,
      });
      if (prefs.loopMode !== 'off') {
        try {
          player.setLoop(prefs.loopMode as 'track' | 'queue');
        } catch {
          // ignore invalid stored loop values
        }
      }
      if (prefs.filters.length > 0) {
        for (const filter of prefs.filters) {
          try {
            player.filters.enable(filter as Parameters<typeof player.filters.enable>[0]);
          } catch {
            // ignore unknown filter names
          }
        }
        void player.filters.apply().catch(() => undefined);
      }
    }

    if (player.voiceChannelId !== voiceChannelId) {
      player.setVoiceChannelId(voiceChannelId);
    }
    if (player.textChannelId !== textChannelId) {
      player.setTextChannelId(textChannelId);
    }

    return player;
  }

  public async play(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
    query: string,
    requester: MusicTrackRequester,
    trackOverride?: {
      title?: string;
      author?: string;
      artworkUrl?: string;
      source?: string;
    },
  ): Promise<PlayResult> {
    const manager = this.moonlinkManager.getManager();

    // Good error handling for public node rate-limit (4000)
    if (!this.moonlinkManager.hasHealthyNode()) {
      Logger.warn({ guildId }, 'All Lavalink nodes are on cooldown (4000 rate-limit). Try again in 30-60s.');
      return {
        loadType: 'error',
        errorReason: 'no-nodes',
        totalTracksAdded: 0,
        positionInQueue: 0,
      };
    }

    const player = this.getOrCreatePlayer(guildId, voiceChannelId, textChannelId);

    if (!player.connected) {
      try {
        await player.connect({ selfDeaf: true });
      } catch (err) {
        Logger.error({ err, guildId }, 'Failed to connect player to voice');
        if (!this.moonlinkManager.hasHealthyNode()) {
          return { loadType: 'error', errorReason: 'no-nodes', totalTracksAdded: 0, positionInQueue: 0 };
        }
        return { loadType: 'error', errorReason: 'voice', totalTracksAdded: 0, positionInQueue: 0 };
      }
    }

    const trimmedQuery = query.trim();

    // 1. Spotify link resolution
    if (this.spotifyResolver.isSpotifyUrl(trimmedQuery)) {
      return await this.playSpotify(player, trimmedQuery, requester, trackOverride);
    }

    // 2. Lavalink search (query or URL - YouTube / SoundCloud)
    const isSoundcloud = /^(https?:\/\/)?(www\.)?soundcloud\.com\/.+$/i.test(trimmedQuery);
    const isYoutubeUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(trimmedQuery);
    const isDirectUrl = isYoutubeUrl || isSoundcloud || /^https?:\/\//i.test(trimmedQuery);
    let searchSource: 'soundcloud' | 'youtube' = isSoundcloud ? 'soundcloud' : 'youtube';

    try {
      let res = await manager.search({
        query: trimmedQuery,
        source: searchSource,
      });

      // YouTube search returns zero hits for some text queries (explicit terms,
      // obscure spellings) while SoundCloud has them — retry there before giving
      // up. Never second-guess a direct URL the user pasted.
      if ((!res || !res.tracks || res.tracks.length === 0) && !isDirectUrl && searchSource === 'youtube') {
        try {
          const scRes = await manager.search({ query: trimmedQuery, source: 'soundcloud' });
          if (scRes?.tracks && scRes.tracks.length > 0) {
            Logger.info({ query: trimmedQuery }, '[Music] YouTube search empty — falling back to SoundCloud');
            res = scRes;
            searchSource = 'soundcloud';
          }
        } catch {
          // fall through to empty below
        }
      }

      if (!res || !res.tracks || res.tracks.length === 0) {
        return {
          loadType: 'empty',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      if (res.loadType === 'playlist') {
        const addedTracks: MusicTrack[] = [];
        for (const rawTrack of res.tracks) {
          rawTrack.requester = requester;
          const trackRecord = rawTrack as unknown as Record<string, unknown>;
          trackRecord.sourceName = searchSource;
          trackRecord.source = searchSource;
          player.queue.add(rawTrack);
          const domain = mapMoonlinkTrack(rawTrack, requester);
          domain.source = searchSource;
          addedTracks.push(domain);
        }

        if (!player.playing && !player.paused) {
          await player.play();
        }

        return {
          loadType: 'playlist',
          playlistName: res.playlistInfo?.name || 'Playlist',
          tracks: addedTracks,
          totalTracksAdded: addedTracks.length,
          positionInQueue: player.queue.size - addedTracks.length + 1,
        };
      }

      // Single track or search result list
      const chosenTrack = res.tracks[0]!;
      chosenTrack.requester = requester;
      if (trackOverride?.title) chosenTrack.title = trackOverride.title;
      if (trackOverride?.author) chosenTrack.author = trackOverride.author;
      if (trackOverride?.artworkUrl) chosenTrack.artworkUrl = trackOverride.artworkUrl;
      const chosenRecord = chosenTrack as unknown as Record<string, unknown>;
      const chosenSource = trackOverride?.source || searchSource;
      chosenRecord.sourceName = chosenSource;
      chosenRecord.source = chosenSource;
      if (trackOverride?.artworkUrl) {
        chosenRecord.artworkUrl = trackOverride.artworkUrl;
      }

      // Query Spotify for clean canonical song name and artist (only if not soundcloud, not direct url, and not overridden)
      if (!isSoundcloud && !isDirectUrl && !trackOverride?.title) {
        try {
          const queryToSearch = cleanTrackTitle(chosenTrack.title);
          const spotifyMatch = await Promise.race([
            this.spotifyResolver.searchTrack(queryToSearch),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
          if (spotifyMatch && isSpotifyMatchValid(chosenTrack, spotifyMatch)) {
            chosenTrack.title = spotifyMatch.name;
            chosenTrack.author = spotifyMatch.artist;
            if (spotifyMatch.artworkUrl) {
              chosenTrack.artworkUrl = spotifyMatch.artworkUrl;
            }
            if (spotifyMatch.spotifyUri) {
              chosenTrack.uri = spotifyMatch.spotifyUri;
            }
          }
        } catch {
          // Fallback safely to Lavalink track info
        }
      }

      player.queue.add(chosenTrack);

      const domainTrack = mapMoonlinkTrack(chosenTrack, requester);
      domainTrack.source = chosenSource;
      if (trackOverride?.artworkUrl) {
        domainTrack.artworkUrl = trackOverride.artworkUrl;
      }

      if (!player.playing && !player.paused) {
        await player.play();
      }

      return {
        loadType: 'track',
        track: domainTrack,
        totalTracksAdded: 1,
        positionInQueue: player.queue.size,
      };
    } catch (err) {
      Logger.error({ err, query: trimmedQuery }, 'Lavalink play search error');
      return {
        loadType: 'error',
        totalTracksAdded: 0,
        positionInQueue: 0,
      };
    }
  }

  private async playSpotify(
    player: Player,
    spotifyUrl: string,
    requester: MusicTrackRequester,
    trackOverride?: {
      title?: string;
      author?: string;
      artworkUrl?: string;
      source?: string;
    },
  ): Promise<PlayResult> {
    const manager = this.moonlinkManager.getManager();
    const resolution = await this.spotifyResolver.resolve(spotifyUrl);

    if (!resolution || resolution.tracks.length === 0) {
      return {
        loadType: 'empty',
        totalTracksAdded: 0,
        positionInQueue: 0,
      };
    }

    if (resolution.type === 'track') {
      const spotifyTrack = resolution.tracks[0]!;
      const res = await manager.search({
        query: spotifyTrack.searchQuery,
        source: 'youtube',
      });

      if (!res || !res.tracks || res.tracks.length === 0) {
        return {
          loadType: 'empty',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      const chosenTrack = res.tracks[0]!;
      chosenTrack.requester = requester;
      chosenTrack.title = trackOverride?.title || spotifyTrack.name;
      chosenTrack.author = trackOverride?.author || spotifyTrack.artist;
      const finalArtwork = trackOverride?.artworkUrl || spotifyTrack.artworkUrl;
      if (finalArtwork) {
        chosenTrack.artworkUrl = finalArtwork;
      }
      chosenTrack.uri = spotifyTrack.spotifyUri || spotifyUrl;
      const trackRecord = chosenTrack as unknown as Record<string, unknown>;
      const finalSource = trackOverride?.source || 'spotify';
      trackRecord.sourceName = finalSource;
      trackRecord.source = finalSource;
      if (finalArtwork) {
        trackRecord.artworkUrl = finalArtwork;
      }
      player.queue.add(chosenTrack);

      const domainTrack = mapMoonlinkTrack(chosenTrack, requester);
      domainTrack.source = finalSource;
      if (finalArtwork) {
        domainTrack.artworkUrl = finalArtwork;
      }

      if (!player.playing && !player.paused) {
        await player.play();
      }

      return {
        loadType: 'track',
        track: domainTrack,
        totalTracksAdded: 1,
        positionInQueue: player.queue.size,
      };
    }

    // Spotify Album / Playlist / Artist top tracks
    const addedTracks: MusicTrack[] = [];
    const firstTrack = resolution.tracks[0]!;

    // Resolve first track immediately so playback begins with minimum delay
    const firstSearchRes = await manager.search({
      query: firstTrack.searchQuery,
      source: 'youtube',
    });

    if (firstSearchRes && firstSearchRes.tracks && firstSearchRes.tracks.length > 0) {
      const firstLavalinkTrack = firstSearchRes.tracks[0]!;
      firstLavalinkTrack.requester = requester;
      firstLavalinkTrack.title = firstTrack.name;
      firstLavalinkTrack.author = firstTrack.artist;
      if (firstTrack.artworkUrl) {
        firstLavalinkTrack.artworkUrl = firstTrack.artworkUrl;
      }
      firstLavalinkTrack.uri = firstTrack.spotifyUri || spotifyUrl;
      const firstRecord = firstLavalinkTrack as unknown as Record<string, unknown>;
      firstRecord.sourceName = 'spotify';
      firstRecord.source = 'spotify';
      player.queue.add(firstLavalinkTrack);
      const firstDomainTrack = mapMoonlinkTrack(firstLavalinkTrack, requester);
      firstDomainTrack.source = 'spotify';
      addedTracks.push(firstDomainTrack);

      if (!player.playing && !player.paused) {
        await player.play();
      }
    }

    // Resolve remaining tracks in parallel batches. Each track gets a bounded
    // YouTube attempt plus one SoundCloud second chance — a blocked uploader
    // or a hung search must not silently drop (or stall) the whole playlist.
    const remainingTracks = resolution.tracks.slice(1);
    const BATCH_SIZE = 5;
    for (let i = 0; i < remainingTracks.length; i += BATCH_SIZE) {
      const batch = remainingTracks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((t) => this.resolvePlaylistTrack(manager, t)),
      );

      for (const item of batchResults) {
        if (!item) continue;
        const lavalinkTrack = item.lavalinkTrack;
        lavalinkTrack.requester = requester;
        lavalinkTrack.title = item.spTrack.name;
        lavalinkTrack.author = item.spTrack.artist;
        if (item.spTrack.artworkUrl) {
          lavalinkTrack.artworkUrl = item.spTrack.artworkUrl;
        }
        if (item.spTrack.spotifyUri) {
          lavalinkTrack.uri = item.spTrack.spotifyUri;
        }
        const remRecord = lavalinkTrack as unknown as Record<string, unknown>;
        remRecord.sourceName = 'spotify';
        remRecord.source = 'spotify';
        player.queue.add(lavalinkTrack);
        const domainTrack = mapMoonlinkTrack(lavalinkTrack, requester);
        domainTrack.source = 'spotify';
        addedTracks.push(domainTrack);
      }
    }

    const loadType =
      resolution.type === 'album'
        ? 'spotify_album'
        : resolution.type === 'playlist'
          ? 'spotify_playlist'
          : 'spotify_artist';

    // Perfect: if playlist was chunked (scraper 100/312), register lazy loader for next 100
    if (resolution.type === 'playlist' && this.playlistChunkManager && resolution.totalTracks > resolution.tracks.length) {
      const parsed = this.spotifyResolver.parseSpotifyUrl(spotifyUrl);
      if (parsed) {
        this.playlistChunkManager.register(
          player.guildId,
          parsed.id,
          resolution.title,
          resolution.totalTracks,
          resolution.tracks.length,
          String((requester as unknown as { id?: string })?.id ?? (requester as unknown as string) ?? 'unknown'),
          player.textChannelId ?? '',
        );
      }
    }

    const partial = addedTracks.length < resolution.tracks.length;
    if (partial) {
      Logger.warn(
        { guildId: player.guildId, added: addedTracks.length, total: resolution.tracks.length },
        '[Music] Playlist partially resolved — unresolvable tracks skipped',
      );
    }

    return {
      loadType,
      playlistName: resolution.title,
      artworkUrl: resolution.artworkUrl,
      tracks: addedTracks,
      totalTracksAdded: addedTracks.length,
      positionInQueue: player.queue.size - addedTracks.length + 1,
      partial,
    };
  }

  /**
   * Resolves one playlist track to a playable Lavalink track: bounded YouTube
   * search first, one SoundCloud second chance, null when unresolvable.
   */
  private async resolvePlaylistTrack(
    manager: { search: (args: { query: string; source: string }) => Promise<{ tracks?: Array<import('moonlink.js').Track> } | null> },
    spTrack: SpotifyResolvedTrack,
  ): Promise<{ lavalinkTrack: import('moonlink.js').Track; spTrack: SpotifyResolvedTrack } | null> {
    const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T | null>((resolve) => {
            timer = setTimeout(() => resolve(null), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      const yt = await withTimeout(
        manager.search({ query: spTrack.searchQuery, source: 'youtube' }),
        8000,
      );
      const ytHit = yt?.tracks?.[0];
      if (ytHit) return { lavalinkTrack: ytHit, spTrack };
    } catch {
      // fall through to SoundCloud
    }

    try {
      const sc = await withTimeout(
        manager.search({ query: spTrack.searchQuery, source: 'soundcloud' }),
        8000,
      );
      const scHit = sc?.tracks?.[0];
      if (scHit) return { lavalinkTrack: scHit, spTrack };
    } catch {
      // unresolvable
    }
    return null;
  }

  public getQueueInfo(guildId: string): MusicQueueInfo | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    return this.queueService.getQueueInfo(player);
  }

  public async skip(guildId: string, amount: number = 1): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;

    // removeRange is inclusive on both ends: to land on the Nth upcoming
    // track, drop the N-1 before it (indices 0..amount-2), then skip().
    if (amount > 1) {
      if (amount - 1 > player.queue.size) return false;
      player.queue.removeRange(0, amount - 2);
    }

    return await player.skip();
  }

  public async stop(guildId: string): Promise<void> {
    const player = this.getPlayer(guildId);
    if (!player) return;

    this.queueService.set247(guildId, false);
    this.playlistChunkManager?.clear(guildId);
    player.queue.clear();
    await player.destroy('Stopped by user');
  }

  public async leave(guildId: string): Promise<void> {
    await this.stop(guildId);
  }

  public clearPlaylistChunks(guildId: string): void {
    this.playlistChunkManager?.clear(guildId);
  }

  public async pause(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    if (player.current) {
      const currentPos = this.queueService.calculatePosition(player);
      player.current.position = currentPos;
      player.current.time = Date.now();
    }
    await player.pause();
    return true;
  }

  public async resume(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    if (player.current) {
      player.current.time = Date.now();
    }
    await player.resume();
    return true;
  }

  public async seek(guildId: string, seconds: number): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || !player.current) return false;
    const ms = Math.max(0, Math.min(seconds * 1000, player.current.duration || 0));
    await player.seek(ms);
    if (player.current) {
      player.current.position = ms;
      player.current.time = Date.now();
    }
    return true;
  }

  public setVolume(guildId: string, volume: number): number | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const clamped = Math.max(0, Math.min(150, Math.round(volume)));
    player.setVolume(clamped);
    this.queueService.saveSettings(guildId, { volume: clamped });
    return clamped;
  }

  public async setFilter(guildId: string, filter: FilterName, enabled: boolean): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;

    if (enabled) {
      player.filters.enable(filter);
    } else {
      player.filters.disable(filter);
    }
    await player.filters.apply();
    this.queueService.saveSettings(guildId, { filters: [...player.filters.enabled] });
    return true;
  }

  public async clearFilters(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    player.filters.clear();
    await player.filters.apply();
    this.queueService.saveSettings(guildId, { filters: [] });
    return true;
  }

  public toggle247(guildId: string, enabled?: boolean): boolean {
    const current = this.queueService.is247(guildId);
    const nextState = enabled !== undefined ? enabled : !current;
    this.queueService.set247(guildId, nextState);
    return nextState;
  }

  public setLoop(guildId: string, mode: LoopMode): LoopMode | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    player.setLoop(mode);
    this.queueService.saveSettings(guildId, { loopMode: mode });
    return mode;
  }

  public toggleAutoplay(guildId: string, enabled?: boolean): boolean | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const nextState = enabled !== undefined ? enabled : !player.autoPlay;
    player.setAutoPlay(nextState);
    this.queueService.saveSettings(guildId, { autoplay: nextState });
    return nextState;
  }

  public shuffle(guildId: string): boolean {
    const player = this.getPlayer(guildId);
    if (!player || player.queue.isEmpty) return false;
    player.queue.shuffle();
    return true;
  }

  public clear(guildId: string): boolean {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    player.queue.clear();
    return true;
  }

  public remove(guildId: string, index: number): MusicTrack | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const removed = player.queue.remove(index);
    return removed ? mapMoonlinkTrack(removed) : null;
  }

  public async previous(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    if (!player.previous || player.previous.length === 0) return false;
    const prevTrack = player.previous.pop()!;
    // Do NOT re-queue current: player.skip()/play() already pushes the old
    // current into history, so re-adding it duplicates the queue on every
    // toggle. Just front the previous track and advance to it.
    player.queue.unshift(prevTrack);
    return await player.skip();
  }

  public async skipto(guildId: string, position: number): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || position < 1 || position > player.queue.size) return false;
    if (position > 1) {
      player.queue.removeRange(0, position - 2);
    }
    return await player.skip();
  }

  public move(guildId: string, from: number, to: number): boolean {
    const player = this.getPlayer(guildId);
    if (!player || from < 1 || to < 1 || from > player.queue.size || to > player.queue.size) {
      return false;
    }
    return player.queue.move(from - 1, to - 1);
  }

  public async replay(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || !player.current) return false;
    await player.seek(0);
    if (player.current) {
      player.current.position = 0;
      player.current.time = Date.now();
    }
    return true;
  }

  public adjustVolume(guildId: string, delta: number): number | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const current = player.volume ?? 100;
    const nextVol = Math.max(0, Math.min(150, current + delta));
    player.setVolume(nextVol);
    this.queueService.saveSettings(guildId, { volume: nextVol });
    return nextVol;
  }

  public cycleLoop(guildId: string): LoopMode | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    let nextMode: LoopMode = 'off';
    if (player.loop === 'off' || !player.loop) nextMode = 'track';
    else if (player.loop === 'track') nextMode = 'queue';
    else if (player.loop === 'queue') nextMode = 'off';
    player.setLoop(nextMode);
    this.queueService.saveSettings(guildId, { loopMode: nextMode });
    return nextMode;
  }

  public async searchTracks(query: string, source: string = 'youtube'): Promise<MusicTrack[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 1. Try Spotify search first for text queries so results have clean track names, artists, high-res artwork, and spotify URIs
    const isUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+/i.test(trimmed) || /^https?:\/\//i.test(trimmed);
    if (!isUrl) {
      try {
        const spotifyResults = await Promise.race([
          this.spotifyResolver.searchTracks(trimmed, 10),
          new Promise<SpotifyResolvedTrack[]>((resolve) => setTimeout(() => resolve([]), 2500)),
        ]);

        if (spotifyResults.length > 0) {
          return spotifyResults.map((st, idx) => ({
            identifier: `spotify:${idx}:${st.name}`,
            title: st.name,
            author: st.artist,
            uri: st.spotifyUri || `${st.artist} - ${st.name}`,
            duration: st.durationMs,
            isSeekable: true,
            isStream: false,
            artworkUrl: st.artworkUrl,
            source: 'spotify',
          }));
        }
      } catch {
        // Fallback to Lavalink
      }
    }

    // 2. Fallback to Lavalink (YouTube / SoundCloud)
    const manager = this.moonlinkManager.getManager();
    const res = await manager.search({ query: trimmed, source });
    if (!res || !res.tracks || res.tracks.length === 0) return [];
    return (res.tracks as Array<import('moonlink.js').Track>).slice(0, 10).map((t) => mapMoonlinkTrack(t));
  }

  public getHistory(guildId: string, limit: number = 10) {
    return this.queueService.getHistory(guildId, limit);
  }

  public getNodeStats(): LavalinkNodeStats[] {
    return this.moonlinkManager.getNodeStats();
  }
}

