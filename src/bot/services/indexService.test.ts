import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { IndexService } from './indexService';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { UpdateType } from '@domain/enums/updateType';

const T1 = new Date('2026-01-01T10:00:00.000Z');
const T2 = new Date('2026-01-02T10:00:00.000Z');

const recentPage = () => ({
  tracks: [
    { artistName: 'Mond', albumName: 'Album', name: 'Esme', timePlayed: T1 },
    { artistName: 'Mond', albumName: 'Album', name: 'Dede', timePlayed: T2 },
  ],
  totalPages: 1,
});

const makeService = (overrides: {
  existingKeys?: Set<string>;
  fetchImpl?: () => Promise<unknown>;
  updateLastIndexed?: ReturnType<typeof vi.fn>;
  batchInsert?: ReturnType<typeof vi.fn>;
}) => {
  const batchInsert =
    overrides.batchInsert ?? vi.fn(async () => 1);
  const updateLastIndexed =
    overrides.updateLastIndexed ?? vi.fn(async () => undefined);
  const service = new IndexService(
    { enqueue: vi.fn(), registerProcessor: vi.fn() } as never,
    { get: vi.fn().mockResolvedValue(undefined), set: vi.fn(), delete: vi.fn() } as never,
    {
      getUserById: vi.fn().mockResolvedValue({ userId: 7, userNameLastFm: 'testuser', sessionKey: 'sk' }),
      updateUserStats: vi.fn().mockResolvedValue(undefined),
      setUserRegisteredLfm: vi.fn().mockResolvedValue(undefined),
      updateLastIndexed,
    } as never,
    { getOrCreateArtistsBulk: vi.fn().mockResolvedValue(new Map()) } as never,
    { getOrCreateAlbumsBulk: vi.fn().mockResolvedValue(new Map()) } as never,
    { getOrCreateTracksBulk: vi.fn().mockResolvedValue(new Map()) } as never,
    {
      findExistingPlayKeys: vi
        .fn()
        .mockResolvedValue(overrides.existingKeys ?? new Set<string>()),
      batchInsertPlays: batchInsert,
    } as never,
    {
      getUserRecentTracksWithMetadata: overrides.fetchImpl ?? vi.fn(async () => recentPage()),
      getTopArtists: vi.fn().mockResolvedValue([]),
      getTopAlbums: vi.fn().mockResolvedValue([]),
      getTopTracks: vi.fn().mockResolvedValue([]),
      getUserInfo: vi.fn().mockResolvedValue(null),
    } as never,
  );
  return { service, batchInsert, updateLastIndexed };
};

describe('IndexService resumable indexing', () => {
  it('skips already-stored plays instead of duplicating them (no wipe needed)', async () => {
    const existing = new Set([PlayRepository.playKey(T1, 'Mond', 'Esme')]);
    const { service, batchInsert } = makeService({ existingKeys: existing });

    const stats = await service.modularUpdate(
      { userId: 7, userNameLastFm: 'testuser' },
      UpdateType.Command,
    );

    expect(stats.error).toBeUndefined();
    expect(batchInsert).toHaveBeenCalledTimes(1);
    const inserted = batchInsert.mock.calls[0]![0] as Array<{ trackName?: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.trackName).toBe('Dede');
  });

  it('inserts everything on a fresh database', async () => {
    const { service, batchInsert } = makeService({});

    await service.modularUpdate(
      { userId: 7, userNameLastFm: 'testuser' },
      UpdateType.Command,
    );

    const inserted = batchInsert.mock.calls[0]![0] as Array<unknown>;
    expect(inserted).toHaveLength(2);
  });

  it('does not mark lastIndexed when the fetch fails (retry stays possible)', async () => {
    const updateLastIndexed = vi.fn(async () => undefined);
    const { service } = makeService({
      updateLastIndexed,
      fetchImpl: vi.fn(async () => {
        throw new Error('last.fm down');
      }),
    });

    const stats = await service.modularUpdate(
      { userId: 7, userNameLastFm: 'testuser' },
      UpdateType.Command,
    );

    expect(stats.error).toBe(true);
    expect(updateLastIndexed).not.toHaveBeenCalled();
  });
});
