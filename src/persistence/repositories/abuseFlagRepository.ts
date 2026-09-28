import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

/**
 * One `abuse_flags` row, projected to its key only. The memory mirror in
 * AbuseFilterService answers one question - "is this user flagged?" - so the
 * expiry predicate is applied in SQL instead of by fetching every row and
 * filtering in JS: the mirror is rebuilt from scratch on each refresh and must
 * not carry dead rows.
 */
export interface AbuseFlagUserRow {
  userId: number;
}

/**
 * One row of the 8-day velocity aggregate. `user_plays.user_id` is an Int
 * column, so `userId` arrives as a JS number; `COUNT(*)` is an int8 in Postgres
 * and therefore a JS bigint, which is why the count is typed as one even though
 * the caller only needs the id.
 */
export interface AbuseVelocityRow {
  userId: number;
  recent: bigint;
}

/**
 * All `abuse_flags` data access for the abuse filter: which users are currently
 * flagged, which are scrobbling at an inhuman rate, and the writes that flag and
 * unflag them.
 *
 * The thresholds are NOT here. Velocity numbers are policy (fmbot parity) and
 * belong to the service; this layer owns the SQL and the row shapes.
 */
@injectable()
export class AbuseFlagRepository {
  constructor(@inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /**
   * Currently-live flags, i.e. permanent ones (`expires_at IS NULL`) plus the
   * TTL-bound ones that have not lapsed yet.
   */
  public async getActiveFlaggedUserIds(): Promise<number[]> {
    const rows = await this.prisma.abuseFlag.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /**
   * Users with more than `minPlays` scrobbles in the last 8 days - the
   * sustained-volume signal. Counted over indexed scrobbles only, so the
   * threshold has to be high enough to exclude a heavy listener rather than a
   * bot.
   */
  public async findEightDayVolumeOffenders(minPlays: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<AbuseVelocityRow[]>`
      SELECT up.user_id AS "userId", COUNT(*) AS "recent"
      FROM user_plays up
      WHERE up.time_played > NOW() - INTERVAL '8 days'
      GROUP BY up.user_id
      HAVING COUNT(*) > ${minPlays}
    `;
    return rows.map((r) => r.userId);
  }

  /**
   * Users with more than `minPlays` scrobbles in the last day - the burst
   * signal, which catches a loop-scrobble that a day-average would hide.
   */
  public async findDaySpikeOffenders(minPlays: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<AbuseFlagUserRow[]>`
      SELECT up.user_id AS "userId"
      FROM user_plays up
      WHERE up.time_played > NOW() - INTERVAL '1 day'
      GROUP BY up.user_id
      HAVING COUNT(*) > ${minPlays}
    `;
    return rows.map((r) => r.userId);
  }

  /**
   * Idempotent: re-flagging an already-flagged user pushes the expiry out
   * instead of failing on the primary key, so a nightly scan can run
   * unconditionally without pre-checking for an existing row.
   */
  public async upsertFlag(userId: number, reason: string, expiresAt: Date): Promise<void> {
    await this.prisma.abuseFlag.upsert({
      where: { userId },
      update: { reason, expiresAt },
      create: { userId, reason, expiresAt },
    });
  }

  /**
   * Self-cleaning sweep. Lapsed flags are deleted rather than left to sit in the
   * table, so `abuse_flags` stays the set of live flags and the mirror query
   * above never has to distinguish them at read time.
   */
  public async deleteExpiredFlags(): Promise<number> {
    const res = await this.prisma.abuseFlag.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return res.count;
  }

  public async deleteFlagsForUser(userId: number): Promise<number> {
    const res = await this.prisma.abuseFlag.deleteMany({ where: { userId } });
    return res.count;
  }
}
