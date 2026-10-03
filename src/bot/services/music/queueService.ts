import type { Player, Track } from 'moonlink.js';
import { USER_SEEK_INTENT_WINDOW_MS } from '@bot/services/music/musicConstants';
import type { LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { mapMoonlinkTrack, type MusicTrack } from '@domain/models/music/musicTrack';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import {
  GuildMusicSettingsRepository,
  DEFAULT_MUSIC_PREFS,
  type GuildMusicPrefs,
} from '@persistence/repositories/guildMusicSettingsRepository';
import { Logger } from '@domain/logging/logger';

export class QueueService {
  private readonly is247Guilds = new Set<string>();
  private readonly guildPrefs = new Map<string, GuildMusicPrefs>();
  /**
   * Live-lyrics opt-outs (in-memory only by design: a restart safely
   * restores the default ON, so no migration is ever needed for a display
   * nicety).
   */
  private readonly karaokeDisabled = new Set<string>();
  private readonly historyRepo: MusicHistoryRepository;
  private readonly settingsRepo?: GuildMusicSettingsRepository;

  constructor(historyRepo: MusicHistoryRepository, settingsRepo?: GuildMusicSettingsRepository) {
    this.historyRepo = historyRepo;
    this.settingsRepo = settingsRepo;
  }

  /** Load durable prefs into memory (once at boot). Hot paths stay synchronous. */
  public async loadPersistedState(): Promise<void> {
    if (!this.settingsRepo) return;
    try {
      const all = await this.settingsRepo.getAllSettings();
      for (const { guildId, ...prefs } of all) {
        this.guildPrefs.set(guildId, prefs);
        if (prefs.stay247) this.is247Guilds.add(guildId);
      }
      if (all.length > 0) {
        Logger.info(`Loaded persisted music settings for ${all.length} guilds`);
      }
    } catch {
      // memory defaults continue to work
    }
  }

  public is247(guildId: string): boolean {
    return this.is247Guilds.has(guildId);
  }

  public isKaraokeEnabled(guildId: string): boolean {
    return !this.karaokeDisabled.has(guildId);
  }

  public toggleKaraoke(guildId: string, enabled?: boolean): boolean {
    const next = enabled ?? !this.isKaraokeEnabled(guildId);
    if (next) this.karaokeDisabled.delete(guildId);
    else this.karaokeDisabled.add(guildId);
    return next;
  }

  public set247(guildId: string, enabled: boolean): void {
    if (enabled) {
      this.is247Guilds.add(guildId);
    } else {
      this.is247Guilds.delete(guildId);
    }
    this.saveSettings(guildId, { stay247: enabled });
  }

  public getSettings(guildId: string): GuildMusicPrefs {
    return this.guildPrefs.get(guildId) ?? { ...DEFAULT_MUSIC_PREFS };
  }

  public saveSettings(guildId: string, partial: Partial<GuildMusicPrefs>): void {
    const current = this.getSettings(guildId);
    this.guildPrefs.set(guildId, { ...current, ...partial });
    if (partial.stay247 !== undefined) {
      if (partial.stay247) this.is247Guilds.add(guildId);
      else this.is247Guilds.delete(guildId);
    }
    if (this.settingsRepo) {
      // CORRECT AS IS: the in-memory map was updated ABOVE and is what every
      // reader uses (getSettings / is247 / toggleKaraoke), so a failed write
      // costs durability across a restart, not correctness this session. The
      // value the caller was told is therefore still true, and the next
      // saveSettings for that guild re-persists the whole partial.
      void this.settingsRepo.saveSettings(guildId, partial).catch(() => undefined);
    }
  }

  /**
   * Live position for the card, lyrics and queue. First live leg wins:
   * 1. Fresh node clock — extrapolate from the last reported update (<60s,
   *    small negative skew tolerated and clamped to the base).
   * 2. Stalled/future-dated node clock while audibly playing — wall-clock
   *    from the last USER SEEK when there was one, else from track start.
   *    Update stalls used to freeze the card + lyrics at the last base
   *    forever (the classic "stuck at 0:04"); a moving approximation beats
   *    a dead card. Seeking from the seek target matters on long content:
   *    wall-clock-from-start ignores seeks and drags a 60-minute set back
   *    to its opening track. Clamped to duration so it never overruns.
   * 3. No clock at all (paused, missing) — the last reported base.
   */
  public calculatePosition(player: Player): number {
    if (!player.current) return 0;

    const rawTrack = player.current as unknown as { position?: number; time?: number };
    const basePos =
      typeof rawTrack.position === 'number' && rawTrack.position >= 0
        ? rawTrack.position
        : (player.lastPosition ?? 0);

    // A recent user seek is AUTHORITATIVE, even when the node's clock is
    // perfectly healthy.
    //
    // moonlink owns `current.position`/`current.time` and rewrites them from
    // the node, which keeps reporting the PRE-seek position for a few seconds
    // after a seek lands. Measured 2026-09-27: after `.seek 50:00` on a
    // 25-chapter set, this returned ~15s and climbed from there, so every
    // consumer of the position — the chapter derivation, the chapter boundary
    // timer, the card fingerprint — read a stale value and the card was one
    // rejected rewind away from snapping back to chapter 0.
    //
    // Only ever moves the position FORWARD: a seek backwards is handled by the
    // node's own clock once it catches up, and this must never fight it.
    const seekAt = typeof player.get === 'function' ? player.get<number>('lastUserSeekAt') : undefined;
    const seekPos = typeof player.get === 'function' ? player.get<number>('lastUserSeekPos') : undefined;
    if (
      typeof seekAt === 'number' &&
      seekAt > 0 &&
      typeof seekPos === 'number' &&
      seekPos >= 0 &&
      seekPos > basePos &&
      Date.now() - seekAt < USER_SEEK_INTENT_WINDOW_MS
    ) {
      const since = player.playing && !player.paused ? Math.max(0, Date.now() - seekAt) : 0;
      const total = player.current.duration || 0;
      const seeked = seekPos + since;
      return total > 0 ? Math.min(total, seeked) : seeked;
    }

    if (!player.playing || player.paused) {
      return basePos;
    }

    const totalDuration = player.current.duration || 0;
    const clamp = (pos: number): number => {
      if (!Number.isFinite(pos) || pos < 0) return basePos;
      return totalDuration > 0 ? Math.min(totalDuration, pos) : pos;
    };

    const trackStartedAt = typeof player.get === 'function' ? player.get<number>('trackStartedAt') : undefined;
    // A node clock older than the track start describes the PRE-track era
    // (voice-connect state, the previous song): adding wall time since it to
    // this track's base inflates the first seconds — measured 2026-10-03, a
    // 10s-old state time put a fresh track at ~10s and fired the first lyric
    // boundary a second early. Clamp the clock to the track start; the
    // wall-clock fallback below then measures from the event, not the
    // connection.
    let updateTime = rawTrack.time || trackStartedAt;
    if (
      typeof trackStartedAt === 'number' &&
      trackStartedAt > 0 &&
      typeof updateTime === 'number' &&
      updateTime < trackStartedAt
    ) {
      updateTime = trackStartedAt;
    }
    if (typeof updateTime === 'number' && updateTime > 0) {
      const elapsed = Date.now() - updateTime;
      // Small negative elapsed is node/bot clock skew (the Home node is a
      // residential PC), not a reason to discard the clock: freeze at the
      // reported base instead of throwing the whole clock away.
      if (elapsed >= -2000 && elapsed < 60000) {
        return clamp(basePos + Math.max(0, elapsed));
      }
    }

    // Node clock stale (or future-dated) — fall back to wall-clock from track
    // start instead of freezing at the last base, so the card and lyrics keep
    // moving. Wall-clock-from-start IGNORES seeks, which on a 60-minute set
    // teleports the position back to the top and lands the chapter system on
    // a song from the start of the show. When the user has seeked since the
    // track began, extrapolate from the seek target instead — same "keep
    // moving" guarantee, but seek-relative.
    const now = Date.now();
    if (
      typeof seekAt === 'number' &&
      seekAt > 0 &&
      typeof seekPos === 'number' &&
      seekPos >= 0 &&
      (typeof trackStartedAt !== 'number' || seekAt > trackStartedAt)
    ) {
      const since = now - seekAt;
      if (since >= -2000) return clamp(seekPos + Math.max(0, since));
    }
    if (typeof trackStartedAt === 'number' && trackStartedAt > 0) {
      const elapsed = now - trackStartedAt;
      if (elapsed >= 0) return clamp(elapsed);
    }

    return basePos;
  }

  public getQueueInfo(player: Player): MusicQueueInfo {
    const rawTracks: Track[] = player.queue.all;
    const tracks: MusicTrack[] = rawTracks.map((t) => mapMoonlinkTrack(t));
    const currentTrack = player.current ? mapMoonlinkTrack(player.current) : null;

    const currentPosition = this.calculatePosition(player);

    const remainingDuration =
      (player.current ? Math.max(0, (player.current.duration || 0) - currentPosition) : 0) +
      player.queue.duration;

    const totalDuration =
      (player.current ? player.current.duration || 0 : 0) + player.queue.duration;

    const activeFilters = player.filters?.enabled || [];

    let loopMode: LoopMode = 'off';
    if (player.loop === 'track') loopMode = 'track';
    else if (player.loop === 'queue') loopMode = 'queue';

    return {
      guildId: player.guildId,
      current: currentTrack,
      tracks,
      totalTracks: tracks.length + (currentTrack ? 1 : 0),
      totalDuration,
      remainingDuration,
      loopMode,
      volume: player.volume ?? 100,
      isPaused: Boolean(player.paused),
      isPlaying: Boolean(player.playing),
      is247: this.is247(player.guildId),
      autoplay: Boolean(player.autoPlay),
      activeFilters,
      voiceChannelId: player.voiceChannelId,
      textChannelId: player.textChannelId,
      position: currentPosition,
      ping: player.ping || 0,
    };
  }

  public recordTrackStart(guildId: string, track: Track): void {
    const domainTrack = mapMoonlinkTrack(track);
    this.historyRepo.addHistory(guildId, domainTrack);
  }

  public getHistory(guildId: string, limit: number = 10) {
    return this.historyRepo.getHistory(guildId, limit);
  }
}
