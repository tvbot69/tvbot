import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
// `modularUpdate` reaches a MODULE-LEVEL prisma singleton for its top-list
// steps, so an unmocked import would open a real connection mid-unit-test.
// Stubbing the module is what keeps this file a unit test; the raw SQL itself
// is covered by indexService.db.test.ts against a real database.
vi.mock('@persistence/prismaClient', () => ({
  prisma: {
    $transaction: vi.fn(async () => undefined),
    userArtist: { deleteMany: vi.fn(), createMany: vi.fn() },
    userAlbum: { deleteMany: vi.fn(), createMany: vi.fn() },
    userTrack: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
}));
vi.mock('@persistence/repositories/playRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@persistence/repositories/playRepository')>();
  return { ...actual, PlayRepository: actual.PlayRepository };
});
import { IndexService } from '@bot/services/lastfm/indexService';

/**
 * indexService was 45% and sits directly on the data-integrity path: it is
 * what writes a user's play history, and a duplicate here is a duplicate that
 * never goes away.
 *
 * The two rules worth pinning:
 *
 *  1. `indexUser` uses `setNX`, NOT get-then-set. Two commands fired together
 *     would both see the key missing and both start - the same race shape the
 *     delta-sync guard had. The key is released in a `finally`, so a crash
 *     cannot wedge a user permanently.
 *
 *  2. `flushPendingPlays` deduplicates against BOTH the database and the batch
 *     being inserted. The in-batch set is the part that is easy to miss: a
 *     user whose history has two identical rows would otherwise insert both
 *     and defeat the database index on the very insert meant to be safe.
 */

const build = (over: Record<string, unknown> = {}) => {
  const indexQueue = {
    enqueue: vi.fn(() => true),
    registerProcessor: vi.fn(),
    ...(over.indexQueue as object),
  };
  const cache = {
    setNX: vi.fn(async () => true),
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    ...(over.cache as object),
  };
  const userRepository = {
    getUserById: vi.fn(async () => ({ userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', lastIndexed: null })),
    ...(over.userRepository as object),
  };
  const artistRepository = { getOrCreateArtistsBulk: vi.fn(async () => new Map([['radiohead', 1]])), ...(over.artistRepository as object) };
  const albumRepository = { getOrCreateAlbumsBulk: vi.fn(async () => new Map([['1|ok computer', 2]])), ...(over.albumRepository as object) };
  const trackRepository = { getOrCreateTracksBulk: vi.fn(async () => new Map([['1|airbag', 3]])), ...(over.trackRepository as object) };
  const playRepository = {
    findExistingPlayKeys: vi.fn(async () => new Set<string>()),
    batchInsertPlays: vi.fn(async () => 1),
    ...(over.playRepository as object),
  };
  const lastfmRepository = {
    getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    getTopArtists: vi.fn(async () => []),
    getTopAlbums: vi.fn(async () => []),
    getTopTracks: vi.fn(async () => []),
    ...(over.lastfmRepository as object),
  };
  const service = new IndexService(
    indexQueue as never, cache as never, userRepository as never, artistRepository as never,
    albumRepository as never, trackRepository as never, playRepository as never, lastfmRepository as never,
  );
  return { service, indexQueue, cache, userRepository, playRepository, lastfmRepository, artistRepository };
};

const play = (i: number, over: Record<string, unknown> = {}) => ({
  name: `Track ${i}`,
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  timePlayed: new Date(Date.UTC(2020, 0, 1, 0, 0, i)),
  nowPlaying: false,
  ...over,
});

const page = (tracks: unknown[], totalPages = 1) => ({ tracks, totalPages, totalScrobbles: tracks.length });

beforeEach(() => vi.clearAllMocks());

describe('IndexService constructor and queue wiring', () => {
  it('registers its processor on the queue at construction', () => {
    const { indexQueue } = build();
    expect(indexQueue.registerProcessor).toHaveBeenCalledTimes(1);
  });

  it('enqueues with the indexQueue flag the skip-check keys off', () => {
    const { service, indexQueue } = build();
    expect(service.enqueueUser(7)).toBe(true);
    expect(indexQueue.enqueue).toHaveBeenCalledWith({ userId: 7, indexQueue: true });
  });
});

describe('IndexService.indexUser concurrency guard', () => {
  it('skips entirely when the lock is already held', async () => {
    // The duplicate-play race: two commands, two index runs, two copies of
    // every scrobble. setNX makes the second one a no-op. This case never
    // reaches modularUpdate, so it needs no database.
    const { service, cache, userRepository } = build();
    (cache.setNX as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await service.indexUser(1);
    expect(userRepository.getUserById).not.toHaveBeenCalled();
  });

  it('releases the lock when the user does not exist', async () => {
    const { service, cache, userRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await service.indexUser(99);
    expect(cache.delete).toHaveBeenCalled();
  });
});
describe('IndexService.processQueuedItem', () => {
  it('does nothing for a user that no longer exists', async () => {
    const { service, userRepository, lastfmRepository } = build();
    (userRepository.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await service.processQueuedItem({ userId: 404, indexQueue: true });
    expect(lastfmRepository.getUserRecentTracksWithMetadata).not.toHaveBeenCalled();
  });
});
describe('IndexService.fetchAndStorePlays', () => {
  const fetch = (service: unknown) =>
    (service as { fetchAndStorePlays(u: number, n: string, s?: string): Promise<{ inserted: number; pages: number; seen: number }> })
      .fetchAndStorePlays(1, 'DreadRock', 'SK');

  it('stops on an empty page rather than looping to the cap', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(page([], 0));
    const result = await fetch(service);
    // `pages` is `page - 1` and the empty page breaks BEFORE `page++`, so this
    // is 0 completed pages. The property that matters is that it stopped at
    // all, rather than walking to the 1000-page cap.
    expect(result.pages).toBe(0);
    expect(result.seen).toBe(0);
  });

  it('flushes partial progress then throws on outage mid-run', async () => {
    const { LastFmUnavailableError } = await import('@domain/models/errors/lastfmUnavailableError');
    const { service, lastfmRepository, playRepository } = build();
    const fullPage = Array.from({ length: 1000 }, (_, i) => play(i));
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page(fullPage, 5))
      .mockRejectedValueOnce(new LastFmUnavailableError('user.getrecenttracks', new Error('down')));
    await expect(fetch(service)).rejects.toBeInstanceOf(LastFmUnavailableError);
    expect(playRepository.batchInsertPlays).toHaveBeenCalled();
  });

  it('never stores a now-playing entry, which is not a scrobble', async () => {
    // A now-playing track has no timestamp and is not a play. Storing it
    // would inflate every count by one.
    const { service, lastfmRepository, playRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(
      page([play(1, { nowPlaying: true, timePlayed: undefined })]),
    );
    await fetch(service);
    expect(playRepository.batchInsertPlays).not.toHaveBeenCalled();
  });

  it('never stores a track with no timestamp', async () => {
    const { service, lastfmRepository, playRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(
      page([play(1, { timePlayed: undefined })]),
    );
    await fetch(service);
    expect(playRepository.batchInsertPlays).not.toHaveBeenCalled();
  });

  it('inserts the plays it received', async () => {
    const { service, lastfmRepository, playRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(page([play(1), play(2)]));
    const result = await fetch(service);
    expect(playRepository.batchInsertPlays).toHaveBeenCalled();
    expect(result.inserted).toBe(1);
  });

  it('stops at the reported total page count', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(page([play(1)], 3));
    // One short page is fetched (page becomes 2), then the short-page check
    // breaks, so exactly one page completed.
    const result = await fetch(service);
    expect(result.pages).toBe(1);
  });

  it('never runs away with the cap when totalPages is missing', async () => {
    const { service, lastfmRepository } = build();
    // totalPages 0 means "unknown"; the short-page check has to end it, or a
    // 1000-page cap turns one bad response into a runaway.
    (lastfmRepository.getUserRecentTracksWithMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(page([play(1)], 0));
    const result = await fetch(service);
    expect(result.pages).toBe(1);
  });
});

describe('IndexService.flushPendingPlays dedup', () => {
  const flush = (service: unknown, plays: unknown[]) =>
    (service as { flushPendingPlays(u: number, p: never[]): Promise<number> }).flushPendingPlays(1, plays as never[]);

  const row = (i: number) => ({
    userId: 1, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: new Date(Date.UTC(2020, 0, 1, 0, 0, i)), playSource: 'LastFm' as const,
  });

  it('returns 0 for an empty batch without querying the database', async () => {
    const { service, playRepository } = build();
    await expect(flush(service, [])).resolves.toBe(0);
    expect(playRepository.findExistingPlayKeys).not.toHaveBeenCalled();
  });

  it('inserts everything when nothing is already stored', async () => {
    const { service, playRepository } = build();
    await flush(service, [row(1), row(2)]);
    const inserted = (playRepository.batchInsertPlays as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(inserted).toHaveLength(2);
  });

  it('skips a play already present in the database', async () => {
    const { service, playRepository } = build();
    // Rebuild the key the same way the repository does.
    const { PlayRepository } = await import('@persistence/repositories/playRepository');
    const key = PlayRepository.playKey(row(1).timePlayed, 'Radiohead', 'Airbag');
    (playRepository.findExistingPlayKeys as ReturnType<typeof vi.fn>).mockResolvedValue(new Set([key]));

    await flush(service, [row(1), row(2)]);

    const inserted = (playRepository.batchInsertPlays as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(inserted).toHaveLength(1);
  });

  it('collapses two identical plays WITHIN the batch', async () => {
    // The in-batch guard. Without it, a history containing the same row twice
    // would insert both, defeating the database index on the very insert
    // meant to be safe.
    const { service, playRepository } = build();
    await flush(service, [row(1), row(1), row(2)]);
    const inserted = (playRepository.batchInsertPlays as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(inserted).toHaveLength(2);
  });

  it('does not insert at all when every play is already stored', async () => {
    const { service, playRepository } = build();
    const { PlayRepository } = await import('@persistence/repositories/playRepository');
    const key = PlayRepository.playKey(row(1).timePlayed, 'Radiohead', 'Airbag');
    (playRepository.findExistingPlayKeys as ReturnType<typeof vi.fn>).mockResolvedValue(new Set([key]));

    await expect(flush(service, [row(1)])).resolves.toBe(0);
    expect(playRepository.batchInsertPlays).not.toHaveBeenCalled();
  });

  it('queries the existing keys over the batch time range', async () => {
    const { service, playRepository } = build();
    await flush(service, [row(1), row(5)]);
    const [userId, from, to] = (playRepository.findExistingPlayKeys as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userId).toBe(1);
    expect((from as Date).getTime()).toBeLessThanOrEqual((to as Date).getTime());
  });
});

