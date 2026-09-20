import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logger';

// fmbot parity (WhoKnowsFilterService): loop-scrobbling trips at ~650 plays
// in a day or sustained inhuman volume across 8 days. Flags last 90 days.
const DAY_SPIKE_THRESHOLD = 650;
const EIGHT_DAY_VOLUME_THRESHOLD = 2500;
const FLAG_TTL_DAYS = 90;

export class AbuseFilterService {
  private flagged = new Set<number>();
  private loadedAt = 0;
  private static readonly REFRESH_MS = 3600000;

  constructor(private readonly prisma?: PrismaClient | null) {}

  /** Synchronous hot-path check (memory mirror, refreshed hourly + on scan). */
  public isFlagged(userId: number): boolean {
    return this.flagged.has(userId);
  }

  public async refresh(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.abuseFlag.findMany({
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { userId: true },
      });
      this.flagged = new Set(rows.map((r) => r.userId));
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
    if (!this.prisma) return 0;
    await this.ensureFresh();
    let flagged = 0;
    try {
      const offenders = await this.prisma.$queryRaw<Array<{ userId: number; recent: bigint }>>`
        SELECT up.user_id AS "userId", COUNT(*) AS "recent"
        FROM user_plays up
        WHERE up.time_played > NOW() - INTERVAL '8 days'
        GROUP BY up.user_id
        HAVING COUNT(*) > ${EIGHT_DAY_VOLUME_THRESHOLD}
      `;
      const daySpike = await this.prisma.$queryRaw<Array<{ userId: number }>>`
        SELECT up.user_id AS "userId"
        FROM user_plays up
        WHERE up.time_played > NOW() - INTERVAL '1 day'
        GROUP BY up.user_id
        HAVING COUNT(*) > ${DAY_SPIKE_THRESHOLD}
      `;
      const ids = new Set<number>([
        ...offenders.map((r) => r.userId),
        ...daySpike.map((r) => r.userId),
      ]);
      const expiresAt = new Date(Date.now() + FLAG_TTL_DAYS * 86400000);
      for (const userId of ids) {
        if (this.flagged.has(userId)) continue;
        await this.prisma.abuseFlag.upsert({
          where: { userId },
          update: { reason: 'scrobble-velocity', expiresAt },
          create: { userId, reason: 'scrobble-velocity', expiresAt },
        });
        flagged++;
      }
      await this.prisma.abuseFlag.deleteMany({ where: { expiresAt: { lt: new Date() } } });
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
    if (!this.prisma) return;
    await this.prisma.abuseFlag.deleteMany({ where: { userId } }).catch(() => undefined);
    this.flagged.delete(userId);
  }
}
