import type { Player, Track } from 'moonlink.js';
import { Track as MoonlinkTrack } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { ladderFor, HOME_NODE, type Rung } from './youtubeHealth';
import { resolveViaHome, type ResolverMeta } from './ytResolver';
import { LOAD_TRACKS_TIMEOUT_MS } from './musicConstants';
import { isNodeCooling } from './musicNodeHealth';
import { leadArtist, preCleanArtwork } from './musicTrackArtwork';
import {
  cleanArtistName,
  isSpotifyMatchValid,
  mapMoonlinkTrack,
  type MusicTrack,
} from '@domain/models/music/musicTrack';
import type { MoonlinkManager } from './moonlinkManager';
import type { SpotifyResolvedTrack, SpotifyResolver } from './spotifyResolver';

export type LadderResult = { track: Track; rung: Rung } | { transportError: true } | null;

/**
 * The provider search ladder: ISRC-first YouTube probe, title search, plugin /
 * resolver / SoundCloud rung selection, plus the picker search used by the
 * +search select menu.
 *
 * Extracted from MusicService. It holds NO state of its own — every rung reads
 * node health from the shared `MoonlinkManager` and the per-node ladder from
 * `youtubeHealth`, which must stay a module-level singleton so that a
 * `healthFor()` record primed anywhere is visible here.
 */
export class MusicSearchLadder {
  public constructor(
    private readonly moonlinkManager: MoonlinkManager,
    private readonly spotifyResolver: SpotifyResolver,
  ) {}

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
    const lead = leadArtist(artist);
    if (!lead || lead.toLowerCase() === artist.toLowerCase()) return null;
    const fallback = `${lead} - ${title}`;
    if (fallback.toLowerCase() === query.trim().toLowerCase()) return null;
    return fallback;
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

  /** Narrows a ladder result to the transport-failure variant. */
  public static isTransportError(found: LadderResult): found is { transportError: true } {
    return !!found && 'transportError' in found;
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
  public async searchWithTimeout(
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
   * One YouTube attempt shared by the plugin + resolver rungs, then per-rung
   * selection. Resolver hits are labeled 'local' so failure handling treats
   * them as resolver output, never as YouTube plugin output. Distinguishes
   * transport failure (node unreachable mid-ladder — every search THREW or
   * returned null) from a genuine miss so callers can report "try again"
   * instead of the misleading "No tracks found".
   */
  public async searchTrackWithLadder(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<LadderResult> {
    const first = await this.searchTrackWithLadderOnce(player, query, meta);
    if (first) return first;
    const fallbackQuery = MusicSearchLadder.fallbackSearchQuery(query, meta);
    if (!fallbackQuery) return null;
    Logger.info({ query, fallbackQuery }, '[Music] Search empty — retrying with lead artist');
    return this.searchTrackWithLadderOnce(player, fallbackQuery, meta);
  }

  public async searchTrackWithLadderOnce(
    player: Player,
    query: string,
    meta?: ResolverMeta,
  ): Promise<LadderResult> {
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
      preCleanArtwork(ytHit, meta?.artworkUrl);
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
      if (rung === 'plugin') {
        // The provider's exact length is in scope, and this is the LAST point
        // before the hit gets relabelled as the provider track. Adopting the
        // bare ytsearch top hit meant `.play <any link with a popular title>`
        // could play a 3-hour compilation or a live cut while the card
        // confidently named the requested song. Same tolerance the ISRC and
        // resolver gates already use.
        if (!this.pluginHitMatchesProvider(ytHit, meta)) {
          Logger.info(
            {
              query,
              expectedMs: meta?.durationMs ?? 0,
              gotMs: ytHit.duration ?? 0,
              title: ytHit.title,
            },
            '[Music] Plugin hit does not match the provider track — skipping rung',
          );
          continue;
        }
        return { track: ytHit, rung };
      }
      const local = await this.tryResolverTrack(player, ytHit, meta);
      if (local) return { track: local, rung };
    }
    if (transportFailed || !answered) return { transportError: true };
    return null;
  }

  /**
   * Does this YouTube hit actually look like the provider track we asked for?
   * Duration is the only signal the mirror gives us, so it is the gate; a
   * missing duration on either side is not evidence of a mismatch.
   */
  public pluginHitMatchesProvider(hit: Track, meta?: ResolverMeta): boolean {
    const expected = meta?.durationMs ?? 0;
    if (!expected || !hit.duration) return true;
    // Mirrors and provider edits differ slightly; the resolver gate uses 30s
    // and the ISRC gate 60s, so sit between them.
    return Math.abs(hit.duration - expected) <= 45_000;
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
    _player: Player,
    rungs: Rung[],
    meta?: ResolverMeta,
  ): Promise<Track | null> {
    const isrc = MusicSearchLadder.normalizeIsrc(meta?.isrc);
    if (!isrc) return null;
    if (!rungs.includes('plugin') && !rungs.includes('resolver')) return null;
    let res: { tracks?: Track[] } | null = null;
    try {
      // Shorter budget than the fuzzy search: this is a precise lookup,
      // and a dead node must not cost double latency before the fallback.
      res = await this.searchWithTimeout({ query: `"${isrc}"`, source: 'youtube' }, 5000);
    } catch {
      // CORRECT AS IS: the ISRC rung failing is a rung failing. `null` here
      // only means "no exact-recording hit from this rung", so the caller runs
      // the fuzzy title search below — it is never reported as "this track
      // does not exist", and the node is already cooled by searchWithTimeout.
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

  public async tryResolverTrack(
    player: Player,
    ytTrack: Track,
    meta?: ResolverMeta,
  ): Promise<Track | null> {
    if (player.node?.identifier !== HOME_NODE) return null;
    // Skip fast when Home is REST-dead instead of burning a doomed loadTracks.
    if (isNodeCooling(this.moonlinkManager, player.node?.identifier ?? '')) return null;
    if (!/^[\w-]{11}$/.test(ytTrack.identifier ?? '')) return null;
    const path = await resolveViaHome(ytTrack.identifier, meta);
    if (!path) return null;
    let res: unknown;
    try {
      // MUST be bounded. The node can be WS-connected but REST-dead (the
      // documented uplink-stall class), and this call is reached from
      // topUpPending, which holds the per-guild reentrancy guard: an
      // unsettled await means the guard is never released and that guild's
      // whole pending queue is frozen forever, silently.
      let loadTimer: NodeJS.Timeout | undefined;
      try {
        res = await Promise.race([
          player.node.rest.loadTracks(path),
          new Promise<never>((_, reject) => {
            loadTimer = setTimeout(() => reject(new Error('loadtracks-timeout')), LOAD_TRACKS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (loadTimer) clearTimeout(loadTimer);
      }
    } catch {
      // Treat it like any other REST failure so the node cools down and the
      // ladder falls through to the next rung instead of retrying it.
      const nodeId = player.node?.identifier;
      if (nodeId) this.moonlinkManager.noteRestFailure(nodeId);
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
      preCleanArtwork(track as unknown as { artworkUrl?: string | null });
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

  /**
   * Picker search for the +search select menu: Spotify first on a short race
   * so an exact hit is instant, then a node-aware Lavalink search, then a
   * batched Spotify upgrade of the raw rows in pure-YouTube mode.
   */
  public async searchTracks(
    query: string,
    source: string = 'youtube',
    spotifyFirst: boolean = true,
  ): Promise<MusicTrack[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 1. Spotify search first (unless the caller wants pure YouTube, e.g. the
    // +search command) so results have clean names, artists, hi-res artwork.
    const isUrl =
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|soundcloud\.com|open\.spotify\.com|deezer\.com|link\.deezer\.com|deezer\.page\.link|music\.apple\.com|itunes\.apple\.com)\/.+/i.test(
        trimmed,
      ) || /^https?:\/\//i.test(trimmed);
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
    const mapped = res.tracks.slice(0, 10).map((t) => mapMoonlinkTrack(t));
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
}
