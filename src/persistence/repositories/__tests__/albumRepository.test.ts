import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AlbumRepository } from '../albumRepository';

/**
 * AlbumRepository was at 13.7% line coverage. The paths worth holding:
 *
 *  - `getOrCreateAlbum` normalises to lowercase BEFORE the lookup and again
 *    before the create. If the two ever disagree, a second insert of the same
 *    album collides on the `(artistId, name)` unique constraint and the caller
 *    gets a thrown P2002 instead of the row it asked for.
 *  - `getOrCreateAlbumsBulk` has three passes: exact `in` lookup, a
 *    case-insensitive `$queryRaw` for ProperCase twins, then createMany +
 *    re-read to learn the ids of what it just wrote. The re-read is not
 *    optional - `createMany` returns a count, never rows, so without it the map
 *    would come back missing every id it just created and the caller would
 *    write scrobbles against `undefined`.
 *  - `setReleaseData` writes `?? null` on all three fields, so a partial call
 *    ERASES the fields it omits. That is pinned here because it is surprising
 *    enough to be a bug the day a caller passes a partial object.
 */

/** Reads one argument out of a vi.fn call without tripping noUncheckedIndexedAccess. */
const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const album = (over: Record<string, unknown> = {}) => ({
  albumId: 7,
  artistId: 3,
  name: 'rumours',
  mbid: null,
  imageUrl: null,
  lastFmImageUrl: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  spotifyImageUrl: null,
  spotifyImageDate: null,
  deezerAlbumId: null,
  deezerImageUrl: null,
  releaseDate: null,
  releaseDatePrecision: null,
  spotifyAlbumType: null,
  ...over,
});

const makePrisma = () => ({
  album: {
    findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => album()),
    update: vi.fn(async (..._args: unknown[]) => album()),
    createMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
  },
  $queryRaw: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
});

type Double = ReturnType<typeof makePrisma>;

const build = (d: Double): AlbumRepository => new AlbumRepository(d as unknown as PrismaClient);

let d: Double;
let repo: AlbumRepository;

beforeEach(() => {
  d = makePrisma();
  repo = build(d);
});

describe('AlbumRepository.getOrCreateAlbum', () => {
  it('returns the existing row without creating, and normalises the lookup name', async () => {
    const existing = album({ albumId: 42, name: 'rumours' });
    d.album.findFirst.mockResolvedValue(existing as never);

    const got = await repo.getOrCreateAlbum('Rumours', 3, 'https://img');

    expect(got).toBe(existing);
    expect(d.album.create).not.toHaveBeenCalled();
    expect(callArg(d.album.findFirst)).toEqual({
      where: { artistId: 3, name: { equals: 'rumours', mode: 'insensitive' } },
    });
  });

  it('creates with the lowercased name when absent', async () => {
    const created = album({ albumId: 99, name: 'tango in the night' });
    d.album.create.mockResolvedValue(created as never);

    const got = await repo.getOrCreateAlbum('Tango In The Night', 3, 'https://img');

    expect(got.albumId).toBe(99);
    expect(callArg(d.album.create)).toEqual({
      data: { name: 'tango in the night', artistId: 3, imageUrl: 'https://img' },
    });
  });

  it('stores imageUrl as null when the caller supplies none', async () => {
    await repo.getOrCreateAlbum('Rumours', 3);

    expect(callArg<{ data: { imageUrl: unknown } }>(d.album.create)?.data.imageUrl).toBeNull();
  });

  it('propagates a lookup failure rather than silently creating', async () => {
    d.album.findFirst.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getOrCreateAlbum('Rumours', 3)).rejects.toThrow('db down');
    expect(d.album.create).not.toHaveBeenCalled();
  });
});

describe('AlbumRepository lookups', () => {
  it('getAlbumByNameAndArtist lowercases the name', async () => {
    const row = album({ albumId: 5, name: 'neverland' });
    d.album.findFirst.mockResolvedValue(row as never);

    const got = await repo.getAlbumByNameAndArtist('Neverland', 3);

    expect(got?.albumId).toBe(5);
    expect(callArg(d.album.findFirst)).toEqual({ where: { artistId: 3, name: 'neverland' } });
  });

  it('getAlbumByNameAndArtist returns null when there is no row', async () => {
    d.album.findFirst.mockResolvedValue(null as never);

    expect(await repo.getAlbumByNameAndArtist('Neverland', 3)).toBeNull();
  });

  it('getAlbumById uses findUnique on the primary key', async () => {
    d.album.findUnique.mockResolvedValue(album({ albumId: 11 }) as never);

    const got = await repo.getAlbumById(11);

    expect(got?.albumId).toBe(11);
    expect(callArg(d.album.findUnique)).toEqual({ where: { albumId: 11 } });
  });

  it('getAlbumById returns null when there is no row', async () => {
    d.album.findUnique.mockResolvedValue(null as never);

    expect(await repo.getAlbumById(404)).toBeNull();
  });
});

describe('AlbumRepository writers', () => {
  it('setSpotifyImage writes both the url and the date it was seen', async () => {
    const date = new Date('2026-02-03T04:05:06Z');

    await repo.setSpotifyImage(7, 'https://spot', date);

    expect(callArg(d.album.update)).toEqual({
      where: { albumId: 7 },
      data: { spotifyImageUrl: 'https://spot', spotifyImageDate: date },
    });
  });

  it('setDeezerImage widens the deezer id to BigInt, not a JS number', async () => {
    await repo.setDeezerImage(7, 123, 'https://deezer');

    expect(callArg<{ data: { deezerAlbumId: unknown } }>(d.album.update)?.data.deezerAlbumId).toBe(123n);
    expect(callArg(d.album.update)).toEqual({
      where: { albumId: 7 },
      data: { deezerAlbumId: 123n, deezerImageUrl: 'https://deezer' },
    });
  });

  it('setImageUrl writes only imageUrl', async () => {
    await repo.setImageUrl(7, 'https://lastfm');

    expect(callArg(d.album.update)).toEqual({
      where: { albumId: 7 },
      data: { imageUrl: 'https://lastfm' },
    });
  });

  it('setReleaseData writes all three fields when all are supplied', async () => {
    const date = new Date('1977-02-04');

    await repo.setReleaseData(7, {
      releaseDate: date,
      releaseDatePrecision: 'day',
      spotifyAlbumType: 'album',
    });

    expect(callArg(d.album.update)).toEqual({
      where: { albumId: 7 },
      data: { releaseDate: date, releaseDatePrecision: 'day', spotifyAlbumType: 'album' },
    });
  });

  it('setReleaseData NULLS the fields a partial call omits', async () => {
    await repo.setReleaseData(7, { spotifyAlbumType: 'single' });

    expect(callArg(d.album.update)).toEqual({
      where: { albumId: 7 },
      data: { releaseDate: null, releaseDatePrecision: null, spotifyAlbumType: 'single' },
    });
  });

  it('propagates an update failure instead of swallowing it', async () => {
    d.album.update.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.setImageUrl(7, 'https://x')).rejects.toThrow('write failed');
  });
});

describe('AlbumRepository.getOrCreateAlbumsBulk', () => {
  it('returns an empty map and touches the database not at all for no input', async () => {
    const got = await repo.getOrCreateAlbumsBulk([]);

    expect(got.size).toBe(0);
    expect(d.album.findMany).not.toHaveBeenCalled();
    expect(d.album.createMany).not.toHaveBeenCalled();
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips blank names and collapses duplicates to one lookup key', async () => {
    d.album.findMany.mockResolvedValue([] as never);

    const got = await repo.getOrCreateAlbumsBulk([
      { albumName: 'Rumours', artistId: 3 },
      { albumName: 'RUMOURS', artistId: 3 },
      { albumName: '', artistId: 3 },
    ]);

    // Blank name never reaches the DB; the two spellings collapse to one entry.
    expect(callArg<{ where: { name: { in: string[] } } }>(d.album.findMany)?.where.name.in).toEqual([
      'rumours',
    ]);
    // 'rumours' was missing, so it is created and read back.
    expect(callArg<{ data: Array<{ name: string; artistId: number }> }>(d.album.createMany)?.data).toEqual([
      { name: 'rumours', artistId: 3 },
    ]);
    expect(got.size).toBe(0);
  });

  it('returns ids for rows the first exact-match pass already found, creating nothing', async () => {
    d.album.findMany.mockResolvedValueOnce([
      { albumId: 12, name: 'rumours', artistId: 3 },
    ] as never);

    const got = await repo.getOrCreateAlbumsBulk([{ albumName: 'Rumours', artistId: 3 }]);

    expect(got.get('3|rumours')).toBe(12);
    expect(d.$queryRaw).not.toHaveBeenCalled();
    expect(d.album.createMany).not.toHaveBeenCalled();
    expect(d.album.findMany).toHaveBeenCalledTimes(1);
  });

  it('resolves a ProperCase twin through the parameterised $queryRaw pass', async () => {
    // First pass: nothing exact. Raw pass: the stored row is 'Rumours'.
    d.album.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockResolvedValueOnce([
      { albumId: 88, name: 'Rumours', artistId: 3 },
    ] as never);

    const got = await repo.getOrCreateAlbumsBulk([{ albumName: 'rumours', artistId: 3 }]);

    expect(got.get('3|rumours')).toBe(88);
    expect(d.album.createMany).not.toHaveBeenCalled();
    // The raw call is a tagged template: [strings, ...values]. artistIds first,
    // then the uppercased missing names. Nothing is interpolated into SQL text.
    const rawValues = (d.$queryRaw.mock.calls[0] ?? []).slice(1) as unknown[];
    expect(rawValues[0]).toEqual([3]);
    expect(rawValues[1]).toEqual(['RUMOURS']);
  });

  it('creates what is still missing and re-reads to learn the new ids', async () => {
    d.album.findMany.mockResolvedValueOnce([] as never); // first pass: miss
    d.$queryRaw.mockResolvedValueOnce([] as never); // twin pass: miss
    d.album.createMany.mockResolvedValueOnce({ count: 2 } as never);
    d.album.findMany.mockResolvedValueOnce([
      { albumId: 101, name: 'tusk', artistId: 3 },
      { albumId: 102, name: 'mirage', artistId: 4 },
    ] as never); // re-read after create

    const got = await repo.getOrCreateAlbumsBulk([
      { albumName: 'Tusk', artistId: 3 },
      { albumName: 'Mirage', artistId: 4 },
    ]);

    expect(got.get('3|tusk')).toBe(101);
    expect(got.get('4|mirage')).toBe(102);
    expect(callArg(d.album.createMany)).toEqual({
      data: [
        { name: 'tusk', artistId: 3 },
        { name: 'mirage', artistId: 4 },
      ],
      skipDuplicates: true,
    });
    // The re-read is scoped to the names it just created, not the whole chunk.
    expect(callArg<{ where: { name: { in: string[] } } }>(d.album.findMany, 1)?.where.name.in).toEqual([
      'tusk',
      'mirage',
    ]);
  });

  it('chunks at 400 and keeps the map keyed artistId|name across chunks', async () => {
    d.album.findMany.mockResolvedValue([] as never);

    const items = Array.from({ length: 401 }, (_, i) => ({
      albumName: `album ${i}`,
      artistId: 3,
    }));
    const got = await repo.getOrCreateAlbumsBulk(items);

    // 2 chunks x (exact pass + createMany + re-read).
    expect(d.album.findMany).toHaveBeenCalledTimes(4);
    expect(d.album.createMany).toHaveBeenCalledTimes(2);
    expect(got.size).toBe(0);
  });

  it('propagates a failure from the exact-match pass instead of returning an empty map', async () => {
    d.album.findMany.mockRejectedValue(new Error('select failed') as never);

    await expect(repo.getOrCreateAlbumsBulk([{ albumName: 'Tusk', artistId: 3 }])).rejects.toThrow(
      'select failed',
    );
    expect(d.album.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure from the raw twin pass rather than creating duplicates', async () => {
    d.album.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockRejectedValue(new Error('raw failed') as never);

    await expect(repo.getOrCreateAlbumsBulk([{ albumName: 'Tusk', artistId: 3 }])).rejects.toThrow(
      'raw failed',
    );
    expect(d.album.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure from createMany', async () => {
    d.album.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockResolvedValueOnce([] as never);
    d.album.createMany.mockRejectedValue(new Error('insert failed') as never);

    await expect(repo.getOrCreateAlbumsBulk([{ albumName: 'Tusk', artistId: 3 }])).rejects.toThrow(
      'insert failed',
    );
  });
});