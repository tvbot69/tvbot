import type { Player, Track } from 'moonlink.js';
import { Track as MoonlinkTrack } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { cleanTrackTitle, isSpotifyMatchValid, mapMoonlinkTrack, spotifyUriToUrl, type MusicTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import { MoonlinkManager, type LavalinkNodeStats } from './moonlinkManager';
import { SpotifyResolver, type SpotifyResolvedTrack } from './spotifyResolver';
import { QueueService } from './queueService';
import type { PlaylistChunkManager } from './playlistChunkManager';
import { ladderFor, HOME_NODE, type Rung } from './youtubeHealth';
import { resolveViaHome, resolverEnabled, type ResolverMeta } from './ytResolver';
import type { ArtworkService } from '@bot/services/artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

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

/** Unresolved Spotify entry waiting for just-in-time resolution. */
interface PendingSpotifyEntry {
  spTrack: SpotifyResolvedTrack;
  requester: MusicTrackRequester;
  spotifyUrl: string;
  override?: { title?: string; author?: string; artworkUrl?: string; source?: string };
}

export class MusicService {
  public readonly moonlinkManager: MoonlinkManager;
  private readonly spotifyResolver: SpotifyResolver;
  private readonly queueService: QueueService;
  private readonly playlistChunkManager?: PlaylistChunkManager;

  /**
   * Just-in-time Spotify entries: resolved 2-ahead as playback advances
   * instead of all-at-enqueue. Cold-cache songs resolve at play time (warm
   * cache, resolver rung) rather than locking in SoundCloud versions
   * upfront, and playlist commands reply in seconds instead of minutes.
   */
  private readonly pendingSpotify = new Map<string, PendingSpotifyEntry[]>();
  private readonly pendingTopUpRunning = new Set<string>();
  private pendingEventsBound = false;
  private static readonly JIT_AHEAD = 2;
  /** Artwork backfill must never stall resolution: cold provider cascades take seconds. */
  private static readonly ARTWORK_TIMEOUT_MS = 6000;
  /** Background paths (JIT top-up, warmup) can afford to wait out slow cascades. */
  private static readonly BACKGROUND_ARTWORK_TIMEOUT_MS = 10000;
  /** Upcoming entries with a warmup cascade already in flight (dedupes overlap). */
  private readonly artWarmKeys = new Set<string>();
  private readonly artworkService?: ArtworkService;

  constructor(
    moonlinkManager: MoonlinkManager,
    spotifyResolver: SpotifyResolver,
    queueService: QueueService,
    playlistChunkManager?: PlaylistChunkManager,
    artworkService?: ArtworkService,
  ) {
    this.moonlinkManager = moonlinkManager;
    this.spotifyResolver = spotifyResolver;
    this.queueService = queueService;
    this.playlistChunkManager = playlistChunkManager;
    this.artworkService = artworkService;
    this.playlistChunkManager?.bindEvents();
    // Chunked (>100) playlist tails resolve through the same ladder
    // (resolver-first, gated, backfilled) instead of raw YouTube search.
    this.playlistChunkManager?.setTrackResolver((player, spTrack) =>
      this.resolvePlaylistTrack(player, spTrack),
    );
    this.bindPendingEvents();
  }

  /** Advance hook: keep 2 resolved tracks ahead; refill + play when drained. */
  private bindPendingEvents(): void {
    if (this.pendingEventsBound) return;
    this.pendingEventsBound = true;
    const manager = this.moonlinkManager.getManager() as unknown as {
      on?: (event: string, cb: (player: Player) => void) => void;
    };
    // Partial manager doubles (unit tests) may not implement .on — top-up
    // still works when called directly; only the automatic triggers skip.
    if (typeof manager.on !== 'function') return;
    manager.on('trackStart', (player: Player) => {
      void this.topUpPending(player.guildId);
    });
    manager.on('trackEnd', (player: Player) => {
      void this.topUpPending(player.guildId);
    });
    manager.on('queueEnd', (player: Player) => {
      void this.topUpPending(player.guildId);
    });
    manager.on('playerDestroy', (player: Player) => {
      this.pendingSpotify.delete(player.guildId);
    });
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
   * them as resolver output, never as YouTube plugin output. Distinguishes
   * transport failure (node unreachable mid-ladder — every search THREW)
   * from a genuine miss so callers can report "try again" instead of the
   * misleading "No tracks found".
   */
  private async searchTrackWithLadder(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | { transportError: true } | null> {
    const rungs = ladderFor(player);
    let ytHit: Track | undefined;
    let transportFailed = false;
    if (rungs.includes('plugin') || rungs.includes('resolver')) {
      try {
        const yt = await this.searchWithTimeout({ query, source: 'youtube' });
        ytHit = yt?.tracks?.[0];
      } catch {
        // Node unreachable, not a miss — remember it for the result below.
        transportFailed = true;
      }
    }
    if (ytHit) {
      // Artwork pre-clean (single choke point): stamp a known-good cover, or
      // drop a raw YouTube thumbnail so the backfill cascade below fills real
      // (Spotify-first) art instead of skipping on the wrong image. Without
      // this, scraper playlists (no per-track covers) inherit YouTube thumbs
      // permanently: adoption skips missing art AND backfill skips present art.
      if (meta?.artworkUrl) ytHit.artworkUrl = meta.artworkUrl;
      else if (MusicService.isYoutubeThumb(ytHit.artworkUrl)) ytHit.artworkUrl = null;
    }
    for (const rung of rungs) {
      if (rung === 'soundcloud') {
        try {
          const sc = await this.searchWithTimeout({ query, source: 'soundcloud' });
          if (sc?.tracks?.[0]) return { track: sc.tracks[0], rung };
        } catch {
          transportFailed = true;
        }
        continue;
      }
      if (!ytHit) continue;
      if (rung === 'plugin') return { track: ytHit, rung };
      const local = await this.tryResolverTrack(player, ytHit, meta);
      if (local) return { track: local, rung };
    }
    if (transportFailed) return { transportError: true };
    return null;
  }

  /** Narrows a ladder result to the transport-failure variant. */
  private static isTransportError(
    found: { track: Track; rung: Rung } | { transportError: true } | null,
  ): found is { transportError: true } {
    return !!found && 'transportError' in found;
  }

  /** True for raw YouTube-family thumbnails (never correct on adopted tracks). */
  private static isYoutubeThumb(url: string | null | undefined): boolean {
    if (!url) return false;
    const host = url.split('/')[2] ?? '';
    return (
      host === 'i.ytimg.com' || host.endsWith('.ytimg.com') || host === 'yt3.ggpht.net' || host === 'lh3.googleusercontent.com'
    );
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
      const track = new MoonlinkTrack(typed.data, ytTrack.requester);
      // Wrong-song guard (same ±30s rule as fallbacks): the ytsearch top hit
      // can be a compilation or wrong upload; the probed file duration is
      // ground truth. Missing durations pass through.
      const expected = ytTrack.duration || 0;
      if (track.duration && expected && Math.abs(track.duration - expected) > 30000) {
        Logger.warn(
          { guildId: player.guildId, videoId: ytTrack.identifier, fileMs: track.duration, expectedMs: expected },
          '[Music] Resolver file duration-mismatched — refusing a wrong song.',
        );
        return null;
      }
      return track;
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
            artworkUrl: trackOverride.artworkUrl,
          } : undefined);
          if (!swapped) {
            return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
          }
          if (MusicService.isTransportError(swapped)) {
            return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
          }
          const hit = swapped.track;
          hit.requester = requester;
            hit.title = trackOverride?.title || meta.title;
            hit.author = trackOverride?.author || meta.author;
            await this.maybeBackfillArt(
              hit,
              trackOverride?.artworkUrl,
              hit.title,
              hit.author,
              MusicService.ARTWORK_TIMEOUT_MS,
              hit.uri,
            );
            const rungSource = swapped.rung === 'resolver' ? 'local' : 'soundcloud';
            const rec = hit as unknown as Record<string, unknown>;
            rec.sourceName = trackOverride?.source || rungSource;
            rec.source = trackOverride?.source || rungSource;
            return await this.enqueueLavalinkTracks(player, [hit], requester, trackOverride, rungSource);
          return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
        }
        return await this.enqueueLavalinkTracks(player, [meta], requester, trackOverride, 'youtube');
      }

      // Text query (or anything else): full ladder.
      const found = await this.searchTrackWithLadder(player, trimmedQuery, trackOverride ? {
        title: trackOverride.title,
        artist: trackOverride.author,
        artworkUrl: trackOverride.artworkUrl,
      } : undefined);
      if (!found) {
        return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
      }
      if (MusicService.isTransportError(found)) {
        return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
      }
      await this.maybeBackfillArt(
        found.track,
        trackOverride?.artworkUrl,
        trackOverride?.title || found.track.title,
        trackOverride?.author || found.track.author,
        MusicService.ARTWORK_TIMEOUT_MS,
        found.track.uri,
      );
      const ladderSource = found.rung === 'resolver' ? 'local' : found.rung === 'soundcloud' ? 'soundcloud' : 'youtube';
      return await this.enqueueLavalinkTracks(player, [found.track], requester, trackOverride, ladderSource, undefined, true);
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
        artworkUrl: trackOverride?.artworkUrl || spotifyTrack.artworkUrl,
      });

      if (!found) {
        return {
          loadType: 'empty',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }
      if (MusicService.isTransportError(found)) {
        return {
          loadType: 'error',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      const chosenTrack = found.track;
      this.adoptSpotifyTrack(chosenTrack, spotifyTrack, found.rung, requester, spotifyUrl, trackOverride);
      // Backfill AFTER adoption: adoption clears the raw YouTube thumbnail
      // when Spotify has no cover, so the cascade can fill real artwork
      // instead of skipping on the wrong image.
      await this.maybeBackfillArt(
        chosenTrack,
        trackOverride?.artworkUrl || spotifyTrack.artworkUrl,
        trackOverride?.title || spotifyTrack.name,
        trackOverride?.author || spotifyTrack.artist,
        MusicService.ARTWORK_TIMEOUT_MS,
        spotifyTrack.spotifyUri,
      );
      player.queue.add(chosenTrack);

      const domainTrack = mapMoonlinkTrack(chosenTrack, requester);
      domainTrack.source = 'spotify';
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
    }

    // Spotify Album / Playlist / Artist top tracks
    const addedTracks: MusicTrack[] = [];
    const firstTrack = resolution.tracks[0]!;

    // Resolve first track immediately so playback begins with minimum delay.
    const firstFound = await this.searchTrackWithLadder(player, firstTrack.searchQuery, {
      title: firstTrack.name,
      artist: firstTrack.artist,
      artworkUrl: firstTrack.artworkUrl,
    });
    if (firstFound && MusicService.isTransportError(firstFound)) {
      return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
    }
    if (firstFound) {
      const firstLavalinkTrack = firstFound.track;
      this.adoptSpotifyTrack(firstLavalinkTrack, firstTrack, firstFound.rung, requester, spotifyUrl, trackOverride);
      await this.maybeBackfillArt(
        firstLavalinkTrack,
        firstTrack.artworkUrl,
        firstTrack.name,
        firstTrack.artist,
        MusicService.ARTWORK_TIMEOUT_MS,
        firstTrack.spotifyUri,
      );
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

    // Just-in-time: the rest wait as pending Spotify entries and resolve
    // 2-ahead as playback advances (see topUpPending). Cold-cache songs
    // resolve at play time — warm cache, resolver rung — instead of locking
    // in SoundCloud versions upfront, and the command replies in seconds.
    const remainingTracks = resolution.tracks.slice(1);
    if (remainingTracks.length > 0) {
      const existing = this.pendingSpotify.get(player.guildId) ?? [];
      for (const spTrack of remainingTracks) {
        existing.push({ spTrack, requester, spotifyUrl, override: trackOverride });
      }
      this.pendingSpotify.set(player.guildId, existing);
      void this.topUpPending(player.guildId);
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

    // Reply lists everything logically queued: resolved tracks plus pending
    // entries mapped from Spotify metadata (durations included, so totals
    // stay truthful). partial is false at enqueue — nothing has failed yet;
    // background skips are logged in topUpPending.
    const pendingDomain = (this.pendingSpotify.get(player.guildId) ?? []).map((e) => this.mapPendingEntry(e));

    return {
      loadType,
      playlistName: resolution.title,
      artworkUrl: resolution.artworkUrl,
      tracks: [...addedTracks, ...pendingDomain],
      totalTracksAdded: addedTracks.length + pendingDomain.length,
      positionInQueue: player.queue.size - addedTracks.length + 1,
      partial: false,
    };
  }

  /**
   * Backfills a missing track cover through ArtworkService (Spotify →
   * Deezer → Apple → Last.fm cascade, strict artist+title matching).
   * Only fires when NEITHER the raw track NOR the known Spotify art has a
   * URL — hot paths (API tracks with art, YouTube hits with thumbs) return
   * synchronously free. Timeout-guarded and catch-all: art must never break
   * or stall playback resolution.
   */
  private async maybeBackfillArt(
    track: Track,
    knownArtworkUrl?: string,
    title?: string,
    artist?: string,
    timeoutMs: number = MusicService.ARTWORK_TIMEOUT_MS,
    spotifyUri?: string | null,
  ): Promise<void> {
    try {
      if (!track || track.artworkUrl || knownArtworkUrl) return;
      const svc = this.artworkService;
      if (!svc) {
        Logger.debug('[Music] Artwork backfill skipped — no artwork service wired');
        return;
      }
      const t = (title || track.title)?.trim();
      const a = (artist || track.author)?.trim();
      if (!t || !a) return;
      const started = Date.now();
      // Never-rejecting lookup: exact by-ID first (no matching risk), then
      // the name cascade. One slow leg can't hang the race.
      const lookup: Promise<string | null> = (async () => {
        try {
          const id = this.spotifyTrackId(spotifyUri);
          if (id) {
            const byId = await svc.getTrackCoverBySpotifyId(id);
            if (byId) return byId;
          }
          return await svc.getTrackCoverUrl(t, a);
        } catch {
          return null;
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        const url = await Promise.race([lookup, timeout]);
        if (url) {
          track.artworkUrl = url;
          Logger.info(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfilled',
          );
        } else {
          Logger.debug(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfill miss',
          );
          // Late attach: the race abandons slow lookups but doesn't cancel
          // them — the cascade still finishes and caches. If art arrives
          // after the timeout and the track is still bare, take it; the
          // progress updater rebuilds the card every 15s, so it shows up.
          void lookup
            .then((late) => {
              if (late && !track.artworkUrl) {
                track.artworkUrl = late;
                Logger.info(
                  { title: t, artist: a, resolveMs: Date.now() - started },
                  '[Music] Artwork late-attached',
                );
              }
            })
            .catch(() => undefined);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // ignore — playback without art beats no playback
    }
  }

  /** Spotify track ID from a spotify: URI or open.spotify URL (track type only). */
  private spotifyTrackId(uri?: string | null): string | undefined {
    if (!uri) return undefined;
    try {
      const parsed = this.spotifyResolver.parseSpotifyUrl(uri);
      return parsed?.type === 'track' ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * Stamps Spotify display metadata onto a resolved Lavalink track. The
   * moonlink track keeps its true backend label ('local' for resolver
   * output) so failure handling routes correctly; the display model keeps
   * the familiar 'spotify' badge. Artwork correctness is handled upstream
   * (searchTrackWithLadder pre-cleans YouTube thumbnails), so a plain
   * conditional stamp here can never resurrect a wrong image.
   */
  private adoptSpotifyTrack(
    lavalinkTrack: Track,
    spTrack: SpotifyResolvedTrack,
    rung: Rung,
    requester: MusicTrackRequester,
    spotifyUrl: string,
    trackOverride?: { title?: string; author?: string; artworkUrl?: string; source?: string },
  ): void {
    lavalinkTrack.requester = requester;
    lavalinkTrack.title = spTrack.name;
    lavalinkTrack.author = spTrack.artist;
    if (spTrack.artworkUrl) {
      lavalinkTrack.artworkUrl = spTrack.artworkUrl;
    }
    lavalinkTrack.uri = spotifyUriToUrl(spTrack.spotifyUri) || spotifyUrl;
    const record = lavalinkTrack as unknown as Record<string, unknown>;
    const backend = rung === 'resolver' ? 'local' : 'spotify';
    record.sourceName = trackOverride?.source || backend;
    record.source = trackOverride?.source || backend;
    if (trackOverride?.artworkUrl) {
      record.artworkUrl = trackOverride.artworkUrl;
    }
  }

  /**
   * Warms the artwork memory cache for the next couple of unresolved entries
   * so their resolve-time backfill usually hits cache instead of racing
   * providers. Bounded, deduped in-flight, timeout-guarded, silent — and
   * skipped entirely while Spotify is rate-limited, so warmup never spends
   * quota the resolvers need.
   */
  private warmUpcomingArt(guildId: string): void {
    if (!this.artworkService) return;
    if (SpotifySearchApi.isRateLimited()) return;
    const pending = this.pendingSpotify.get(guildId);
    if (!pending || pending.length === 0) return;
    for (const entry of pending.slice(0, 2)) {
      // Entries that already carry art need no lookup — adoption sets it.
      if (entry.spTrack.artworkUrl || entry.override?.artworkUrl) continue;
      const key = `${entry.spTrack.artist} - ${entry.spTrack.name}`.toLowerCase();
      if (this.artWarmKeys.has(key)) continue;
      this.artWarmKeys.add(key);
      void (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const svc = this.artworkService!;
          const run: Promise<string | null> = (async () => {
            try {
              const id = this.spotifyTrackId(entry.spTrack.spotifyUri);
              if (id) {
                const byId = await svc.getTrackCoverBySpotifyId(id);
                if (byId) return byId;
              }
              return await svc.getTrackCoverUrl(entry.spTrack.name, entry.spTrack.artist);
            } catch {
              return null;
            }
          })();
          const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS);
          });
          await Promise.race([run, timeout]);
        } catch {
          // ignore — resolve-time backfill remains the safety net
        } finally {
          if (timer) clearTimeout(timer);
          this.artWarmKeys.delete(key);
        }
      })();
    }
  }

  private mapPendingEntry(e: PendingSpotifyEntry): MusicTrack {
    return {
      identifier: e.spTrack.spotifyUri || '',
      title: e.override?.title || e.spTrack.name,
      author: e.override?.author || e.spTrack.artist,
      uri: spotifyUriToUrl(e.spTrack.spotifyUri) || '',
      duration: e.spTrack.durationMs || 0,
      isSeekable: true,
      isStream: false,
      artworkUrl: e.override?.artworkUrl || e.spTrack.artworkUrl,
      source: 'spotify',
      requester: e.requester,
    };
  }

  /**
   * Resolves pending Spotify entries until 2 tracks wait ahead in the
   * Moonlink queue (or pending drains). Runs in background on enqueue and
   * on trackStart/trackEnd/queueEnd. Skipped (unresolvable) entries are
   * dropped with a warn — never retried in a loop. If the queue drained
   * with pending left (all prior resolves failed), newly resolved tracks
   * start playing immediately.
   */
  public async topUpPending(guildId: string): Promise<void> {
    const pending = this.pendingSpotify.get(guildId);
    if (!pending || pending.length === 0) return;
    if (this.pendingTopUpRunning.has(guildId)) return;
    this.pendingTopUpRunning.add(guildId);
    let added = 0;
    let skipped = 0;
    try {
      for (;;) {
        const player = this.getPlayer(guildId);
        if (!player) {
          this.pendingSpotify.delete(guildId);
          return;
        }
        const list = this.pendingSpotify.get(guildId);
        if (!list || list.length === 0) {
          this.pendingSpotify.delete(guildId);
          break;
        }
        if (player.queue.size >= MusicService.JIT_AHEAD) break;
        const entry = list.shift()!;
        const found = await this.resolvePlaylistTrack(player, entry.spTrack).catch(() => null);
        if (!this.getPlayer(guildId)) {
          this.pendingSpotify.delete(guildId);
          return;
        }
        if (!found) {
          skipped++;
          continue;
        }
        this.adoptSpotifyTrack(
          found.lavalinkTrack,
          found.spTrack,
          found.rung,
          entry.requester,
          entry.spotifyUrl,
          entry.override,
        );
        const live = this.getPlayer(guildId);
        if (!live) {
          this.pendingSpotify.delete(guildId);
          return;
        }
        live.queue.add(found.lavalinkTrack);
        added++;
      }
    } finally {
      this.pendingTopUpRunning.delete(guildId);
      if (skipped > 0) {
        Logger.warn({ guildId, skipped }, '[Music] JIT top-up skipped unresolvable tracks');
      }
    }
    this.warmUpcomingArt(guildId);
    if (added > 0) {
      const player = this.getPlayer(guildId);
      if (player && !player.playing && !player.paused) {
        await player.play().catch(() => undefined);
      }
    }
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
      artworkUrl: spTrack.artworkUrl,
    });
    if (!found || MusicService.isTransportError(found)) return null;
    // Background-only path (topUpPending): generous art timeout, nobody waits.
    await this.maybeBackfillArt(
      found.track,
      spTrack.artworkUrl,
      spTrack.name,
      spTrack.artist,
      MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
      spTrack.spotifyUri,
    );
    return { lavalinkTrack: found.track, spTrack, rung: found.rung };
  }

  public getQueueInfo(guildId: string): MusicQueueInfo | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const info = this.queueService.getQueueInfo(player);
    // The visible queue is resolved tracks + pending JIT entries (which the
    // Added reply already promised). Without this, shuffle/remove/move act
    // on songs the user can't see.
    const pending = this.pendingSpotify.get(guildId) ?? [];
    if (pending.length === 0) return info;
    const pendingTracks = pending.map((e) => this.mapPendingEntry(e));
    const pendingMs = pendingTracks.reduce((acc, t) => acc + (t.duration || 0), 0);
    return {
      ...info,
      tracks: [...info.tracks, ...pendingTracks],
      totalTracks: info.totalTracks + pendingTracks.length,
      totalDuration: info.totalDuration + pendingMs,
      remainingDuration: info.remainingDuration + pendingMs,
    };
  }

  public async skip(guildId: string, amount: number = 1): Promise<boolean> {
    // amount: 1-based position to land on (skip(1) = play next).
    return this.jumpToCombined(guildId, amount - 1);
  }

  public async stop(guildId: string): Promise<void> {
    const player = this.getPlayer(guildId);
    if (!player) {
      this.pendingSpotify.delete(guildId);
      return;
    }

    this.queueService.set247(guildId, false);
    this.playlistChunkManager?.clear(guildId);
    this.pendingSpotify.delete(guildId);
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
    // Pending entries are the queue's tail — shuffle them too so the order
    // stays uniformly random once they resolve.
    const pending = this.pendingSpotify.get(guildId);
    if (pending && pending.length > 1) {
      for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pending[i], pending[j]] = [pending[j]!, pending[i]!];
      }
    }
    return true;
  }

  public clear(guildId: string): boolean {
    const player = this.getPlayer(guildId);
    if (!player) {
      this.pendingSpotify.delete(guildId);
      return false;
    }
    this.pendingSpotify.delete(guildId);
    player.queue.clear();
    return true;
  }

  public remove(guildId: string, index: number): MusicTrack | null {
    const player = this.getPlayer(guildId);
    if (!player || index < 0) return null;
    if (index < player.queue.size) {
      const removed = player.queue.remove(index);
      return removed ? mapMoonlinkTrack(removed) : null;
    }
    // Past the resolved queue: drop the pending entry (it was displayed).
    const pending = this.pendingSpotify.get(guildId);
    const entry = pending?.[index - player.queue.size];
    if (!pending || !entry) return null;
    pending.splice(index - player.queue.size, 1);
    return this.mapPendingEntry(entry);
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
    return this.jumpToCombined(guildId, position - 1);
  }

  /**
   * Jumps to a 0-based index in the COMBINED queue (resolved + pending) and
   * plays it, dropping everything ahead — that's what skipping here means.
   * Pending targets resolve on demand; a miss refuses with the queue
   * untouched (resolve happens before any mutation).
   */
  private async jumpToCombined(guildId: string, index: number): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || index < 0) return false;
    if (index < player.queue.size) {
      // removeRange is inclusive on both ends: to land on the Nth upcoming
      // track, drop the N-1 before it, then skip().
      if (index > 0) player.queue.removeRange(0, index - 1);
      return await player.skip();
    }
    const pending = this.pendingSpotify.get(guildId);
    const entry = pending?.[index - player.queue.size];
    if (!pending || !entry) return false;
    const found = await this.resolvePlaylistTrack(player, entry.spTrack).catch(() => null);
    const live = this.getPlayer(guildId);
    const liveList = this.pendingSpotify.get(guildId);
    if (!found || !live || !liveList) return false;
    const at = liveList.indexOf(entry);
    if (at === -1) return false;
    live.queue.clear();
    liveList.splice(0, at + 1);
    if (liveList.length === 0) this.pendingSpotify.delete(guildId);
    this.adoptSpotifyTrack(
      found.lavalinkTrack,
      entry.spTrack,
      found.rung,
      entry.requester,
      entry.spotifyUrl,
      entry.override,
    );
    live.queue.unshift(found.lavalinkTrack);
    return await live.skip();
  }

  /** Rebuilds a pending entry from a resolved track (resolved → pending moves). */
  private pendingFromTrack(track: Track): PendingSpotifyEntry {
    const mapped = mapMoonlinkTrack(track);
    return {
      spTrack: {
        searchQuery: `${mapped.author} - ${mapped.title}`,
        name: mapped.title,
        artist: mapped.author,
        durationMs: mapped.duration,
        artworkUrl: mapped.artworkUrl,
        spotifyUri: mapped.uri.startsWith('https://open.spotify.com/') ? mapped.uri : undefined,
      },
      requester: mapped.requester ?? { id: 'unknown' },
      spotifyUrl: mapped.uri,
      override: undefined,
    };
  }

  public async move(guildId: string, from: number, to: number): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || from < 1 || to < 1) return false;
    const size = player.queue.size;
    const pending = this.pendingSpotify.get(guildId) ?? [];
    if (from > size + pending.length || to > size + pending.length) return false;
    const i = from - 1;
    const j = to - 1;
    if (i === j) return true;
    if (i < size && j < size) return player.queue.move(i, j);
    if (i >= size && j >= size) {
      const list = this.pendingSpotify.get(guildId);
      if (!list) return false;
      const entry = list[i - size];
      if (!entry) return false;
      list.splice(i - size, 1);
      // Same splice/remove-insert semantics as Moonlink's move (to addresses
      // the post-removal order).
      list.splice(j - size, 0, entry);
      return true;
    }
    if (i < size) {
      // Resolved → pending: downgrade, re-resolves lazily on advance.
      // j addressed the pre-removal order; removal shifts everything past i.
      const track = player.queue.remove(i);
      if (!track) return false;
      const list = this.pendingSpotify.get(guildId) ?? [];
      // j addresses the post-removal combined order (same as Moonlink move).
      list.splice(Math.max(0, Math.min(j - player.queue.size, list.length)), 0, this.pendingFromTrack(track));
      this.pendingSpotify.set(guildId, list);
      return true;
    }
    // Pending → resolved: resolve first — a miss refuses with nothing mutated.
    const entry = pending[i - size];
    if (!entry) return false;
    const found = await this.resolvePlaylistTrack(player, entry.spTrack).catch(() => null);
    if (!found) return false;
    const live = this.getPlayer(guildId);
    const liveList = this.pendingSpotify.get(guildId);
    if (!live || !liveList) return false;
    const at = liveList.indexOf(entry);
    if (at === -1) return false;
    liveList.splice(at, 1);
    if (liveList.length === 0) this.pendingSpotify.delete(guildId);
    this.adoptSpotifyTrack(
      found.lavalinkTrack,
      entry.spTrack,
      found.rung,
      entry.requester,
      entry.spotifyUrl,
      entry.override,
    );
    if (j < live.queue.size) live.queue.insert(j, found.lavalinkTrack);
    else live.queue.add(found.lavalinkTrack);
    return true;
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

