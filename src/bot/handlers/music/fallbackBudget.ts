import type { Track } from 'moonlink.js';

/** Per-track fallback cap. */
export const MAX_FALLBACKS_PER_TRACK = 3;
/** Per-guild fallback cap inside one window. */
export const MAX_FALLBACKS_PER_GUILD_WINDOW = 5;
/** Length of the per-guild fallback window. */
export const FALLBACK_BUDGET_WINDOW_MS = 60000;
/** Failures of the same artist+title before the song is abandoned. */
export const MAX_FAILURES_PER_SONG = 2;
/** Length of the song-identity failure window. */
export const SONG_FAILURE_WINDOW_MS = 600000;

/**
 * Budgeting and circuit-breaking for the alternate-track fallback ladder.
 *
 * Extracted from MusicHandler. The Maps are NOT owned here — they are passed in
 * by reference from the handler, which matters for two reasons: the handler
 * keeps sole ownership (so `forgetGuild` can sweep them), and the test suite
 * reads them straight off the handler to assert budget behaviour. A copy would
 * silently break both.
 */
export class FallbackBudget {
  public constructor(
    private readonly fallbackAttempts: Map<string, number>,
    private readonly guildFallbackBudget: Map<string, { count: number; windowStart: number }>,
    private readonly triedFallbackIds: Map<string, Set<string>>,
    private readonly songFailureCounts: Map<string, { count: number; firstAt: number }>,
  ) {}

  public fallbackTrackKey(guildId: string, failedKey: string): string {
    return `${guildId}|${failedKey}`;
  }

  public checkFallbackBudget(guildId: string, failedKey: string): boolean {
    const attempts = this.fallbackAttempts.get(this.fallbackTrackKey(guildId, failedKey)) ?? 0;
    if (attempts >= MAX_FALLBACKS_PER_TRACK) return false;
    const now = Date.now();
    const budget = this.guildFallbackBudget.get(guildId);
    if (!budget || now - budget.windowStart > FALLBACK_BUDGET_WINDOW_MS) {
      this.guildFallbackBudget.set(guildId, { count: 0, windowStart: now });
    } else if (budget.count >= MAX_FALLBACKS_PER_GUILD_WINDOW) {
      return false;
    }
    return true;
  }

  public recordFallbackAttempt(guildId: string, failedKey: string, fallbackId?: string): void {
    const trackKey = this.fallbackTrackKey(guildId, failedKey);
    this.fallbackAttempts.set(trackKey, (this.fallbackAttempts.get(trackKey) ?? 0) + 1);
    const budget = this.guildFallbackBudget.get(guildId);
    if (budget) budget.count++;
    if (fallbackId) {
      let tried = this.triedFallbackIds.get(guildId);
      if (!tried) {
        tried = new Set();
        this.triedFallbackIds.set(guildId, tried);
      }
      if (tried.size >= 10) tried.clear();
      tried.add(fallbackId);
    }
  }

  /**
   * Drops every per-guild entry, including the prefix-matched attempt and
   * song-failure keys. The two prefix scans must stay together: splitting them
   * would half-orphan one of the two Maps.
   */
  public clearFallbackState(guildId: string): void {
    this.guildFallbackBudget.delete(guildId);
    this.triedFallbackIds.delete(guildId);
    for (const key of this.fallbackAttempts.keys()) {
      if (key.startsWith(`${guildId}|`)) this.fallbackAttempts.delete(key);
    }
    for (const key of this.songFailureCounts.keys()) {
      if (key.startsWith(`${guildId}|`)) this.songFailureCounts.delete(key);
    }
  }

  // Song-identity circuit breaker: budgets keyed on track bytes can't stop a
  // poison SONG (every alternate upload is a new encoded id). After N failed
  // attempts at the same artist+title, abandon the song instead of burning
  // more searches and stuttering dead air.
  public songIdentityKey(guildId: string, track: Track): string {
    return `${guildId}|${(track.author || '').toLowerCase().trim()} - ${(track.title || '').toLowerCase().trim()}`;
  }

  public isSongExhausted(guildId: string, track: Track): boolean {
    const key = this.songIdentityKey(guildId, track);
    const now = Date.now();
    const entry = this.songFailureCounts.get(key);
    if (!entry || now - entry.firstAt > SONG_FAILURE_WINDOW_MS) {
      this.songFailureCounts.set(key, { count: 1, firstAt: now });
      return false;
    }
    entry.count++;
    return entry.count > MAX_FAILURES_PER_SONG;
  }

  public matchesFallbackDuration(failedTrack: Track, duration?: number): boolean {
    const failedDuration = failedTrack.duration || 0;
    if (!duration || !failedDuration) return true;
    return Math.abs(duration - failedDuration) <= 30000;
  }

  public isFreshCandidate(failedTrack: Track, guildId: string, t: Track): boolean {
    const tried = this.triedFallbackIds.get(guildId) ?? new Set<string>();
    return (
      t.identifier !== failedTrack.identifier &&
      !tried.has(t.identifier) &&
      this.matchesFallbackDuration(failedTrack, t.duration)
    );
  }
}
