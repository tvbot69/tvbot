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
