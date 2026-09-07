import { singleton } from 'tsyringe';

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

export interface RateLimitResult {
  rateLimited: boolean;
  messageSent: boolean;
  retryAfterSeconds?: number;
}

@singleton()
export class RateLimitService {
  private readonly shortWindowMs = 10 * 1000; // 10 seconds
  private readonly shortMaxRequests = 13;
  private readonly shortPenaltyCooldownMs = 8 * 1000; // 8 seconds

  private readonly longWindowMs = 40 * 1000; // 40 seconds
  private readonly longMaxRequests = 35;
  private readonly longPenaltyCooldownMs = 20 * 1000; // 20 seconds

  private readonly shortCache = new Map<string, RateLimitEntry>();
  private readonly longCache = new Map<string, RateLimitEntry>();
  private readonly errorSentCache = new Map<string, number>();

  // Optional bypass set for bot administrators / internal testing
  private readonly bypassUserIds = new Set<string>();

  public addBypassUser(userId: string): void {
    this.bypassUserIds.add(userId);
  }

  public checkUserRateLimit(discordUserId: string): RateLimitResult {
    if (this.bypassUserIds.has(discordUserId)) {
      return { rateLimited: false, messageSent: false };
    }

    const now = Date.now();
    this.cleanupExpired(now);

    const errorSentExpiresAt = this.errorSentCache.get(discordUserId) ?? 0;
    const errorAlreadySent = errorSentExpiresAt > now;

    // Check Short Window (10s / 13 requests)
    let shortEntry = this.shortCache.get(discordUserId);
    if (shortEntry && shortEntry.expiresAt > now) {
      if (shortEntry.count >= this.shortMaxRequests) {
        const cooldown = now + this.shortPenaltyCooldownMs;
        this.errorSentCache.set(discordUserId, cooldown);
        this.shortCache.set(discordUserId, { count: shortEntry.count, expiresAt: cooldown });
        const retryAfter = Math.ceil(this.shortPenaltyCooldownMs / 1000);
        return { rateLimited: true, messageSent: errorAlreadySent, retryAfterSeconds: retryAfter };
      }
      shortEntry.count++;
    } else {
      shortEntry = { count: 1, expiresAt: now + this.shortWindowMs };
      this.shortCache.set(discordUserId, shortEntry);
    }

    // Check Long Window (40s / 35 requests)
    let longEntry = this.longCache.get(discordUserId);
    if (longEntry && longEntry.expiresAt > now) {
      if (longEntry.count >= this.longMaxRequests) {
        const cooldown = now + this.longPenaltyCooldownMs;
        this.errorSentCache.set(discordUserId, cooldown);
        this.shortCache.set(discordUserId, { count: shortEntry.count, expiresAt: cooldown });
        const retryAfter = Math.ceil(this.longPenaltyCooldownMs / 1000);
        return { rateLimited: true, messageSent: errorAlreadySent, retryAfterSeconds: retryAfter };
      }
      longEntry.count++;
    } else {
      longEntry = { count: 1, expiresAt: now + this.longWindowMs };
      this.longCache.set(discordUserId, longEntry);
    }

    return { rateLimited: false, messageSent: errorAlreadySent };
  }

  public resetUser(discordUserId: string): void {
    this.shortCache.delete(discordUserId);
    this.longCache.delete(discordUserId);
    this.errorSentCache.delete(discordUserId);
  }

  private cleanupExpired(now: number): void {
    // Only clean up intermittently if maps grow large
    if (this.shortCache.size > 2000) {
      for (const [key, entry] of this.shortCache.entries()) {
        if (entry.expiresAt <= now) this.shortCache.delete(key);
      }
    }
    if (this.longCache.size > 2000) {
      for (const [key, entry] of this.longCache.entries()) {
        if (entry.expiresAt <= now) this.longCache.delete(key);
      }
    }
    if (this.errorSentCache.size > 2000) {
      for (const [key, expiresAt] of this.errorSentCache.entries()) {
        if (expiresAt <= now) this.errorSentCache.delete(key);
      }
    }
  }
}
