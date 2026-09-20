import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { AbuseFilterService } from './abuseFilterService';

const makeService = (overrides: {
  scanRows?: Array<{ userId: number }>;
  dayRows?: Array<{ userId: number }>;
  flaggedRows?: Array<{ userId: number }>;
} = {}) => {
  const upsert = vi.fn(async () => undefined);
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('8 days')) return overrides.scanRows ?? [];
      return overrides.dayRows ?? [];
    }),
    abuseFlag: {
      findMany: vi.fn(async () => overrides.flaggedRows ?? []),
      upsert,
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { service: new AbuseFilterService(prisma as never), prisma, upsert };
};

describe('AbuseFilterService (Phase 4)', () => {
  it('flags velocity abusers from either window and refreshes memory', async () => {
    const { service, upsert } = makeService({
      scanRows: [{ userId: 11 }],
      dayRows: [{ userId: 22 }],
    });

    const flagged = await service.scanAndFlag();
    expect(flagged).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('flags nobody on a clean library', async () => {
    const { service, upsert } = makeService({});
    const flagged = await service.scanAndFlag();
    expect(flagged).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(service.isFlagged(11)).toBe(false);
  });

  it('loads existing flags into memory on refresh', async () => {
    const { service } = makeService({ flaggedRows: [{ userId: 33 }] });
    await service.refresh();
    expect(service.isFlagged(33)).toBe(true);
    expect(service.isFlagged(34)).toBe(false);
  });

  it('does nothing without a database', async () => {
    const service = new AbuseFilterService(null);
    await expect(service.scanAndFlag()).resolves.toBe(0);
    await expect(service.refresh()).resolves.toBeUndefined();
  });
});
