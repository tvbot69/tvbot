import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import {
  lyricWindowAt,
  lyricEffectiveAt,
  nextLyricBoundary,
  LYRIC_SAFETY_LAG_MS,
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

export class KaraokeController {
  public constructor(
    private readonly host: KaraokeHost,
    private readonly karaokeTimers: Map<string, NodeJS.Timeout>,
  ) {}

  /**
   * Lyric window for a position, or null when lyrics are off, unsynced or
   * nothing singable (card renders unchanged).
   *
   * Full sync contract, in order:
   * 1. Single position authority: callers pass `calculatePosition` output;
   *    this never reads the node clock itself.
   * 2. Safety lag: the lookup runs behind the clock by LYRIC_SAFETY_LAG_MS
   *    so a line is never shown before it is heard (timer slack, edit
   *    round-trip, voice jitter). Lines are pre-aligned per track by
   *    `alignSyncedLines`; this lag is the never-early guarantee on top.
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
      const pos = Math.max(0, positionMs);
      const effective = lyricEffectiveAt(pos, safetyLagMs);
      const fresh = lyricWindowAt(lines, pos, safetyLagMs);
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
   * Timer and display share one effective position
   * (`effective = position - SAFETY_LAG`): the timer arms to
   * `next.ms - effective` and the window derives from the same effective,
   * so the two can never disagree about which line is next. Arming on the
   * raw clock while displaying lagged fired a full lag early.
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
      const position = this.host.queueService.calculatePosition(player);
      const effective = lyricEffectiveAt(Math.max(0, position), safetyLagMs);
      const next = nextLyricBoundary(lines, effective);
      if (!next) return;
      let delay = next.ms - effective;
      // Paused clocks are frozen: recheck cheaply instead of hot-looping.
      // An overshoot (delay < 0, the clock moved past the boundary while the
      // lines resolved) is the opposite — the new line is ALREADY singing,
      // so publish on the floor instead of parking it for 15s.
      if (player.paused) delay = 15000;
      else if (delay < 0) delay = KARAOKE_TIMER_MIN_MS;
      const timer = setTimeout(() => {
        this.karaokeTimers.delete(player.guildId);
        try {
          // Boundary diagnostic. `effectiveAheadBy` separates a node-side
          // lead from a bad LRC clock: effective is what the card shows, so
          // a steady positive lead here is exactly the "lyrics early"
          // symptom. `elapsed`/`nodeLead` keep the wall-clock triangulation
          // for year-gap and stale-clock cases.
          const atFire = this.host.queueService.calculatePosition(player);
          const atEffective = lyricEffectiveAt(Math.max(0, atFire), safetyLagMs);
          const startedAt = typeof player.get === 'function' ? player.get<number>('trackStartedAt') : undefined;
          const elapsed = typeof startedAt === 'number' && startedAt > 0 ? Date.now() - startedAt : -1;
          const title =
            typeof player.current === 'object' && player.current !== null
              ? String((player.current as { title?: unknown }).title ?? '').slice(0, 60)
              : '';
          Logger.debug(
            `[Music] Karaoke boundary { track: '${title}', pos: ${atFire}, effective: ${atEffective}, lineMs: ${next.ms}, effectiveAheadBy: ${atEffective - next.ms}, elapsed: ${elapsed}, nodeLead: ${elapsed >= 0 ? atFire - elapsed : 'n/a'} }`,
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
