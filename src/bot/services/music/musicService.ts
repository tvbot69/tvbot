import type { Player, Track } from 'moonlink.js';
import { Track as MoonlinkTrack } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { cleanTrackTitle, isSpotifyMatchValid, mapMoonlinkTrack, type MusicTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import { MoonlinkManager, type LavalinkNodeStats } from './moonlinkManager';
import { SpotifyResolver, type SpotifyResolvedTrack } from './spotifyResolver';
import { QueueService } from './queueService';
import type { PlaylistChunkManager } from './playlistChunkManager';
import { ladderFor, HOME_NODE, type Rung } from './youtubeHealth';
import { resolveViaHome, resolverEnabled, type ResolverMeta } from './ytResolver';

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

  public async getOrCreatePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<Player> {
    const manager = this.moonlinkManager.getManager();
    let player = manager.players.get(guildId);
    let created = false;
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
      created = true;
    }

    // Fresh players start on Home when the resolver is configured: local
    // files only exist there, and Home-first is the standing preference.
    // Existing (playing) players are never moved here — failover owns that.
    if (created && resolverEnabled()) {
      try {
        await player.transferNode(HOME_NODE).catch(() => undefined);
      } catch {
        // Home down or missing — least-load pick stands
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

  private async searchWithTimeout(
    args: { query: string; source: string },
    ms: number = 8000,
  ): Promise<{ tracks?: Track[] } | null> {
    const manager = this.moonlinkManager.getManager();
    let timer: NodeJS.Timeout | undefined;
    try {
      const raced = await Promise.race([
        manager.search(args),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
      return raced as { tracks?: Track[] } | null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One YouTube attempt shared by the plugin + resolver rungs, then per-rung
   * selection. Resolver hits are labeled 'local' so failure handling treats
   * them as resolver output, never as YouTube plugin output.
   */
  private async searchTrackWithLadder(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | null> {
    const rungs = ladderFor(player);
    let ytHit: Track | undefined;
    if (rungs.includes('plugin') || rungs.includes('resolver')) {
      try {
        const yt = await this.searchWithTimeout({ query, source: 'youtube' });
        ytHit = yt?.tracks?.[0];
      } catch {
        // fall through to remaining rungs
      }
    }
    for (const rung of rungs) {
      if (rung === 'soundcloud') {
        try {
          const sc = await this.searchWithTimeout({ query, source: 'soundcloud' });
          if (sc?.tracks?.[0]) return { track: sc.tracks[0], rung };
        } catch {
          // next rung
        }
        continue;
      }
      if (!ytHit) continue;
      if (rung === 'plugin') return { track: ytHit, rung };
      const local = await this.tryResolverTrack(player, ytHit, meta);
      if (local) return { track: local, rung };
    }
    return null;
  }

  private async tryResolverTrack(player: Player, ytTrack: Track, meta?: ResolverMeta): Promise<Track | null> {
    if (player.node?.identifier !== HOME_NODE) return null;
    if (!/^[\w-]{11}$/.test(ytTrack.identifier ?? '')) return null;
    const path = await resolveViaHome(ytTrack.identifier, meta);
    if (!path) return null;
    let res: unknown;
    try {
      res = await player.node.rest.loadTracks(path);
    } catch {
      return null;
    }
    const typed = res as { loadType?: string; data?: { encoded?: string } };
    if (typed?.loadType !== 'track' || !typed.data?.encoded) return null;
    try {
      return new MoonlinkTrack(typed.data, ytTrack.requester);
    } catch (err) {
      Logger.debug(
        { err, keys: typed.data ? Object.keys(typed.data) : [] },
        '[Music] Track construction from resolver data failed',
      );
      return null;
    }
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

    const player = await this.getOrCreatePlayer(guildId, voiceChannelId, textChannelId);

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

    // Direct SoundCloud URLs always go straight there; everything else runs
    // the health ladder (resolver → plugin → soundcloud, SoundCloud-first
    // while YouTube is declared down).
    if (isSoundcloud) {
      try {
        const res = await manager.search({ query: trimmedQuery, source: 'soundcloud' });
        if (!res?.tracks || res.tracks.length === 0) {
          return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
        }
        return await this.enqueueLavalinkTracks(player, res.tracks, requester, trackOverride, 'soundcloud');
      } catch (err) {
        Logger.error({ err, query: trimmedQuery }, 'Lavalink play search error');
        return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
      }
    }

    try {
      // A pasted YouTube URL loads metadata first; when YouTube is down the
      // same ladder replays it from SoundCloud (or the local resolver).
      if (isYoutubeUrl) {
        let urlRes: { tracks?: Track[]; loadType?: string } | null = null;
        try {
          urlRes = await this.searchWithTimeout({ query: trimmedQuery, source: 'youtube' });
        } catch {
          urlRes = null;
        }
        if (!urlRes?.tracks || urlRes.tracks.length === 0) {
          return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
        }
        if (urlRes.loadType === 'playlist') {
          return await this.enqueueLavalinkTracks(player, urlRes.tracks, requester, trackOverride, 'youtube');
        }
        const meta = urlRes.tracks[0]!;
        const rungs = ladderFor(player);
        if (!rungs.includes('plugin')) {
          const scQuery = `${meta.author} - ${meta.title}`;
          const swapped = await this.searchTrackWithLadder(player, scQuery, trackOverride ? {
            title: trackOverride.title,
            artist: trackOverride.author,
          } : undefined);
          if (swapped) {
            const hit = swapped.track;
            hit.requester = requester;
            hit.title = trackOverride?.title || meta.title;
            hit.author = trackOverride?.author || meta.author;
            const rungSource = swapped.rung === 'resolver' ? 'local' : 'soundcloud';
            const rec = hit as unknown as Record<string, unknown>;
            rec.sourceName = trackOverride?.source || rungSource;
            rec.source = trackOverride?.source || rungSource;
            return await this.enqueueLavalinkTracks(player, [hit], requester, trackOverride, rungSource);
          }
          return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
        }
        return await this.enqueueLavalinkTracks(player, [meta], requester, trackOverride, 'youtube');
      }

      // Text query (or anything else): full ladder.
      const found = await this.searchTrackWithLadder(player, trimmedQuery, trackOverride ? {
        title: trackOverride.title,
        artist: trackOverride.author,
      } : undefined);
      if (!found) {
        return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
      }
      const ladderSource = found.rung === 'resolver' ? 'local' : found.rung === 'soundcloud' ? 'soundcloud' : 'youtube';
      return await this.enqueueLavalinkTracks(player, [found.track], requester, trackOverride, ladderSource, undefined, true);

      return {
        loadType: 'empty',
        totalTracksAdded: 0,
        positionInQueue: 0,
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

  /**
   * Queues already-resolved Lavalink tracks (playlist arrays or single hits).
   * `source` is the ladder rung that produced them — resolver output stays
   * 'local' so failure handling never mistakes it for plugin output.
   */
  private async enqueueLavalinkTracks(
    player: Player,
    tracks: Track[],
    requester: MusicTrackRequester,
    trackOverride: { title?: string; author?: string; artworkUrl?: string; source?: string } | undefined,
    source: string,
    playlistName?: string,
    enrichWithSpotify = false,
  ): Promise<PlayResult> {
    const addedTracks: MusicTrack[] = [];
    for (const rawTrack of tracks) {
      rawTrack.requester = requester;
      if (trackOverride?.title) rawTrack.title = trackOverride.title;
      if (trackOverride?.author) rawTrack.author = trackOverride.author;
      if (trackOverride?.artworkUrl) rawTrack.artworkUrl = trackOverride.artworkUrl;
      const trackRecord = rawTrack as unknown as Record<string, unknown>;
      const finalSource = trackOverride?.source || source;
      trackRecord.sourceName = finalSource;
      trackRecord.source = finalSource;
      if (enrichWithSpotify && source === 'youtube' && !trackOverride?.title) {
        try {
          const queryToSearch = cleanTrackTitle(rawTrack.title);
          const spotifyMatch = await Promise.race([
            this.spotifyResolver.searchTrack(queryToSearch),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
          if (spotifyMatch && isSpotifyMatchValid(rawTrack, spotifyMatch)) {
            rawTrack.title = spotifyMatch.name;
            rawTrack.author = spotifyMatch.artist;
            if (spotifyMatch.artworkUrl) rawTrack.artworkUrl = spotifyMatch.artworkUrl;
            if (spotifyMatch.spotifyUri) rawTrack.uri = spotifyMatch.spotifyUri;
          }
        } catch {
          // Fallback safely to Lavalink track info
        }
      }
      player.queue.add(rawTrack);
      const domain = mapMoonlinkTrack(rawTrack, requester);
      domain.source = finalSource;
      if (trackOverride?.artworkUrl) domain.artworkUrl = trackOverride.artworkUrl;
      addedTracks.push(domain);
    }

    if (!player.playing && !player.paused) {
      await player.play();
    }

    if (tracks.length > 1 || playlistName) {
      return {
        loadType: 'playlist',
        playlistName: playlistName || 'Playlist',
        tracks: addedTracks,
        totalTracksAdded: addedTracks.length,
        positionInQueue: player.queue.size - addedTracks.length + 1,
      };
    }
    return {
      loadType: 'track',
      track: addedTracks[0],
      totalTracksAdded: addedTracks.length,
      positionInQueue: player.queue.size,
    };
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
      const found = await this.searchTrackWithLadder(player, spotifyTrack.searchQuery, {
        title: trackOverride?.title || spotifyTrack.name,
        artist: trackOverride?.author || spotifyTrack.artist,
      });

      if (!found) {
        return {
          loadType: 'empty',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      const chosenTrack = found.track;
      chosenTrack.requester = requester;
      chosenTrack.title = trackOverride?.title || spotifyTrack.name;
      chosenTrack.author = trackOverride?.author || spotifyTrack.artist;
      const finalArtwork = trackOverride?.artworkUrl || spotifyTrack.artworkUrl;
      if (finalArtwork) {
        chosenTrack.artworkUrl = finalArtwork;
      }
      chosenTrack.uri = spotifyTrack.spotifyUri || spotifyUrl;
      const trackRecord = chosenTrack as unknown as Record<string, unknown>;
      const backend = found.rung === 'resolver' ? 'local' : 'spotify';
      const finalSource = trackOverride?.source || backend;
      trackRecord.sourceName = finalSource;
      trackRecord.source = finalSource;
      if (finalArtwork) {
        trackRecord.artworkUrl = finalArtwork;
      }
      player.queue.add(chosenTrack);

      const domainTrack = mapMoonlinkTrack(chosenTrack, requester);
      domainTrack.source = 'spotify';
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

    // Resolve first track immediately so playback begins with minimum delay.
    // The moonlink track keeps its true backend label ('local' for resolver
    // output) so failure handling routes correctly; the display model keeps
    // the familiar 'spotify' badge.
    const adoptSpotifyTrack = (lavalinkTrack: Track, spTrack: SpotifyResolvedTrack, rung: Rung): void => {
      lavalinkTrack.requester = requester;
      lavalinkTrack.title = spTrack.name;
      lavalinkTrack.author = spTrack.artist;
      if (spTrack.artworkUrl) {
        lavalinkTrack.artworkUrl = spTrack.artworkUrl;
      }
      lavalinkTrack.uri = spTrack.spotifyUri || spotifyUrl;
      const record = lavalinkTrack as unknown as Record<string, unknown>;
      const backend = rung === 'resolver' ? 'local' : 'spotify';
      record.sourceName = trackOverride?.source || backend;
      record.source = trackOverride?.source || backend;
      if (trackOverride?.artworkUrl) {
        record.artworkUrl = trackOverride.artworkUrl;
      }
    };

    const firstFound = await this.searchTrackWithLadder(player, firstTrack.searchQuery, {
      title: firstTrack.name,
      artist: firstTrack.artist,
    });
    if (firstFound) {
      const firstLavalinkTrack = firstFound.track;
      adoptSpotifyTrack(firstLavalinkTrack, firstTrack, firstFound.rung);
      player.queue.add(firstLavalinkTrack);
      const firstDomainTrack = mapMoonlinkTrack(firstLavalinkTrack, requester);
      firstDomainTrack.source = 'spotify';
      if (trackOverride?.artworkUrl) {
        firstDomainTrack.artworkUrl = trackOverride.artworkUrl;
      }
      addedTracks.push(firstDomainTrack);

      if (!player.playing && !player.paused) {
        await player.play();
      }
    }

    // Resolve remaining tracks in parallel batches through the same ladder.
    const remainingTracks = resolution.tracks.slice(1);
    const BATCH_SIZE = 5;
    for (let i = 0; i < remainingTracks.length; i += BATCH_SIZE) {
      const batch = remainingTracks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((t) => this.resolvePlaylistTrack(player, t)),
      );

      for (const item of batchResults) {
        if (!item) continue;
        const lavalinkTrack = item.lavalinkTrack;
        adoptSpotifyTrack(lavalinkTrack, item.spTrack, item.rung);
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
   * Resolves one playlist track through the health ladder
   * (resolver → plugin → soundcloud, SoundCloud-first while down).
   */
  private async resolvePlaylistTrack(
    player: Player,
    spTrack: SpotifyResolvedTrack,
  ): Promise<{ lavalinkTrack: Track; spTrack: SpotifyResolvedTrack; rung: Rung } | null> {
    const found = await this.searchTrackWithLadder(player, spTrack.searchQuery, {
      title: spTrack.name,
      artist: spTrack.artist,
    });
    if (!found) return null;
    return { lavalinkTrack: found.track, spTrack, rung: found.rung };
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

