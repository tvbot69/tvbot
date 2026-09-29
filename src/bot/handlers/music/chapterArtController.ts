import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { CHAPTER_ART_RETRY_MS } from '@bot/services/music/musicConstants';
import {
  extractArtistFromTitle,
  isGenericChapterTitle,
  splitChapterTitle,
  transitionLeadSong,
  getVideoTitle,
  type ChapterCard,
  type VideoChapter,
} from '@bot/services/music/videoChapters';
import type { ArtworkService } from '@bot/services/artworkService';
import type { ColorService } from '@bot/services/colorService';

/**
 * Chapter artwork: the per-chapter cover lookup, the upcoming-chapter cache
 * warm, and the dedicated retry timer.
 *
 * Extracted from MusicHandler. The retry Map is passed in BY REFERENCE and
 * stays owned by the handler, because `clearChapterTimer`/`clearCardTimers`/
 * `forgetGuild` all sweep it and a copy would leak timers.
 */
export interface ChapterArtHost {
  /** Read live, never captured: tests reassign it after construction. */
  readonly artworkService?: ArtworkService;
  /** Read live, never captured: tests reassign it after construction. */
  readonly colorService?: ColorService;
  /** Must route through the host so `vi.spyOn` on the handler still fires. */
  scheduleImmediateProgress(player: Player, delayMs?: number): void;
}

export class ChapterArtController {
  public constructor(
    private readonly host: ChapterArtHost,
    private readonly chapterArtRetryTimers: Map<string, NodeJS.Timeout>,
  ) {}

  /**
   * Cover lookup for a chapter with the transition fallback: medley
   * chapters ("BACKR00MS TO KICK OUT" — A fading into B) have no Spotify
   * track under the full title, so when it misses, retry with the
   * transition's lead song — its cover matches the chapter start. Real
   * songs ("Back To December", "NO BYSTANDERS") hit on the first attempt
   * and never reach the fallback.
   */
  public async getChapterCover(
    chapterTitle: string,
    song: string,
    artist: string | undefined,
  ): Promise<string | null> {
    const svc = this.host.artworkService;
    if (!svc) return null;
    // CORRECT AS IS: a rejected cascade is this RUNG finding nothing, not
    // "this song has no artwork". null goes to resolveChapterArt, which
    // leaves the previously displayed cover in place (the documented hold),
    // and a medley chapter still gets its lead-song retry below. Nothing
    // here is ever reported to the listener as a fact about the catalogue.
    const art = await svc.getTrackCoverUrl(song, artist).catch(() => null);
    if (art) return art;
    const lead = transitionLeadSong(chapterTitle);
    if (!lead || lead.toLowerCase() === song.trim().toLowerCase()) return null;
    Logger.debug({ chapter: chapterTitle, lead }, '[Music] Transition chapter — retrying art with lead song');
    // Same rung, second try: a throw here is still just "not found this
    // time", so null again. The retry timer re-enters at most every 30s.
    return svc.getTrackCoverUrl(lead, artist).catch(() => null);
  }

  /**
   * Warms the shared artwork cache for upcoming chapters so their covers
   * are usually ready before the chapter starts. Results are discarded —
   * the cache (not player state) carries them to resolveChapterArt.
   * Bounded to a couple of chapters per call; misses stay cheap via the
   * cascade's own negative caching.
   */
  public prefetchChapterArts(player: Player, chapters: VideoChapter[], indices: number[]): void {
    try {
      const svc = this.host.artworkService;
      if (!svc) return;
      const cur = player.current as unknown as { title?: string } | null;
      const videoArtist = extractArtistFromTitle(getVideoTitle(cur)) ?? undefined;
      for (const i of indices) {
        const ch = chapters[i];
        if (!ch || isGenericChapterTitle(ch.title)) continue;
        const { artist, song } = splitChapterTitle(ch.title);
        if (!song) continue;
        // Warm the accent color alongside the cover: the art edit extracts
        // color from this exact URL, and downloading+quantizing serially
        // inside the publish path used to add seconds to every swap.
        void (async () => {
          const art = await this.getChapterCover(ch.title, song, artist ?? videoArtist);
          const colorService = this.host.colorService;
          if (art && colorService) {
            // CORRECT AS IS: the accent colour is cosmetic, and this runs
            // inside a fire-and-forget IIFE — an escaping rejection here
            // would be an UNHANDLED rejection with no card to attach it to.
            // The next publish falls back to the builder's default accent.
            await colorService.getAccentColorAsync(player.guildId, art).catch(() => undefined);
          }
        })();
      }
    } catch {
      // Prefetch is best-effort by definition.
    }
  }

  /**
   * Retry a chapter's cover on a DEDICATED timer rather than whenever a
   * publish happens to occur. The retry used to be gated on publish triggers,
   * and a paused player produces one every 15s via the chapter timer's
   * re-arm — so a show left paused for hours re-swept all four artwork
   * providers every 30 seconds, per chapter, burning quota for a cover that
   * was genuinely missing. Publishing now costs nothing extra, and the retry
   * cadence is explicit.
   */
  public scheduleChapterArtRetry(player: Player, idx: number, chapters: VideoChapter[]): void {
    const retry = player.get<{ idx: number; at: number } | null>('chapterArtRetry');
    if (retry && retry.idx === idx && Date.now() - retry.at < CHAPTER_ART_RETRY_MS) return;
    player.set('chapterArtRetry', { idx, at: Date.now() });
    this.clearChapterArtRetryTimer(player.guildId);
    const timer = setTimeout(() => {
      this.chapterArtRetryTimers.delete(player.guildId);
      // Only retry while this chapter is still the one on screen.
      if ((player.get<number>('chapterIdx') ?? -2) !== idx) return;
      if (player.get<ChapterCard | null>('chapterCard')?.artworkUrl) return;
      void this.resolveChapterArt(player, idx, chapters);
    }, CHAPTER_ART_RETRY_MS);
    timer.unref?.();
    this.chapterArtRetryTimers.set(player.guildId, timer);
  }

  public clearChapterArtRetryTimer(guildId: string): void {
    const timer = this.chapterArtRetryTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.chapterArtRetryTimers.delete(guildId);
    }
  }

  public async resolveChapterArt(
    player: Player,
    idx: number,
    chapters: VideoChapter[],
    coverOnly = false,
  ): Promise<void> {
    // Generation captured before the cascade: a track change mid-resolve
    // must not paint this cover onto the next track's card.
    const chapterToken = player.get<number>('chapterToken');
    try {
      const ch = chapters[idx];
      if (!ch) return;
      const { artist, song } = splitChapterTitle(ch.title);
      if (!song) return;
      // Song-only chapters ("Rottweiler") carry no artist; fall back to the
      // performer named in the VIDEO title ("EsDeeKid - Live..."), since the
      // uploader channel often differs (or is useless) for lives.
      let useArtist = artist;
      if (!useArtist) {
        const cur = player.current as unknown as { title?: string } | null;
        useArtist = extractArtistFromTitle(getVideoTitle(cur)) ?? undefined;
      }
      const svc = this.host.artworkService;
      if (!svc) return;
      const artStartedAt = Date.now();
      const art = await Promise.race([
        this.getChapterCover(ch.title, song, useArtist),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      Logger.info(
        { guildId: player.guildId, idx, song, artMs: Date.now() - artStartedAt, ok: Boolean(art) },
        '[Music] Chapter art',
      );
      if (!art) return;
      // Only publish if the listener hasn't moved on meanwhile (track
      // generation AND chapter index — a list swap mid-resolve must not
      // paint the wrong cover).
      if (player.get<number>('chapterToken') !== chapterToken) return;
      if (coverOnly) {
        // Opening hype: show the first real song's cover WITHOUT naming it
        // (the card stays on the show until its chapter starts). The hold
        // rule picks it up on the next publish.
        player.set('lastCoverUrl', art);
        this.host.scheduleImmediateProgress(player);
        return;
      }
      if ((player.get<number>('chapterIdx') ?? -2) !== idx) return;
      player.set('chapterCard', { title: ch.title, artworkUrl: art });
      // Art landed with no publish scheduled — push the swap immediately.
      this.host.scheduleImmediateProgress(player);
    } catch {
      // CORRECT AS IS: a throw here can only leave the card in a state the
      // hold rule already covers. The two `player.set` calls are the only
      // writes, and each is preceded by its generation/index check, so the
      // worst case is the card still carrying the {title, artworkUrl: null}
      // chapterTimeline staged — which resolveDisplayedChapter resolves by
      // holding the previous cover, deliberately and indefinitely. It is
      // never a blanked or wrong cover, and this returns void, so it cannot
      // reject into the player or the resolver's pause/alert machinery.
    }
  }
}
