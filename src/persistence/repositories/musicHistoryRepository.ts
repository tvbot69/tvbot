import type { MusicTrack } from '@domain/models/music/musicTrack';

export interface MusicHistoryItem {
  guildId: string;
  track: MusicTrack;
  playedAt: Date;
}

export class MusicHistoryRepository {
  // In-memory bounded cache of recently played tracks per guild (max 50 per guild)
  private readonly historyByGuild = new Map<string, MusicHistoryItem[]>();

  public addHistory(guildId: string, track: MusicTrack): void {
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
