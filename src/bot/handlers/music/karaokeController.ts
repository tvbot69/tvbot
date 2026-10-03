import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import { lyricWindowAt, type SyncedLine, type LyricWindow } from '@bot/services/music/syncedLyrics';
import { KARAOKE_TIMER_MIN_MS, LYRIC_STARTUP_OFFSET_MS } from '@bot/services/music/musicConstants';
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
   * nothing singable (card renders unchanged). The startup offset runs the
   * lookup behind the clock by the measured track-start audibility gap
   * (trackStart event vs first audible frame); 0 until measured.
   */
  public lyricWindowFor(
    player: Player,
    positionMs: number,
    startupOffsetMs: number = LYRIC_STARTUP_OFFSET_MS,
  ): LyricWindow | null {
    try {
      if (!this.host.lyricsService) return null;
      if (!this.host.queueService.isKaraokeEnabled(player.guildId)) return null;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return null;
      return lyricWindowAt(lines, Math.max(0, positionMs), startupOffsetMs);
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
      if (lines && lines.length > 0) player.set('karaokeLines', lines);
    } catch {
      // No synced lyrics — standard card without the section.
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
   * Both callbacks go through the HOST, not through this object. A sibling
   * call would leave the handler's own methods un-spied, and a frozen card
   * fails silently rather than loudly.
   */
  public armKaraokeTimer(player: Player): void {
    this.clearKaraokeTimer(player.guildId);
    try {
      if (!this.host.lyricsService) return;
      if (!this.host.queueService.isKaraokeEnabled(player.guildId)) return;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return;
      const position = this.host.queueService.calculatePosition(player);
      const next = lines.find((l) => l.ms > position);
      if (!next) return;
      let delay = next.ms - position;
      // Paused clocks are frozen: recheck cheaply instead of hot-looping.
      // An overshoot (delay < 0, the clock moved past the boundary while the
      // lines resolved) is the opposite — the new line is ALREADY singing,
      // so publish on the floor instead of parking it for 15s.
      if (player.paused) delay = 15000;
      else if (delay < 0) delay = KARAOKE_TIMER_MIN_MS;
      const timer = setTimeout(() => {
        this.karaokeTimers.delete(player.guildId);
        try {
          // Boundary diagnostic: clock position vs the line about to show.
          // Pair with what you HEAR to measure the real offset — the log
          // alone only proves internal consistency, not audibility.
          const atFire = this.host.queueService.calculatePosition(player);
          const title =
            typeof player.current === 'object' && player.current !== null
              ? String((player.current as { title?: unknown }).title ?? '').slice(0, 60)
              : '';
          Logger.debug(
            `[Music] Karaoke boundary { track: '${title}', pos: ${atFire}, lineMs: ${next.ms}, clockAheadBy: ${atFire - next.ms} }`,
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
