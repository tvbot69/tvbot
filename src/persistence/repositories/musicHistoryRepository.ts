import type { MusicTrack } from '@domain/models/music/musicTrack';

export interface MusicHistoryItem {
  guildId: string;
  track: MusicTrack;
  playedAt: Date;
}

export class MusicHistoryRepository {
  // In-memory bounded cache of recently played tracks per guild (max 50 per guild)
  private readonly historyByGuild = new Map<string, MusicHistoryItem[]>();
  private static readonly MAX_GUILDS = 2000;

  public addHistory(guildId: string, track: MusicTrack): void {
    // clearHistory() existed but had no callers, so one entry (up to 50 full
    // track objects) was retained for every guild the bot has EVER played in,
    // for the life of the process. Cap the number of tracked guilds as well.
    if (!this.historyByGuild.has(guildId) && this.historyByGuild.size >= MusicHistoryRepository.MAX_GUILDS) {
      const oldest = this.historyByGuild.keys().next();
      if (!oldest.done) this.historyByGuild.delete(oldest.value);
    }
    const list = this.historyByGuild.get(guildId) ?? [];
    list.unshift({
      guildId,
      track,
      playedAt: new Date(),
    });
    if (list.length > 50) {
      list.length = 50;
    }
    this.historyByGuild.set(guildId, list);
  }

  public getHistory(guildId: string, limit: number = 10): MusicHistoryItem[] {
    const list = this.historyByGuild.get(guildId) ?? [];
    return list.slice(0, limit);
  }

  public clearHistory(guildId: string): void {
    this.historyByGuild.delete(guildId);
  }
}
