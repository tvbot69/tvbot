import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { UpdateService } from './updateService';
import { IndexService } from './indexService';

const T1 = new Date('2026-03-01T10:00:00.000Z');
const T2 = new Date('2026-03-01T10:00:01.000Z');

interface TrackStub {
  artistName: string;
  albumName?: string;
  name: string;
  timePlayed: Date;
  nowPlaying?: boolean;
}

const makeService = (overrides: {
  incoming?: TrackStub[];
  existing?: Array<{ userPlayId: bigint; artistName: string; trackName?: string; timePlayed: Date }>;
  totalScrobbles?: number;
  userTotal?: number;
  setLastUpdate?: ReturnType<typeof vi.fn>;
  batchInsert?: ReturnType<typeof vi.fn>;
  removeByIds?: ReturnType<typeof vi.fn>;
}) => {
  const setLastUpdate = overrides.setLastUpdate ?? vi.fn(async () => undefined);
  const batchInsert = overrides.batchInsert ?? vi.fn(async (p: unknown[]) => p.length);
  const removeByIds = overrides.removeByIds ?? vi.fn(async (ids: unknown[]) => ids.length);
  const service = new UpdateService(
    {
      getUserById: vi.fn(async () => ({
        userId: 9,
        userNameLastFm: 'deltauser',
        totalPlayCount: overrides.userTotal ?? 100,
        lastUpdate: new Date(Date.now() - 5 * 3600 * 1000),
        lastScrobbleUpdate: new Date(Date.now() - 5 * 3600 * 1000),
      })),
      setLastUpdate,
      setLastScrobbleUpdate: vi.fn(async () => undefined),
      updateUserStats: vi.fn(async () => undefined),
      incrementTotalPlayCount: vi.fn(async () => undefined),
    } as never,
    {
      getRecentPlays: vi.fn(async () => overrides.existing ?? []),
      batchInsertPlays: batchInsert,
      removePlaysByIds: removeByIds,
    } as never,
    {
      getUserRecentTracksWithMetadata: vi.fn(async () => ({
        tracks: overrides.incoming ?? [],
        totalPages: 1,
        totalScrobbles: overrides.totalScrobbles ?? 100,
      })),
    } as never,
    {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as never,
    vi.fn(async () => undefined),
  );
  return { service, setLastUpdate, batchInsert, removeByIds };
};

describe('UpdateService delta sync (Phase 0.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts same-second distinct scrobbles instead of timestamp-colliding them', async () => {
    const { service, batchInsert } = makeService({
      existing: [{ userPlayId: 1n, artistName: 'A', trackName: 'X', timePlayed: T1 }],
      incoming: [
        { artistName: 'A', name: 'X', timePlayed: T1 },
        { artistName: 'B', name: 'Y', timePlayed: T1 },
      ],
    });

    const res = await service.updateUser(9);
    expect(res.newPlays).toBe(1);
    expect(res.removedPlays).toBe(0);
    const inserted = batchInsert.mock.calls[0]![0] as Array<{ trackName?: string }>;
    expect(inserted.map((p) => p.trackName)).toEqual(['Y']);
  });

  it('detects a deleted scrobble without nuking its same-second neighbor', async () => {
    const { service, removeByIds } = makeService({
      existing: [
        { userPlayId: 1n, artistName: 'A', trackName: 'X', timePlayed: T1 },
        { userPlayId: 2n, artistName: 'B', trackName: 'Y', timePlayed: T1 },
      ],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    const res = await service.updateUser(9);
    expect(res.newPlays).toBe(0);
    expect(res.removedPlays).toBe(1);
    expect(removeByIds.mock.calls[0]![0]).toEqual([2n]);
  });

  it('escalates to a full index when the delta window cannot cover the gap', async () => {
    const enqueueUser = vi.fn(() => true);
    container.registerInstance(IndexService, { enqueueUser } as never);
    try {
      const { service } = makeService({
        existing: [],
        incoming: [
          { artistName: 'A', name: 'X', timePlayed: T1 },
          { artistName: 'A', name: 'Y', timePlayed: T2 },
        ],
        totalScrobbles: 1000,
        userTotal: 100,
      });

      await service.updateUser(9);
      expect(enqueueUser).toHaveBeenCalledWith(9);
    } finally {
      container.clearInstances();
    }
  });

  it('does not mark fresh on an empty fetch with a nonzero library', async () => {
    const setLastUpdate = vi.fn(async () => undefined);
    const { service } = makeService({
      setLastUpdate,
      existing: [],
      incoming: [],
      totalScrobbles: 500,
    });

    await service.updateUser(9);
    const stamped = (setLastUpdate.mock.calls[0] as unknown as [number, Date])[1];
    expect(Date.now() - stamped.getTime()).toBeGreaterThan(40 * 3600 * 1000);
  });

  it('advances the cursor for a genuinely empty library', async () => {
    const setLastUpdate = vi.fn(async () => undefined);
    const { service } = makeService({
      setLastUpdate,
      existing: [],
      incoming: [],
      totalScrobbles: 0,
    });

    await service.updateUser(9);
    const stamped = (setLastUpdate.mock.calls[0] as unknown as [number, Date])[1];
    expect(Date.now() - stamped.getTime()).toBeLessThan(60 * 1000);
  });
});

describe('UpdateService chunked top-list maintenance', () => {
  const makeChunkSvc = (
    incomingCount: number,
    applyImpl?: (...args: any[]) => Promise<void>,
  ) => {
    const recalc = vi.fn(async () => undefined);
    const apply = vi.fn(applyImpl ?? (async () => undefined));
    const incoming = Array.from({ length: incomingCount }, (_, i) => ({
      artistName: 'Chunk Artist',
      name: `Chunk Song ${i}`,
      timePlayed: new Date(Date.now() - (incomingCount - i) * 60000),
    }));
    const svc = new UpdateService(
      {
        getUserById: vi.fn(async () => ({
          userId: 9,
          userNameLastFm: 'chunkuser',
          totalPlayCount: 100,
          lastUpdate: new Date(Date.now() - 5 * 3600 * 1000),
          lastScrobbleUpdate: new Date(Date.now() - 5 * 3600 * 1000),
        })),
        setLastUpdate: vi.fn(async () => undefined),
        setLastScrobbleUpdate: vi.fn(async () => undefined),
        updateUserStats: vi.fn(async () => undefined),
        incrementTotalPlayCount: vi.fn(async () => undefined),
      } as never,
      {
        getRecentPlays: vi.fn(async () => []),
        batchInsertPlays: vi.fn(async (p: unknown[]) => p.length),
        removePlaysByIds: vi.fn(async (ids: unknown[]) => ids.length),
      } as never,
      {
        getUserRecentTracksWithMetadata: vi.fn(async () => ({
          tracks: incoming,
          totalPages: 1,
          totalScrobbles: 100 + incomingCount,
        })),
      } as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      } as never,
      recalc,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { updateUser: (id: number) => Promise<unknown> };
    (svc as unknown as { applyIncrementalTopLists: unknown }).applyIncrementalTopLists = apply;
    return { svc, recalc, apply };
  };

  it('splits a 500-play delta into 150-play incremental chunks, never recalc', async () => {
    const { svc, recalc, apply } = makeChunkSvc(500);
    await svc.updateUser(9);
    expect(apply).toHaveBeenCalledTimes(4);
    const sizes = apply.mock.calls.map((c) => (c[1] as unknown[]).length);
    expect(sizes).toEqual([150, 150, 150, 50]);
    expect(recalc).not.toHaveBeenCalled();
  });

  it('falls back to full recalc when a chunk throws', async () => {
    const { svc, recalc, apply } = makeChunkSvc(300, async () => {
      throw new Error('chunk boom');
    });
    await svc.updateUser(9);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(recalc).toHaveBeenCalledTimes(1);
  });
});
