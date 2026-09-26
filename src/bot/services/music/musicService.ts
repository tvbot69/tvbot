import type { Player, Track } from 'moonlink.js';
import { Track as MoonlinkTrack } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { cleanArtistName, cleanTrackTitle, isSpotifyMatchValid, isYoutubeThumbUrl, mapMoonlinkTrack, spotifyUriToUrl, type MirrorResolution, type MirrorTrack, type MusicTrack, type MusicTrackRequester } from '@domain/models/music/musicTrack';
import { MoonlinkManager, type LavalinkNodeStats } from './moonlinkManager';
import { SpotifyResolver, type SpotifyResolvedTrack } from './spotifyResolver';
import type { DeezerResolver } from './deezerResolver';
import type { AppleMusicResolver } from './appleMusicResolver';
import { QueueService } from './queueService';
import type { PlaylistChunkManager } from './playlistChunkManager';
import { ladderFor, HOME_NODE, type Rung } from './youtubeHealth';
import { resolveViaHome, resolverEnabled, type ResolverMeta } from './ytResolver';
import { extractArtistFromTitle } from './videoChapters';
import type { ArtworkService } from '@bot/services/artworkService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

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

/** Hard sanity cap on the player queue — stops runaway playlist ingestion. */
export const MAX_QUEUE_TRACKS = 5000;

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
  /** Optional provider resolvers (wired at startup; absent = links unsupported). */
  private deezerResolver?: DeezerResolver;
  private appleMusicResolver?: AppleMusicResolver;
  /** Wired at startup — best-effort one-line notice in the now-playing channel. */
  private unavailableNotifier: ((guildId: string, message: string) => void) | null = null;
  /** Wired at startup — refreshes the event-driven card on karaoke toggle. */
  private karaokeToggleNotifier: ((guildId: string) => void) | null = null;
  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  private cardRefreshNotifier: ((guildId: string) => void) | null = null;

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

  /**
   * Custom definitions for our FilterNames that Moonlink does NOT ship
   * built in (it only has nightcore/vaporwave/karaoke of ours — the rest
   * throw `Filter does not exist` on enable). Registered per player via
   * ensureFilterDefined before every enable, so toggles, restores, and
   * interaction retries all work. Values are standard audible Lavalink
   * shapes; distortion starts mild — ear-test before pushing further.
   */
  private static readonly FILTER_DEFINITIONS: Partial<Record<FilterName, Record<string, unknown>>> = {
    bassboost: {
      equalizer: [
        { band: 0, gain: 0.6 }, { band: 1, gain: 0.5 }, { band: 2, gain: 0.4 },
        { band: 3, gain: 0.2 }, { band: 4, gain: 0 }, { band: 5, gain: 0 },
        { band: 6, gain: 0 }, { band: 7, gain: 0 }, { band: 8, gain: 0 },
        { band: 9, gain: 0 }, { band: 10, gain: 0 }, { band: 11, gain: 0 },
        { band: 12, gain: 0 }, { band: 13, gain: 0 }, { band: 14, gain: 0 },
      ],
    },
    // Studio clarity via SUBTRACTION: cut mud and harshness, leave everything
    // else flat. Deliberately almost no boosts — boosts on small drivers +
    // low-bitrate streams clip and distort (v1 boosted the lows and sounded
    // like a muddy bassboost). Cuts can't clip; nudge volume up to compensate.
    audiophile: {
      equalizer: [
        { band: 0, gain: 0 }, { band: 1, gain: 0 }, { band: 2, gain: 0 },
        { band: 3, gain: 0 }, { band: 4, gain: -0.05 }, { band: 5, gain: -0.15 },
        { band: 6, gain: -0.05 }, { band: 7, gain: 0 }, { band: 8, gain: 0 },
        { band: 9, gain: 0 }, { band: 10, gain: -0.15 }, { band: 11, gain: -0.1 },
        { band: 12, gain: 0 }, { band: 13, gain: 0.1 }, { band: 14, gain: 0 },
      ],
    },
    tremolo: { tremolo: { frequency: 2.0, depth: 0.5 } },
    vibrato: { vibrato: { frequency: 4.0, depth: 0.5 } },
    rotation: { rotation: { rotationHz: 0.2 } },
    distortion: {
      distortion: {
        sinOffset: 0, sinScale: 1.5, cosOffset: 0, cosScale: 0.8,
        tanOffset: 0, tanScale: 0.5, offset: 0, scale: 1,
      },
    },
    lowpass: { lowPass: { smoothing: 20.0 } },
  };

  /** Registers our custom definition on the player (idempotent, silent). */
  private ensureFilterDefined(player: Player, filter: FilterName): void {
    const def = MusicService.FILTER_DEFINITIONS[filter];
    if (def === undefined) return;
    try {
      player.filters.define(filter, def as never);
    } catch {
      // Already defined or client without custom support — enable decides.
    }
  }

  /**
   * Equalizer presets are mutually exclusive: Moonlink CONCATENATES the band
   * arrays of every active EQ filter (30 entries for two presets), which
   * Lavalink resolves unpredictably — in practice, mud. Enabling one EQ
   * preset silently switches the other off. All other DSP blocks combine
   * cleanly and stay stackable.
   */
  private static readonly EQ_EXCLUSIVE_GROUP: FilterName[] = ['bassboost', 'audiophile'];

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
        // Sanitize: settings saved while EQ presets could stack may hold
        // both bassboost and audiophile — keep the most recent (last).
        const eqSeen = new Set<FilterName>();
        const sanitized = [...prefs.filters].reverse().filter((f) => {
          if ((MusicService.EQ_EXCLUSIVE_GROUP as string[]).includes(f)) {
            if (eqSeen.size > 0) return false;
            eqSeen.add(f as FilterName);
          }
          return true;
        }).reverse();
        for (const filter of sanitized) {
          try {
            this.ensureFilterDefined(player, filter as FilterName);
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
    // A REST-dead Home is never pinned: the least-load pick stands and
    // search-level exclusions route around it.
    if (created && resolverEnabled() && !this.isCooling(HOME_NODE)) {
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

  /** REST-dead cooldown check, tolerant of partial test doubles. */
  private isCooling(identifier: string): boolean {
    const fn = this.moonlinkManager.isNodeCoolingDown;
    return typeof fn === 'function' ? fn.call(this.moonlinkManager, identifier) : false;
  }

  private async raceSearch(
    manager: { search: (args: { query: string; source: string; node?: string }) => Promise<unknown> },
    args: { query: string; source: string; node?: string },
    ms: number,
  ): Promise<{ tracks?: Track[] } | null> {
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
   * Node-aware search with cross-node retry (tower-uplink-stall class,
   * proven live 2026-09-24): Moonlink's picker can't see REST-death, so a
   * REST-dead-but-WS-connected node absorbs every search. We pick
   * exclusions-aware and mark failures — one observed failure (throw OR
   * timeout-null; the incident surfaced as timeouts) already cost ~4 REST
   * attempts, so it cools the node down immediately and the same command
   * retries on the next candidate. Partial test doubles without the new
   * manager methods fall back to the legacy single attempt.
   */
  private async searchWithTimeout(
    args: { query: string; source: string },
    ms: number = 8000,
  ): Promise<{ tracks?: Track[] } | null> {
    const manager = this.moonlinkManager.getManager();
    const canFailover =
      typeof this.moonlinkManager.pickSearchNode === 'function' &&
      typeof this.moonlinkManager.noteRestFailure === 'function';
    if (!canFailover) {
      return this.raceSearch(manager, args, ms);
    }
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const node = this.moonlinkManager.pickSearchNode([...tried]);
      if (!node) return null;
      try {
        const res = await this.raceSearch(manager, { ...args, node: node.identifier }, ms);
        if (res) return res;
        this.moonlinkManager.noteRestFailure(node.identifier);
        tried.add(node.identifier);
      } catch {
        this.moonlinkManager.noteRestFailure(node.identifier);
        tried.add(node.identifier);
      }
    }
    return null;
  }

  /**
   * Lead-artist fallback query ("ZAF, Omar Taa'i - cashwekaas" -> "ZAF -
   * cashwekaas"). Multi-artist Spotify billing poisons YouTube search into
   * a genuine empty while the video exists; the lead artist + exact title
   * surfaces it. Returns null when no distinct fallback exists.
   */
  public static fallbackSearchQuery(query: string, meta?: ResolverMeta): string | null {
    const title = meta?.title?.trim();
    const artist = meta?.artist?.trim();
    if (!title || !artist) return null;
    const lead = MusicService.leadArtist(artist);
    if (!lead || lead.toLowerCase() === artist.toLowerCase()) return null;
    const fallback = `${lead} - ${title}`;
    if (fallback.toLowerCase() === query.trim().toLowerCase()) return null;
    return fallback;
  }

  /**
   * One YouTube attempt shared by the plugin + resolver rungs, then per-rung
   * selection. Resolver hits are labeled 'local' so failure handling treats
   * them as resolver output, never as YouTube plugin output. Distinguishes
   * transport failure (node unreachable mid-ladder — every search THREW or
   * returned null) from a genuine miss so callers can report "try again"
   * instead of the misleading "No tracks found".
   */
  private async searchTrackWithLadder(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | { transportError: true } | null> {
    const first = await this.searchTrackWithLadderOnce(player, query, meta);
    if (first) return first;
    const fallbackQuery = MusicService.fallbackSearchQuery(query, meta);
    if (!fallbackQuery) return null;
    Logger.info({ query, fallbackQuery }, '[Music] Search empty — retrying with lead artist');
    return this.searchTrackWithLadderOnce(player, fallbackQuery, meta);
  }

  private async searchTrackWithLadderOnce(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<{ track: Track; rung: Rung } | { transportError: true } | null> {
    const rungs = ladderFor(player);
    let ytHit: Track | undefined;
    let transportFailed = false;
    // Any search returning a response object (even an empty one) proves the
    // network answered; all-null across every rung means the nodes are dead,
    // which must report as transportError, not as "No tracks found".
    let answered = false;
    if (rungs.includes('plugin') || rungs.includes('resolver')) {
      // ISRC-first: an exact-recording hit replaces the fuzzy title search
      // entirely (faster AND more accurate). Only on miss/skip does the
      // title search run, so behavior without metadata is unchanged.
      const isrcHit = await this.searchIsrcFirst(player, rungs, meta);
      if (isrcHit) {
        answered = true;
        ytHit = isrcHit;
      } else {
        try {
          const yt = await this.searchWithTimeout({ query, source: 'youtube' });
          if (yt) {
            answered = true;
            ytHit = yt.tracks?.[0];
          }
        } catch {
          // Node unreachable, not a miss — remember it for the result below.
          transportFailed = true;
        }
      }
    }
    if (ytHit) {
      // Artwork pre-clean (single choke point): stamp a known-good cover, or
      // drop a raw YouTube thumbnail so the backfill cascade below fills real
      // (Spotify-first) art instead of skipping on the wrong image. Without
      // this, scraper playlists (no per-track covers) inherit YouTube thumbs
      // permanently: adoption skips missing art AND backfill skips present art.
      MusicService.preCleanArtwork(ytHit, meta?.artworkUrl);
      // Chapter context: stash the raw video title + ID before Spotify
      // adoption overwrites title/author. Without this, extractArtistFromTitle
      // reads the Spotify title (no " - ") and resolver local files lose the
      // video ID entirely.
      const rec = ytHit as unknown as Record<string, unknown>;
      if (typeof rec._rawVideoTitle !== 'string' && ytHit.title) {
        rec._rawVideoTitle = ytHit.title;
      }
      if (typeof rec._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(ytHit.identifier ?? '')) {
        rec._sourceVideoId = ytHit.identifier;
      }
    }
    for (const rung of rungs) {
      if (rung === 'soundcloud') {
        try {
          const sc = await this.searchWithTimeout({ query, source: 'soundcloud' });
          if (sc) answered = true;
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
    if (transportFailed || !answered) return { transportError: true };
    return null;
  }

  /** Narrows a ladder result to the transport-failure variant. */
  private static isTransportError(
    found: { track: Track; rung: Rung } | { transportError: true } | null,
  ): found is { transportError: true } {
    return !!found && 'transportError' in found;
  }

  /**
   * Normalizes an ISRC for search (dashes stripped, uppercased). ISRCs are
   * 12 alphanumerics (CC-XXX-YY-NNNNN); anything else is not searched —
   * a malformed code would only return junk.
   */
  public static normalizeIsrc(isrc?: string): string | null {
    if (!isrc) return null;
    const stripped = isrc.replace(/-/g, '').toUpperCase();
    return /^[A-Z0-9]{12}$/.test(stripped) ? stripped : null;
  }

  /**
   * ISRC-first YouTube hit (LavaSrc DefaultMirroringAudioTrackResolver):
   * `ytsearch:"ISRC"` matches the exact recording where a title search can
   * land on a cover, remix, or live upload. Runs BEFORE the fuzzy title
   * search and replaces it on success — same cost on hit, one extra probe
   * on miss. Gross-mismatch guard: the exact recording must be close in
   * length (±60s); a wild duration means the code matched wrong metadata,
   * so fall through to the title search instead of playing a wrong song.
   */
  private async searchIsrcFirst(
    player: Player,
    rungs: Rung[],
    meta?: ResolverMeta,
  ): Promise<Track | null> {
    const isrc = MusicService.normalizeIsrc(meta?.isrc);
    if (!isrc) return null;
    if (!rungs.includes('plugin') && !rungs.includes('resolver')) return null;
    let res: { tracks?: Track[] } | null = null;
    try {
      // Shorter budget than the fuzzy search: this is a precise lookup,
      // and a dead node must not cost double latency before the fallback.
      res = await this.searchWithTimeout({ query: `"${isrc}"`, source: 'youtube' }, 5000);
    } catch {
      return null;
    }
    const hit = res?.tracks?.[0];
    if (!hit) return null;
    const expected = meta?.durationMs || 0;
    if (expected > 0 && hit.duration > 0 && Math.abs(hit.duration - expected) > 60_000) {
      Logger.info(
        { isrc, hitMs: hit.duration, expectedMs: expected },
        '[Music] ISRC hit duration-mismatched — falling back to title search',
      );
      return null;
    }
    Logger.info({ isrc, title: hit.title }, '[Music] ISRC-first search hit');
    return hit;
  }

  /** True for raw YouTube-family thumbnails (never correct on adopted tracks). */
  public static isYoutubeThumb(url: string | null | undefined): boolean {
    return isYoutubeThumbUrl(url);
  }

  /**
   * Artwork pre-clean (single choke point, also used by the direct URL
   * path): stamp a known-good cover, or drop a raw YouTube thumbnail so a
   * later backfill cascade fills real art instead of skipping on it. Only
   * long-form content (>20min) additionally stashes the video thumbnail —
   * that stash is the sole entry into the long-form video-art system
   * (square rug crop → card paint). Short tracks never enter it: no video
   * thumb, no crop downloads — cascade art only.
   *
   * A YouTube thumbnail passed AS the trusted cover (search picks carry the
   * Lavalink hit's ytimg art as their override) is treated as absent: it is
   * never stamped, so backfill/enrichment still run. Stamping it would
   * permanently paint the card with a video frame instead of the song cover.
   */
  public static preCleanArtwork(
    track: { artworkUrl?: string | null; duration?: number | null },
    artworkUrl?: string | null,
  ): void {
    if (artworkUrl && !MusicService.isYoutubeThumb(artworkUrl)) track.artworkUrl = artworkUrl;
    else if (MusicService.isYoutubeThumb(track.artworkUrl)) track.artworkUrl = null;
  }

  /**
   * Drops a YouTube-thumbnail artworkUrl from a play override. Overrides are
   * trusted downstream (they skip backfill AND Spotify enrichment), so a
   * ytimg URL smuggled in as "known art" — the +search select path — would
   * paint video frames on the card forever. Applied once at play() entry so
   * every downstream path (ladder, adopt, backfill, domain) treats the art
   * as unknown and resolves the real cover.
   */
  public static sanitizeOverride<T extends { artworkUrl?: string } | undefined>(override: T): T {
    if (override?.artworkUrl && MusicService.isYoutubeThumb(override.artworkUrl)) {
      Logger.debug('[Music] Dropping YouTube-thumbnail override art — resolving the real cover instead');
      const { artworkUrl: _dropped, ...rest } = override;
      return rest as T;
    }
    return override;
  }

  private async tryResolverTrack(player: Player, ytTrack: Track, meta?: ResolverMeta): Promise<Track | null> {
    if (player.node?.identifier !== HOME_NODE) return null;
    // Skip fast when Home is REST-dead instead of burning a doomed loadTracks.
    if (this.isCooling(player.node?.identifier ?? '')) return null;
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
      // The resolver's own response carries the SOURCE VIDEO's thumbnail.
      // Left stamped, it looks like resolved art: the backfill cascade skips
      // any track that already has artwork, so the card would show a video
      // frame for the whole set instead of the real cover. Drop it here (no
      // known art to stamp) so the ladder's backfill fills real art.
      MusicService.preCleanArtwork(track as unknown as { artworkUrl?: string | null });
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
      // Carry chapter context onto the local file (it has no video ID itself).
      const srcRec = ytTrack as unknown as Record<string, unknown>;
      const dstRec = track as unknown as Record<string, unknown>;
      const rawTitle = srcRec._rawVideoTitle ?? ytTrack.title;
      if (typeof rawTitle === 'string' && rawTitle && typeof dstRec._rawVideoTitle !== 'string') {
        dstRec._rawVideoTitle = rawTitle;
      }
      if (/^[\w-]{11}$/.test(ytTrack.identifier ?? '')) {
        dstRec._sourceVideoId = ytTrack.identifier;
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
    // Overrides are trusted downstream (they skip backfill AND Spotify
    // enrichment), so a YouTube thumbnail smuggled in as "known art" — the
    // +search pick path — is dropped here, once. Every path below then
    // resolves the real cover instead of painting video frames on the card.
    trackOverride = MusicService.sanitizeOverride(trackOverride);

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
    const isDirectUrl = isYoutubeUrl || isSoundcloud || /^https?:\/\//i.test(trimmedQuery);

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
        if (!urlRes?.tracks || urlRes.tracks.length === 0) {
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
          if (MusicService.isTransportError(swapped)) {
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
              MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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
        MusicService.preCleanArtwork(meta, trackOverride?.artworkUrl);
        void this.maybeBackfillArt(
          meta,
          trackOverride?.artworkUrl,
          trackOverride?.title || meta.title,
          trackOverride?.author || meta.author,
          MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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
      if (MusicService.isTransportError(found)) {
        return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
      }
      // Audio-first: never gate playback on art — background cascade,
      // late-attach, and the card refreshes when art lands.
      void this.maybeBackfillArt(
        found.track,
        trackOverride?.artworkUrl,
        trackOverride?.title || found.track.title,
        trackOverride?.author || found.track.author,
        MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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
   * Give the handshake one more short chance, then roll back everything this
   * enqueue added — a full queue in silent limbo is worse than an honest
   * failure the command can report.
   */
  private async startPlaybackOrRollback(player: Player, sizeBefore: number): Promise<boolean> {
    if (player.playing || player.paused) return true;
    if (await player.play()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (player.playing || player.paused) return true;
    if (await player.play()) return true;
    while (player.queue.size > sizeBefore) player.queue.remove(sizeBefore);
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
    const sizeBefore = player.queue.size;
    const room = Math.max(0, MAX_QUEUE_TRACKS - sizeBefore);
    const incoming = tracks.slice(0, room);
    const capped = tracks.length > incoming.length;
    const addedTracks: MusicTrack[] = [];
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
      player.queue.add(rawTrack);
      const domain = mapMoonlinkTrack(rawTrack, requester);
      domain.source = finalSource;
      if (trackOverride?.artworkUrl) domain.artworkUrl = trackOverride.artworkUrl;
      addedTracks.push(domain);
    }

    if (incoming.length > 0 && !(await this.startPlaybackOrRollback(player, sizeBefore))) {
      return { loadType: 'error', errorReason: 'voice', totalTracksAdded: 0, positionInQueue: sizeBefore };
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
      if (MusicService.isTransportError(found)) {
        return {
          loadType: 'error',
          totalTracksAdded: 0,
          positionInQueue: 0,
        };
      }

      const chosenTrack = found.track;
      this.adoptMirrorTrack(chosenTrack, mirrorTrack, found.rung, requester, sourceUrl, trackOverride);
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
        MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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

      if (!(await this.startPlaybackOrRollback(player, sizeBefore))) {
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
    if (firstFound && MusicService.isTransportError(firstFound)) {
      return { loadType: 'error', totalTracksAdded: 0, positionInQueue: 0 };
    }
    if (firstFound) {
      const firstLavalinkTrack = firstFound.track;
      this.adoptMirrorTrack(firstLavalinkTrack, firstTrack, firstFound.rung, requester, sourceUrl, trackOverride);
      // Audio-first: never gate playback on art — background cascade,
      // late-attach, and the card refreshes when art lands.
      void this.maybeBackfillArt(
        firstLavalinkTrack,
        firstTrack.artworkUrl,
        firstTrack.name,
        firstTrack.artist,
        MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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

      if (!(await this.startPlaybackOrRollback(player, firstSizeBefore))) {
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
    if (provider === 'spotify' && resolution.type === 'playlist' && this.playlistChunkManager && resolution.totalTracks > resolution.tracks.length) {
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
    notifyGuildId?: string,
  ): Promise<void> {
    try {
      if (!track || track.artworkUrl || knownArtworkUrl) return;
      const t = (title || track.title)?.trim();
      const a = (artist || track.author)?.trim();
      if (!t || !a) return;
      const started = Date.now();
      const trackRec = track as unknown as Record<string, unknown>;
      trackRec._artLookupStartedAt = started;
      const dur = track.duration || 0;
      const svc = this.artworkService;
      if (!svc) {
        Logger.debug('[Music] Artwork backfill skipped — no artwork service wired');
        return;
      }
      Logger.info(
        { title: t, artist: a, timeoutMs, durationMs: dur },
        '[Music] Artwork lookup start',
      );
      // Never-rejecting lookup: exact by-ID first (no matching risk), then
      // the name cascade, then the artist profile picture. One slow leg
      // can't hang the race.
      const lookup: Promise<string | null> = (async () => {
        try {
          const id = this.spotifyTrackId(spotifyUri);
          if (id) {
            const byId = await svc.getTrackCoverBySpotifyId(id);
            if (byId) return byId;
          }
          const cover = await svc.getTrackCoverUrl(t, a);
          if (cover) return cover;
          // Artist fallback (live sets, bootlegs, cover-less tracks): the
          // artist's profile picture beats a blank card. When the title
          // names the performer ("EsDeeKid - Live...") THAT is the search
          // target and the uploader channel is skipped entirely — channels
          // ("gloss") can strictly match same-named wrong artists.
          // Otherwise the billed author is tried as before.
          const titleLead = extractArtistFromTitle(t);
          const candidates =
            titleLead && titleLead.toLowerCase() !== MusicService.leadArtist(a).toLowerCase()
              ? [titleLead]
              : [MusicService.leadArtist(a)];
          for (const lead of candidates) {
            if (!lead) continue;
            const pic = await svc.getArtistImageUrl(lead, t).catch(() => null);
            if (pic) return pic;
          }
          return null;
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
          trackRec._artLookupResolvedAt = Date.now();
          trackRec._artLookupOutcome = 'hit';
          Logger.info(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfilled',
          );
          this.notifyCardArt(notifyGuildId);
        } else {
          trackRec._artLookupOutcome = 'miss';
          Logger.debug(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfill miss',
          );
          // Late attach: the race abandons slow lookups but doesn't cancel
          // them — the cascade still finishes and caches. If art arrives
          // after the timeout and the track is still bare, take it and
          // refresh the event-driven card so it shows up.
          void lookup
            .then((late) => {
              if (late && !track.artworkUrl) {
                track.artworkUrl = late;
                const lateMs = Date.now() - started;
                trackRec._artLookupResolvedAt = Date.now();
                trackRec._artLookupOutcome = 'late-hit';
                Logger.info({ title: t, artist: a, resolveMs: lateMs }, '[Music] Artwork late-attached');
                this.notifyCardArt(notifyGuildId);
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
   * First billed artist for profile-picture fallback ("A, B & C feat. D" →
   * "A"). Channel suffixes ("X - Topic", "X VEVO") are stripped — uploads
   * come from auto-generated topic channels as often as from the artist.
   * Mirrors the fallback-query artist logic.
   */
  private static leadArtist(artist: string): string {
    const first = artist.split(/[,/&]/)[0] ?? '';
    return first
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .replace(/\s+(feat\.?|ft\.?|featuring|with|x)\s+.*$/i, '')
      .trim();
  }
  /**
   * Stamps provider display metadata onto a resolved Lavalink track. The
   * moonlink track keeps its true backend label ('local' for resolver
   * output, otherwise the provider) so failure handling routes correctly;
   * the display model keeps the familiar provider badge. Artwork correctness
   * is handled upstream (ladder pre-clean + override sanitizing), so a plain
   * conditional stamp here can never resurrect a wrong image. A trusted
   * override cover wins over provider art; YouTube thumbnails never qualify.
   */
  private adoptMirrorTrack(
    lavalinkTrack: Track,
    mirrorTrack: MirrorTrack,
    rung: Rung,
    requester: MusicTrackRequester,
    sourceUrl: string,
    trackOverride?: { title?: string; author?: string; artworkUrl?: string; source?: string },
  ): void {
    const record = lavalinkTrack as unknown as Record<string, unknown>;
    // Preserve chapter context: the raw video title is captured in
    // searchTrackWithLadder before this overwrite runs. Fall back to the
    // pre-adoption title when the stash is missing (older queue entries).
    if (typeof record._rawVideoTitle !== 'string' && lavalinkTrack.title) {
      record._rawVideoTitle = lavalinkTrack.title;
    }
    if (typeof record._sourceVideoId !== 'string' && /^[\w-]{11}$/.test(lavalinkTrack.identifier ?? '')) {
      const src = String(record.sourceName ?? '');
      if (src === 'youtube' || src === '') record._sourceVideoId = lavalinkTrack.identifier;
    }
    lavalinkTrack.requester = requester;
    lavalinkTrack.title = mirrorTrack.name;
    lavalinkTrack.author = mirrorTrack.artist;
    if (mirrorTrack.artworkUrl) {
      lavalinkTrack.artworkUrl = mirrorTrack.artworkUrl;
    }
    if (mirrorTrack.album?.trim()) {
      record._album = mirrorTrack.album.trim();
    }
    lavalinkTrack.uri = spotifyUriToUrl(mirrorTrack.spotifyUri) || mirrorTrack.sourceUrl || sourceUrl;
    const backend = rung === 'resolver' ? 'local' : (mirrorTrack.provider ?? 'spotify');
    record.sourceName = trackOverride?.source || backend;
    record.source = trackOverride?.source || backend;
    if (trackOverride?.artworkUrl && !MusicService.isYoutubeThumb(trackOverride.artworkUrl)) {
      lavalinkTrack.artworkUrl = trackOverride.artworkUrl;
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
        this.adoptMirrorTrack(
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
    if (!found || MusicService.isTransportError(found)) return null;
    // Background-only path (topUpPending): generous art timeout, nobody waits.
    await this.maybeBackfillArt(
      found.track,
      spTrack.artworkUrl,
      spTrack.name,
      spTrack.artist,
      MusicService.BACKGROUND_ARTWORK_TIMEOUT_MS,
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

  /**
   * Seeks to `seconds`. The seek event fires synchronously inside
   * player.seek (chapter swap runs instantly); the REST round-trip on slow
   * nodes can take seconds, so it races a timeout instead of hanging the
   * command. Intent markers are recorded BEFORE awaiting, so stall grace
   * observes the seek even if REST hangs. A timed-out REST still applies
   * late server-side (or the stuck detector recovers) — true either way,
   * since the event already fired and recovery is event-driven.
   */
  public async seek(guildId: string, seconds: number, restTimeoutMs = 8000): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player || !player.current) return false;
    const ms = Math.max(0, Math.min(seconds * 1000, player.current.duration || 0));
    // Record user seeks so a stall in the seconds after one retries the seek
    // itself instead of burning fallback budget on a healthy upload.
    try {
      player.set('lastUserSeekAt', Date.now());
      player.set('lastUserSeekPos', ms);
      player.set('seekStallRetried', false);
    } catch {
      // Non-critical metadata; the seek below is what matters.
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        player.seek(ms),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('seek-rest-timeout')), restTimeoutMs);
        }),
      ]);
    } catch {
      // Slow/dead REST: the sync event already fired (swap ran, clock
      // pinned); stuck detection owns recovery from here.
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  public async setFilter(
    guildId: string,
    filter: FilterName,
    enabled: boolean,
  ): Promise<{ applied: boolean; replaced: FilterName[] }> {
    const none = { applied: false, replaced: [] as FilterName[] };
    const player = this.getPlayer(guildId);
    if (!player) return none;

    const replaced: FilterName[] = [];
    if (enabled) {
      this.ensureFilterDefined(player, filter);
      if (MusicService.EQ_EXCLUSIVE_GROUP.includes(filter)) {
        for (const other of MusicService.EQ_EXCLUSIVE_GROUP) {
          if (other !== filter && player.filters.enabled.includes(other)) {
            try {
              player.filters.disable(other);
              replaced.push(other);
            } catch {
              // ignore — enable below decides
            }
          }
        }
      }
      try {
        player.filters.enable(filter);
      } catch (err) {
        Logger.warn({ err, guildId, filter }, '[Music] Enable filter failed');
        return { applied: false, replaced };
      }
    } else {
      try {
        player.filters.disable(filter);
      } catch (err) {
        Logger.warn({ err, guildId, filter }, '[Music] Disable filter failed');
        return { applied: false, replaced };
      }
    }
    try {
      await player.filters.apply();
    } catch (err) {
      Logger.warn({ err, guildId, filter }, '[Music] Apply filters failed');
      return { applied: false, replaced };
    }
    this.queueService.saveSettings(guildId, { filters: [...player.filters.enabled] });
    return { applied: true, replaced };
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

  public isKaraokeEnabled(guildId: string): boolean {
    return this.queueService.isKaraokeEnabled(guildId);
  }

  public toggleKaraoke(guildId: string, enabled?: boolean): boolean {
    const next = this.queueService.toggleKaraoke(guildId, enabled);
    // The card is event-driven: a toggle must refresh it (show/hide lyrics)
    // instead of waiting for the next lyric/chapter boundary.
    try {
      this.karaokeToggleNotifier?.(guildId);
    } catch {
      // A notice must never break the toggle.
    }
    return next;
  }

  /** Wired at startup — refreshes the card when karaoke is toggled. */
  public setKaraokeToggleNotifier(notifier: (guildId: string) => void): void {
    this.karaokeToggleNotifier = notifier;
  }

  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  public setCardRefreshNotifier(notifier: (guildId: string) => void): void {
    this.cardRefreshNotifier = notifier;
  }

  /** Best-effort card repaint after art attaches (fingerprint dedupes no-ops). */
  private notifyCardArt(guildId?: string): void {
    if (!guildId) return;
    try {
      this.cardRefreshNotifier?.(guildId);
    } catch {
      // A notice must never break resolution.
    }
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
    this.adoptMirrorTrack(
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
    if (!found) return false;
    const live = this.getPlayer(guildId);
    const liveList = this.pendingSpotify.get(guildId);
    if (!live || !liveList) return false;
    const at = liveList.indexOf(entry);
    if (at === -1) return false;
    liveList.splice(at, 1);
    if (liveList.length === 0) this.pendingSpotify.delete(guildId);
    this.adoptMirrorTrack(
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

  public async searchTracks(query: string, source: string = 'youtube', spotifyFirst: boolean = true): Promise<MusicTrack[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 1. Spotify search first (unless the caller wants pure YouTube, e.g. the
    // +search command) so results have clean names, artists, hi-res artwork.
    const isUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|soundcloud\.com|open\.spotify\.com|deezer\.com|link\.deezer\.com|deezer\.page\.link|music\.apple\.com|itunes\.apple\.com)\/.+/i.test(trimmed) || /^https?:\/\//i.test(trimmed);
    if (spotifyFirst && !isUrl) {
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

    // 2. Fallback to Lavalink (YouTube / SoundCloud) — node-aware, so a
    // REST-dead node can't swallow the search picker's results.
    const res = await this.searchWithTimeout({ query: trimmed, source });
    if (!res || !res.tracks || res.tracks.length === 0) return [];
    const mapped = (res.tracks as Array<import('moonlink.js').Track>).slice(0, 10).map((t) => mapMoonlinkTrack(t));
    // Pure-YouTube mode (+search) would otherwise return raw upload titles
    // with video-frame thumbs — and the pick would carry that thumb into
    // play() as trusted art. One batched Spotify lookup upgrades each hit to
    // the clean studio name + real cover (per-track validated; misses keep
    // raw data). The upgraded metadata rides the select-override into play(),
    // so the card shows the song cover from frame one.
    if (!spotifyFirst && source === 'youtube' && mapped.length > 0) {
      await this.upgradePickerResults(trimmed, mapped);
    }
    return mapped;
  }

  /**
   * Upgrades +search picker results with Spotify-side clean names + covers.
   * Bounded (single batched call, 2.5s race) and silent — a wrong match is
   * worse than a raw upload title, so only isSpotifyMatchValid stamps touch
   * a result. Failures leave the picker exactly as raw as today.
   */
  private async upgradePickerResults(query: string, tracks: MusicTrack[]): Promise<void> {
    try {
      const candidates = await Promise.race([
        this.spotifyResolver.searchTracks(query, 10),
        new Promise<SpotifyResolvedTrack[]>((resolve) => setTimeout(() => resolve([]), 2500)),
      ]);
      if (candidates.length === 0) return;
      for (const t of tracks) {
        const match = candidates.find((c) =>
          isSpotifyMatchValid({ title: t.title, author: t.author, duration: t.duration }, c),
        );
        if (!match) continue;
        t.title = match.name;
        t.author = cleanArtistName(match.artist);
        if (match.artworkUrl) t.artworkUrl = match.artworkUrl;
      }
    } catch {
      // Picker stays raw — today's behavior.
    }
  }

  public getHistory(guildId: string, limit: number = 10) {
    return this.queueService.getHistory(guildId, limit);
  }

  public getNodeStats(): LavalinkNodeStats[] {
    return this.moonlinkManager.getNodeStats();
  }
}

