import { Logger } from '@domain/logger';
import { AbuseFlagRepository } from '@persistence/repositories/abuseFlagRepository';

// fmbot parity (WhoKnowsFilterService): loop-scrobbling trips at ~650 plays
// in a day or sustained inhuman volume across 8 days. Flags last 90 days.
const DAY_SPIKE_THRESHOLD = 650;
const EIGHT_DAY_VOLUME_THRESHOLD = 2500;
const FLAG_TTL_DAYS = 90;
const FLAG_REASON = 'scrobble-velocity';

/**
 * The client `AbuseFlagRepository` is built from, taken from the repository's own
 * constructor rather than imported from `@prisma/client`: `bot/` must not import
 * the Prisma client (debt ratchet `prisma-client-import-in-bot`), and this
 * service holds no schema knowledge of its own any more - it only forwards a
 * client to the repository. Deriving it this way means the two cannot drift.
 */
export type AbuseFlagPrismaClient = ConstructorParameters<typeof AbuseFlagRepository>[0];

export class AbuseFilterService {
  private flagged = new Set<number>();
  private loadedAt = 0;
  private static readonly REFRESH_MS = 3600000;
  private readonly store: AbuseFlagRepository | null;

  /**
   * @param prisma Legacy injection path, kept so existing callers and tests can
   *   hand over a bare client; a repository is built from it when none is given.
   * @param store  The data access. Takes precedence over `prisma`.
   */
  constructor(prisma?: AbuseFlagPrismaClient | null, store?: AbuseFlagRepository | null) {
    this.store = store ?? (prisma ? new AbuseFlagRepository(prisma) : null);
  }

  /** Synchronous hot-path check (memory mirror, refreshed hourly + on scan). */
  public isFlagged(userId: number): boolean {
    return this.flagged.has(userId);
  }

  public async refresh(): Promise<void> {
    if (!this.store) return;
    try {
      this.flagged = new Set(await this.store.getActiveFlaggedUserIds());
      this.loadedAt = Date.now();
    } catch (err) {
      Logger.debug({ err }, 'Abuse flag refresh failed');
    }
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt > AbuseFilterService.REFRESH_MS) {
      await this.refresh();
    }
  }

  /**
   * Nightly scan: flags inhuman scrobble velocity. Idempotent (upsert) and
   * self-cleaning (expired rows deleted). Returns newly flagged user count.
   */
  public async scanAndFlag(): Promise<number> {
    if (!this.store) return 0;
    await this.ensureFresh();
    let flagged = 0;
    try {
      const offenders = await this.store.findEightDayVolumeOffenders(EIGHT_DAY_VOLUME_THRESHOLD);
      const daySpike = await this.store.findDaySpikeOffenders(DAY_SPIKE_THRESHOLD);
      const ids = new Set<number>([...offenders, ...daySpike]);
      const expiresAt = new Date(Date.now() + FLAG_TTL_DAYS * 86400000);
      for (const userId of ids) {
        if (this.flagged.has(userId)) continue;
        await this.store.upsertFlag(userId, FLAG_REASON, expiresAt);
        flagged++;
      }
      await this.store.deleteExpiredFlags();
      await this.refresh();
      if (flagged > 0) {
        Logger.warn(`Abuse scan flagged ${flagged} users for scrobble velocity`);
      }
      return flagged;
    } catch (err) {
      Logger.error({ err }, 'Abuse scan failed');
      return 0;
    }
  }

  public async unflag(userId: number): Promise<void> {
    if (!this.store) return;
    // CORRECT AS IS on the current code: nothing calls `unflag` — the method is
    // unreferenced outside its own definition, so there is no user-visible claim
    // to be wrong about today.
    //
    // It is still not safe to leave as it is, because the two halves disagree.
    // If a caller is ever added, a failed delete clears `this.flagged` anyway,
    // and the next `refresh()` reads the still-present row back and re-flags the
    // user — so the caller's "done" would be undone silently. Logging makes the
    // rollback visible to whoever wires this up.
    await this.store.deleteFlagsForUser(userId).catch((err: unknown) => {
      Logger.warn({ err, userId }, 'Abuse flag could not be deleted; it will be re-read from the database');
    });
    this.flagged.delete(userId);
  }
}
