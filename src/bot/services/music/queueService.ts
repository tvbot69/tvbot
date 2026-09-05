import type { Player, Track } from 'moonlink.js';
import type { LoopMode, MusicQueueInfo } from '@domain/models/music/musicQueue';
import { mapMoonlinkTrack, type MusicTrack } from '@domain/models/music/musicTrack';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';

export class QueueService {
  private readonly is247Guilds = new Set<string>();
  private readonly historyRepo: MusicHistoryRepository;

  constructor(historyRepo: MusicHistoryRepository) {
    this.historyRepo = historyRepo;
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
