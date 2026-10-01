import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// `modularUpdate` reaches a MODULE-LEVEL prisma singleton for its top-list
// steps, so an unmocked import would open a real connection mid-unit-test.
// `vi.hoisted` so these are the very same function objects the module under
// test closes over - the assertions below read their arguments.
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(async () => undefined),
  userArtist: { deleteMany: vi.fn(), createMany: vi.fn() },
  userAlbum: { deleteMany: vi.fn(), createMany: vi.fn() },
  userTrack: { deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: prismaMock }));
vi.mock('@persistence/repositories/playRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@persistence/repositories/playRepository')>();
  return { ...actual, PlayRepository: actual.PlayRepository };
});

import { IndexService } from '../lastfm/indexService';
import { UpdateType } from '@domain/enums/updateType';

/**
 * `modularUpdate` is the function that decides whether a user counts as
 * INDEXED, and it is the one place in the bot where a quiet failure is
 * permanent rather than cosmetic. The `lastIndexed` stamp is what the
 * stale-index sweep reads: stamp it and the user is never retried, do not
 * stamp it and they are.
 *
 * The property, in both directions:
 *
 *   - a section that failed leaves `error` set and `lastIndexed` untouched,
 *     so the sweep picks the user back up;
 *   - a run where every provider answered (including "no top artists at
 *     all") stamps `lastIndexed` and reports no error, because a user who
 *     has genuinely never played anything must not be retried forever.
 *
 * Each of the four sections also has its OWN try. That is load-bearing for a
 * different reason: a Last.fm outage raises rather than returning `[]`, so a
 * single shared try would abort the whole method and the user would look
 * neither indexed nor failed.
 */

type Repo = Record<string, unknown>;

const build = (over: Record<string, unknown> = {}) => {
  const indexQueue = { enqueue: vi.fn(() => true), registerProcessor: vi.fn(), ...(over.indexQueue as Repo) };
  const cache = {
    setNX: vi.fn(async () => true),
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    ...(over.cache as Repo),
  };
  const userRepository = {
    getUserById: vi.fn(async () => ({
      userId: 7,
      userNameLastFm: 'DreadRock',
      sessionKey: 'SK',
      lastIndexed: null,
      registeredLastFm: true,
    })),
    updateUserStats: vi.fn(async () => undefined),
    setUserRegisteredLfm: vi.fn(async () => undefined),
    updateLastIndexed: vi.fn(async () => undefined),
    ...(over.userRepository as Repo),
  };
  // All three bulk resolvers DE-DUPLICATE their input before assigning ids:
  // `getOrCreateArtistsBulk` does `[...new Set(names.map(lowercase))]`
  // (artistRepository.ts:30) and the album/track pair key on
  // `artistId|lowercasedName` into a `Map` first (albumRepository.ts:73,
  // trackRepository.ts:52). A last-write-wins double would hand the same artist
  // a different id depending on which of the three rollups mentioned them last,
  // so `recalculateTopLists` would write three ids for one artist — a shape the
  // real database can never return.
  const artistRepository = {
    getOrCreateArtistsBulk: vi.fn(async (names: string[]) => {
      const map = new Map<string, number>();
      [...new Set(names.map((n) => n.toLowerCase()))].forEach((n, i) => map.set(n, i + 1));
      return map;
    }),
    ...(over.artistRepository as Repo),
  };
  const albumRepository = {
    getOrCreateAlbumsBulk: vi.fn(async (rows: Array<{ albumName: string; artistId: number }>) => {
      const map = new Map<string, number>();
      const unique = new Set<string>();
      for (const r of rows) unique.add(`${r.artistId}|${r.albumName.toLowerCase()}`);
      [...unique].forEach((key, i) => map.set(key, 100 + i));
      return map;
    }),
    ...(over.albumRepository as Repo),
  };
  const trackRepository = {
    getOrCreateTracksBulk: vi.fn(async (rows: Array<{ trackName: string; artistId: number }>) => {
      const map = new Map<string, number>();
      const unique = new Set<string>();
      for (const r of rows) unique.add(`${r.artistId}|${r.trackName.toLowerCase()}`);
      [...unique].forEach((key, i) => map.set(key, 200 + i));
      return map;
    }),
    ...(over.trackRepository as Repo),
  };
  const playRepository = {
    findExistingPlayKeys: vi.fn(async () => new Set<string>()),
    batchInsertPlays: vi.fn(async () => 1),
    getRawTopArtistNames: vi.fn(async () => []),
    getRawTopAlbumEntries: vi.fn(async () => []),
    getRawTopTrackEntries: vi.fn(async () => []),
    replaceUserArtists: vi.fn(async () => undefined),
    replaceUserAlbums: vi.fn(async () => undefined),
    replaceUserTracks: vi.fn(async () => undefined),
    ...(over.playRepository as Repo),
  };
  const lastfmRepository = {
    getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    getTopArtists: vi.fn(async () => []),
    getTopAlbums: vi.fn(async () => []),
    getTopTracks: vi.fn(async () => []),
    getUserInfo: vi.fn(async () => ({ playCount: 4242, registeredAt: new Date('2010-01-01') })),
    ...(over.lastfmRepository as Repo),
  };
  const service = new IndexService(
    indexQueue as never,
    cache as never,
    userRepository as never,
    artistRepository as never,
    albumRepository as never,
    trackRepository as never,
    playRepository as never,
    lastfmRepository as never,
  );
  return { service, userRepository, artistRepository, albumRepository, trackRepository, playRepository, lastfmRepository };
};

const USER = { userId: 7, userNameLastFm: 'DreadRock' };

const topArtist = (name: string, playcount = 10) => ({ name, playcount });
const topAlbum = (name: string, artistName: string, playcount = 10) => ({ name, artistName, playcount });
const topTrack = (name: string, artistName: string, playcount = 10) => ({ name, artistName, playcount });

/** The rows the prisma `createMany` for one rollup was called with. */
const createManyData = (model: 'userArtist' | 'userAlbum' | 'userTrack'): Array<Record<string, unknown>> =>
  (prismaMock[model].createMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.data as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockResolvedValue(undefined);
});

describe('IndexService.modularUpdate — step selection', () => {
  it('runs all four sections for a Full index', async () => {
    const { service, lastfmRepository } = build();
    await service.modularUpdate(USER, UpdateType.Full);
    expect(lastfmRepository.getUserRecentTracksWithMetadata).toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).toHaveBeenCalled();
    expect(lastfmRepository.getTopAlbums).toHaveBeenCalled();
    expect(lastfmRepository.getTopTracks).toHaveBeenCalled();
  });

  it('runs only the artist section when only Artists was asked for', async () => {
    // The cron and the command paths both narrow the type, so a narrow request
    // must not silently reach every other Last.fm endpoint.
    const { service, lastfmRepository } = build();
    await service.modularUpdate(USER, UpdateType.Artists);
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledTimes(1);
    expect(lastfmRepository.getTopAlbums).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopTracks).not.toHaveBeenCalled();
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('reads the all-time top list regardless of the requested step', async () => {
    const { service, lastfmRepository } = build();
    await service.modularUpdate(USER, UpdateType.Artists);
    const call = (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe('AllTime');
    expect(call[2]).toBe(1000);
  });

  it('reports a user that vanished between enqueue and run as an error', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const stats = await service.modularUpdate(USER, UpdateType.Full);

    expect(stats).toEqual({ durationSec: '0.0', error: true });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });
});

describe('IndexService.modularUpdate — top artists rollup', () => {
  it('writes one row per artist and reports the count', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      topArtist('Radiohead', 500),
      topArtist('Portishead', 300),
    ]);

    const stats = await service.modularUpdate(USER, UpdateType.Artists);

    expect(stats.artistCount).toBe(2);
    const data = createManyData('userArtist');
    expect(data).toHaveLength(2);
    expect(data.map((r) => r.name).sort()).toEqual(['Portishead', 'Radiohead']);
  });

  it('replaces the previous rollup in one transaction rather than appending', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([topArtist('Radiohead')]);

    await service.modularUpdate(USER, UpdateType.Artists);

    const ops = (prismaMock.$transaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as unknown[];
    expect(ops).toHaveLength(2);
    expect(prismaMock.userArtist.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect((prismaMock.userArtist.createMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.skipDuplicates).toBe(true);
  });

  it('sums two spellings of the same artist instead of writing both', async () => {
    // Two rollup rows for one id would double-count every who-knows rank.
    const { service, lastfmRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 5]]));
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      topArtist('Radiohead', 500),
      topArtist('radiohead', 12),
    ]);

    const stats = await service.modularUpdate(USER, UpdateType.Artists);

    expect(stats.artistCount).toBe(1);
    expect(createManyData('userArtist')[0]?.playcount).toBe(512);
  });

  it('keeps the largest-count row when spellings merge', async () => {
    const { service, lastfmRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 5]]));
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      topArtist('Radiohead', 7),
      topArtist('RADIOHEAD', 99),
    ]);

    await service.modularUpdate(USER, UpdateType.Artists);

    expect(createManyData('userArtist')[0]?.name).toBe('RADIOHEAD');
  });

  it('skips an artist the database could not resolve rather than inventing an id', async () => {
    const { service, lastfmRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['portishead', 1]]));
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([
      topArtist('Radiohead'),
      topArtist('Portishead'),
    ]);

    const stats = await service.modularUpdate(USER, UpdateType.Artists);

    expect(stats.artistCount).toBe(1);
    expect(createManyData('userArtist').map((r) => r.name)).toEqual(['Portishead']);
  });

  it('writes nothing and reports no error for a user with no top artists at all', async () => {
    // The other direction of the A1 pairing. An empty list that RAN is the
    // truth; treating it as a failure would retry the user forever.
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const stats = await service.modularUpdate(USER, UpdateType.Artists);

    expect(stats.error).toBeUndefined();
    expect(stats.artistCount).toBeUndefined();
    expect(userRepository.updateLastIndexed).toHaveBeenCalled();
  });

  it('reports a Last.fm artist outage as an error and leaves the stamp alone', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('last.fm 503'));

    const stats = await service.modularUpdate(USER, UpdateType.Artists);

    expect(stats.error).toBe(true);
    expect(userRepository.updateLastIndexed).not.toHaveBeenCalled();
  });

  it('does not delete the previous rollup when the section failed', async () => {
    // The transaction is what makes delete+create atomic; a failure before it
    // means the old rows are still there and the user is not left empty.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    await service.modularUpdate(USER, UpdateType.Artists);

    expect(prismaMock.userArtist.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('carries on to the other sections after one failed', async () => {
    // A shared try/catch would abort the whole method here, and the user would
    // look neither indexed nor failed.
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([topAlbum('Kid A', 'Radiohead')]);

    const stats = await service.modularUpdate(USER, UpdateType.Full);

    expect(stats.error).toBe(true);
    expect(stats.albumCount).toBe(1);
    expect(lastfmRepository.getTopTracks).toHaveBeenCalled();
  });
});

describe('IndexService.modularUpdate — top albums rollup', () => {
  it('resolves the album through its artist id', async () => {
    const { service, lastfmRepository, albumRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 4]]));
    (albumRepository.getOrCreateAlbumsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['4|kid a', 41]]));
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([topAlbum('Kid A', 'Radiohead')]);

    const stats = await service.modularUpdate(USER, UpdateType.Albums);

    expect(stats.albumCount).toBe(1);
    expect(createManyData('userAlbum')[0]).toMatchObject({ albumId: 41, name: 'Kid A' });
  });

  it('never asks the album repository about an album whose artist is unknown', async () => {
    // artistId 0 is a sentinel, not a row; asking for it would create an
    // orphaned album attached to nothing.
    const { service, lastfmRepository, albumRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([topAlbum('Kid A', 'Nobody')]);

    await service.modularUpdate(USER, UpdateType.Albums);

    expect((albumRepository.getOrCreateAlbumsBulk as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([]);
  });

  it('skips an album the database could not resolve', async () => {
    const { service, lastfmRepository, albumRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 4]]));
    (albumRepository.getOrCreateAlbumsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockResolvedValue([topAlbum('Kid A', 'Radiohead')]);

    const stats = await service.modularUpdate(USER, UpdateType.Albums);

    expect(stats.albumCount).toBe(0);
  });

  it('reports an album outage as an error and leaves the stamp alone', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getTopAlbums as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('last.fm 503'));

    const stats = await service.modularUpdate(USER, UpdateType.Albums);

    expect(stats.error).toBe(true);
    expect(userRepository.updateLastIndexed).not.toHaveBeenCalled();
  });
});

describe('IndexService.modularUpdate — top tracks rollup', () => {
  it('resolves the track through its artist id', async () => {
    const { service, lastfmRepository, trackRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 4]]));
    (trackRepository.getOrCreateTracksBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['4|airbag', 41]]));
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([topTrack('Airbag', 'Radiohead')]);

    const stats = await service.modularUpdate(USER, UpdateType.Tracks);

    expect(stats.trackCount).toBe(1);
    expect(createManyData('userTrack')[0]).toMatchObject({ trackId: 41, name: 'Airbag' });
  });

  it('reports a track outage as an error and leaves the stamp alone', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('last.fm 503'));

    const stats = await service.modularUpdate(USER, UpdateType.Tracks);

    expect(stats.error).toBe(true);
    expect(userRepository.updateLastIndexed).not.toHaveBeenCalled();
  });

  it('still stamps the index when a LATER section fails but an EARLIER one succeeded', async () => {
    // The stamp decision is `!stats.error`, not per-section, so one failure
    // anywhere keeps the user retryable.
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getTopArtists as ReturnType<typeof vi.fn>).mockResolvedValue([topArtist('Radiohead')]);
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));

    await service.modularUpdate(USER, UpdateType.Full);

    expect(userRepository.updateLastIndexed).not.toHaveBeenCalled();
  });
});

describe('IndexService.modularUpdate — the user-info section', () => {
  it('stores the scrobble total and stamps the index on a clean run', async () => {
    const { service, userRepository } = build();

    const stats = await service.modularUpdate(USER, UpdateType.Command);

    expect(stats.totalScrobbles).toBe(4242);
    expect(stats.error).toBeUndefined();
    expect(userRepository.updateUserStats).toHaveBeenCalledWith(7, 4242, expect.any(Date));
    expect(userRepository.updateLastIndexed).toHaveBeenCalledTimes(1);
  });

  it('reports a user-info outage instead of leaving the user looking indexed', async () => {
    // The comment in the source calls this out: this block has its own try
    // because `getUserInfo` raises on an outage, and an escaping throw would
    // skip the stamp entirely.
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('last.fm 503'));

    const stats = await service.modularUpdate(USER, UpdateType.Command);

    expect(stats.error).toBe(true);
    expect(userRepository.updateLastIndexed).not.toHaveBeenCalled();
  });

  it('stamps the index when Last.fm answers "no such user" with null', async () => {
    // A null that RAN is an answer. Reading it as an outage would retry a
    // deleted Last.fm account for ever.
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const stats = await service.modularUpdate(USER, UpdateType.Command);

    expect(stats.error).toBeUndefined();
    expect(userRepository.updateLastIndexed).toHaveBeenCalled();
  });

  it('backfills the registration date for a user who has never been linked', async () => {
    const { service, userRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', sessionKey: 'SK', lastIndexed: null, registeredLastFm: false,
    });

    await service.modularUpdate(USER, UpdateType.Command);

    expect(userRepository.setUserRegisteredLfm).toHaveBeenCalledWith(7, new Date('2010-01-01'));
  });

  it('does not re-backfill a user who is already linked', async () => {
    const { service, userRepository } = build();

    await service.modularUpdate(USER, UpdateType.Command);

    expect(userRepository.setUserRegisteredLfm).not.toHaveBeenCalled();
  });

  it('does not backfill when Last.fm gives no registration date', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', sessionKey: 'SK', lastIndexed: null, registeredLastFm: false,
    });
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ playCount: 10, registeredAt: null });

    await service.modularUpdate(USER, UpdateType.Command);

    expect(userRepository.setUserRegisteredLfm).not.toHaveBeenCalled();
  });

  it('reports a statistics write failure as an error', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'));
    (userRepository.updateUserStats as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const stats = await service.modularUpdate(USER, UpdateType.Command);

    expect(stats.error).toBe(true);
  });

  it('always reports a duration, so the caller can log how long a run took', async () => {
    const { service } = build();
    const stats = await service.modularUpdate(USER, UpdateType.Command);
    expect(stats.durationSec).toMatch(/^\d+\.\d$/);
  });
});

describe('IndexService.recalculateTopLists', () => {
  it('reads all three raw rollups and writes all three back', async () => {
    const { service, playRepository } = build();
    (playRepository.getRawTopArtistNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Radiohead', playcount: 5 }]);
    (playRepository.getRawTopAlbumEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Kid A', artistName: 'Radiohead', playcount: 3 }]);
    (playRepository.getRawTopTrackEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Airbag', artistName: 'Radiohead', playcount: 2 }]);

    await service.recalculateTopLists(7);

    expect(playRepository.getRawTopArtistNames).toHaveBeenCalledWith(7);
    expect(playRepository.replaceUserArtists).toHaveBeenCalledWith(7, [
      { artistId: 1, name: 'Radiohead', playcount: 5 },
    ]);
    expect(playRepository.replaceUserAlbums).toHaveBeenCalled();
    expect(playRepository.replaceUserTracks).toHaveBeenCalled();
  });

  it('resolves the artists of all three rollups in one bulk call', async () => {
    // Three rollups share the artists table; three separate `getOrCreate` calls
    // would triple the work on the reconcile path for the same rows.
    const { service, playRepository, artistRepository } = build();
    (playRepository.getRawTopArtistNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Radiohead', playcount: 5 }]);
    (playRepository.getRawTopAlbumEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Kid A', artistName: 'Radiohead', playcount: 3 }]);
    (playRepository.getRawTopTrackEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Airbag', artistName: 'Radiohead', playcount: 2 }]);

    await service.recalculateTopLists(7);

    expect(artistRepository.getOrCreateArtistsBulk).toHaveBeenCalledTimes(1);
    const asked = (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(asked).toEqual(['Radiohead', 'Radiohead', 'Radiohead']);
  });

  it('drops an entry whose artist cannot be resolved rather than writing id 0', async () => {
    const { service, playRepository, artistRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    (playRepository.getRawTopArtistNames as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Ghost', playcount: 5 }]);

    await service.recalculateTopLists(7);

    expect(playRepository.replaceUserArtists).toHaveBeenCalledWith(7, []);
  });

  it('writes empty rollups for a user with no indexed plays', async () => {
    // A user whose plays were purged must lose their rollups too, not keep a
    // ranking that references plays which no longer exist.
    const { service, playRepository } = build();

    await service.recalculateTopLists(7);

    expect(playRepository.replaceUserArtists).toHaveBeenCalledWith(7, []);
    expect(playRepository.replaceUserAlbums).toHaveBeenCalledWith(7, []);
    expect(playRepository.replaceUserTracks).toHaveBeenCalledWith(7, []);
  });

  it('resolves albums and tracks through the artist id before writing', async () => {
    const { service, playRepository, artistRepository, albumRepository, trackRepository } = build();
    (artistRepository.getOrCreateArtistsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['radiohead', 4]]));
    (albumRepository.getOrCreateAlbumsBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['4|kid a', 41]]));
    (trackRepository.getOrCreateTracksBulk as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['4|airbag', 42]]));
    (playRepository.getRawTopAlbumEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Kid A', artistName: 'Radiohead', playcount: 3 }]);
    (playRepository.getRawTopTrackEntries as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'Airbag', artistName: 'Radiohead', playcount: 2 }]);

    await service.recalculateTopLists(7);

    expect(playRepository.replaceUserAlbums).toHaveBeenCalledWith(7, [
      { albumId: 41, name: 'Kid A', playcount: 3 },
    ]);
    expect(playRepository.replaceUserTracks).toHaveBeenCalledWith(7, [
      { trackId: 42, name: 'Airbag', playcount: 2 },
    ]);
  });

  it('lets a failed raw read propagate instead of writing empty rollups', () => {
    // This is the A1 branch with the worst consequence in the class: a caught
    // failure would REPLACE a user's real ranking with an empty one, and
    // nothing would ever put it back.
    const { service, playRepository } = build();
    (playRepository.getRawTopArtistNames as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection lost'));

    return expect(service.recalculateTopLists(7)).rejects.toThrow('connection lost');
  });
});

describe('IndexService.processQueuedItem — the daily-skip guard', () => {
  it('skips a user who was indexed within the last day', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', lastIndexed: new Date(Date.now() - 3600 * 1000),
    });

    await service.processQueuedItem({ userId: 7, indexQueue: true });

    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });

  it('runs a stale user even when the queue item carries the index flag', async () => {
    // Automatic matches no step bits, so a stale user on the automatic path
    // would be "indexed" without doing anything and never picked up again.
    const { service, userRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', lastIndexed: new Date(Date.now() - 48 * 3600 * 1000),
    });

    await service.processQueuedItem({ userId: 7, indexQueue: true });

    expect(userRepository.updateLastIndexed).toHaveBeenCalled();
  });

  it('does not skip on the 24h boundary being crossed by a millisecond', async () => {
    const { service, userRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', lastIndexed: new Date(Date.now() - 24 * 3600 * 1000 - 1),
    });

    await service.processQueuedItem({ userId: 7, indexQueue: true });

    expect(userRepository.updateLastIndexed).toHaveBeenCalled();
  });

  it('never skips a user whose queue item did not ask to be skipped', async () => {
    const { service, userRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, userNameLastFm: 'DreadRock', lastIndexed: new Date(Date.now() - 60 * 1000),
    });

    await service.processQueuedItem({ userId: 7, indexQueue: false });

    expect(userRepository.updateLastIndexed).toHaveBeenCalled();
  });
});
