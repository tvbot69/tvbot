import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { UpdateService } from '../lastfm/updateService';
import { IndexService } from '../lastfm/indexService';

const T1 = new Date('2026-03-01T10:00:00.000Z');
const T2 = new Date('2026-03-01T10:00:01.000Z');

interface TrackStub {
  artistName: string;
  albumName?: string;
  name: string;
  timePlayed?: Date;
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
  userOverrides?: Record<string, unknown>;
  cacheGet?: () => Promise<boolean | undefined>;
  genreService?: { getGenresForArtist: ReturnType<typeof vi.fn> };
}) => {
  const setLastUpdate = overrides.setLastUpdate ?? vi.fn(async () => undefined);
  const batchInsert = overrides.batchInsert ?? vi.fn(async (p: unknown[]) => p.length);
  const removeByIds = overrides.removeByIds ?? vi.fn(async (ids: unknown[]) => ids.length);
  const userRepository = {
    getUserById: vi.fn(async () => ({
      userId: 9,
      userNameLastFm: 'deltauser',
      totalPlayCount: overrides.userTotal ?? 100,
      lastUpdate: new Date(Date.now() - 5 * 3600 * 1000),
      lastScrobbleUpdate: new Date(Date.now() - 5 * 3600 * 1000),
      ...overrides.userOverrides,
    })),
    setLastUpdate,
    setLastScrobbleUpdate: vi.fn(async () => undefined),
    updateUserStats: vi.fn(async () => undefined),
    incrementTotalPlayCount: vi.fn(async () => undefined),
  };
  const playRepository = {
    getRecentPlays: vi.fn(async () => overrides.existing ?? []),
    batchInsertPlays: batchInsert,
    removePlaysByIds: removeByIds,
  };
  const lastfmRepository = {
    getUserRecentTracksWithMetadata: vi.fn(async () => ({
      tracks: overrides.incoming ?? [],
      totalPages: 1,
      totalScrobbles: overrides.totalScrobbles ?? 100,
    })),
  };
  const cache = {
    get: vi.fn(async () => overrides.cacheGet?.() ?? undefined),
    set: vi.fn(async () => undefined),
    // Mirrors CacheService.setNX: succeeds when the key is free, so the sync proceeds.
    setNX: vi.fn(async () => true),
    delete: vi.fn(async () => undefined),
  };
  const recalc = vi.fn(async () => undefined);
  const service = new UpdateService(
    userRepository as never,
    playRepository as never,
    lastfmRepository as never,
    cache as never,
    recalc,
    undefined,
    undefined,
    undefined,
    overrides.genreService as never,
  );
  return {
    service,
    setLastUpdate,
    batchInsert,
    removeByIds,
    userRepository,
    playRepository,
    lastfmRepository,
    cache,
    recalc,
  };
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
        // Mirrors CacheService.setNX: succeeds when the key is free, so the sync proceeds.
        setNX: vi.fn(async () => true),
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

describe('UpdateService.updateUserAndGetRecentTracks', () => {
  const makeRecentSvc = (opts: {
    indexPending?: boolean;
    updateInProgress?: boolean;
    deltaTracks?: TrackStub[];
    fallbackTracks?: TrackStub[];
  }) => {
    const fallbackTracks = opts.fallbackTracks ?? [];
    const lastfmRepository = {
      getUserRecentTracks: vi.fn(async () => fallbackTracks),
      getUserRecentTracksWithMetadata: vi.fn(async () => ({
        tracks: opts.deltaTracks ?? [],
        totalPages: 1,
        totalScrobbles: 100,
      })),
    };
    const service = new UpdateService(
      {
        getUserById: vi.fn(async () => ({
          userId: 9,
          userNameLastFm: 'recentuser',
          sessionKey: 'sess-abc',
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
      lastfmRepository as never,
      {
        get: vi.fn(async (key: string) => {
          if (key === 'index-started-9') return opts.indexPending;
          if (key === 'user-9-update-in-progress') return opts.updateInProgress;
          return undefined;
        }),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => true),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
    );
    const user = { userId: 9, userNameLastFm: 'recentuser', sessionKey: 'sess-abc' } as never;
    return { service, lastfmRepository, user, fallbackTracks };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves a lightweight fetch without running the delta sync when a guard key is held', async () => {
    const { service, lastfmRepository, user, fallbackTracks } = makeRecentSvc({
      updateInProgress: true,
      fallbackTracks: [{ name: 'F', artistName: 'A', albumName: '', nowPlaying: false }],
    });

    const res = await service.updateUserAndGetRecentTracks(user);

    expect(res.updateResult).toEqual({ newPlays: 0, removedPlays: 0 });
    expect(res.recentTracks).toEqual(fallbackTracks);
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('returns up to five most recent non-nowPlaying tracks from the delta fetch', async () => {
    const { service, user } = makeRecentSvc({
      deltaTracks: [
        { artistName: 'A', name: 'Live', albumName: '', timePlayed: T1, nowPlaying: true },
        ...Array.from({ length: 6 }, (_, i) => ({
          artistName: 'A',
          name: `S${i}`,
          albumName: '',
          timePlayed: new Date(T1.getTime() + (i + 1) * 1000),
          nowPlaying: false,
        })),
      ],
    });

    const res = await service.updateUserAndGetRecentTracks(user);

    expect(res.recentTracks).toHaveLength(5);
    expect(res.recentTracks.every((t) => !t.nowPlaying)).toBe(true);
    expect(res.updateResult.newPlays).toBe(6);
  });

  it('falls back to a fresh fetch when the delta sync returns no tracks', async () => {
    const { service, user, fallbackTracks } = makeRecentSvc({
      deltaTracks: [],
      fallbackTracks: [{ name: 'F', artistName: 'A', albumName: '', nowPlaying: false }],
    });

    const res = await service.updateUserAndGetRecentTracks(user);

    expect(res.recentTracks).toEqual(fallbackTracks);
    expect(res.updateResult).toEqual({ newPlays: 0, removedPlays: 0, totalScrobbles: 100 });
  });

  it('runs the delta sync despite a pending index when bypassIndexPending is set', async () => {
    const { service, lastfmRepository, user } = makeRecentSvc({
      indexPending: true,
      deltaTracks: [{ artistName: 'A', name: 'X', albumName: '', timePlayed: T1 }],
    });

    const res = await service.updateUserAndGetRecentTracks(user, true);

    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalled();
    expect(res.recentTracks.map((t) => t.name)).toEqual(['X']);
    expect(res.updateResult.newPlays).toBe(1);
  });
});

describe('UpdateService.updateUser guards and error path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeros when the user does not exist', async () => {
    const lastfmRepository = {
      getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    };
    const service = new UpdateService(
      { getUserById: vi.fn(async () => null) } as never,
      {} as never,
      lastfmRepository as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => true),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
    );

    const res = await service.updateUser(42);

    expect(res).toEqual({ newPlays: 0, removedPlays: 0 });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('skips a queue-mode sync for a user updated within the stale threshold', async () => {
    const { service, lastfmRepository } = makeService({});

    const res = await service.updateUser(9, { queue: true });

    expect(res).toEqual({ newPlays: 0, removedPlays: 0 });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('blocks the delta sync while a full index is running', async () => {
    const { service, lastfmRepository } = makeService({ cacheGet: async () => true });

    const res = await service.updateUser(9);

    expect(res).toEqual({ newPlays: 0, removedPlays: 0 });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('returns zeros when another delta sync holds the dedup lock', async () => {
    const lastfmRepository = {
      getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    };
    const service = new UpdateService(
      {
        getUserById: vi.fn(async () => ({
          userId: 9,
          userNameLastFm: 'deltauser',
          totalPlayCount: 100,
          lastUpdate: new Date(Date.now() - 5 * 3600 * 1000),
          lastScrobbleUpdate: new Date(Date.now() - 5 * 3600 * 1000),
        })),
        setLastUpdate: vi.fn(async () => undefined),
        setLastScrobbleUpdate: vi.fn(async () => undefined),
        updateUserStats: vi.fn(async () => undefined),
        incrementTotalPlayCount: vi.fn(async () => undefined),
      } as never,
      {} as never,
      lastfmRepository as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => false),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
    );

    const res = await service.updateUser(9);

    expect(res).toEqual({ newPlays: 0, removedPlays: 0 });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('stamps a retry backoff and returns zeros when the delta fetch throws', async () => {
    const { service, setLastUpdate, lastfmRepository } = makeService({});
    lastfmRepository.getUserRecentTracksWithMetadata.mockRejectedValueOnce(new Error('upstream 500'));

    const res = await service.updateUser(9);

    expect(res).toEqual({ newPlays: 0, removedPlays: 0 });
    const stamped = (setLastUpdate.mock.calls[0] as unknown as [number, Date])[1];
    const elapsed = Date.now() - stamped.getTime();
    expect(elapsed).toBeGreaterThan(46 * 3600 * 1000);
    expect(elapsed).toBeLessThan(48 * 3600 * 1000);
  });
});

describe('UpdateService delta sync data mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes invisible characters and whitespace in stored names', async () => {
    const { service, batchInsert } = makeService({
      existing: [],
      incoming: [
        { artistName: 'A\u200bB', albumName: ' Al \u200cbum ', name: '  X  ', timePlayed: T1 },
      ],
    });

    const res = await service.updateUser(9);

    expect(res.newPlays).toBe(1);
    const inserted = batchInsert.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(inserted[0]).toMatchObject({
      userId: 9,
      artistName: 'AB',
      albumName: 'Al bum',
      trackName: 'X',
      playSource: 'LastFm',
      timePlayed: T1,
    });
  });

  it('maps an empty album name to undefined', async () => {
    const { service, batchInsert } = makeService({
      existing: [],
      incoming: [{ artistName: 'A', albumName: '', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9);

    const inserted = batchInsert.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(inserted[0]!.albumName).toBeUndefined();
  });

  it('filters out nowPlaying tracks before insert', async () => {
    const { service, batchInsert } = makeService({
      existing: [],
      incoming: [
        { artistName: 'A', name: 'Live', albumName: '', timePlayed: T1, nowPlaying: true },
        { artistName: 'B', name: 'Stored', albumName: '', timePlayed: T2 },
      ],
    });

    const res = await service.updateUser(9);

    expect(res.newPlays).toBe(1);
    const inserted = batchInsert.mock.calls[0]![0] as Array<{ trackName: string }>;
    expect(inserted.map((p) => p.trackName)).toEqual(['Stored']);
  });

  it('passes the Last.fm total through in the update result', async () => {
    const { service } = makeService({
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
      totalScrobbles: 555,
    });

    const res = await service.updateUser(9);

    expect(res.totalScrobbles).toBe(555);
  });

  it('trusts the Last.fm total when accurateTotal is set', async () => {
    const { service, userRepository } = makeService({
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9, { accurateTotal: true });

    expect(userRepository.updateUserStats).toHaveBeenCalledWith(9, 100, expect.any(Date));
    expect(userRepository.incrementTotalPlayCount).not.toHaveBeenCalled();
  });

  it('increments by the net delta when the total is not authoritative', async () => {
    const { service, userRepository } = makeService({
      existing: [{ userPlayId: 1n, artistName: 'A', trackName: 'Old', timePlayed: T1 }],
      incoming: [
        { artistName: 'A', name: 'X', timePlayed: T2 },
        { artistName: 'B', name: 'Y', timePlayed: T2 },
      ],
    });

    const res = await service.updateUser(9);

    expect(res.newPlays).toBe(2);
    expect(res.removedPlays).toBe(0);
    expect(userRepository.incrementTotalPlayCount).toHaveBeenCalledWith(9, 2);
    expect(userRepository.updateUserStats).not.toHaveBeenCalled();
  });

  it('falls back to the Last.fm total when the user has no stored count', async () => {
    const { service, userRepository } = makeService({
      userOverrides: { totalPlayCount: undefined },
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9);

    expect(userRepository.updateUserStats).toHaveBeenCalledWith(9, 100, expect.any(Date));
    expect(userRepository.incrementTotalPlayCount).not.toHaveBeenCalled();
  });

  it('resolves a missing scrobble cursor from the latest stored play', async () => {
    const { service, userRepository } = makeService({
      userOverrides: { lastScrobbleUpdate: undefined },
      existing: [{ userPlayId: 1n, artistName: 'A', trackName: 'X', timePlayed: T1 }],
      incoming: [{ artistName: 'A', name: 'Y', timePlayed: T2 }],
    });

    await service.updateUser(9);

    await vi.waitFor(() => {
      expect(userRepository.setLastScrobbleUpdate).toHaveBeenCalledWith(9, T1);
    });
  });

  it('fetches a second page when the cursor is more than 72h stale', async () => {
    const staleUser = {
      userId: 9,
      userNameLastFm: 'deltauser',
      totalPlayCount: 100,
      lastUpdate: new Date(Date.now() - 5 * 3600 * 1000),
      lastScrobbleUpdate: new Date(Date.now() - 100 * 3600 * 1000),
    };
    const pageOne = Array.from({ length: 195 }, (_, i) => ({
      artistName: 'A',
      name: `P1-${i}`,
      albumName: '',
      timePlayed: new Date(Date.now() - i * 60000),
      nowPlaying: false,
    }));
    const lastfm = vi.fn(async (_u: string, _c: number, page: number) =>
      page === 1
        ? { tracks: pageOne, totalPages: 2, totalScrobbles: 196 }
        : { tracks: [{ artistName: 'A', name: 'P2', albumName: '', timePlayed: new Date(), nowPlaying: false }], totalPages: 2, totalScrobbles: 196 },
    );
    const service = new UpdateService(
      {
        getUserById: vi.fn(async () => staleUser),
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
      { getUserRecentTracksWithMetadata: lastfm } as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => true),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
    );

    await service.updateUser(9);

    expect(lastfm).toHaveBeenCalledTimes(2);
    expect(lastfm.mock.calls[1]![2]).toBe(2);
  });

  it('stops paginating when a page comes back nearly empty', async () => {
    const lastfm = vi.fn(async () => ({
      tracks: Array.from({ length: 10 }, (_, i) => ({
        artistName: 'A',
        name: `S${i}`,
        albumName: '',
        timePlayed: new Date(Date.now() - i * 60000),
        nowPlaying: false,
      })),
      totalPages: 5,
      totalScrobbles: 100,
    }));
    const service = new UpdateService(
      {
        getUserById: vi.fn(async () => ({
          userId: 9,
          userNameLastFm: 'puser',
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
      { getUserRecentTracksWithMetadata: lastfm } as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => true),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
    );

    const res = await service.updateUser(9);

    expect(lastfm).toHaveBeenCalledTimes(1);
    expect(res.newPlays).toBe(10);
  });

  it('drops the timeFrom window and caps the count when accurateTotal is set', async () => {
    const { service, lastfmRepository } = makeService({
      userOverrides: { lastScrobbleUpdate: new Date(Date.now() - 3600 * 1000) },
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: new Date() }],
    });

    await service.updateUser(9, { accurateTotal: true });

    const args = lastfmRepository.getUserRecentTracksWithMetadata.mock.calls[0] as unknown as [
      string,
      number,
      number,
      number | undefined,
    ];
    expect(args[1]).toBe(180);
    expect(args[3]).toBeUndefined();
  });

  it('invalidates the cached alltime top-artists key after a sync with changes', async () => {
    const { service, cache } = makeService({
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9);

    expect(cache.delete).toHaveBeenCalledWith('user-9-topartists-alltime');
  });

  it('warms the genre cache for distinct artists on new plays', async () => {
    const getGenresForArtist = vi.fn(async () => []);
    const { service } = makeService({
      existing: [],
      incoming: [
        { artistName: 'A', name: 'X', timePlayed: T1 },
        { artistName: 'B', name: 'Y', timePlayed: T2 },
        { artistName: 'A', name: 'Z', timePlayed: T2 },
      ],
      genreService: { getGenresForArtist },
    });

    await service.updateUser(9);

    await vi.waitFor(() => {
      expect(getGenresForArtist).toHaveBeenCalledWith('A');
      expect(getGenresForArtist).toHaveBeenCalledWith('B');
    });
    expect(getGenresForArtist).toHaveBeenCalledTimes(2);
  });

  it('passes the user session key through to Last.fm', async () => {
    const { service, lastfmRepository } = makeService({
      userOverrides: { sessionKey: 'sess-abc' },
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9);

    const args = lastfmRepository.getUserRecentTracksWithMetadata.mock.calls[0] as unknown as unknown[];
    expect(args[4]).toBe('sess-abc');
  });

  it('advances the scrobble cursor to the newest inserted play', async () => {
    const { service, userRepository } = makeService({
      existing: [],
      incoming: [
        { artistName: 'A', name: 'X', timePlayed: T1 },
        { artistName: 'B', name: 'Y', timePlayed: T2 },
      ],
    });

    await service.updateUser(9);

    expect(userRepository.setLastScrobbleUpdate).toHaveBeenCalledWith(9, T2);
  });

  it('applies incremental artist/album/track deltas when repositories are available', async () => {
    const applyArtistDeltas = vi.fn(async () => undefined);
    const applyAlbumDeltas = vi.fn(async () => undefined);
    const applyTrackDeltas = vi.fn(async () => undefined);
    const artistRepository = {
      getOrCreateArtistsBulk: vi.fn(async (names: string[]) => new Map(names.map((n) => [n.toLowerCase(), 1]))),
    };
    const albumRepository = {
      getOrCreateAlbumsBulk: vi.fn(
        async (inputs: Array<{ albumName: string; artistId: number }>) =>
          new Map(inputs.map((i) => [`${i.artistId}|${i.albumName.toLowerCase()}`, 10])),
      ),
    };
    const trackRepository = {
      getOrCreateTracksBulk: vi.fn(
        async (inputs: Array<{ trackName: string; artistId: number }>) =>
          new Map(inputs.map((i) => [`${i.artistId}|${i.trackName.toLowerCase()}`, 100])),
      ),
    };
    const service = new UpdateService(
      {
        getUserById: vi.fn(async () => ({
          userId: 9,
          userNameLastFm: 'incuser',
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
        applyArtistDeltas,
        applyAlbumDeltas,
        applyTrackDeltas,
      } as never,
      {
        getUserRecentTracksWithMetadata: vi.fn(async () => ({
          tracks: [
            { artistName: 'A', name: 'X', albumName: 'Alb', timePlayed: T2, nowPlaying: false },
            { artistName: 'B', name: 'Y', timePlayed: T2, nowPlaying: false },
          ],
          totalPages: 1,
          totalScrobbles: 100,
        })),
      } as never,
      {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        setNX: vi.fn(async () => true),
        delete: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined),
      artistRepository as never,
      albumRepository as never,
      trackRepository as never,
    );

    const res = await service.updateUser(9);

    expect(res.newPlays).toBe(2);
    expect(applyArtistDeltas).toHaveBeenCalledTimes(1);
    expect(applyAlbumDeltas).toHaveBeenCalledTimes(1);
    expect(applyTrackDeltas).toHaveBeenCalledTimes(1);
  });

  it('falls back to a full recalc when repositories are not available', async () => {
    const { service, recalc } = makeService({
      existing: [],
      incoming: [{ artistName: 'A', name: 'X', timePlayed: T1 }],
    });

    await service.updateUser(9);

    expect(recalc).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateService.needsUpdate', () => {
  const baseUser: { userId: number; userNameLastFm: string } = { userId: 1, userNameLastFm: 'u' };

  it('is true when lastUpdate is missing', () => {
    expect(UpdateService.needsUpdate(baseUser as never)).toBe(true);
  });

  it('is true when the last update is older than the threshold', () => {
    const user = { ...baseUser, lastUpdate: new Date(Date.now() - 10 * 60 * 1000) };
    expect(UpdateService.needsUpdate(user as never, 5)).toBe(true);
  });

  it('is false when the last update is within the threshold', () => {
    const user = { ...baseUser, lastUpdate: new Date(Date.now() - 60 * 1000) };
    expect(UpdateService.needsUpdate(user as never, 5)).toBe(false);
  });

  it('is true when lastUpdate is unreadable', () => {
    const user = { ...baseUser, lastUpdate: 'not-a-date' as unknown as Date };
    expect(UpdateService.needsUpdate(user as never)).toBe(true);
  });
});
