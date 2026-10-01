import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { Logger } from '@domain/logger';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';

/**
 * The read paths of playRepository: top-entity rollups, raw groupBy mappers,
 * replace/delete maintenance, delta merge/update/create, and the
 * artistplays/albumplays/trackplays entity queries.
 *
 * The insert path, retry classification, chunking, playKey normalisation and
 * findExistingPlayKeys/removePlaysByIds are covered by the sibling files
 * (playRepository.insert.test.ts, playRepository.unit.test.ts,
 * playRepository.test.ts); this file covers what they do not.
 */

type Delegate = {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
};

const makeDelegate = (): Delegate => ({
  findMany: vi.fn(async () => []),
  findFirst: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  deleteMany: vi.fn(async () => ({ count: 0 })),
  createMany: vi.fn(async () => ({ count: 0 })),
  delete: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  create: vi.fn(async () => ({})),
  groupBy: vi.fn(async () => []),
});

const makePrisma = () => {
  const userPlay = makeDelegate();
  userPlay.groupBy = vi.fn(async () => []);
  const userArtist = makeDelegate();
  const userAlbum = makeDelegate();
  const userTrack = makeDelegate();
  const $queryRawUnsafe = vi.fn(async (): Promise<Array<{ week: number; month: number }>> => []);
  const $transaction = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === 'function') {
      // replaceUserEntities passes a callback receiving the tx client; the
      // tx exposes the same delegates as the root client.
      return (arg as (tx: unknown) => unknown)({ userArtist, userAlbum, userTrack });
    }
    return arg;
  });
  return { userPlay, userArtist, userAlbum, userTrack, $queryRawUnsafe, $transaction };
};

const repo = (p: ReturnType<typeof makePrisma>) => new PlayRepository(p as never);

const at = (s: string) => new Date(s);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlayRepository.getTopArtists', () => {
  it('maps rollup rows to name/entityId/playcount and passes the limit', async () => {
    const p = makePrisma();
    p.userArtist.findMany.mockResolvedValue([
      { name: 'Radiohead', artistId: 5, playcount: 120 },
      { name: 'Muse', artistId: 9, playcount: 80 },
    ]);

    const out = await repo(p).getTopArtists(3, undefined, 5);

    expect(out).toEqual([
      { name: 'Radiohead', entityId: 5, playcount: 120 },
      { name: 'Muse', entityId: 9, playcount: 80 },
    ]);
    expect(p.userArtist.findMany).toHaveBeenCalledWith({
      where: { userId: 3 },
      orderBy: { playcount: 'desc' },
      take: 5,
    });
  });

  it('defaults the limit to 10 when none is given', async () => {
    const p = makePrisma();
    await repo(p).getTopArtists(3);
    expect(p.userArtist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it('returns an empty array when the user has no rollup rows', async () => {
    const p = makePrisma();
    await expect(repo(p).getTopArtists(3)).resolves.toEqual([]);
  });

  it('propagates a prisma failure rather than swallowing it', async () => {
    const p = makePrisma();
    p.userArtist.findMany.mockRejectedValue(new Error('connection reset'));
    await expect(repo(p).getTopArtists(3)).rejects.toThrow('connection reset');
  });
});

describe('PlayRepository.getTopAlbums', () => {
  it('maps rollup rows using albumId as the entity id', async () => {
    const p = makePrisma();
    p.userAlbum.findMany.mockResolvedValue([
      { name: 'OK Computer', albumId: 42, playcount: 64 },
    ]);

    const out = await repo(p).getTopAlbums(7, undefined, 3);

    expect(out).toEqual([{ name: 'OK Computer', entityId: 42, playcount: 64 }]);
    expect(p.userAlbum.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      orderBy: { playcount: 'desc' },
      take: 3,
    });
  });
});

describe('PlayRepository.getTopTracks', () => {
  it('maps rollup rows using trackId as the entity id', async () => {
    const p = makePrisma();
    p.userTrack.findMany.mockResolvedValue([
      { name: 'Airbag', trackId: 101, playcount: 12 },
    ]);

    const out = await repo(p).getTopTracks(1, undefined, 1);

    expect(out).toEqual([{ name: 'Airbag', entityId: 101, playcount: 12 }]);
    expect(p.userTrack.findMany).toHaveBeenCalledWith({
      where: { userId: 1 },
      orderBy: { playcount: 'desc' },
      take: 1,
    });
  });
});

describe('PlayRepository.getRawTopArtistNames', () => {
  it('maps the groupBy result to name/playcount pairs', async () => {
    const p = makePrisma();
    p.userPlay.groupBy.mockResolvedValue([
      { artistName: 'Radiohead', _count: { artistName: 300 } },
      { artistName: 'Muse', _count: { artistName: 210 } },
    ]);

    const out = await repo(p).getRawTopArtistNames(4);

    expect(out).toEqual([
      { name: 'Radiohead', playcount: 300 },
      { name: 'Muse', playcount: 210 },
    ]);
    expect(p.userPlay.groupBy).toHaveBeenCalledWith({
      by: ['artistName'],
      where: { userId: 4 },
      _count: { artistName: true },
      orderBy: { _count: { artistName: 'desc' } },
    });
  });

  it('returns an empty array when the user has no plays', async () => {
    const p = makePrisma();
    await expect(repo(p).getRawTopArtistNames(4)).resolves.toEqual([]);
  });
});

describe('PlayRepository.getRawTopAlbumEntries', () => {
  it('maps groupBy rows and coalesces a null album name to an empty string', async () => {
    const p = makePrisma();
    p.userPlay.groupBy.mockResolvedValue([
      { artistName: 'Radiohead', albumName: 'OK Computer', _count: { albumName: 64 } },
      { artistName: 'Radiohead', albumName: null, _count: { albumName: 3 } },
    ]);

    const out = await repo(p).getRawTopAlbumEntries(2);

    expect(out).toEqual([
      { name: 'OK Computer', artistName: 'Radiohead', playcount: 64 },
      { name: '', artistName: 'Radiohead', playcount: 3 },
    ]);
  });

  it('excludes plays with no album at the query level', async () => {
    const p = makePrisma();
    await repo(p).getRawTopAlbumEntries(2);
    expect(p.userPlay.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 2, albumName: { not: null } } }),
    );
  });
});

describe('PlayRepository.getRawTopTrackEntries', () => {
  it('maps groupBy rows and coalesces a null track name to an empty string', async () => {
    const p = makePrisma();
    p.userPlay.groupBy.mockResolvedValue([
      { artistName: 'Muse', trackName: 'Hysteria', _count: { trackName: 40 } },
      { artistName: 'Muse', trackName: null, _count: { trackName: 1 } },
    ]);

    const out = await repo(p).getRawTopTrackEntries(8);

    expect(out).toEqual([
      { name: 'Hysteria', artistName: 'Muse', playcount: 40 },
      { name: '', artistName: 'Muse', playcount: 1 },
    ]);
  });

  it('excludes plays with no track at the query level', async () => {
    const p = makePrisma();
    await repo(p).getRawTopTrackEntries(8);
    expect(p.userPlay.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 8, trackName: { not: null } } }),
    );
  });
});

describe('PlayRepository.replaceUserArtists', () => {
  it('deletes the old rows and creates the new ones with lowercased names', async () => {
    const p = makePrisma();
    const tx = { userArtist: p.userArtist, userAlbum: p.userAlbum, userTrack: p.userTrack };

    await repo(p).replaceUserArtists(5, [
      { artistId: 1, name: 'Radiohead', playcount: 10 },
      { artistId: 2, name: 'Muse', playcount: 4 },
    ]);

    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(p.userArtist.deleteMany).toHaveBeenCalledWith({ where: { userId: 5 } });
    expect(p.userArtist.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 5, artistId: 1, name: 'radiohead', playcount: 10 },
        { userId: 5, artistId: 2, name: 'muse', playcount: 4 },
      ],
      skipDuplicates: true,
    });
    // The delete must be issued before the create, or a failure between the
    // two leaves the user with no rollup at all.
    const deleteOrder = p.userArtist.deleteMany.mock.invocationCallOrder[0] ?? 0;
    const createOrder = p.userArtist.createMany.mock.invocationCallOrder[0] ?? 0;
    expect(deleteOrder).toBeLessThan(createOrder);
    expect(tx).toBeDefined();
  });
});

describe('PlayRepository.replaceUserAlbums', () => {
  it('targets the userAlbum delegate with albumId as the id field', async () => {
    const p = makePrisma();

    await repo(p).replaceUserAlbums(6, [{ albumId: 9, name: 'OK Computer', playcount: 7 }]);

    expect(p.userAlbum.deleteMany).toHaveBeenCalledWith({ where: { userId: 6 } });
    expect(p.userAlbum.createMany).toHaveBeenCalledWith({
      data: [{ userId: 6, albumId: 9, name: 'ok computer', playcount: 7 }],
      skipDuplicates: true,
    });
  });
});

describe('PlayRepository.replaceUserTracks', () => {
  it('targets the userTrack delegate with trackId as the id field', async () => {
    const p = makePrisma();

    await repo(p).replaceUserTracks(6, [{ trackId: 12, name: 'Airbag', playcount: 3 }]);

    expect(p.userTrack.deleteMany).toHaveBeenCalledWith({ where: { userId: 6 } });
    expect(p.userTrack.createMany).toHaveBeenCalledWith({
      data: [{ userId: 6, trackId: 12, name: 'airbag', playcount: 3 }],
      skipDuplicates: true,
    });
  });
});

describe('PlayRepository.getLastStoredPlayTime', () => {
  it('returns the most recent play time when one exists', async () => {
    const p = makePrisma();
    p.userPlay.findFirst.mockResolvedValue({ timePlayed: at('2026-05-01T12:00:00Z') });

    await expect(repo(p).getLastStoredPlayTime(1)).resolves.toEqual(at('2026-05-01T12:00:00Z'));
    expect(p.userPlay.findFirst).toHaveBeenCalledWith({
      where: { userId: 1 },
      orderBy: { timePlayed: 'desc' },
      select: { timePlayed: true },
    });
  });
});

describe('PlayRepository.deletePlaysBefore', () => {
  it('deletes only plays older than the cutoff for that user', async () => {
    const p = makePrisma();
    const before = at('2026-01-01T00:00:00Z');

    await repo(p).deletePlaysBefore(11, before);

    expect(p.userPlay.deleteMany).toHaveBeenCalledWith({
      where: { userId: 11, timePlayed: { lt: before } },
    });
  });
});

describe('PlayRepository.deleteAllPlaysForUser', () => {
  it('deletes every play for the user with no time filter', async () => {
    const p = makePrisma();

    await repo(p).deleteAllPlaysForUser(12);

    expect(p.userPlay.deleteMany).toHaveBeenCalledWith({ where: { userId: 12 } });
  });
});

describe('PlayRepository.getRecentPlays', () => {
  it('maps stored rows, coalescing null names to undefined', async () => {
    const p = makePrisma();
    p.userPlay.findMany.mockResolvedValue([
      {
        userPlayId: 100n,
        userId: 2,
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        trackName: 'Airbag',
        timePlayed: at('2026-03-01T00:00:00Z'),
        playSource: 'LastFm',
      },
      {
        userPlayId: 101n,
        userId: 2,
        artistName: 'Muse',
        albumName: null,
        trackName: null,
        timePlayed: at('2026-03-02T00:00:00Z'),
        playSource: null,
      },
    ]);

    const out = await repo(p).getRecentPlays(2, 10);

    expect(out).toEqual([
      {
        userPlayId: 100n,
        userId: 2,
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        trackName: 'Airbag',
        timePlayed: at('2026-03-01T00:00:00Z'),
        playSource: 'LastFm',
      },
      {
        userPlayId: 101n,
        userId: 2,
        artistName: 'Muse',
        albumName: undefined,
        trackName: undefined,
        timePlayed: at('2026-03-02T00:00:00Z'),
        playSource: undefined,
      },
    ]);
  });

  it('filters to LastFm-source plays only, newest first', async () => {
    const p = makePrisma();
    await repo(p).getRecentPlays(2, 5);

    expect(p.userPlay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 2, playSource: 'LastFm' },
        orderBy: { timePlayed: 'desc' },
        take: 5,
      }),
    );
  });
});

describe('PlayRepository.applyArtistDeltas merge behaviour', () => {
  it('sums multiple deltas for one id and keeps the first name', async () => {
    const p = makePrisma();
    p.userArtist.findMany.mockResolvedValue([]);

    await repo(p).applyArtistDeltas(3, [
      { name: 'Radiohead', artistId: 5, delta: 2 },
      { name: 'radiohead', artistId: 5, delta: 3 },
    ]);

    // One merged delta of +5, not two separate creates.
    expect(p.userArtist.create).toHaveBeenCalledTimes(1);
    expect(p.userArtist.create).toHaveBeenCalledWith({
      data: { userId: 3, artistId: 5, name: 'radiohead', playcount: 5 },
    });
  });

  it('updates an existing row in place when the result stays positive', async () => {
    const p = makePrisma();
    p.userArtist.findMany.mockResolvedValue([{ artistId: 5, playcount: 10 }]);

    await repo(p).applyArtistDeltas(3, [{ name: 'Radiohead', artistId: 5, delta: 4 }]);

    expect(p.userArtist.update).toHaveBeenCalledWith({
      where: { userId_artistId: { userId: 3, artistId: 5 } },
      data: { playcount: 14 },
    });
    expect(p.$transaction).toHaveBeenCalledTimes(1);
  });

  it('creates a row when the id is new and the delta is positive', async () => {
    const p = makePrisma();
    p.userArtist.findMany.mockResolvedValue([]);

    await repo(p).applyArtistDeltas(3, [{ name: 'Muse', artistId: 9, delta: 1 }]);

    expect(p.userArtist.create).toHaveBeenCalledWith({
      data: { userId: 3, artistId: 9, name: 'muse', playcount: 1 },
    });
  });

  it('does nothing when every delta is zero', async () => {
    const p = makePrisma();

    await repo(p).applyArtistDeltas(3, [{ name: 'X', artistId: 1, delta: 0 }]);

    expect(p.userArtist.findMany).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });
});

describe('PlayRepository.applyAlbumDeltas / applyTrackDeltas', () => {
  it('routes album deltas through the userAlbum delegate', async () => {
    const p = makePrisma();
    p.userAlbum.findMany.mockResolvedValue([]);

    await repo(p).applyAlbumDeltas(4, [{ name: 'A', artistId: 1, albumId: 7, delta: 2 }]);

    expect(p.userAlbum.findMany).toHaveBeenCalledWith({
      where: { userId: 4, albumId: { in: [7] } },
      select: { albumId: true, playcount: true },
    });
    expect(p.userAlbum.create).toHaveBeenCalledWith({
      data: { userId: 4, albumId: 7, name: 'a', playcount: 2 },
    });
  });

  it('routes track deltas through the userTrack delegate', async () => {
    const p = makePrisma();
    p.userTrack.findMany.mockResolvedValue([]);

    await repo(p).applyTrackDeltas(4, [{ name: 'T', artistId: 1, trackId: 8, delta: 3 }]);

    expect(p.userTrack.findMany).toHaveBeenCalledWith({
      where: { userId: 4, trackId: { in: [8] } },
      select: { trackId: true, playcount: true },
    });
    expect(p.userTrack.create).toHaveBeenCalledWith({
      data: { userId: 4, trackId: 8, name: 't', playcount: 3 },
    });
  });
});

describe('PlayRepository.getRecentEntityPlaycounts', () => {
  it('returns week/month counts from the raw query', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockResolvedValue([{ week: 3, month: 12 }]);

    const out = await repo(p).getRecentEntityPlaycounts(1, 'Radiohead');

    expect(out).toEqual({ week: 3, month: 12 });
    expect(p.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(p.userPlay.findMany).not.toHaveBeenCalled();
  });

  it('returns zeros when the raw query returns no rows', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockResolvedValue([]);

    await expect(repo(p).getRecentEntityPlaycounts(1, 'Radiohead')).resolves.toEqual({
      week: 0,
      month: 0,
    });
  });

  it('falls back to a findMany count when the raw query fails', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('syntax error'));
    const now = Date.now();
    const day = 86_400_000;
    p.userPlay.findMany.mockResolvedValue([
      { timePlayed: new Date(now - day) }, // within the week
      { timePlayed: new Date(now - 10 * day) }, // within the month, outside the week
      { timePlayed: new Date(now - 20 * day) }, // within the month
    ]);

    const out = await repo(p).getRecentEntityPlaycounts(1, 'Radiohead', 'OK Computer', 'Airbag');

    expect(out).toEqual({ week: 1, month: 3 });
    expect(p.userPlay.findMany).toHaveBeenCalledTimes(1);
    const arg = p.userPlay.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.albumName).toEqual({ equals: 'OK Computer', mode: 'insensitive' });
    expect(arg.where.trackName).toEqual({ equals: 'Airbag', mode: 'insensitive' });
  });

  it('builds a case-insensitive artist filter when no album/track is given', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom'));
    p.userPlay.findMany.mockResolvedValue([]);

    await repo(p).getRecentEntityPlaycounts(1, 'Radiohead');

    const arg = p.userPlay.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.artistName).toEqual({ equals: 'Radiohead', mode: 'insensitive' });
    expect(arg.where.albumName).toBeUndefined();
    expect(arg.where.trackName).toBeUndefined();
  });
});

describe('PlayRepository.getEntityTotalPlaycount', () => {
  it('returns the stored count for the entity', async () => {
    const p = makePrisma();
    p.userPlay.count.mockResolvedValue(77);

    await expect(repo(p).getEntityTotalPlaycount(2, 'Muse')).resolves.toBe(77);
    expect(p.userPlay.count).toHaveBeenCalledWith({
      where: {
        userId: 2,
        artistName: { equals: 'Muse', mode: 'insensitive' },
      },
    });
  });

  it('adds album and track filters when supplied', async () => {
    const p = makePrisma();
    p.userPlay.count.mockResolvedValue(5);

    await repo(p).getEntityTotalPlaycount(2, 'Muse', 'Black Holes', 'Hysteria');

    const arg = p.userPlay.count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where.albumName).toEqual({ equals: 'Black Holes', mode: 'insensitive' });
    expect(arg.where.trackName).toEqual({ equals: 'Hysteria', mode: 'insensitive' });
  });

  // This pair replaced a test that asserted the bug. The old test made
  // `userPlay.count` reject and asserted `resolves.toBe(0)` - i.e. it pinned
  // the fabricated number, and the count it produced is indistinguishable from
  // a real "this user never played that artist". Asserting only the raise would
  // not distinguish the fix from a method that ALWAYS throws; asserting only the
  // zero would not distinguish it from the bug. Both halves are needed.
  it('raises SourceUnavailableError when the count query throws', async () => {
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const p = makePrisma();
    p.userPlay.count.mockRejectedValue(new Error("Can't reach database server"));

    const err = await repo(p)
      .getEntityTotalPlaycount(2, 'Muse')
      .catch((e: unknown) => e);

    // `isSourceUnavailable` rather than a bare instanceof: the same class is
    // loaded through several module specifiers here, and a cross-module copy
    // would fail an instanceof while still being the right error.
    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as SourceUnavailableError).name).toBe('SourceUnavailableError');
    expect((err as Error).message).toContain('Database unavailable');
    expect((err as Error).message).toContain('playRepository.getEntityTotalPlaycount:userPlay.count');
    expect((err as Error).message).toContain("Can't reach database server");
    expect((err as SourceUnavailableError).cause).toBeInstanceOf(Error);

    // The log names the query, so whoever reads Railway knows which read failed.
    expect(logged).toHaveBeenCalled();
    const context = logged.mock.calls[0]?.[0] as { query?: string; err?: string };
    expect(context.query).toContain('getEntityTotalPlaycount');
    expect(context.err).toContain("Can't reach database server");
  });

  it('returns 0 when the count query ran and found no plays', async () => {
    // The genuine zero. A `count` over no matching rows SUCCEEDS with 0, so this
    // is a real answer and must stay one - it is the same value the old bug
    // fabricated, and the only reason the two are distinguishable is that one of
    // them arrives with an error attached.
    const p = makePrisma();
    p.userPlay.count.mockResolvedValue(0);

    await expect(repo(p).getEntityTotalPlaycount(2, 'Muse')).resolves.toBe(0);
    expect(p.userPlay.count).toHaveBeenCalledWith({
      where: {
        userId: 2,
        artistName: { equals: 'Muse', mode: 'insensitive' },
      },
    });
  });
});

describe('PlayRepository.getEntityFirstPlay', () => {
  it('returns the earliest play for the artist', async () => {
    const p = makePrisma();
    p.userPlay.findFirst.mockResolvedValue({
      timePlayed: at('2024-06-01T00:00:00Z'),
      albumName: 'OK Computer',
      trackName: 'Airbag',
    });

    const out = await repo(p).getEntityFirstPlay(1, 'Radiohead');

    expect(out).toEqual({
      timePlayed: at('2024-06-01T00:00:00Z'),
      albumName: 'OK Computer',
      trackName: 'Airbag',
    });
    expect(p.userPlay.findFirst).toHaveBeenCalledWith({
      where: { userId: 1, artistName: { equals: 'Radiohead', mode: 'insensitive' } },
      orderBy: { timePlayed: 'asc' },
      select: { timePlayed: true, albumName: true, trackName: true },
    });
  });

  it('returns null when the artist was never played', async () => {
    const p = makePrisma();
    await expect(repo(p).getEntityFirstPlay(1, 'Unknown')).resolves.toBeNull();
  });
});

describe('PlayRepository.getEntityFirstPlayDate', () => {
  it('returns just the date of the earliest matching play', async () => {
    const p = makePrisma();
    p.userPlay.findFirst.mockResolvedValue({ timePlayed: at('2024-06-01T00:00:00Z') });

    await expect(
      repo(p).getEntityFirstPlayDate(1, 'Radiohead', 'OK Computer', 'Airbag'),
    ).resolves.toEqual(at('2024-06-01T00:00:00Z'));

    const arg = p.userPlay.findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where.albumName).toEqual({ equals: 'OK Computer', mode: 'insensitive' });
    expect(arg.where.trackName).toEqual({ equals: 'Airbag', mode: 'insensitive' });
  });

  it('returns null when nothing matches', async () => {
    const p = makePrisma();
    await expect(repo(p).getEntityFirstPlayDate(1, 'Radiohead')).resolves.toBeNull();
  });
});

describe('PlayRepository.getEntityLastPlay', () => {
  it('returns the newest play before the cutoff', async () => {
    const p = makePrisma();
    p.userPlay.findFirst.mockResolvedValue({
      timePlayed: at('2026-01-15T00:00:00Z'),
      albumName: null,
      trackName: 'Starlight',
    });
    const cutoff = at('2026-02-01T00:00:00Z');

    const out = await repo(p).getEntityLastPlay(1, 'Muse', cutoff);

    expect(out).toEqual({
      timePlayed: at('2026-01-15T00:00:00Z'),
      albumName: null,
      trackName: 'Starlight',
    });
    expect(p.userPlay.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 1,
        timePlayed: { lt: cutoff },
        artistName: { equals: 'Muse', mode: 'insensitive' },
      },
      orderBy: { timePlayed: 'desc' },
      select: { timePlayed: true, albumName: true, trackName: true },
    });
  });

  it('returns null when the cutoff precedes every play', async () => {
    const p = makePrisma();
    await expect(repo(p).getEntityLastPlay(1, 'Muse', at('2020-01-01'))).resolves.toBeNull();
  });
});

describe('PlayRepository.getEntityLastPlayDate', () => {
  it('returns the date of the newest play before the cutoff', async () => {
    const p = makePrisma();
    p.userPlay.findFirst.mockResolvedValue({ timePlayed: at('2026-01-15T00:00:00Z') });
    const cutoff = at('2026-02-01T00:00:00Z');

    await expect(
      repo(p).getEntityLastPlayDate(1, 'Muse', cutoff, 'Black Holes', 'Hysteria'),
    ).resolves.toEqual(at('2026-01-15T00:00:00Z'));

    const arg = p.userPlay.findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where.timePlayed).toEqual({ lt: cutoff });
    expect(arg.where.albumName).toEqual({ equals: 'Black Holes', mode: 'insensitive' });
    expect(arg.where.trackName).toEqual({ equals: 'Hysteria', mode: 'insensitive' });
  });

  it('returns null when no play precedes the cutoff', async () => {
    const p = makePrisma();
    await expect(repo(p).getEntityLastPlayDate(1, 'Muse', at('2020-01-01'))).resolves.toBeNull();
  });
});
