import type { Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { cleanTrackTitle, isSpotifyMatchValid, mapMoonlinkTrack, spotifyUriToUrl, type MirrorResolution, type MirrorTrack, type MusicTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import { MoonlinkManager, type LavalinkNodeStats } from './moonlinkManager';
import { SpotifyResolver } from './spotifyResolver';
import type { DeezerResolver } from './deezerResolver';
import type { AppleMusicResolver } from './appleMusicResolver';
import { QueueService } from './queueService';
import type { PlaylistChunkManager } from './playlistChunkManager';
import { ladderFor, type Rung } from './youtubeHealth';
import { type ResolverMeta } from './ytResolver';
import { MAX_QUEUE_TRACKS, SEEK_REST_TIMEOUT_MS } from './musicConstants';

import type { ArtworkService } from '@bot/services/artworkService';
import { MusicSearchLadder } from './musicSearchLadder';
import { MusicTrackArtwork, isYoutubeThumb, preCleanArtwork, sanitizeOverride, ARTWORK_TIMEOUT_MS, BACKGROUND_ARTWORK_TIMEOUT_MS } from './musicTrackArtwork';
import { adoptMirrorTrack } from './musicTrackAdoption';
import { hasHealthyNode } from './musicNodeHealth';
import { PlayerRegistry, isDestroyedPlayer } from './musicPlayerRegistry';
import { MusicPlaybackControls } from './musicPlaybackControls';

import type { PendingQueueView } from './musicTypes';

export interface PlayResult {
  loadType: 'track' | 'playlist' | 'spotify_album' | 'spotify_playlist' | 'spotify_artist' | 'mirror_album' | 'mirror_playlist' | 'mirror_artist' | 'empty' | 'error';
  track?: MusicTrack;
  tracks?: MusicTrack[];
  playlistName?: string;
  artworkUrl?: string;
  totalTracksAdded: number;
  positionInQueue: number;
  /** True when fewer tracks resolved than the source listed (blocked/missing). */
  partial?: boolean;
  /**
   * Why the load was partial, when it is not the ordinary unresolvable-track
   * case. Spotify stopped exposing playlist contents to app-only tokens, so a
   * long playlist can only ever yield its first 100 tracks — saying so beats
   * silently handing back a fifth of what was asked for.
   */
  partialReason?: string;
  errorReason?: 'no-nodes' | 'voice' | 'search' | 'empty-spotify' | 'queue-full';
}

/** The fallback when nothing can say WHY there are no nodes. */
const GENERIC_NO_NODES = 'All music nodes are rate-limited right now. Try again in 30–60 seconds.';

/**
 * The sentence a failed `play()` gets, in words the listener can act on.
 *
 * The manager arrives as an ARGUMENT, never through `this`: this is a free
 * function with call sites in three modules (slash, text, interactions), and
 * an arrow function has no `this` of its own — a version that read `this` could
 * never see a manager, which is how the 'disabled' and 'disconnected' answers
 * and the computed cooldown became unreachable and every no-nodes failure
 * rendered as a rate limit.
 *
 * Omitting the manager still yields the generic sentence, so a caller that
 * cannot reach a service degrades rather than throwing; every call site that
 * CAN should pass it. `MusicService.playErrorMessage` is the bound form.
 */
export const playErrorMessage = (
  reason?: PlayResult['errorReason'],
  moonlinkManager?: MoonlinkManager,
): string => {
  switch (reason) {
    case 'no-nodes': {
      // Derive the real cause instead of always claiming a rate limit.
      const getter = moonlinkManager?.getUnavailableReason;
      if (typeof getter !== 'function') {
        return GENERIC_NO_NODES;
      }
      const info = getter.call(moonlinkManager);
      if (info.reason === 'disabled') return 'Music playback is disabled in this environment.';
      if (info.reason === 'disconnected') return 'I cannot reach any music node right now. Try again shortly.';
      const secs = Math.max(1, Math.ceil(info.retryAfterMs / 1000));
      const wait = secs < 60 ? `${secs}s` : `${Math.ceil(secs / 60)} min`;
      return `All music nodes are rate-limited right now. Try again in ${wait}.`;
    }
    case 'voice':
      return 'I could not join your voice channel. Check my permissions and try again.';
    case 'empty-spotify':
      return 'Could not resolve that Spotify link (private, deleted, or region-locked?).';
    case 'queue-full':
      return `The queue is full (${MAX_QUEUE_TRACKS} tracks). Clear some of it first.`;
    default:
      return 'An error occurred while communicating with the music node. Try again in a few seconds.';
  }
};

/**
 * Hard cap on the player queue — stops runaway playlist ingestion. Lives in
 * musicConstants (which moonlinkManager and the chunk manager also read) so
 * the service, the chunk manager and Moonlink's own maxSize can never disagree
 * about what the cap is.
 */
export { MAX_QUEUE_TRACKS };

/** Unresolved entry waiting for just-in-time resolution. The slot names are
 * historical — `spTrack`/`spotifyUrl` now carry any provider's mirror track
 * (Spotify/Deezer/Apple) and its canonical page URL. */
interface PendingSpotifyEntry {
  spTrack: MirrorTrack;
  requester: MusicTrackRequester;
  spotifyUrl: string;
  override?: { title?: string; author?: string; artworkUrl?: string; source?: string };
}

export class MusicService {
  public readonly moonlinkManager: MoonlinkManager;
  private readonly spotifyResolver: SpotifyResolver;
  private readonly queueService: QueueService;
  private readonly playlistChunkManager?: PlaylistChunkManager;
  /** Provider search ladder (ISRC-first, title, plugin/resolver/soundcloud rungs). */
  private readonly ladder: MusicSearchLadder;
  /** Artwork backfill, cascade lookup and upcoming-track warmup. */
  private readonly artwork: MusicTrackArtwork;
  /** Player acquisition/creation, destroyed-player guard, filter definitions. */
  private readonly registry: PlayerRegistry;
  /** Pause/resume/seek/previous/replay/volume/filters/loop/autoplay/24-7/karaoke. */
  private readonly controls: MusicPlaybackControls;

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
  /** Wall-clock budget for one pending top-up pass before deferring the rest. */
  private static readonly TOP_UP_DEADLINE_MS = 60_000;
  /** Consecutive resolve failures that mean "stop, this source is down". */
  private static readonly TOP_UP_MAX_CONSECUTIVE_MISSES = 5;
  /** Artwork backfill must never stall resolution: cold provider cascades take seconds. */
  private readonly artworkService?: ArtworkService;
  /** Optional provider resolvers (wired at startup; absent = links unsupported). */
  private deezerResolver?: DeezerResolver;
  private appleMusicResolver?: AppleMusicResolver;
  /** Wired at startup — best-effort one-line notice in the now-playing channel. */
  private unavailableNotifier: ((guildId: string, message: string) => void) | null = null;
  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  private cardRefreshNotifier: ((guildId: string) => void) | null = null;

  /**
   * Static aliases onto the extracted collaborators. The ladder/artwork logic
   * now lives in MusicSearchLadder / MusicTrackArtwork, but these call sites
   * (production AND the test suite) have always read them off MusicService —
   * keeping the aliases means the split needed zero call-site churn.
   */
  public static readonly fallbackSearchQuery = MusicSearchLadder.fallbackSearchQuery;
  public static readonly normalizeIsrc = MusicSearchLadder.normalizeIsrc;
  public static readonly isTransportError = MusicSearchLadder.isTransportError;
  public static readonly isYoutubeThumb = isYoutubeThumb;
  public static readonly preCleanArtwork = preCleanArtwork;
  public static readonly sanitizeOverride = sanitizeOverride;

  /**
   * The bound form of the module-level `playErrorMessage`, carrying THIS
   * service's manager. Command layers call this rather than the free function
   * so a no-nodes failure is answered from the real node state — disabled,
   * unreachable and rate-limited are three different sentences.
   */
  public playErrorMessage(reason?: PlayResult['errorReason']): string {
    return playErrorMessage(reason, this.moonlinkManager);
  }

  public setUnavailableNotifier(notifier: (guildId: string, message: string) => void): void {
    this.unavailableNotifier = notifier;
  }

  /** Wired at startup — Deezer link support. Never a constructor param
   * (tests build MusicService positionally). */
  public setDeezerResolver(resolver: DeezerResolver): void {
    this.deezerResolver = resolver;
  }

  /** Wired at startup — Apple Music link support. Same positional rule. */
  public setAppleMusicResolver(resolver: AppleMusicResolver): void {
    this.appleMusicResolver = resolver;
  }

  private notifyUnavailable(guildId: string, message: string): void {
    try {
      this.unavailableNotifier?.(guildId, message);
    } catch {
      // A notice must never break the flow that produced it.
    }
  }

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
    this.ladder = new MusicSearchLadder(moonlinkManager, spotifyResolver);
    this.artwork = new MusicTrackArtwork(artworkService, spotifyResolver, this.pendingView());
    this.registry = new PlayerRegistry(moonlinkManager, queueService);
    this.controls = new MusicPlaybackControls(this.registry, queueService, (g) => this.getQueueInfo(g));
    this.playlistChunkManager?.bindEvents();
    // Chunked (>100) playlist tails resolve through the same ladder
    // (resolver-first, gated, backfilled) instead of raw YouTube search.
    this.playlistChunkManager?.setTrackResolver((player, spTrack) =>
      this.resolvePlaylistTrack(player, spTrack),
    );
    this.bindPendingEvents();
  }

  /**
   * The live pending store as a port. Returns the SAME Map instance the
   * service owns — never a copy — because shuffle reorders and remove splices
   * the array in place. A copying port would silently turn both into no-ops.
   */
  private pendingView(): PendingQueueView {
    const store = this.pendingSpotify;
    return {
      get: (guildId) => store.get(guildId),
      set: (guildId, entries) => void store.set(guildId, entries),
      delete: (guildId) => void store.delete(guildId),
      has: (guildId) => store.has(guildId),
    };
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

  /** Node-aware search with cross-node retry — see MusicSearchLadder. */
  private async searchWithTimeout(
    args: { query: string; source: string },
    ms: number = 8000,
  ): Promise<{ tracks?: Track[] } | null> {
    return this.ladder.searchWithTimeout(args, ms);
  }

  /** One ladder pass, then one lead-artist fallback pass. */
  private async searchTrackWithLadder(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | { transportError: true } | null> {
    return this.ladder.searchTrackWithLadder(player, query, meta);
  }

  private async searchTrackWithLadderOnce(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | { transportError: true } | null> {
    return this.ladder.searchTrackWithLadderOnce(player, query, meta);
  }

  private async tryResolverTrack(player: Player, ytTrack: Track, meta?: ResolverMeta): Promise<Track | null> {
    return this.ladder.tryResolverTrack(player, ytTrack, meta);
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
    // Overrides are trusted downstream (they skip backfill AND Spotify
    // enrichment), so a YouTube thumbnail smuggled in as "known art" — the
    // +search pick path — is dropped here, once. Every path below then
    // resolves the real cover instead of painting video frames on the card.
    trackOverride = sanitizeOverride(trackOverride);

    // 1. Spotify link resolution
    if (this.spotifyResolver.isSpotifyUrl(trimmedQuery)) {
      return await this.playSpotify(player, trimmedQuery, requester, trackOverride);
    }

    // 1b. Deezer / Apple Music links mirror onto Lavalink audio exactly like
    // Spotify links: provider metadata → ISRC-first ladder → JIT for
    // collections. Unwired resolvers (or unresolvable links) fall through to
    // the normal search path instead of failing.
    if (this.deezerResolver?.isDeezerUrl(trimmedQuery)) {
      const resolution = await this.deezerResolver.resolve(trimmedQuery).catch((err) => {
        Logger.warn({ err, query: trimmedQuery }, '[Music] Deezer link resolve failed');
        return null;
      });
      if (resolution && resolution.tracks.length > 0) {
        return await this.playMirror(player, resolution, trimmedQuery, requester, trackOverride);
      }
    }
    if (this.appleMusicResolver?.isAppleMusicUrl(trimmedQuery)) {
      const resolution = await this.appleMusicResolver.resolve(trimmedQuery).catch((err) => {
        Logger.warn({ err, query: trimmedQuery }, '[Music] Apple Music link resolve failed');
        return null;
      });
      if (resolution && resolution.tracks.length > 0) {
        return await this.playMirror(player, resolution, trimmedQuery, requester, trackOverride);
      }
    }

    // 2. Lavalink search (query or URL - YouTube / SoundCloud)
    const isSoundcloud = /^(https?:\/\/)?(www\.)?soundcloud\.com\/.+$/i.test(trimmedQuery);
    const isYoutubeUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(trimmedQuery);

    // Direct SoundCloud URLs always go straight there; everything else runs
    // the health ladder (resolver → plugin → soundcloud, SoundCloud-first
    // while YouTube is declared down).
    if (isSoundcloud) {
      try {
        // Node-aware search: a REST-dead node must not absorb direct
        // SoundCloud URL plays (same tower-uplink-stall class as text queries).
        const res = await this.searchWithTimeout({ query: trimmedQuery, source: 'soundcloud' });
        if (!res) {
          return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
        }
        if (!res.tracks || res.tracks.length === 0) {
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
        // `null` means NO node answered — every attempt threw or timed out.
        // That is not the same as a node answering "no results", and reporting
        // it as 'empty' rendered "No tracks found for: <url>" on a
        // tower-uplink stall, i.e. a transport failure rendered as "this track
        // does not exist". The SoundCloud branch above already refuses to make
        // that distinction up (null -> 'error'), and the ladder itself carries
        // the same transport-vs-miss rule; this path was the odd one out.
        if (urlRes === null) {
          return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
        }
        if (!urlRes.tracks || urlRes.tracks.length === 0) {
          return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
        }
        if (urlRes.loadType === 'playlist') {
          return await this.enqueueLavalinkTracks(player, urlRes.tracks, requester, trackOverride, 'youtube');
        }
        const meta = urlRes.tracks[0]!;
        const rungs = ladderFor(player);
        if (!rungs.includes('plugin')) {          const scQuery = `${meta.author} - ${meta.title}`;
          const swapped = await this.searchTrackWithLadder(player, scQuery, trackOverride ? {
            title: trackOverride.title,
            artist: trackOverride.author,
            artworkUrl: trackOverride.artworkUrl,
          } : undefined);
          if (!swapped) {
            return { loadType: 'empty', totalTracksAdded: 0, positionInQueue: 0 };
          }
          if (MusicSearchLadder.isTransportError(swapped)) {
            return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
          }
          const hit = swapped.track;
          hit.requester = requester;
            hit.title = trackOverride?.title || meta.title;
            hit.author = trackOverride?.author || meta.author;
            // Audio-first: never gate playback on art — background cascade,
            // late-attach, and the card refreshes when art lands.
            void this.maybeBackfillArt(
              hit,
              trackOverride?.artworkUrl,
              hit.title,
              hit.author,
              BACKGROUND_ARTWORK_TIMEOUT_MS,
              hit.uri,
              player.guildId,
            );
            const rungSource = swapped.rung === 'resolver' ? 'local' : 'soundcloud';
            const rec = hit as unknown as Record<string, unknown>;
            rec.sourceName = trackOverride?.source || rungSource;
            rec.source = trackOverride?.source || rungSource;
            return await this.enqueueLavalinkTracks(player, [hit], requester, trackOverride, rungSource);
          }
        // Direct plugin-rung URL plays skip the ladder: pre-clean + backfill
        // here so lives on third-party channels get artist/chapter art, not
        // raw thumbnails. Fire-and-forget (never stalls the fast path — the
        // card refreshes when late-arriving art lands).
        // Enrichment adopts the Spotify-side clean title + cover for pasted
        // URLs (no trusted override); picks already carry upgraded metadata.
        preCleanArtwork(meta, trackOverride?.artworkUrl);
        void this.maybeBackfillArt(
          meta,
          trackOverride?.artworkUrl,
          trackOverride?.title || meta.title,
          trackOverride?.author || meta.author,
          BACKGROUND_ARTWORK_TIMEOUT_MS,
          meta.uri,
          player.guildId,
        );
        return await this.enqueueLavalinkTracks(player, [meta], requester, trackOverride, 'youtube', undefined, !trackOverride?.title);
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
      if (MusicSearchLadder.isTransportError(found)) {
        return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
      }
      // Audio-first: never gate playback on art — background cascade,
      // late-attach, and the card refreshes when art lands.
      void this.maybeBackfillArt(
        found.track,
        trackOverride?.artworkUrl,
        trackOverride?.title || found.track.title,
        trackOverride?.author || found.track.author,
        BACKGROUND_ARTWORK_TIMEOUT_MS,
        found.track.uri,
        player.guildId,
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
   * moonlink's play() resolves false instead of throwing when voice isn't
   * ready (it retries connect internally) or the head track is undecodable.
   * Give the handshake one more short chance, then roll back exactly what THIS
   * call added — the old index-range rollback (`while size > sizeBefore`)
   * truncated everything, so two members racing /play where one handshake
   * failed lost BOTH tracks while the other was told "Added to Queue".
   */
  private async startPlaybackOrRollback(player: Player, addedRaw: Track[]): Promise<boolean> {
    if (player.playing || player.paused) return true;
    if (await player.play()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (player.playing || player.paused) return true;
    if (await player.play()) return true;
    for (const track of addedRaw) {
      try {
        const at = player.queue.all.indexOf(track);
        if (at !== -1) player.queue.remove(at);
      } catch {
        // Already consumed by playback or removed elsewhere.
      }
    }
    return false;
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
    // Single gate for every enqueue path (single track, playlist, mirror, JIT).
    // A ladder search can take 20-70s; if the player was stopped/destroyed in
    // that window, writing to it now would resurrect a dead session.
    if (isDestroyedPlayer(player)) {
      return { loadType: 'error', errorReason: 'voice', totalTracksAdded: 0, positionInQueue: 0 };
    }
    const sizeBefore = player.queue.size;
    const room = Math.max(0, MAX_QUEUE_TRACKS - sizeBefore);
    const incoming = tracks.slice(0, room);
    const capped = tracks.length > incoming.length;
    const addedTracks: MusicTrack[] = [];
    const addedRaw: Track[] = [];
    for (const rawTrack of incoming) {
      rawTrack.requester = requester;
      if (trackOverride?.title) rawTrack.title = trackOverride.title;
      if (trackOverride?.author) rawTrack.author = trackOverride.author;
      if (trackOverride?.artworkUrl) rawTrack.artworkUrl = trackOverride.artworkUrl;
      const trackRecord = rawTrack as unknown as Record<string, unknown>;
      const finalSource = trackOverride?.source || source;
      // Stash raw video context before any title overwrite (trackOverride or
      // Spotify enrichment) so chapter artist extraction keeps working.
      if ((finalSource === 'youtube' || finalSource === 'spotify' || finalSource === 'local')) {
        if (typeof trackRecord._rawVideoTitle !== 'string' && rawTrack.title) {
          trackRecord._rawVideoTitle = rawTrack.title;
        }
        if (typeof trackRecord._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(rawTrack.identifier ?? '')) {
          trackRecord._sourceVideoId = rawTrack.identifier;
        }
      }
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
            if (spotifyMatch.album?.trim()) {
              (rawTrack as unknown as Record<string, unknown>)._album = spotifyMatch.album.trim();
            }
          }
        } catch {
          // Fallback safely to Lavalink track info
        }
      }
      // The Spotify enrichment above awaits; the player may have been stopped
      // (and possibly replaced) in that window.
      if (isDestroyedPlayer(player)) {
        return { loadType: 'error', errorReason: 'voice', totalTracksAdded: addedTracks.length, positionInQueue: sizeBefore };
      }
      player.queue.add(rawTrack);
      addedRaw.push(rawTrack);
      const domain = mapMoonlinkTrack(rawTrack, requester);
      domain.source = finalSource;
      if (trackOverride?.artworkUrl) domain.artworkUrl = trackOverride.artworkUrl;
      addedTracks.push(domain);
    }

    if (incoming.length === 0) {
      // Queue is full. Returning a success-shaped result with zero tracks made
      // the command answer "Added <query> to the queue" for a track that was
      // never queued.
      Logger.info({ guildId: player.guildId, size: sizeBefore }, 'Queue full — rejecting play');
      return { loadType: 'error', errorReason: 'queue-full', totalTracksAdded: 0, positionInQueue: sizeBefore };
    }

    if (!(await this.startPlaybackOrRollback(player, addedRaw))) {
      // A failed handshake on a lagging public node is a NODE problem, not a
      // voice-permission problem; saying "check my permissions" sent users
      // hunting for a permission that was never wrong.
      const reason = hasHealthyNode(this.moonlinkManager) ? 'voice' : 'no-nodes';
      return { loadType: 'error', errorReason: reason, totalTracksAdded: 0, positionInQueue: sizeBefore };
    }

    if (tracks.length > 1 || playlistName) {
      return {
        loadType: 'playlist',
        playlistName: playlistName || 'Playlist',
        tracks: addedTracks,
        totalTracksAdded: addedTracks.length,
        positionInQueue: player.queue.size - addedTracks.length + 1,
        partial: capped || undefined,
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
    const resolution = await this.spotifyResolver.resolve(spotifyUrl);

    if (!resolution || resolution.tracks.length === 0) {
      return {
        loadType: 'empty',
        totalTracksAdded: 0,
        positionInQueue: 0,
      };
    }
    return await this.playMirror(player, resolution, spotifyUrl, requester, trackOverride);
  }

  /**
   * Plays a mirrored provider resolution (Spotify / Deezer / Apple Music):
   * provider metadata drives an ISRC-first ladder search for the audio,
   * single tracks resolve immediately, collections resolve first-now and
   * queue the rest just-in-time. One path for every provider — no
   * per-provider playback forks to rot.
   */
  private async playMirror(
    player: Player,
    resolution: MirrorResolution,
    sourceUrl: string,
    requester: MusicTrackRequester,
    trackOverride?: {
      title?: string;
      author?: string;
      artworkUrl?: string;
      source?: string;
    },
  ): Promise<PlayResult> {
    // Real resolvers always stamp provider; default to Spotify so older
    // callers/mocks without the field keep the legacy badges + load types.
    const provider = resolution.provider ?? 'spotify';
    // Ladder metadata: ISRC + expected duration enable the exact-recording
    // first search; title/artist/artwork keep the fuzzy fallback identical.
    const mirrorMeta = (t: MirrorTrack): ResolverMeta => ({
      title: trackOverride?.title || t.name,
      artist: trackOverride?.author || t.artist,
      artworkUrl: trackOverride?.artworkUrl || t.artworkUrl,
      isrc: t.isrc,
      durationMs: t.durationMs,
    });

    if (resolution.type === 'track') {
      const mirrorTrack = resolution.tracks[0]!;
      const found = await this.searchTrackWithLadder(player, mirrorTrack.searchQuery, mirrorMeta(mirrorTrack));

      if (!found) {
        return {
          loadType: 'empty',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }
      if (MusicSearchLadder.isTransportError(found)) {
        return {
          loadType: 'error',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      const chosenTrack = found.track;
      adoptMirrorTrack(chosenTrack, mirrorTrack, found.rung, requester, sourceUrl, trackOverride);
      // Backfill AFTER adoption: adoption clears the raw YouTube thumbnail
      // when the provider has no cover, so the cascade can fill real artwork
      // instead of skipping on the wrong image.
      // Audio-first: never gate playback on art — background cascade,
      // late-attach, and the card refreshes when art lands.
      void this.maybeBackfillArt(
        chosenTrack,
        trackOverride?.artworkUrl || mirrorTrack.artworkUrl,
        trackOverride?.title || mirrorTrack.name,
        trackOverride?.author || mirrorTrack.artist,
        BACKGROUND_ARTWORK_TIMEOUT_MS,
        mirrorTrack.spotifyUri,
        player.guildId,
      );
      const sizeBefore = player.queue.size;
      player.queue.add(chosenTrack);

      const domainTrack = mapMoonlinkTrack(chosenTrack, requester);
      domainTrack.source = provider;
      if (trackOverride?.artworkUrl) {
        domainTrack.artworkUrl = trackOverride.artworkUrl;
      }

      if (!(await this.startPlaybackOrRollback(player, [chosenTrack]))) {
        return { loadType: 'error', errorReason: 'voice', totalTracksAdded: 0, positionInQueue: sizeBefore };
      }

      return {
        loadType: 'track',
        track: domainTrack,
        totalTracksAdded: 1,
        positionInQueue: player.queue.size,
      };
    }

    // Provider Album / Playlist / Artist top tracks
    const addedTracks: MusicTrack[] = [];
    const firstTrack = resolution.tracks[0]!;

    // Resolve first track immediately so playback begins with minimum delay.
    const firstFound = await this.searchTrackWithLadder(player, firstTrack.searchQuery, mirrorMeta(firstTrack));
    if (firstFound && MusicSearchLadder.isTransportError(firstFound)) {
      return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
    }
    if (firstFound) {
      const firstLavalinkTrack = firstFound.track;
      adoptMirrorTrack(firstLavalinkTrack, firstTrack, firstFound.rung, requester, sourceUrl, trackOverride);
      // Audio-first: never gate playback on art — background cascade,
      // late-attach, and the card refreshes when art lands.
      void this.maybeBackfillArt(
        firstLavalinkTrack,
        firstTrack.artworkUrl,
        firstTrack.name,
        firstTrack.artist,
        BACKGROUND_ARTWORK_TIMEOUT_MS,
        firstTrack.spotifyUri,
        player.guildId,
      );
      const firstDomainTrack = mapMoonlinkTrack(firstLavalinkTrack, requester);
      firstDomainTrack.source = provider;
      if (trackOverride?.artworkUrl) {
        firstDomainTrack.artworkUrl = trackOverride.artworkUrl;
      }
      addedTracks.push(firstDomainTrack);

      const firstSizeBefore = player.queue.size;
      player.queue.add(firstLavalinkTrack);

      if (!(await this.startPlaybackOrRollback(player, [firstLavalinkTrack]))) {
        return { loadType: 'error', errorReason: 'voice', totalTracksAdded: 0, positionInQueue: firstSizeBefore };
      }
    }

    // Just-in-time: the rest wait as pending entries and resolve 2-ahead as
    // playback advances (see topUpPending). Cold-cache songs resolve at play
    // time — warm cache, resolver rung — instead of locking in SoundCloud
    // versions upfront, and the command replies in seconds.
    const remainingTracks = resolution.tracks.slice(1);
    if (remainingTracks.length > 0) {
      const existing = this.pendingSpotify.get(player.guildId) ?? [];
      for (const spTrack of remainingTracks) {
        existing.push({ spTrack, requester, spotifyUrl: sourceUrl, override: trackOverride });
      }
      this.pendingSpotify.set(player.guildId, existing);
      void this.topUpPending(player.guildId);
    }

    // Spotify keeps its legacy load types (builders/tests key off them);
    // other providers report provider-agnostic mirror_* collections.
    const loadType =
      resolution.type === 'album'
        ? provider === 'spotify'
          ? 'spotify_album'
          : 'mirror_album'
        : resolution.type === 'playlist'
          ? provider === 'spotify'
            ? 'spotify_playlist'
            : 'mirror_playlist'
          : provider === 'spotify'
            ? 'spotify_artist'
            : 'mirror_artist';

    // Perfect: if playlist was chunked (scraper 100/312), register lazy loader for next 100
    //
    // Measured 2026-09-27: that paging can no longer work. Spotify removed
    // playlist-contents access for app-only tokens — /v1/playlists/{id}/tracks
    // is 403, /v1/playlists/{id} returns metadata with no `tracks`, the anon
    // web-player token endpoint returns XML, the main playlist HTML no longer
    // ships __NEXT_DATA__, and the embed page returns the SAME first 100
    // tracks for ?offset=0/100/200 alike. 100 is a hard ceiling without
    // extended quota access, which Spotify now grants only to organisations
    // with 250k+ MAU. So the chunk manager is registered (harmless, and it
    // still drains anything a future source can provide) but the reply below
    // tells the truth instead of quietly handing back a fraction of the ask.
    // Truncation is now three-valued, because "the count was unreadable" is not
    // the same claim as "the count is larger than what we got".
    //
    // Before this, `totalTracks` silently meant `max(count, shard)` — the shard
    // size when the count could not be read — and the gate
    // `totalTracks > tracks.length` was then `100 > 100`, false. So a
    // 347-track playlist rendered a confident "100 tracks" with no notice at
    // all. The honest states are: a real count that exceeds the shard (truncated
    // by a known amount), a real count that fits (complete), and no count
    // (size unknown, so the number shown is a floor).
    const totalUnknown = resolution.type === 'playlist' && resolution.totalKnown === false;
    const spotifyTruncated =
      provider === 'spotify' &&
      resolution.type === 'playlist' &&
      (resolution.totalTracks > resolution.tracks.length || totalUnknown);
    if (spotifyTruncated && this.playlistChunkManager) {
      const parsed = this.spotifyResolver.parseSpotifyUrl(sourceUrl);
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

    const missing = resolution.totalTracks - resolution.tracks.length;
    return {
      loadType,
      playlistName: resolution.title,
      artworkUrl: resolution.artworkUrl,
      tracks: [...addedTracks, ...pendingDomain],
      totalTracksAdded: addedTracks.length + pendingDomain.length,
      positionInQueue: player.queue.size - addedTracks.length + 1,
      partial: spotifyTruncated || undefined,
      // Two different sentences, because they are two different claims. With a
      // real count we can name what is missing; without one, naming a number
      // would be inventing it — which is the exact bug this whole path exists
      // to remove.
      partialReason: spotifyTruncated
        ? totalUnknown
          ? `Spotify only exposes ${resolution.tracks.length} tracks of this playlist to bots, and does not report the full size — more may exist beyond what was loaded`
          : `Spotify only exposes the first ${resolution.tracks.length} of ${resolution.totalTracks} tracks to bots — ${missing} more were not loaded`
        : undefined,
    };
  }

  /** Artwork backfill — see MusicTrackArtwork. */
  private async maybeBackfillArt(
    track: Track,
    knownArtworkUrl?: string,
    title?: string,
    artist?: string,
    timeoutMs: number = ARTWORK_TIMEOUT_MS,
    spotifyUri?: string | null,
    notifyGuildId?: string,
  ): Promise<void> {
    return this.artwork.maybeBackfillArt(
      track,
      knownArtworkUrl,
      title,
      artist,
      timeoutMs,
      spotifyUri,
      notifyGuildId,
    );
  }

  /** Prewarm the next couple of pending covers — see MusicTrackArtwork. */
  public warmUpcomingArt(guildId: string): void {
    this.artwork.warmUpcomingArt(guildId);
  }

  private mapPendingEntry(e: PendingSpotifyEntry): MusicTrack {
    return {
      identifier: e.spTrack.spotifyUri || e.spTrack.sourceUrl || '',
      title: e.override?.title || e.spTrack.name,
      author: e.override?.author || e.spTrack.artist,
      uri: spotifyUriToUrl(e.spTrack.spotifyUri) || e.spTrack.sourceUrl || '',
      duration: e.spTrack.durationMs || 0,
      isSeekable: true,
      isStream: false,
      artworkUrl: e.override?.artworkUrl || e.spTrack.artworkUrl,
      album: e.spTrack.album,
      source: e.spTrack.provider ?? 'spotify',
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
    let drained = false;
    try {
      // The only brake on this loop was `queue.size`, which stays 0 when every
      // resolve fails. A node/YouTube outage then drained a 400-track playlist
      // one entry at a time, each costing up to ~84s of ladder retries and up
      // to 8 searches — hours of background work that would trip 4000 on every
      // public node. Stop on a run of misses and keep the rest pending.
      let consecutiveMisses = 0;
      const deadline = Date.now() + MusicService.TOP_UP_DEADLINE_MS;
      for (;;) {
        const player = this.getPlayer(guildId);
        if (!player) {
          this.pendingSpotify.delete(guildId);
          return;
        }
        const list = this.pendingSpotify.get(guildId);
        if (!list || list.length === 0) {
          this.pendingSpotify.delete(guildId);
          drained = true;
          break;
        }
        if (player.queue.size >= MusicService.JIT_AHEAD) break;
        if (Date.now() > deadline) {
          Logger.warn(
            { guildId, remaining: list.length, added, skipped },
            '[Music] Pending top-up hit its time budget — deferring the rest',
          );
          break;
        }
        const entry = list.shift()!;
        const found = await this.resolvePlaylistTrack(player, entry.spTrack).catch(() => null);
        // CORRECT AS IS: a resolve that throws is a resolve that did not
        // produce a track, and is counted as a miss by the consecutive-miss
        // brake below. Nothing was queued, so nothing needs undoing, and the
        // channel notice says "could not be resolved" — never "does not
        // exist". A resolved entry still adopts and enqueues normally.
        if (!this.getPlayer(guildId)) {
          this.pendingSpotify.delete(guildId);
          return;
        }
        if (!found) {
          skipped++;
          if (++consecutiveMisses >= MusicService.TOP_UP_MAX_CONSECUTIVE_MISSES) {
            Logger.warn(
              { guildId, misses: consecutiveMisses, remaining: list.length },
              '[Music] Pending top-up hit consecutive resolve misses — deferring the rest',
            );
            break;
          }
          continue;
        }
        consecutiveMisses = 0;
        adoptMirrorTrack(
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
    if (drained && skipped > 0) {
      const unit = skipped === 1 ? 'track' : 'tracks';
      this.notifyUnavailable(guildId, `⚠️ ${skipped} queued ${unit} could not be resolved and were skipped.`);
    }
    this.artwork.warmUpcomingArt(guildId);
    if (added > 0) {
      const player = this.getPlayer(guildId);
      if (player && !player.playing && !player.paused) {
        // CORRECT AS IS: the queue was refilled after a drain, so the one job
        // left is starting it. A refused start() is a voice/REST refusal — the
        // tracks stay queued and visible, so the queue count the user sees is
        // true, and the next play/trackEnd trigger tries again.
        await player.play().catch(() => undefined);
      }
    }
  }

  /**
   * Resolves one playlist track through the health ladder
   * (resolver → plugin → soundcloud, SoundCloud-first while down).
   * ISRC + expected duration ride along for the exact-recording search.
   */
  private async resolvePlaylistTrack(
    player: Player,
    spTrack: MirrorTrack,
  ): Promise<{ lavalinkTrack: Track; spTrack: MirrorTrack; rung: Rung } | null> {
    const found = await this.searchTrackWithLadder(player, spTrack.searchQuery, {
      title: spTrack.name,
      artist: spTrack.artist,
      artworkUrl: spTrack.artworkUrl,
      isrc: spTrack.isrc,
      durationMs: spTrack.durationMs,
    });
    if (!found || MusicSearchLadder.isTransportError(found)) return null;
    // Audio-first, like every other path: this await used to sit between the
    // ladder and the return, so the JIT could not enqueue track N+1 until
    // track N's 10s artwork race finished — and `move`/`skipto` onto a pending
    // entry blocked the user for the same 10s. The track object is mutated in
    // place and notifyCardArt refreshes the card when art lands.
    void this.maybeBackfillArt(
      found.track,
      spTrack.artworkUrl,
      spTrack.name,
      spTrack.artist,
      BACKGROUND_ARTWORK_TIMEOUT_MS,
      spTrack.spotifyUri,
      player.guildId,
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
    try {
      await player.destroy('Stopped by user');
    } catch (err) {
      // A failed teardown must not reject into the command (and, unhandled,
      // into the process) — the player is going away either way.
      Logger.warn({ err, guildId }, '[Music] Player destroy reported a failure');
    }
  }

  public getPlayer(guildId: string): Player | undefined {
    return this.registry.getPlayer(guildId);
  }

  public async getOrCreatePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<Player> {
    return this.registry.getOrCreatePlayer(guildId, voiceChannelId, textChannelId);
  }

  public async pause(guildId: string): Promise<boolean> {
    return this.controls.pause(guildId);
  }

  public async resume(guildId: string): Promise<boolean> {
    return this.controls.resume(guildId);
  }

  public async seek(guildId: string, seconds: number, restTimeoutMs = SEEK_REST_TIMEOUT_MS): Promise<number | null> {
    return this.controls.seek(guildId, seconds, restTimeoutMs);
  }

  /**
   * Playback control policy — see MusicPlaybackControls. Kept as a delegate so
   * every surface (slash, text, buttons, menus) keeps one shared answer.
   */
  public canControlPlayback(guildId: string, userId: string, isAdmin = false): boolean {
    return this.controls.canControlPlayback(guildId, userId, isAdmin);
  }

  public setVolume(guildId: string, volume: number): number | null {
    return this.controls.setVolume(guildId, volume);
  }

  public adjustVolume(guildId: string, delta: number): number | null {
    return this.controls.adjustVolume(guildId, delta);
  }

  public async setFilter(
    guildId: string,
    filter: FilterName,
    enabled: boolean,
  ): Promise<{ applied: boolean; replaced: FilterName[] }> {
    return this.controls.setFilter(guildId, filter, enabled);
  }

  public async clearFilters(guildId: string): Promise<boolean> {
    return this.controls.clearFilters(guildId);
  }

  public toggle247(guildId: string, enabled?: boolean): boolean {
    return this.controls.toggle247(guildId, enabled);
  }

  public isKaraokeEnabled(guildId: string): boolean {
    return this.controls.isKaraokeEnabled(guildId);
  }

  public toggleKaraoke(guildId: string, enabled?: boolean): boolean {
    return this.controls.toggleKaraoke(guildId, enabled);
  }

  /** Wired at startup — refreshes the card when karaoke is toggled. */
  public setKaraokeToggleNotifier(notifier: (guildId: string) => void): void {
    this.controls.setKaraokeToggleNotifier(notifier);
  }

  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  public setCardRefreshNotifier(notifier: (guildId: string) => void): void {
    this.artwork.setCardRefreshNotifier(notifier);
  }

  public setLoop(guildId: string, mode: LoopMode): LoopMode | null {
    return this.controls.setLoop(guildId, mode);
  }

  public cycleLoop(guildId: string): LoopMode | null {
    return this.controls.cycleLoop(guildId);
  }

  public toggleAutoplay(guildId: string, enabled?: boolean): boolean | null {
    return this.controls.toggleAutoplay(guildId, enabled);
  }

  public async previous(guildId: string): Promise<boolean> {
    return this.controls.previous(guildId);
  }

  public async replay(guildId: string): Promise<boolean> {
    return this.controls.replay(guildId);
  }

  public shuffle(guildId: string): boolean {
    const player = this.getPlayer(guildId);
    const pending = this.pendingSpotify.get(guildId);
    const hasPending = !!pending && pending.length > 0;
    const hasQueue = !!player && !player.queue.isEmpty;

    // Both sides have to be checked. Returning early on an empty Moonlink queue
    // looked right but was wrong for the common case: a large playlist resolves
    // two tracks ahead, so for most of the load the queue is EMPTY while the
    // pending store holds almost everything. Shuffle therefore did nothing at
    // all, and reported "nothing to shuffle", for the exact moment a listener is
    // most likely to press it.
    if (!hasQueue && !hasPending) return false;

    if (hasQueue) player.queue.shuffle();
    // Pending entries are the queue's tail - shuffle them in place too so the
    // order stays uniformly random once they resolve. The array must be the
    // live one: see pendingStoreIdentity.test.ts.
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
    // Chunk state must die with the session either way — a stale entry would
    // otherwise append the old playlist to whatever the guild plays next.
    this.playlistChunkManager?.clear(guildId);
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
      //
      // The dropped tracks are captured first: if skip() then fails (voice not
      // ready) the old code had already destroyed them and still reported
      // "Invalid track position" — 11 tracks gone with nothing said.
      const dropped = index > 0 ? player.queue.all.slice(0, index) : [];
      if (index > 0) player.queue.removeRange(0, index - 1);
      if (await player.skip()) return true;
      // The restore is a PREPEND, so it walks the dropped block back-to-front
      // and puts every track at index 0: [a,b,c] drops a,b, and rebuilding
      // b-then-a lands [a,b,c] again. `add` APPENDED, so the refused jump left
      // [c,a,b] — the target the user asked for sat AHEAD of the tracks that
      // were in front of it, a queue nobody chose. `insert` is the same
      // splice-based call `move()` uses, and 0 is the one index that stays
      // valid whatever happened to the queue during the awaited skip().
      for (const track of [...dropped].reverse()) {
        try {
          player.queue.insert(0, track);
        } catch {
          // CORRECT AS IS: restoring the dropped tracks is best effort on a
          // path that has ALREADY failed (skip() returned false) and already
          // answers the user "invalid position". Throwing here would replace
          // that answer with an unhandled rejection.
        }
      }
      return false;
    }
    const pending = this.pendingSpotify.get(guildId);
    const entry = pending?.[index - player.queue.size];
    if (!pending || !entry) return false;
    const sizeAtEntry = player.queue.size;
    const found = await this.resolvePlaylistTrack(player, entry.spTrack).catch(() => null);
    const live = this.getPlayer(guildId);
    const liveList = this.pendingSpotify.get(guildId);
    // CORRECT AS IS: a throw or a miss both land here, BEFORE any mutation,
    // so refusing the jump leaves the queue exactly as it was — the promise
    // this method makes ("a miss refuses with the queue untouched").
    if (!found || !live || !liveList) return false;
    // The player may have been replaced entirely while we resolved.
    if (live !== player || isDestroyedPlayer(live)) return false;
    const at = liveList.indexOf(entry);
    if (at === -1) return false;
    // Drop only what existed when the jump started. `queue.clear()` here wiped
    // tracks ANOTHER member queued during the ~18s resolve, while this user
    // was told "Jumped to track #N".
    for (let i = 0; i < sizeAtEntry && live.queue.size > 0; i++) {
      live.queue.remove(0);
    }
    liveList.splice(0, at + 1);
    if (liveList.length === 0) this.pendingSpotify.delete(guildId);
    adoptMirrorTrack(
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
    const src = mapped.source;
    return {
      spTrack: {
        searchQuery: `${mapped.author} - ${mapped.title}`,
        name: mapped.title,
        artist: mapped.author,
        durationMs: mapped.duration,
        artworkUrl: mapped.artworkUrl,
        spotifyUri: mapped.uri.startsWith('https://open.spotify.com/') ? mapped.uri : undefined,
        sourceUrl: mapped.uri,
        album: mapped.album,
        provider: src === 'spotify' || src === 'deezer' || src === 'apple' ? src : undefined,
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
    // CORRECT AS IS: like jumpToCombined, the resolve happens before any
    // mutation, so a throw or a miss refuses the move with the queue intact.
    if (!found) return false;
    const live = this.getPlayer(guildId);
    const liveList = this.pendingSpotify.get(guildId);
    if (!live || !liveList) return false;
    const at = liveList.indexOf(entry);
    if (at === -1) return false;
    liveList.splice(at, 1);
    if (liveList.length === 0) this.pendingSpotify.delete(guildId);
    adoptMirrorTrack(
      found.lavalinkTrack,
      entry.spTrack,
      found.rung,
      entry.requester,
      entry.spotifyUrl,
      entry.override,
    );
    // `j` was derived from the queue size captured before a resolve that can
    // take ~18s. Recompute the destination against the CURRENT size so the
    // track lands where the user asked even if the queue grew meanwhile.
    const target = Math.max(0, Math.min(j, live.queue.size));
    if (target < live.queue.size) live.queue.insert(target, found.lavalinkTrack);
    else live.queue.add(found.lavalinkTrack);
    return true;
  }

  /** Picker search for the +search select menu — see MusicSearchLadder. */
  public async searchTracks(
    query: string,
    source: string = 'youtube',
    spotifyFirst: boolean = true,
  ): Promise<MusicTrack[]> {
    return this.ladder.searchTracks(query, source, spotifyFirst);
  }

  public getHistory(guildId: string, limit: number = 10) {
    return this.queueService.getHistory(guildId, limit);
  }

  public getNodeStats(): LavalinkNodeStats[] {
    return this.moonlinkManager.getNodeStats();
  }
}

