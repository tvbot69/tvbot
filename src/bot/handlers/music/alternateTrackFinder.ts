import { Track, type Manager } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import { HOME_NODE, YoutubeHealth, ladderFor } from '@bot/services/music/youtubeHealth';
import { resolveViaHome } from '@bot/services/music/ytResolver';
import { getSourceVideoId, getVideoTitle } from '@bot/services/music/videoChapters';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { QueueService } from '@bot/services/music/queueService';
import type { FallbackBudget } from '@bot/handlers/music/fallbackBudget';
import { buildFallbackQuery } from '@bot/handlers/music/cardFingerprint';

/**
 * The alternate-track ladder: when a track fails or sticks, find another
 * playable upload of the same song.
 *
 * Extracted from MusicHandler. The health ladder (`ladderFor` / `YoutubeHealth`)
 * MUST stay the module-level singleton from `youtubeHealth` — a copy would
 * silently stop seeing outage records primed anywhere else, and
 * `musicFallback.test.ts` primes one directly.
 */
export interface FallbackHost {
  readonly moonlinkManager: MoonlinkManager;
  readonly queueService: QueueService;
  readonly budget: FallbackBudget;
}

export class AlternateTrackFinder {
  public constructor(private readonly host: FallbackHost) {}

  private isNodeCoolingDown(nodeId: string): boolean {
    const fn = this.host.moonlinkManager.isNodeCoolingDown;
    return typeof fn === 'function' ? fn.call(this.host.moonlinkManager, nodeId) : false;
  }

  public adoptFallbackMetadata(fallback: Track, failedTrack: Track, source: string): void {
    fallback.requester = failedTrack.requester;
    fallback.title = failedTrack.title;
    fallback.author = failedTrack.author;
    if (failedTrack.artworkUrl) fallback.artworkUrl = failedTrack.artworkUrl;
    const rec = fallback as unknown as Record<string, unknown>;
    rec.sourceName = source;
    rec.source = source;
  }

  /** Frozen position snapshot for resume carryover; 0 when unknowable. */
  public frozenPosition(player: Parameters<QueueService['calculatePosition']>[0]): number {
    try {
      const ms = this.host.queueService.calculatePosition(player);
      return typeof ms === 'number' && ms > 0 ? ms : 0;
    } catch {
      // CORRECT AS IS: 0 here is "position unknowable", and it is the SAFE
      // unknowable: resumeFallbackAt refuses anything under 5000ms, so the
      // replacement simply starts at the top. It is never mistaken for a
      // real position of zero, and no card renders it.
      return 0;
    }
  }

  /**
   * Resume-position carryover: when a stuck/failed track is replaced by a
   * fallback alternate, land the replacement where the listener was (the
   * frozen position ≈ the user's seek target after a seek-stall). Clamped
   * to the replacement's duration; skipped for streams/unknown lengths and
   * unless the replacement is actually current. Never throws — advancement
   * already succeeded when this runs.
   */
  public async resumeFallbackAt(
    player: Parameters<QueueService['calculatePosition']>[0],
    fallback: Track,
    resumeMs: number,
  ): Promise<void> {
    try {
      const totalMs = fallback.duration || 0;
      if (!resumeMs || resumeMs < 5000 || !totalMs) return;
      const cur = player.current as unknown as {
        encoded?: string;
        uri?: string | null;
        identifier?: string;
      } | null;
      const key = (t: { encoded?: string; uri?: string | null; identifier?: string } | null | undefined): string =>
        String(t?.encoded ?? t?.uri ?? t?.identifier ?? '');
      if (!cur || key(cur) !== key(fallback)) return;
      const at = Math.max(0, Math.min(resumeMs, totalMs - 1000));
      if (at <= 0) return;
      // CORRECT AS IS: the replacement track is already current and
      // advancing — advancement succeeded before this runs. A refused
      // seek-back costs the listener the resume point (the song restarts),
      // which is a visible degradation but not a wrong claim and not a
      // reason to throw into the ladder. No retry: the ladder's own
      // stuck-detector is what recovers a genuinely wedged player.
      await player.seek(at).catch(() => undefined);
      if (player.current) {
        player.current.position = at;
        player.current.time = Date.now();
      }
      Logger.info({ guildId: player.guildId, at }, '[Music] Fallback resumed at last-known position.');
    } catch {
      // Best-effort only.
    }
  }

  public async searchYoutubeAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    const query = buildFallbackQuery(failedTrack);
    if (!query) return null;
    try {
      const yt = await manager.search({ query, source: 'youtube' });
      const alt = yt?.tracks?.find((t: Track) => this.host.budget.isFreshCandidate(failedTrack, guildId, t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'youtube');
        Logger.info(
          { guildId, query, uri: alt.uri },
          `[Music] Alternate YouTube upload found for "${failedTrack.title}" — retrying without the blocked upload.`,
        );
        return alt;
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] Alternate YouTube search failed');
    }
    return null;
  }

  public async searchSoundcloudAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    const query = buildFallbackQuery(failedTrack);
    if (!query) return null;
    try {
      const sc = await manager.search({ query, source: 'soundcloud' });
      const alt = sc?.tracks?.find((t: Track) => this.host.budget.isFreshCandidate(failedTrack, guildId, t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'soundcloud');
        return alt;
      }
      if (sc?.tracks && sc.tracks.length > 0) {
        Logger.warn(
          { query, topHit: sc.tracks[0]?.title },
          `[Music] SoundCloud top hit duration-mismatched — refusing to play a wrong song.`,
        );
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] SoundCloud fallback search failed');
    }
    return null;
  }

  /**
   * Resolves the exact video through the home PC's yt-dlp resolver and loads
   * it as a local file on the Home node. Only for Home players and YouTube
   * tracks; everything else returns null so the ladder moves on.
   */
  public async tryResolver(
    player: Parameters<QueueService['calculatePosition']>[0],
    src: Track,
  ): Promise<Track | null> {
    if (player.node?.identifier !== HOME_NODE) return null;
    // Skip fast when Home is REST-dead instead of burning a doomed loadTracks
    // (tolerant of partial test doubles).
    if (this.isNodeCoolingDown(player.node?.identifier ?? '')) return null;
    const videoId = getSourceVideoId(src as unknown as { sourceName?: string; identifier?: string });
    if (!videoId) return null;
    const path = await resolveViaHome(videoId, {
      title: src.title,
      artist: src.author,
    });
    if (!path) return null;
    let res: unknown;
    try {
      res = await player.node.rest.loadTracks(path);
    } catch {
      // CORRECT AS IS: the resolver rung failing IS the ladder falling
      // through — findAlternatePlayableTrack logs the rung and moves to the
      // next one, and the caller already recorded this track as failed, so
      // there is no risk of a second fallback for the same track. The
      // player is untouched: nothing was queued, nothing is removed.
      //
      // NOTED ASYMMETRY (not a silent failure, and left alone on purpose):
      // musicSearchLadder.tryResolverTrack also calls noteRestFailure on a
      // loadTracks throw, this one does not. The pre-flight
      // isNodeCoolingDown check means a node that was ALREADY REST-dead is
      // still skipped; only a node that goes dead mid-fallback is not
      // cooled from here. Cost is one doomed call per fallback, and adding
      // the note would change failover behaviour, not correctness.
      return null;
    }
    const typed = res as { loadType?: string; data?: { encoded?: string } };
    if (typed?.loadType !== 'track' || !typed.data?.encoded) return null;
    try {
      const t = new Track(typed.data, src.requester);
      // Wrong-song guard BEFORE metadata adoption (adoption would mask the
      // probe): same ±30s rule as fallbacks. Missing durations pass through.
      if (!this.host.budget.matchesFallbackDuration(src, t.duration)) {
        Logger.warn(
          { guildId: player.guildId, videoId: src.identifier, fileMs: t.duration, expectedMs: src.duration },
          '[Music] Resolver file duration-mismatched — refusing a wrong song.',
        );
        return null;
      }
      t.title = src.title;
      t.author = src.author;
      t.artworkUrl = src.artworkUrl;
      t.uri = src.uri;
      if (!t.duration || t.isStream) t.duration = src.duration;
      const srcRec = src as unknown as Record<string, unknown>;
      const dstRec = t as unknown as Record<string, unknown>;
      const rawTitle = srcRec._rawVideoTitle ?? getVideoTitle(src as unknown as { title?: string }) ?? src.title;
      if (typeof rawTitle === 'string' && rawTitle) dstRec._rawVideoTitle = rawTitle;
      if (videoId) dstRec._sourceVideoId = videoId;
      return t;
    } catch (err) {
      Logger.debug(
        { err, keys: typed.data ? Object.keys(typed.data) : [] },
        '[Music] Track construction from resolver data failed',
      );
      return null;
    }
  }

  /**
   * Finds an alternate playable upload for a failed/stuck track.
   * Order matters:
   *  1. Alternate YouTube upload — official label uploads are the most likely to be
   *     region/age/embed-blocked for Lavalink; lyric and fan re-uploads of the same
   *     duration (different video id) usually play fine.
   *  2. SoundCloud version — last resort; duration-gated so we never silently play a
   *     wrong song (worse UX than skipping).
   * Previously-tried uploads are excluded so a failing fallback can't loop.
   * Returns null when nothing playable exists so the caller can skip past the poison track.
   */
  public async findAlternatePlayableTrack(
    manager: Manager,
    player: Parameters<QueueService['calculatePosition']>[0],
    failedTrack: Track | null | undefined,
    guildId: string,
    failedKey: string,
    err?: unknown,
  ): Promise<Track | null> {
    if (!failedTrack) return null;
    const nodeId = player.node?.identifier ?? 'unknown';
    const outage = !!err && YoutubeHealth.isOutage(err);
    let rungs = ladderFor(player).filter((r) => !(outage && r === 'plugin'));
    // A resolved local file that failed must not be re-resolved.
    if (failedTrack.sourceName === 'local') {
      rungs = rungs.filter((r) => r !== 'resolver');
    }
    Logger.info(
      { guildId, node: nodeId, outage, rungs, track: failedTrack.title },
      '[Music] fallback ladder',
    );
    for (const rung of rungs) {
      const alt =
        rung === 'resolver'
          ? await this.tryResolver(player, failedTrack)
          : rung === 'plugin'
            ? await this.searchYoutubeAlternate(manager, failedTrack, guildId)
            : await this.searchSoundcloudAlternate(manager, failedTrack, guildId);
      Logger.info(
        { guildId, node: nodeId, rung, ok: !!alt, track: failedTrack.title },
        '[Music] fallback rung',
      );
      if (alt) {
        this.host.budget.recordFallbackAttempt(guildId, failedKey, alt.identifier);
        return alt;
      }
    }
    this.host.budget.recordFallbackAttempt(guildId, failedKey);
    return null;
  }
}
