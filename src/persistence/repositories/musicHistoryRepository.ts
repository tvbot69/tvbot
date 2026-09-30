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
    const list = this.historyByGuild.get(guildId) ?? [];
    list.unshift({
      guildId,
      track,
      playedAt: new Date(),
    });
    if (list.length > 50) {
      list.length = 50;
    }

    // The cap evicts the LEAST RECENTLY WRITTEN guild, which takes a
    // delete-then-re-insert rather than a plain `set`: `Map.set` on a key that is
    // already present keeps its ORIGINAL position, so without the delete a guild
    // the bot plays in daily never moved and was the next thing evicted — the
    // cache lost its hottest entries first, and the guild that had just joined
    // survived. A write is the right refresh signal because the only thing this
    // cache holds is what was last played: a guild with no recent play has the
    // least interesting history, and `getHistory` deliberately stays read-only
    // so reading a history cannot change which guild is dropped.
    //
    // The delete happens BEFORE the cap check, so re-adding a guild that is
    // already tracked is never mistaken for a new guild needing a slot. `list`
    // was read first, so the live array is reused and the re-insert does not
    // drop the history it just grew.
    const wasTracked = this.historyByGuild.delete(guildId);
    if (!wasTracked && this.historyByGuild.size >= MusicHistoryRepository.MAX_GUILDS) {
      const coldest = this.historyByGuild.keys().next();
      if (!coldest.done) this.historyByGuild.delete(coldest.value);
    }
    this.historyByGuild.set(guildId, list);
  }

  public getHistory(guildId: string, limit: number = 10): MusicHistoryItem[] {
    const list = this.historyByGuild.get(guildId) ?? [];
    return list.slice(0, limit);
  }
}
