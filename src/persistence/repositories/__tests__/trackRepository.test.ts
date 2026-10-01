import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TrackRepository } from '@persistence/repositories/trackRepository';

/**
 * TrackRepository was at 14.5% line coverage. It mirrors AlbumRepository, but
 * "mirrors" is exactly why it went untested: a copy of a tested file looks
 * covered until one table/column name is wrong, and the two files are not
 * edited together. These tests assert the track-specific names (`track`,
 * `trackId`, `tracks`, `track_id`) rather than anything they share.
 *
 * The three-pass bulk lookup is the expensive path, so it is asserted in full:
 * exact `in` match, the case-insensitive `$queryRaw` twin pass, then createMany
 * plus a re-read. The re-read is load-bearing - `createMany` returns a count,
 * never rows - and dropping it would hand the caller a map with no ids for
 * everything it just inserted.
 */

const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const track = (over: Record<string, unknown> = {}) => ({
  trackId: 7,
  artistId: 3,
  name: 'the chain',
  mbid: null,
  imageUrl: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  spotifyImageUrl: null,
  spotifyImageDate: null,
  ...over,
});

const makePrisma = () => ({
  track: {
    findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => track()),
    update: vi.fn(async (..._args: unknown[]) => track()),
    createMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
  },
  $queryRaw: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: TrackRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new TrackRepository(d as unknown as PrismaClient);
});

describe('TrackRepository.getOrCreateTrack', () => {
  it('returns the existing row without creating, using an insensitive lookup', async () => {
    const existing = track({ trackId: 55, name: 'the chain' });
    d.track.findFirst.mockResolvedValue(existing as never);

    const got = await repo.getOrCreateTrack('The Chain', 3, 'https://img');

    expect(got).toBe(existing);
    expect(d.track.create).not.toHaveBeenCalled();
    expect(callArg(d.track.findFirst)).toEqual({
      where: { artistId: 3, name: { equals: 'the chain', mode: 'insensitive' } },
    });
  });

  it('creates with the lowercased name when absent', async () => {
    d.track.create.mockResolvedValue(track({ trackId: 61, name: 'go your own way' }) as never);

    const got = await repo.getOrCreateTrack('Go Your Own Way', 3, 'https://img');

    expect(got.trackId).toBe(61);
    expect(callArg(d.track.create)).toEqual({
      data: { name: 'go your own way', artistId: 3, imageUrl: 'https://img' },
    });
  });

  it('stores imageUrl as null when the caller supplies none', async () => {
    await repo.getOrCreateTrack('The Chain', 3);

    expect(callArg<{ data: { imageUrl: unknown } }>(d.track.create)?.data.imageUrl).toBeNull();
  });

  it('propagates a lookup failure instead of creating a duplicate', async () => {
    d.track.findFirst.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getOrCreateTrack('The Chain', 3)).rejects.toThrow('db down');
    expect(d.track.create).not.toHaveBeenCalled();
  });
});

describe('TrackRepository lookups', () => {
  it('getTrackByNameAndArtist lowercases the name', async () => {
    d.track.findFirst.mockResolvedValue(track({ trackId: 5, name: 'birdchain' }) as never);

    const got = await repo.getTrackByNameAndArtist('Birdchain', 3);

    expect(got?.trackId).toBe(5);
    expect(callArg(d.track.findFirst)).toEqual({ where: { artistId: 3, name: 'birdchain' } });
  });

  it('getTrackByNameAndArtist returns null when there is no row', async () => {
    d.track.findFirst.mockResolvedValue(null as never);

    expect(await repo.getTrackByNameAndArtist('Birdchain', 3)).toBeNull();
  });

  it('getTrackById uses findUnique on trackId, not albumId', async () => {
    d.track.findUnique.mockResolvedValue(track({ trackId: 11 }) as never);

    const got = await repo.getTrackById(11);

    expect(got?.trackId).toBe(11);
    expect(callArg(d.track.findUnique)).toEqual({ where: { trackId: 11 } });
  });

  it('getTrackById returns null when there is no row', async () => {
    d.track.findUnique.mockResolvedValue(null as never);

    expect(await repo.getTrackById(404)).toBeNull();
  });
});

describe('TrackRepository writers', () => {
  it('setSpotifyImage writes both the url and the date it was seen', async () => {
    const date = new Date('2026-02-03T04:05:06Z');

    await repo.setSpotifyImage(7, 'https://spot', date);

    expect(callArg(d.track.update)).toEqual({
      where: { trackId: 7 },
      data: { spotifyImageUrl: 'https://spot', spotifyImageDate: date },
    });
  });

  it('setImageUrl writes only imageUrl', async () => {
    await repo.setImageUrl(7, 'https://lastfm');

    expect(callArg(d.track.update)).toEqual({
      where: { trackId: 7 },
      data: { imageUrl: 'https://lastfm' },
    });
  });

  it('propagates an update failure instead of swallowing it', async () => {
    d.track.update.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.setImageUrl(7, 'https://x')).rejects.toThrow('write failed');
  });
});

describe('TrackRepository.getOrCreateTracksBulk', () => {
  it('returns an empty map and touches the database not at all for no input', async () => {
    const got = await repo.getOrCreateTracksBulk([]);

    expect(got.size).toBe(0);
    expect(d.track.findMany).not.toHaveBeenCalled();
    expect(d.track.createMany).not.toHaveBeenCalled();
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips blank names and collapses case variants to one lookup key', async () => {
    d.track.findMany.mockResolvedValue([] as never);

    await repo.getOrCreateTracksBulk([
      { trackName: 'The Chain', artistId: 3 },
      { trackName: 'THE CHAIN', artistId: 3 },
      { trackName: '', artistId: 3 },
    ]);

    expect(callArg<{ where: { name: { in: string[] } } }>(d.track.findMany)?.where.name.in).toEqual([
      'the chain',
    ]);
    expect(callArg<{ data: Array<{ name: string }> }>(d.track.createMany)?.data).toEqual([
      { name: 'the chain', artistId: 3 },
    ]);
  });

  it('returns ids from the exact-match pass and creates nothing', async () => {
    d.track.findMany.mockResolvedValueOnce([{ trackId: 12, name: 'the chain', artistId: 3 }] as never);

    const got = await repo.getOrCreateTracksBulk([{ trackName: 'The Chain', artistId: 3 }]);

    expect(got.get('3|the chain')).toBe(12);
    expect(d.$queryRaw).not.toHaveBeenCalled();
    expect(d.track.createMany).not.toHaveBeenCalled();
    expect(d.track.findMany).toHaveBeenCalledTimes(1);
  });

  it('resolves a ProperCase twin through the parameterised raw pass', async () => {
    d.track.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockResolvedValueOnce([{ trackId: 88, name: 'The Chain', artistId: 3 }] as never);

    const got = await repo.getOrCreateTracksBulk([{ trackName: 'the chain', artistId: 3 }]);

    expect(got.get('3|the chain')).toBe(88);
    expect(d.track.createMany).not.toHaveBeenCalled();
    // Tagged template: [strings, ...values]. Names travel as bound parameters.
    const rawValues = (d.$queryRaw.mock.calls[0] ?? []).slice(1) as unknown[];
    expect(rawValues[0]).toEqual([3]);
    expect(rawValues[1]).toEqual(['THE CHAIN']);
  });

  it('creates what is still missing and re-reads to learn the new ids', async () => {
    d.track.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockResolvedValueOnce([] as never);
    d.track.createMany.mockResolvedValueOnce({ count: 1 } as never);
    d.track.findMany.mockResolvedValueOnce([{ trackId: 501, name: 'birdchain', artistId: 4 }] as never);

    const got = await repo.getOrCreateTracksBulk([{ trackName: 'Birdchain', artistId: 4 }]);

    expect(got.get('4|birdchain')).toBe(501);
    expect(callArg(d.track.createMany)).toEqual({
      data: [{ name: 'birdchain', artistId: 4 }],
      skipDuplicates: true,
    });
    expect(callArg<{ where: { name: { in: string[] } } }>(d.track.findMany, 1)?.where.name.in).toEqual([
      'birdchain',
    ]);
  });

  it('chunks at 400 across two chunks', async () => {
    d.track.findMany.mockResolvedValue([] as never);

    const items = Array.from({ length: 401 }, (_, i) => ({
      trackName: `track ${i}`,
      artistId: 3,
    }));
    const got = await repo.getOrCreateTracksBulk(items);

    expect(d.track.findMany).toHaveBeenCalledTimes(4);
    expect(d.track.createMany).toHaveBeenCalledTimes(2);
    expect(got.size).toBe(0);
  });

  it('propagates a failure from the exact-match pass instead of returning an empty map', async () => {
    d.track.findMany.mockRejectedValue(new Error('select failed') as never);

    await expect(repo.getOrCreateTracksBulk([{ trackName: 'The Chain', artistId: 3 }])).rejects.toThrow(
      'select failed',
    );
    expect(d.track.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure from the raw twin pass rather than creating duplicates', async () => {
    d.track.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockRejectedValue(new Error('raw failed') as never);

    await expect(repo.getOrCreateTracksBulk([{ trackName: 'The Chain', artistId: 3 }])).rejects.toThrow(
      'raw failed',
    );
    expect(d.track.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure from createMany', async () => {
    d.track.findMany.mockResolvedValueOnce([] as never);
    d.$queryRaw.mockResolvedValueOnce([] as never);
    d.track.createMany.mockRejectedValue(new Error('insert failed') as never);

    await expect(repo.getOrCreateTracksBulk([{ trackName: 'The Chain', artistId: 3 }])).rejects.toThrow(
      'insert failed',
    );
  });
});