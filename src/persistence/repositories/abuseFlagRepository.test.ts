import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AbuseFlagRepository } from './abuseFlagRepository';

/**
 * These assertions exist because the SQL is invisible to every other test. The
 * service's own tests mock the repository, and the raw aggregates were written
 * before this layer existed, so the only place the two velocity windows and the
 * expiry predicate can be checked is here - against a Prisma double, not a
 * database.
 */

/** Joins a tagged-template call back into one string so the WHERE can be asserted. */
const sqlOf = (call: unknown[] | undefined): string => {
  const strings = call?.[0] as TemplateStringsArray;
  return strings.join(' ? ');
};

/** The first argument of a recorded call, typed for the assertion that follows. */
const firstArg = <T>(call: unknown[] | undefined): T => call?.[0] as T;

const makePrisma = () => {
  const $queryRaw = vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) =>
    [] as Array<{ userId: number; recent?: bigint }>,
  );
  const findMany = vi.fn(async (_args: Record<string, unknown>) => [] as Array<{ userId: number }>);
  const upsert = vi.fn(async (_args: Record<string, unknown>) => undefined);
  const deleteMany = vi.fn(async (_args: Record<string, unknown>) => ({ count: 0 }));
  const prisma = {
    $queryRaw,
    abuseFlag: { findMany, upsert, deleteMany },
  };
  return { prisma, $queryRaw, findMany, upsert, deleteMany };
};

const makeRepo = () => {
  const db = makePrisma();
  return { repo: new AbuseFlagRepository(db.prisma as never), ...db };
};

describe('AbuseFlagRepository', () => {
  describe('getActiveFlaggedUserIds', () => {
    it('asks for the user id alone and returns it as a list', async () => {
      const { repo, findMany } = makeRepo();
      findMany.mockResolvedValueOnce([{ userId: 4 }, { userId: 9 }]);

      await expect(repo.getActiveFlaggedUserIds()).resolves.toEqual([4, 9]);

      const args = firstArg<{ select: unknown }>(findMany.mock.calls[0]);
      expect(args.select).toEqual({ userId: true });
    });

    it('keeps permanent flags and drops lapsed ones in SQL', async () => {
      const { repo, findMany } = makeRepo();
      await repo.getActiveFlaggedUserIds();

      const where = firstArg<{ where: { OR: Array<Record<string, unknown>> } }>(findMany.mock.calls[0]).where;
      // An unexpiring flag (expiresAt null) or one whose TTL has not passed.
      expect(where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
    });
  });

  describe('findEightDayVolumeOffenders', () => {
    it('counts scrobbles over 8 days and returns only the ids', async () => {
      const { repo, $queryRaw } = makeRepo();
      $queryRaw.mockResolvedValueOnce([
        { userId: 11, recent: 4001n },
        { userId: 12, recent: 2501n },
      ]);

      await expect(repo.findEightDayVolumeOffenders(2500)).resolves.toEqual([11, 12]);

      const call = $queryRaw.mock.calls[0] as unknown[];
      const sql = sqlOf(call);
      expect(sql).toMatch(/INTERVAL '8 days'/);
      expect(sql).toMatch(/HAVING COUNT\(\*\) >\s*\?/);
      // Threshold is a bound parameter, never string-interpolated.
      expect(call.slice(1)).toEqual([2500]);
    });
  });

  describe('findDaySpikeOffenders', () => {
    it('counts scrobbles over 1 day and returns only the ids', async () => {
      const { repo, $queryRaw } = makeRepo();
      $queryRaw.mockResolvedValueOnce([{ userId: 21 }]);

      await expect(repo.findDaySpikeOffenders(650)).resolves.toEqual([21]);

      const call = $queryRaw.mock.calls[0] as unknown[];
      expect(sqlOf(call)).toMatch(/INTERVAL '1 day'/);
      expect(sqlOf(call)).toMatch(/HAVING COUNT\(\*\) >\s*\?/);
      expect(call.slice(1)).toEqual([650]);
    });

    it('is a narrower window than the volume query, so the two are not swapped', async () => {
      const { repo, $queryRaw } = makeRepo();
      await repo.findDaySpikeOffenders(650);
      const sql = sqlOf($queryRaw.mock.calls[0] as unknown[]);
      expect(sql).not.toMatch(/8 days/);
    });
  });

  describe('upsertFlag', () => {
    it('updates the expiry of an existing flag and creates a new one otherwise', async () => {
      const { repo, upsert } = makeRepo();
      const expiresAt = new Date('2026-12-19T00:00:00.000Z');

      await repo.upsertFlag(7, 'scrobble-velocity', expiresAt);

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith({
        where: { userId: 7 },
        update: { reason: 'scrobble-velocity', expiresAt },
        create: { userId: 7, reason: 'scrobble-velocity', expiresAt },
      });
    });
  });

  describe('deleteExpiredFlags', () => {
    it('deletes only lapsed rows and reports how many went', async () => {
      const { repo, deleteMany } = makeRepo();
      deleteMany.mockResolvedValueOnce({ count: 3 });

      await expect(repo.deleteExpiredFlags()).resolves.toBe(3);

      expect(deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
    });
  });

  describe('deleteFlagsForUser', () => {
    it('deletes that user only and reports how many went', async () => {
      const { repo, deleteMany } = makeRepo();
      deleteMany.mockResolvedValueOnce({ count: 1 });

      await expect(repo.deleteFlagsForUser(7)).resolves.toBe(1);

      expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    });
  });
});
