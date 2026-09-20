import type { Player, Track } from 'moonlink.js';
import type { LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { mapMoonlinkTrack, type MusicTrack } from '@domain/models/music/musicTrack';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import {
  GuildMusicSettingsRepository,
  DEFAULT_MUSIC_PREFS,
  type GuildMusicPrefs,
} from '@persistence/repositories/guildMusicSettingsRepository';
import { Logger } from '@domain/logger';

export class QueueService {
  private readonly is247Guilds = new Set<string>();
  private readonly guildPrefs = new Map<string, GuildMusicPrefs>();
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
      void this.settingsRepo.saveSettings(guildId, partial).catch(() => undefined);
    }
  }

  public calculatePosition(player: Player): number {
    if (!player.current) return 0;

    const rawTrack = player.current as unknown as { position?: number; time?: number };
    const basePos =
      typeof rawTrack.position === 'number' && rawTrack.position >= 0
        ? rawTrack.position
        : (player.lastPosition ?? 0);

    if (!player.playing || player.paused) {
      return basePos;
    }

    const trackStartedAt = typeof player.get === 'function' ? player.get<number>('trackStartedAt') : undefined;
    const updateTime = rawTrack.time || trackStartedAt;
    if (updateTime && typeof updateTime === 'number' && updateTime > 0) {
      const elapsed = Date.now() - updateTime;
      if (elapsed > 0 && elapsed < 60000) {
        const totalDuration = player.current.duration || 0;
        const livePos = basePos + elapsed;
        return totalDuration > 0 ? Math.min(totalDuration, livePos) : livePos;
      }
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
