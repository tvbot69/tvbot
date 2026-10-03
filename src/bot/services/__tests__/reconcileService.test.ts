import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ReconcileService } from '@bot/services/lastfm/reconcileService';

const db = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  userArtist: { aggregate: vi.fn() },
  userAlbum: { aggregate: vi.fn() },
  userTrack: { aggregate: vi.fn() },
  userPlay: { count: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

const agg = (v: number | null) => ({ _sum: { playcount: v } });

/** Only the two discriminators this test branches on are typed, not the whole args object. */
type CountArgs = { where?: { albumName?: string; trackName?: string } };

const healthyState = (total = 1000) => {
  db.user.findMany.mockResolvedValue([{ userId: 1, totalPlayCount: total }]);
  db.userArtist.aggregate.mockResolvedValue(agg(total));
  db.userAlbum.aggregate.mockResolvedValue(agg(900));
  db.userTrack.aggregate.mockResolvedValue(agg(950));
  db.userPlay.count.mockImplementation(async (args: CountArgs) => {
    if (args?.where?.albumName) return 900;
    if (args?.where?.trackName) return 950;
    return total;
  });
  db.$queryRaw.mockResolvedValue([{ artists: 0, albums: 0, tracks: 0 }]);
};

const makeSvc = () => {
  const indexService = {
    recalculateTopLists: vi.fn(async () => undefined),
    enqueueUser: vi.fn(() => true),
  };
  return { svc: new ReconcileService(indexService as never), indexService };
};

describe('ReconcileService', () => {
  it('leaves a healthy user alone', async () => {
    healthyState();
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(report.checkedUsers).toBe(1);
    expect(report.healedUsers).toBe(0);
    expect(report.escalatedUsers).toBe(0);
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    expect(indexService.enqueueUser).not.toHaveBeenCalled();
  });

  it('rebuilds aggregates on drift', async () => {
    healthyState();
    db.userArtist.aggregate.mockResolvedValue(agg(500));
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(indexService.recalculateTopLists).toHaveBeenCalledWith(1);
    expect(report.healedUsers).toBe(1);
    expect(report.details[0]?.action).toBe('healed-aggregates');
  });

  it('enqueues a full index on missing history', async () => {
    healthyState(1000);
    db.userArtist.aggregate.mockResolvedValue(agg(800));
    db.userAlbum.aggregate.mockResolvedValue(agg(800));
    db.userTrack.aggregate.mockResolvedValue(agg(800));
    db.userPlay.count.mockImplementation(async (args: CountArgs) => {
      if (args?.where?.albumName) return 800;
      if (args?.where?.trackName) return 800;
      return 800;
    });
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(indexService.enqueueUser).toHaveBeenCalledWith(1);
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    expect(report.escalatedUsers).toBe(1);
  });

  it('ignores import-inflated libraries (local exceeds Last.fm)', async () => {
    healthyState(1000);
    db.userArtist.aggregate.mockResolvedValue(agg(1200));
    db.userAlbum.aggregate.mockResolvedValue(agg(1200));
    db.userTrack.aggregate.mockResolvedValue(agg(1200));
    db.userPlay.count.mockResolvedValue(1200);
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(report.healedUsers).toBe(0);
    expect(report.escalatedUsers).toBe(0);
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    expect(indexService.enqueueUser).not.toHaveBeenCalled();
  });

  it('tolerates small drift silently', async () => {
    healthyState(1000);
    db.userArtist.aggregate.mockResolvedValue(agg(995));
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(report.healedUsers).toBe(0);
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
  });

  it('skips users with no plays', async () => {
    healthyState(0);
    db.userPlay.count.mockResolvedValue(0);
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(report.checkedUsers).toBe(0);
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
  });

  it('reports reappearing entity dupes without destructive heals', async () => {
    healthyState();
    db.$queryRaw.mockResolvedValue([{ artists: 2, albums: 0, tracks: 1 }]);
    const { svc, indexService } = makeSvc();
    const report = await svc.runAsync();
    expect(report.entityDupes).toEqual({ artists: 2, albums: 0, tracks: 1 });
    expect(indexService.recalculateTopLists).not.toHaveBeenCalled();
    expect(indexService.enqueueUser).not.toHaveBeenCalled();
  });
});

describe('ReconcileService pagination and cap', () => {
  // Mirrors USER_BATCH_SIZE 500 and MAX_USERS_PER_RUN 2000 in reconcileService.ts.
  // If those constants move, these tests must move with them.
  const BATCH = 500;
  const MAX = 2000;

  type ListArgs = { take?: number; cursor?: { userId: number }; skip?: number; orderBy?: unknown };

  const sliceDb = (total: number) => {
    const all = Array.from({ length: total }, (_, i) => ({ userId: i + 1, totalPlayCount: null }));
    db.user.findMany.mockClear();
    db.user.findMany.mockImplementation(async (args: ListArgs) => {
      const take = args?.take ?? BATCH;
      const cursorId = args?.cursor?.userId;
      let start = 0;
      if (cursorId !== undefined) {
        const idx = all.findIndex((u) => u.userId === cursorId);
        start = idx + 1;
      }
      return all.slice(start, start + take);
    });
  };

  const healthyAggregates = () => {
    db.userArtist.aggregate.mockResolvedValue(agg(100));
    db.userAlbum.aggregate.mockResolvedValue(agg(100));
    db.userTrack.aggregate.mockResolvedValue(agg(100));
    db.userPlay.count.mockResolvedValue(100);
    db.$queryRaw.mockResolvedValue([{ artists: 0, albums: 0, tracks: 0 }]);
  };

  it('pages user listing with take/order/cursor instead of one unbounded read', async () => {
    sliceDb(BATCH + 100);
    healthyAggregates();
    const { svc } = makeSvc();
    const report = await svc.runAsync();
    expect(report.checkedUsers).toBe(BATCH + 100);
    expect(report.truncated).toBe(false);
    expect(db.user.findMany).toHaveBeenCalledTimes(2);
    const first = db.user.findMany.mock.calls[0]?.[0] as ListArgs;
    const second = db.user.findMany.mock.calls[1]?.[0] as ListArgs;
    expect(first.take).toBe(BATCH);
    expect(second.take).toBe(BATCH);
    expect(second.cursor).toEqual({ userId: BATCH });
    expect(second.skip).toBe(1);
    // Removing take/cursor returns all 600 in one call: this fails.
    expect(db.user.findMany).not.toHaveBeenCalledTimes(1);
  });

  it('caps scan at MAX and marks truncated so remainder defers', async () => {
    sliceDb(MAX + 1);
    healthyAggregates();
    const { svc } = makeSvc();
    const report = await svc.runAsync();
    expect(report.checkedUsers).toBe(MAX);
    expect(report.truncated).toBe(true);
    expect(report.details).toHaveLength(MAX);
    // Uncapped run would check all 2001 with truncated false: this fails.
    expect(report.checkedUsers).not.toBe(MAX + 1);
  });

  it('continues past one bad user instead of aborting run', async () => {
    db.user.findMany.mockResolvedValue([
      { userId: 1, totalPlayCount: null },
      { userId: 2, totalPlayCount: null },
    ]);
    db.$queryRaw.mockResolvedValue([{ artists: 0, albums: 0, tracks: 0 }]);
    db.userArtist.aggregate.mockImplementation(async (args: { where?: { userId?: number } }) => {
      if (args?.where?.userId === 1) throw new Error('aggregate down');
      return agg(100);
    });
    db.userAlbum.aggregate.mockResolvedValue(agg(100));
    db.userTrack.aggregate.mockResolvedValue(agg(100));
    db.userPlay.count.mockResolvedValue(100);
    const { svc } = makeSvc();
    const report = await svc.runAsync();
    expect(report.checkedUsers).toBe(1);
    expect(report.details.map((d) => d.userId)).toEqual([2]);
  });
});
