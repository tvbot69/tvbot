import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import {
  lyricWindowAt,
  lyricClockFor,
  measureLyricLead,
  nextLyricBoundary,
  LYRIC_SAFETY_LAG_MS,
  LYRIC_LEAD_WINDOW_MS,
  LYRIC_LEAD_STABLE_TOLERANCE_MS,
  LYRIC_STARTUP_RECHECK_MS,
  LYRIC_MONOTONIC_TOLERANCE_MS,
  type SyncedLine,
  type LyricWindow,
} from '@bot/services/music/syncedLyrics';
import { KARAOKE_TIMER_MIN_MS, USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { QueueService } from '@bot/services/music/queueService';

/**
 * Karaoke: the lyric window for the card, the one-per-track synced-line
 * lookup, and the boundary timer that republishes on each line.
 *
 * Extracted from MusicHandler. The timer Map is passed in BY REFERENCE and
 * stays owned by the handler, because the test suite reads
 * `handler.karaokeTimers` directly and `clearCardTimers`/`forgetGuild` sweep
 * it — a copy would silently break both.
 */
export interface KaraokeHost {
  /** Read live, never captured: tests reassign this after construction. */
  readonly lyricsService?: LyricsService;
  readonly queueService: QueueService;
  /** Must route through the host so `vi.spyOn(handler, 'publishProgress')` fires. */
  publishProgress(player: Player): Promise<void>;
  /** Must route through the host so own-property shadows still take effect. */
  armKaraokeTimer(player: Player): void;
}

/** What the lead measurement currently believes. `frozen` means settled. */
export interface LyricLeadState {
  /** Measured (or proven-absent) startup lead in ms. */
  leadMs: number;
  /** True once the lead stopped moving, or the window closed. */
  frozen: boolean;
  /** Wall time since trackStart, or -1 when unknown. */
  elapsedMs: number;
}

export class KaraokeController {
  public constructor(
    private readonly host: KaraokeHost,
    private readonly karaokeTimers: Map<string, NodeJS.Timeout>,
  ) {}

  /** Player state keys. Read through the live object; tests may shadow them. */
  private static readonly LEAD_KEY = 'lyricLeadMs';
  private static readonly LEAD_FROZEN_KEY = 'lyricLeadFrozen';
  private static readonly LEAD_CANDIDATE_KEY = 'lyricLeadCandidateMs';
  private static readonly LEAD_STABLE_RUNS_KEY = 'lyricLeadStableRuns';
  

  private readPlayer<T>(player: Player, key: string): T | undefined {
    if (typeof player.get !== 'function') return undefined;
    try {
      return player.get<T>(key);
    } catch (err) {
      // A player whose get throws has no memo; the caller uses its fallback.
      Logger.debug({ err, key }, '[Music] Lyric player state read failed');
      return undefined;
    }
  }

  private writePlayer(player: Player, key: string, value: unknown): void {
    if (typeof player.set !== 'function') return;
    try {
      player.set(key, value);
    } catch (err) {
      // Memo writes are decoration; the clock is recomputed next read.
      Logger.debug({ err, key }, '[Music] Lyric player state write failed');
    }
  }

  /**
   * The startup lead: how far ahead of audible audio this node's reported
   * position runs. Measured from the only two clocks the bot has — the node
   * position and wall time since trackStart — because the value is per track
   * and per node (8680ms and 11606ms on two tracks of the same session).
   *
   * Rules, each of which exists because the opposite shipped a bug:
   * - Running MAX: the candidate rises as the node true-ups its clock. An
   *   under-read shows a line LATE; an over-read shows it EARLY, so it may
   *   never be lowered once seen.
   * - FREEZE ON STABILITY, not on a wait: the lead is settled once the
   *   candidate repeats within tolerance. Until then the caller shows no
   *   singing line at all, because during that transient the node position
   *   is known to lag truth and any derived clock can be early.
   * - Window bound and seek guard: a seek moves the position base without
   *   moving wall time, so measuring across one would swallow the seek
   *   target. Measurements also stop at LYRIC_LEAD_WINDOW_MS.
   */
  private measureLead(player: Player, positionMs: number): LyricLeadState {
    const previous = this.readPlayer<number>(player, KaraokeController.LEAD_KEY);
    const leadMs = typeof previous === 'number' && Number.isFinite(previous) ? Math.max(0, previous) : 0;
    const frozen = this.readPlayer<boolean>(player, KaraokeController.LEAD_FROZEN_KEY) === true;
    const startedAt = this.readPlayer<number>(player, 'trackStartedAt');
    const elapsedMs = typeof startedAt === 'number' && startedAt > 0 ? Date.now() - startedAt : -1;
    const seekAt = this.readPlayer<number>(player, 'lastUserSeekAt');
    const recentSeek =
      typeof seekAt === 'number' && seekAt > 0 && Date.now() - seekAt < USER_SEEK_INTENT_WINDOW_MS;
    if (frozen || elapsedMs < 0 || recentSeek) {
      return { leadMs, frozen: true, elapsedMs };
    }
    // Past the measurement window the lead is settled by definition. It MUST
    // be persisted: an earlier version returned `frozen: true` here without
    // writing the flag, so the runtime believed the clock was proven while
    // the stored state (and the boundary diagnostic that reads it) still said
    // otherwise — two consumers disagreeing about the same fact.
    if (elapsedMs > LYRIC_LEAD_WINDOW_MS) {
      this.writePlayer(player, KaraokeController.LEAD_FROZEN_KEY, true);
      return { leadMs, frozen: true, elapsedMs };
    }

    const candidate = measureLyricLead(positionMs, elapsedMs, leadMs);
    // Stability is judged against the PREVIOUS SAMPLE, not against the value
    // this read just wrote. An earlier version stored the same value in both
    // slots, so every second read compared a number with itself, called it
    // stable and froze the lead — measured 2026-10-10: it froze at 3820ms while
    // `nodeLead` (pos - elapsed) was 11713ms and still climbing, and every
    // lyric after that was ~7.9s out.
    const lastCandidate = this.readPlayer<number>(player, KaraokeController.LEAD_CANDIDATE_KEY);
    const stableRead =
      typeof lastCandidate === 'number' && Number.isFinite(lastCandidate)
        ? Math.abs(candidate - lastCandidate) <= LYRIC_LEAD_STABLE_TOLERANCE_MS
        : false;
    const stableRuns = stableRead ? (this.readPlayer<number>(player, KaraokeController.LEAD_STABLE_RUNS_KEY) ?? 0) + 1 : 0;
    // Three consecutive agreeing samples, not two: a single quiet read while
    // the node is still buffering is exactly what a wrong freeze looks like.
    const settled = stableRuns >= 3 && candidate > 0;
    const nowFrozen = settled || elapsedMs >= LYRIC_LEAD_WINDOW_MS;
    this.writePlayer(player, KaraokeController.LEAD_KEY, candidate);
    this.writePlayer(player, KaraokeController.LEAD_CANDIDATE_KEY, candidate);
    this.writePlayer(player, KaraokeController.LEAD_STABLE_RUNS_KEY, stableRuns);
    this.writePlayer(player, KaraokeController.LEAD_FROZEN_KEY, nowFrozen);
    return { leadMs: candidate, frozen: nowFrozen, elapsedMs };
  }

  /**
   * The single lyric clock. Card display and boundary timer both read it,
   * so they can never disagree about which line is singing.
   *
   * The clock is WALL TIME since the track started, anchored on the node
   * position only to survive seeks. Measured 2026-10-10 on "Young"
   * (VACATIONS) across 20 boundaries: `nodeLead` (pos - elapsed) sat at
   * 11684..11713ms for the whole track — a constant, not a drift. So
   * audible position IS wall time, and the node position is a fixed ~11.7s
   * ahead of it on this node. Deriving the clock as `pos - measuredLead`
   * reproduces that only if the lead is measured right, and the lead is a
   * lagging estimate; deriving it as `elapsed` uses the exact quantity.
   *
   * After a user seek (or a resume) wall time since track start is no longer
   * the audio clock, so the node position minus the last measured lead is
   * used instead — the only case where an estimate is better than nothing.
   */
  public lyricClockFor(
    player: Player,
    positionMs: number,
    safetyLagMs: number = LYRIC_SAFETY_LAG_MS,
  ): { clock: number; lead: LyricLeadState } {
    const pos = Math.max(0, positionMs);
    const lead = this.measureLead(player, pos);
    const seekAt = this.readPlayer<number>(player, 'lastUserSeekAt');
    const seeked =
      typeof seekAt === 'number' && seekAt > 0 && Date.now() - seekAt < USER_SEEK_INTENT_WINDOW_MS;
    const startedAt = this.readPlayer<number>(player, 'trackStartedAt');
    const elapsedMs = typeof startedAt === 'number' && startedAt > 0 ? Date.now() - startedAt : -1;
    // Either branch yields the AUDIBLE position. The edit lag is applied once,
    // below — `lyricClockFor` already subtracts the lag it is given, so
    // passing one here would double-count it.
    const audibleMs = !seeked && elapsedMs >= 0 ? elapsedMs : lyricClockFor(pos, lead.leadMs, 0);
    return { clock: Math.max(0, audibleMs - Math.max(0, safetyLagMs)), lead };
  }

  

  /**
   * Lyric window for a position, or null when lyrics are off, unsynced or
   * nothing singable (card renders unchanged).
   *
   * Full sync contract, in order:
   * 1. Single position authority: callers pass `calculatePosition` output;
   *    this never reads the node clock itself.
   * 2. Startup lead + safety lag: the clock runs behind the node by the
   *    measured lead and a fixed beat, so a line is never shown before it is
   *    heard (lag covers timer slack, edit round-trip, voice jitter). Lines
   *    are pre-aligned per track by `alignSyncedLines`; the lead and lag are
   *    the never-early guarantee on top.
   * 3. Monotonic hold: a position that moves BACKWARDS past tolerance with
   *    no recorded seek intent is stale node data, not a rewind — the last
   *    window holds. A genuine backward seek always carries
   *    lastUserSeekAt/lastUserSeekPos, recorded by seek() before it awaits
   *    the node. Survives year-long pauses: frozen clocks hold, resumed
   *    clocks move forward, stale wall-clock fallbacks cannot rewind the
   *    lyrics to the intro.
   */
  public lyricWindowFor(
    player: Player,
    positionMs: number,
    safetyLagMs: number = LYRIC_SAFETY_LAG_MS,
  ): LyricWindow | null {
    try {
      if (!this.host.lyricsService) return null;
      if (!this.host.queueService.isKaraokeEnabled(player.guildId)) return null;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return null;
      // One clock for the window lookup: lead-measured, then lagged.
      const { clock, lead } = this.lyricClockFor(player, positionMs, safetyLagMs);
      if (!lead.frozen) {
        // The startup lead is still being proven. Any clock derived from a
        // node position that has not true-upped yet can be early, so the
        // card claims nothing is singing and only offers the first upcoming
        // line. Late by a moment beats early by a groove.
        const first = nextLyricBoundary(lines, 0);
        if (!first) return null;
        return { current: null, next: first.text.length > 0 ? first.text : null };
      }
      const effective = clock;
      const fresh = lyricWindowAt(lines, effective);
      if (!fresh) return null;
      // Monotonic hold: refuse stale rewinds, allow deliberate seeks.
      try {
        const get = typeof player.get === 'function' ? player.get.bind(player) : null;
        const set = typeof player.set === 'function' ? player.set.bind(player) : null;
        if (get && set) {
          const lastEffective = get<number>('lyricLastEffective');
          const lastWindow = get<LyricWindow | null>('lyricLastWindow');
          const seekAt = get<number>('lastUserSeekAt');
          const hasRecentSeek =
            typeof seekAt === 'number' && seekAt > 0 && Date.now() - seekAt < USER_SEEK_INTENT_WINDOW_MS;
          if (
            typeof lastEffective === 'number' &&
            Number.isFinite(lastEffective) &&
            lastWindow !== undefined &&
            lastWindow !== null &&
            effective < lastEffective - LYRIC_MONOTONIC_TOLERANCE_MS &&
            !hasRecentSeek
          ) {
            return lastWindow;
          }
          set('lyricLastEffective', effective);
          set('lyricLastWindow', fresh);
        }
      } catch (err) {
        // Monotonic memo is decoration; the fresh window is still correct.
        Logger.debug({ err, guildId: player.guildId }, '[Music] Lyric monotonic memo write failed');
      }
      return fresh;
    } catch {
      // CORRECT AS IS: "no lyric window" is exactly the pre-karaoke card,
      // so the fingerprint carries 'none' and no edit is spent proving it.
      // Nothing is cleared: `karaokeLines` survives on the player and the
      // next line boundary re-derives the window. Purely a read of player
      // state, so a throw cannot reject into the publish path.
      return null;
    }
  }

  /**
   * Resolves synced lines once per track start (bounded, never stalls the
   * card) and stores them on the player for the karaoke boundary timer.
   */
  public async resolveKaraokeLines(
    player: Player,
    title: string,
    artist: string,
    durationMs: number,
  ): Promise<void> {
    player.set('karaokeLines', null);
    try {
      player.set('lyricLastEffective', null);
      player.set('lyricLastWindow', null);
      player.set('lyricResolvedAt', null);
      // The startup lead is per-track state: a new song starts measuring again.
      player.set(KaraokeController.LEAD_KEY, null);
      player.set(KaraokeController.LEAD_FROZEN_KEY, null);
    } catch (err) {
      // Memo reset is decoration; resolution continues.
      Logger.debug({ err, guildId: player.guildId }, '[Music] Lyric memo reset failed');
    }
    const svc = this.host.lyricsService;
    if (!svc) return;
    if (!this.host.queueService.isKaraokeEnabled(player.guildId)) return;
    if (!title || !artist) return;
    try {
      const lines = await Promise.race([
        // CORRECT AS IS: a rejected provider is one leg of the 6s race
        // timing out as far as the card is concerned. `karaokeLines` stays
        // null (set on entry), which IS the "off" state the publisher
        // already renders, so a failure is indistinguishable from a song
        // with no synced lyrics and is never reported as a broken feature.
        svc.getSyncedLyrics(title, artist, durationMs).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (lines && lines.length > 0) {
        player.set('karaokeLines', lines);
        try {
          player.set('lyricResolvedAt', Date.now());
        } catch (err) {
          // Observability only.
          Logger.debug({ err, guildId: player.guildId }, '[Music] Lyric resolve stamp failed');
        }
      }
    } catch (err) {
      // No synced lyrics — standard card without the section.
      Logger.debug({ err, guildId: player.guildId }, '[Music] Karaoke line resolve failed');
    }
  }

  public clearKaraokeTimer(guildId: string): void {
    const timer = this.karaokeTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.karaokeTimers.delete(guildId);
    }
  }

  /**
   * Arms a one-shot to the next lyric-line boundary. Fires -> publish (the
   * fingerprint admits the edit only when the window actually changed) ->
   * re-arm. Paused/frozen clocks get a cheap 15s recheck instead of a hot
   * loop; the silence between lines costs zero edits and zero work.
   *
   * Timer and display share ONE clock (`lyricClockFor`): node position minus
   * the measured startup lead minus the safety lag, clamped by wall time while
   * the lead is still being measured. The timer arms to `next.ms - clock` and
   * the window derives from the same clock, so the two can never disagree
   * about which line is next. Arming on the raw position while displaying a
   * lagged one fired a full lead early — the 2026-10-10 "lyrics 11.6s early"
   * incident.
   *
   * Both callbacks go through the HOST, not through this object. A sibling
   * call would leave the handler's own methods un-spied, and a frozen card
   * fails silently rather than loudly.
   */
  public armKaraokeTimer(player: Player, safetyLagMs: number = LYRIC_SAFETY_LAG_MS): void {
    this.clearKaraokeTimer(player.guildId);
    try {
      if (!this.host.lyricsService) return;
      if (!this.host.queueService.isKaraokeEnabled(player.guildId)) return;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return;
      const positionMs = Math.max(0, this.host.queueService.calculatePosition(player));
      const { clock, lead } = this.lyricClockFor(player, positionMs, safetyLagMs);
      let delay: number;
      let next: SyncedLine | null;
      if (!lead.frozen) {
        // Lead not proven yet: re-measure on a short recheck rather than
        // arming to a boundary computed from a position that is known to be
        // behind truth. No line is claimed while this is true.
        next = null;
        delay = LYRIC_STARTUP_RECHECK_MS;
      } else {
        next = nextLyricBoundary(lines, clock);
        if (!next) return;
        delay = next.ms - clock;
        // Paused clocks are frozen: recheck cheaply instead of hot-looping.
        // An overshoot (delay < 0, the clock moved past the boundary while the
        // lines resolved) is the opposite — the new line is ALREADY singing,
        // so publish on the floor instead of parking it for 15s.
        if (player.paused) delay = 15000;
        else if (delay < 0) delay = KARAOKE_TIMER_MIN_MS;
      }
      const timer = setTimeout(() => {
        this.karaokeTimers.delete(player.guildId);
        try {
          // Boundary diagnostic. `clockAheadBy` is the audibility question:
          // how far the lyric clock sits past the boundary it fires for, so a
          // steady positive value is exactly the "lyrics early" symptom.
          // `elapsed`/`nodeLead`/`lead` keep the wall-clock triangulation for
          // year-gap, stale-clock and lead-measurement cases.
          const atFire = Math.max(0, this.host.queueService.calculatePosition(player));
          const at = this.lyricClockFor(player, atFire, safetyLagMs);
          const startedAt = typeof player.get === 'function' ? player.get<number>('trackStartedAt') : undefined;
          const elapsed = typeof startedAt === 'number' && startedAt > 0 ? Date.now() - startedAt : -1;
          const title =
            typeof player.current === 'object' && player.current !== null
              ? String((player.current as { title?: unknown }).title ?? '').slice(0, 60)
              : '';
          Logger.debug(
            `[Music] Karaoke boundary { track: '${title}', pos: ${atFire}, clock: ${at.clock}, lead: ${at.lead.leadMs}, leadFrozen: ${at.lead.frozen}, lineMs: ${next?.ms ?? 'n/a'}, clockAheadBy: ${next ? at.clock - next.ms : 'n/a'}, elapsed: ${elapsed}, nodeLead: ${elapsed >= 0 ? atFire - elapsed : 'n/a'} }`,
          );
          void this.host.publishProgress(player);
        } catch {
          // Timer errors must never break the chain below.
        }
        // Re-armed OUTSIDE the try on purpose: if publishing throws, the
        // chain to the next lyric line must survive, or the card freezes on
        // one line for the rest of the track.
        this.host.armKaraokeTimer(player);
      }, Math.max(delay, KARAOKE_TIMER_MIN_MS));
      timer.unref?.();
      this.karaokeTimers.set(player.guildId, timer);
    } catch {
      // Karaoke is decoration — never break playback.
    }
  }
}
