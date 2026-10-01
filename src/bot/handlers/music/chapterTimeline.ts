import type { Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import {
  chapterIndexAt,
  isGenericChapterTitle,
  isLiveVideo,
  getSourceVideoId,
  type ChapterCard,
  type VideoChapter,
} from '@bot/services/music/videoChapters';
import { getVideoChapters } from '@bot/services/music/ytResolver';
import {
  CHAPTER_ART_RETRY_MS,
  CHAPTER_JUMP_CONFIRM_MS,
  CHAPTER_REGRESSION_TOLERANCE_MS,
  USER_SEEK_INTENT_WINDOW_MS,
} from '@bot/services/music/musicConstants';
import type { ChapterArtController } from '@bot/handlers/music/chapterArtController';

/**
 * The chapter timeline: probing a video's chapters, deriving which chapter a
 * position belongs to, and swapping instantly on a seek.
 *
 * Extracted from MusicHandler. This is the hub of the chapter graph, so the
 * two things it calls out to — the artwork controller and the boundary timer —
 * are injected rather than reached for, and every call back into the handler
 * goes through the host so spies and own-property shadows still work.
 */
export interface ChapterTimelineHost {
  /** The boundary timer owns its own Map on the handler, so it stays there. */
  armChapterTimer(player: Player): void;
  scheduleImmediateProgress(player: Player, delayMs?: number): void;
}

export class ChapterTimeline {
  public constructor(
    private readonly host: ChapterTimelineHost,
    private readonly art: ChapterArtController,
  ) {}

  /**
   * Kicks off a chapter probe for a YouTube track (fire-and-forget: the card
   * goes out immediately and upgrades when chapters land). Only videos with
   * 2+ chapters qualify — a single chapter carries no segmentation info.
   * Resolver-side caching makes repeat plays free. Warms the first covers
   * so chapter one rarely starts cold.
   */
  public resolveVideoChapters(player: Player, track: Track | null | undefined): void {
    const rec = track as unknown as { sourceName?: string; identifier?: string } | null;
    const id = getSourceVideoId(rec);
    // Same video restarting (double trackStart, replay, loop): keep the
    // attached chapters — the trackStart post renders them immediately
    // instead of gaping through a wipe + re-probe — but reset the
    // PRESENTATION state. Carrying the previous play-through's cover/timer
    // into a new one paints the encore's artwork next to song one, and a
    // stale chapterStartedAt makes the borrow window already-expired (or
    // not) at random. The index is re-derived at position 0 by trackStart.
    if (id && id === player.get<string>('chapterSourceId')) {
      player.set('chapterIdx', -2);
      player.set('chapterCommittedPosMs', null);
      player.set('chapterCard', null);
      player.set('lastCoverUrl', null);
      player.set('chapterStartedAt', null);
      player.set('chapterArtRetry', null);
      player.set('chapterJumpPending', null);
      return;
    }
    // Generation token: a slow probe from a skipped track must never attach
    // its chapters (or covers) to the next track. Bumped synchronously on
    // every track so orphans always fail the check below.
    const chapterToken = (player.get<number>('chapterToken') ?? 0) + 1;
    player.set('chapterToken', chapterToken);
    player.set('chapterSourceId', null);
    player.set('chapters', null);
    player.set('chapterIdx', -2);
    player.set('chapterCommittedPosMs', null);
    player.set('chapterCard', null);
    player.set('lastCoverUrl', null);
    player.set('chapterStartedAt', null);
    player.set('chapterArtRetry', null);
    player.set('chapterJumpPending', null);
    try {
      // Standalone live gate: chapters probe ONLY for long videos. Short
      // tracks and Spotify-link plays return here with zero probe cost and
      // byte-identical behavior to before the live system existed.
      if (!isLiveVideo(track?.duration)) return;
      if (!id) {
        Logger.debug({ guildId: player.guildId, title: track?.title }, '[Music] Chapter probe skipped — no video id');
        return;
      }
      const probeStartedAt = Date.now();
      void (async () => {
        try {
          const chapters = await getVideoChapters(id);
          if (player.get<number>('chapterToken') !== chapterToken) return;
          if (chapters && chapters.length >= 2) {
            player.set('chapterSourceId', id);
            player.set('chapters', chapters);
            Logger.info(
              { guildId: player.guildId, chapters: chapters.length, probeMs: Date.now() - probeStartedAt },
              '[Music] Video chapters attached',
            );
            this.art.prefetchChapterArts(player, chapters, [0, 1, 2]);
            // Chapters landed after track start (the trackStart timer check
            // found nothing) — arm following now, or transitions never fire.
            this.host.armChapterTimer(player);
            // Publish the chapter card now instead of waiting for a boundary
            // timer — the card is ready the moment chapters land.
            this.host.scheduleImmediateProgress(player);
          }
          // null (transient probe failure) deliberately does NOT retry here:
          // both cache layers negative-cache misses for 10 minutes, so a
          // quick retry could never succeed — the next track re-probes.
        } catch {
          // CORRECT AS IS: a probe that threw is INCONCLUSIVE, not a
          // chapter-less video, and nothing is written to any cache here —
          // the negative layers inside getVideoChapters own that decision,
          // and neither provider leg caches when it throws. The card stays a
          // plain one; a later play of the same video re-probes.
        }
      })();
    } catch {
      // CORRECT AS IS: an empty/throw here happens BEFORE the probe is
      // awaited, so no chapter state has been written yet. The card is
      // simply a plain one for this track, which is what the listener saw
      // before the chapter system existed. Deliberately silent: this is a
      // fire-and-forget probe fired from trackStart, so a throw here has
      // no caller to report to, and the next track re-probes.
    }
  }

  /**
   * Display-ready chapter card for the current position. Advances with
   * playback; on a chapter change it stages the title immediately and
   * resolves that chapter's cover in the background (late-attach via the
   * fingerprint). A missed cover is retried at most every 30s while the
   * chapter plays (the first attempt often loses to a cold provider
   * cascade). Generic container titles (Intro/Outro/...) suppress the card
   * but still warm the first real song's cover so shows open on music art.
   */
  public chapterCardFor(player: Player, positionMs: number): ChapterCard | null {
    try {
      const chapters = player.get<VideoChapter[] | null>('chapters');
      if (!chapters || chapters.length < 2) return player.get<ChapterCard | null>('chapterCard') ?? null;
      // Exact boundaries: the legacy 3s startup offset made explicit seeks
      // land on the PREVIOUS chapter for the whole song.
      const idx = chapterIndexAt(chapters, Math.max(0, positionMs));
      const lastIdx = player.get<number>('chapterIdx') ?? -2;
      if (idx === lastIdx) {
        const stored = player.get<ChapterCard | null>('chapterCard') ?? null;
        // Generic chapters never display a card, so their art can never
        // attach — measured on Railway: a suppressed "08 DJ Intro" burned a
        // 2s cascade miss every 30s retry for nothing.
        if (!stored?.artworkUrl && idx >= 0 && !isGenericChapterTitle(chapters[idx]?.title)) {
          this.art.scheduleChapterArtRetry(player, idx, chapters);
        }
        return stored;
      }

      // REGRESSION GUARD. The forward-jump guard below handles clock drift, but
      // nothing handled the opposite: a stale position read (a `queue.position`
      // of 0 captured before a seek's REST landed) rewound the card straight
      // back to chapter 0 with no delay and no confirmation. Measured locally
      // 2026-09-27: a `.seek 21:58` correctly showed chapter 8 with resolved
      // art, then one second later the card reverted to chapter 0 — the exact
      // "chapter didn't change" symptom.
      //
      // A position that goes BACKWARDS, with no user seek to explain it, is
      // stale data — never a listener request. A genuine backward seek always
      // carries a recorded seek intent, so it still gets through.
      if (lastIdx >= 0 && idx < lastIdx) {
        const committedAt = player.get<number>('chapterCommittedPosMs');
        const seekedAt = player.get<number | null>('lastUserSeekAt') ?? null;
        const seekedPos = player.get<number | null>('lastUserSeekPos') ?? null;
        const explainedBySeek =
          seekedAt !== null &&
          seekedPos !== null &&
          Date.now() - seekedAt < USER_SEEK_INTENT_WINDOW_MS &&
          chapterIndexAt(chapters, Math.max(0, seekedPos)) === idx;
        const regression =
          typeof committedAt === 'number' && positionMs < committedAt - CHAPTER_REGRESSION_TOLERANCE_MS;
        if (regression && !explainedBySeek) {
          // DEBUG, not INFO: every publish tick during the node's post-seek
          // catch-up window legitimately reads stale, so this fires several
          // times per seek by design. Nudging a re-derive lets a genuinely
          // moved clock win as soon as the node catches up.
          Logger.debug(
            { guildId: player.guildId, from: lastIdx, to: idx, positionMs, committedAt },
            '[Music] Stale position read — refused chapter rewind',
          );
          this.host.scheduleImmediateProgress(player);
          return player.get<ChapterCard | null>('chapterCard') ?? null;
        }
      }

      // Multi-chapter forward jump with no seek behind it. A seek commits its
      // own index (swapChapterOnSeek), so reaching here means the POSITION is
      // suspect — a stale/future-dated node clock, or the wall-clock fallback
      // after a long stall. Committing it would skip every chapter in between
      // for good: armChapterTimer re-arms to chapters[idx+1], so the songs
      // being skipped are never revisited and the card sits on the wrong song
      // (and the wrong cover) until the next boundary. Hold the current
      // chapter for one settle window instead; if the clock still says so
      // afterwards, the jump was real (a long stall) and it is committed.
      if (lastIdx >= 0 && idx > lastIdx + 1) {
        // A jump the USER asked for is not a suspicious clock. `seek()` records
        // its intent on the player BEFORE awaiting the REST round-trip, so this
        // is the authoritative signal that the position is deliberate.
        //
        // Measured 2026-09-27 (local test): a deliberate `.seek 21:50` across
        // five chapters was logged as "Implausible chapter jump" twice and took
        // ~17s to commit, because swapChapterOnSeek had already early-returned
        // (moonlink reports the pre-seek position on playerTriggeredSeek) and
        // the position-derived path then treated the user's own seek as clock
        // drift. Honouring the recorded intent removes that stall entirely.
        const seekedAt = player.get<number | null>('lastUserSeekAt') ?? null;
        const seekedPos = player.get<number | null>('lastUserSeekPos') ?? null;
        const userInitiated =
          seekedAt !== null &&
          seekedPos !== null &&
          Date.now() - seekedAt < USER_SEEK_INTENT_WINDOW_MS &&
          chapterIndexAt(chapters, Math.max(0, seekedPos)) === idx;
        if (userInitiated) {
          player.set('chapterJumpPending', null);
          Logger.info(
            { guildId: player.guildId, from: lastIdx, to: idx },
            '[Music] Multi-chapter jump matches a user seek — committing immediately',
          );
        } else {
          const pending = player.get<{ idx: number; at: number } | null>('chapterJumpPending') ?? null;
          const sameJump = !!pending && pending.idx === idx;
          const confirmed = sameJump && Date.now() - pending.at > CHAPTER_JUMP_CONFIRM_MS;
          if (!confirmed) {
            if (!sameJump) {
              player.set('chapterJumpPending', { idx, at: Date.now() });
              Logger.info(
                { guildId: player.guildId, from: lastIdx, to: idx },
                '[Music] Implausible chapter jump — holding current chapter to confirm',
              );
              // Re-derive once the settle window closes: the next boundary timer
              // is armed from the (possibly wrong) jumped position, so it may
              // be minutes away. This is the only prompt re-check.
              this.host.scheduleImmediateProgress(player, CHAPTER_JUMP_CONFIRM_MS + 500);
            }
            return player.get<ChapterCard | null>('chapterCard') ?? null;
          }
          player.set('chapterJumpPending', null);
          Logger.info(
            { guildId: player.guildId, from: lastIdx, to: idx },
            '[Music] Chapter jump confirmed after settle — committing',
          );
        }
      }
      player.set('chapterJumpPending', null);
      player.set('chapterIdx', idx);
      player.set('chapterStartedAt', Date.now());
      player.set('chapterCommittedPosMs', positionMs);
      const ch = idx >= 0 ? chapters[idx] : undefined;
      if (!ch || isGenericChapterTitle(ch.title)) {
        const hadCard = player.get<ChapterCard | null>('chapterCard') ?? null;
        player.set('chapterCard', null);
        if (hadCard) {
          Logger.debug(
            { guildId: player.guildId, chapter: hadCard.title },
            '[Music] Chapter card cleared (generic/no chapter)',
          );
        }
        // Hype/intro chapters stay off the card, but the show should still
        // open on the first real song's cover: warm it cover-only (title
        // untouched) so the gallery never sits bare behind the intro.
        const upcomingIdx = chapters.findIndex((c, i) => i > idx && !isGenericChapterTitle(c.title));
        if (upcomingIdx >= 0) {
          const retry = player.get<{ idx: number; at: number } | null>('chapterArtRetry');
          if (!retry || retry.idx !== upcomingIdx || Date.now() - retry.at > CHAPTER_ART_RETRY_MS) {
            player.set('chapterArtRetry', { idx: upcomingIdx, at: Date.now() });
            void this.art.resolveChapterArt(player, upcomingIdx, chapters, true);
          }
        }
        return null;
      }
      const card: ChapterCard = { title: ch.title, artworkUrl: null };
      player.set('chapterCard', card);
      player.set('chapterArtRetry', { idx, at: Date.now() });
      void this.art.resolveChapterArt(player, idx, chapters);
      this.art.prefetchChapterArts(player, chapters, [idx + 1, idx + 2]);
      return card;
    } catch {
      // CORRECT AS IS: `null` here drops the chapter TITLE for this publish,
      // and that is the honest answer to "I could not derive a chapter" —
      // not a wrong one. Nothing is written to the player, so `chapterIdx`
      // and `chapterCard` survive and the next boundary re-derives from
      // them. Crucially the COVER is not blanked either: with a null chapter
      // resolveDisplayedChapter falls through to lastCoverUrl, so the
      // gallery still shows the previous art rather than raw track art.
      // Sync-only, and every caller wraps it, so it cannot reject playback.
      return null;
    }
  }

  /**
   * Seek = instant chapter swap. Natural chapter transitions are caught by
   * the chapter boundary timer; a user seek that crosses a boundary used to
   * wait for it and then pay a cold art cascade (~3-5s before the cover
   * sat). Fires for every Player.seek() — user seeks, stall re-seeks,
   * fallback resume — but only a chapter change does work; same-chapter
   * seeks no-op.
   *
   * Pins the optimistic clock FIRST: moonlink emits playerTriggeredSeek
   * synchronously and only updates current.position AFTER the seek REST
   * round-trip (~1s+ on slow nodes), never touching current.time. Without
   * the pin, the trailing nudge publish re-derives the PREVIOUS chapter
   * from the stale clock and flaps the card back (plus mistimed timers).
   * A failed seek self-corrects on the next node update within seconds.
   */
  public swapChapterOnSeek(player: Player, positionMs: number): void {
    try {
      // Pin the optimistic clock before anything reads it: this event fires
      // synchronously while current.position/time still hold the pre-seek
      // values (moonlink updates them only after the REST round-trip).
      const cur = player.current as unknown as { position?: unknown; time?: unknown } | null;
      if (cur) {
        cur.position = Math.max(0, positionMs);
        cur.time = Date.now();
      }
      const chapters = player.get<VideoChapter[] | null>('chapters');
      if (!chapters || chapters.length < 2) return;
      // Exact boundaries (see chapterCardFor): a seek to a chapter start
      // shows THAT chapter immediately.
      const idx = chapterIndexAt(chapters, Math.max(0, positionMs));
      if (idx === (player.get<number>('chapterIdx') ?? -2)) return;
      this.art.clearChapterArtRetryTimer(player.guildId);
      player.set('chapterArtRetry', null);
      player.set('chapterIdx', idx);
      player.set('chapterStartedAt', Date.now());
      player.set('chapterCommittedPosMs', positionMs);
      const ch = idx >= 0 ? chapters[idx] : undefined;
      if (!ch || isGenericChapterTitle(ch.title)) {
        player.set('chapterCard', null);
        // Seeking INTO a hype chapter dropped the gallery to the track art for
        // the whole intro (unlike the natural-transition path, which warms the
        // first real song's cover). Do the same warm here.
        const upcomingIdx = chapters.findIndex((c, i) => i > idx && !isGenericChapterTitle(c.title));
        if (upcomingIdx >= 0) {
          void this.art.resolveChapterArt(player, upcomingIdx, chapters, true);
        }
      } else {
        player.set('chapterCard', { title: ch.title, artworkUrl: null });
        player.set('chapterArtRetry', { idx, at: Date.now() });
        void this.art.resolveChapterArt(player, idx, chapters);
      }
      // Target ±1: backward seeks replay what a forward pass warmed;
      // forward seeks need idx+1/idx+2. idx itself warms the accent color
      // for the art swap about to resolve.
      this.art.prefetchChapterArts(
        player,
        chapters,
        [idx - 1, idx, idx + 1, idx + 2].filter((i) => i >= 0 && i < chapters.length),
      );
      this.host.scheduleImmediateProgress(player);
    } catch {
      // Chapter swap is decoration — never break the seek.
    }
  }
}
