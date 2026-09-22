import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ReconcileService } from './reconcileService';

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

const healthyState = (total = 1000) => {
  db.user.findMany.mockResolvedValue([{ userId: 1, totalPlayCount: total }]);
  db.userArtist.aggregate.mockResolvedValue(agg(total));
  db.userAlbum.aggregate.mockResolvedValue(agg(900));
  db.userTrack.aggregate.mockResolvedValue(agg(950));
  db.userPlay.count.mockImplementation(async (args: any) => {
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
    db.userPlay.count.mockImplementation(async (args: any) => {
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
