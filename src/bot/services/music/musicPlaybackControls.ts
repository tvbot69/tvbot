import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logger';
import type { FilterName, LoopMode } from '@domain/models/music/musicQueue';
import { SEEK_REST_TIMEOUT_MS } from './musicConstants';
import { EQ_EXCLUSIVE_GROUP } from './musicPlayerRegistry';
import type { PlayerRegistry } from './musicPlayerRegistry';
import type { QueueService } from './queueService';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';

/**
 * Transport controls: pause, resume, seek, previous, replay, volume, filters,
 * loop, autoplay, 24/7 and karaoke — plus the single playback-control policy
 * every surface shares.
 *
 * Extracted from MusicService. It owns exactly one field (the karaoke card
 * notifier); the merged visible queue it needs for the control policy arrives
 * as a callback, so it never has to import the playback service back.
 */
export class MusicPlaybackControls {
  /** Wired at startup — refreshes the event-driven card on karaoke toggle. */
  private karaokeToggleNotifier: ((guildId: string) => void) | null = null;

  public constructor(
    private readonly registry: PlayerRegistry,
    private readonly queueService: QueueService,
    /** The merged visible queue (resolved + pending) — the policy's only input. */
    private readonly getQueueInfo: (guildId: string) => MusicQueueInfo | null,
  ) {}

  private getPlayer(guildId: string): Player | undefined {
    return this.registry.getPlayer(guildId);
  }

  public async pause(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    if (player.paused) return true;
    if (player.current) {
      const currentPos = this.queueService.calculatePosition(player);
      player.current.position = currentPos;
      player.current.time = Date.now();
    }
    try {
      await player.pause();
    } catch (err) {
      Logger.warn({ err, guildId }, '[Music] Pause failed');
      return false;
    }
    return true;
  }

  public async resume(guildId: string): Promise<boolean> {
    const player = this.getPlayer(guildId);
    if (!player) return false;
    if (player.current) {
      player.current.time = Date.now();
    }
    try {
      await player.resume();
    } catch (err) {
      Logger.warn({ err, guildId }, '[Music] Resume failed');
      return false;
    }
    return true;
  }

  /**
   * Seeks to `seconds`. Returns the position actually applied (ms) so callers
   * can report the truth — a clamped seek used to answer "Jumped to 99999
   * seconds" after jumping to the end — or null when the seek was refused
   * (no player, no track, a live stream, or unknown duration).
   *
   * The seek event fires synchronously inside player.seek (chapter swap runs
   * instantly); the REST round-trip on slow nodes can take seconds, so it
   * races a timeout instead of hanging the command. Intent markers are
   * recorded BEFORE awaiting, so stall grace observes the seek even if REST
   * hangs. A timed-out REST still applies late server-side (or the stuck
   * detector recovers) — true either way, since the event already fired and
   * recovery is event-driven.
   */
  public async seek(guildId: string, seconds: number, restTimeoutMs = SEEK_REST_TIMEOUT_MS): Promise<number | null> {
    const player = this.getPlayer(guildId);
    if (!player || !player.current) return null;
    // A stream has no duration, so the old clamp (min against duration || 0)
    // silently turned EVERY seek on a live stream into a jump to 0 while
    // still reporting success. Refuse what cannot be honoured.
    if (player.current.isStream) return null;
    const duration = player.current.duration || 0;
    if (duration <= 0) return null;
    const ms = Math.max(0, Math.min(seconds * 1000, duration));
    // Identity of the track we are seeking, re-checked after the await below.
    const trackIdentifier = (player.current as unknown as { identifier?: string }).identifier ?? '';
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
      // Only if the SAME track is still current: a REST that stalls past the
      // track's end would otherwise stamp this position onto the next song.
      const cur = player.current as unknown as { identifier?: string; position?: number; time?: number };
      if (cur.identifier === trackIdentifier) {
        cur.position = ms;
        cur.time = Date.now();
      }
    }
    return ms;
  }

  /**
   * Playback control policy, shared by every surface (slash, text, buttons,
   * menus) so they cannot disagree: the person who queued the current track
   * controls it, and server admins can always recover the bot. Tracks with no
   * requester (autoplay, 24/7, a restored session) stay open — otherwise
   * nobody could stop them.
   *
   * This exists because the BUTTONS enforced requester-only while NO command
   * did: any member could `/music stop`, `clear`, `volume 0` or `skipto` and
   * hijack a session they had nothing to do with.
   */
  public canControlPlayback(guildId: string, userId: string, isAdmin = false): boolean {
    if (isAdmin) return true;
    try {
      const requesterId = this.getQueueInfo(guildId)?.current?.requester?.id;
      return !requesterId || requesterId === userId;
    } catch {
      // Never lock the owner out of their own bot because a read failed.
      return true;
    }
  }

  public setVolume(guildId: string, volume: number): number | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const clamped = Math.max(0, Math.min(150, Math.round(volume)));
    player.setVolume(clamped);
    this.queueService.saveSettings(guildId, { volume: clamped });
    return clamped;
  }

  public adjustVolume(guildId: string, delta: number): number | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const current = player.volume ?? 100;
    const clamped = Math.max(0, Math.min(150, current + delta));
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
      this.registry.ensureFilterDefined(player, filter);
      if (EQ_EXCLUSIVE_GROUP.includes(filter)) {
        for (const other of EQ_EXCLUSIVE_GROUP) {
          if (other !== filter && player.filters.enabled.includes(other)) {
            try {
              player.filters.disable(other);
              replaced.push(other);
            } catch {
              // CORRECT AS IS: a disable that throws leaves the other EQ
              // preset on, so the audible cost is the concatenated-EQ mud
              // documented on EQ_EXCLUSIVE_GROUP — never a wrong number on the
              // card: `replaced` only lists what really was switched off, and
              // the apply() below still decides the result the user is told.
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
    try {
      // Unguarded, a dead-node REST rejection here became an UNHANDLED
      // rejection — fatal to the process on Node's default policy, from a
      // command as ordinary as "clear the filters".
      await player.filters.apply();
    } catch (err) {
      Logger.warn({ err, guildId }, '[Music] Clear filters: apply failed');
      return false;
    }
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

  public setLoop(guildId: string, mode: LoopMode): LoopMode | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    player.setLoop(mode);
    this.queueService.saveSettings(guildId, { loopMode: mode });
    return mode;
  }

  public cycleLoop(guildId: string): LoopMode | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const current = (player.loop ?? 'off') as LoopMode;
    const next: LoopMode = current === 'off' ? 'track' : current === 'track' ? 'queue' : 'off';
    player.setLoop(next);
    this.queueService.saveSettings(guildId, { loopMode: next });
    return next;
  }

  public toggleAutoplay(guildId: string, enabled?: boolean): boolean | null {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const nextState = enabled !== undefined ? enabled : !player.autoPlay;
    player.setAutoPlay(nextState);
    this.queueService.saveSettings(guildId, { autoplay: nextState });
    return nextState;
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
    if (await player.skip()) return true;
    // skip() resolved false (voice not ready): the old code had already lost
    // the history entry AND left the track duplicated in the queue, then told
    // the user "No previous track in history". Put both back.
    try {
      const at = player.queue.all.indexOf(prevTrack);
      if (at !== -1) player.queue.remove(at);
      player.previous.push(prevTrack);
    } catch {
      // Best effort restore: indexOf/remove/push on a live queue are not
      // expected to throw, and if one did the previous() call still returns
      // false — the same honest "could not go back" answer the pre-restore
      // code gave, never a claim that the history was changed.
    }
    return false;
  }

  public async replay(guildId: string): Promise<boolean> {
    const seeked = await this.seek(guildId, 0);
    if (seeked === null) return false;
    const player = this.getPlayer(guildId);
    if (player?.current) {
      player.current.position = 0;
      player.current.time = Date.now();
    }
    return true;
  }
}
