import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ArtistRepository } from './artistRepository';

/**
 * The seven `ArtistRepository` methods `artistRepository.test.ts` does not
 * reach - that file holds two assertions, both for `getOrCreateArtist`.
 *
 * `getOrCreateArtistsBulk` is the interesting one, and it is the method with
 * the most ways to be quietly wrong. The `artists.name` unique constraint is
 * case-SENSITIVE, so an exact `name IN (...)` lookup misses a ProperCase twin
 * ("Mac DeMarco" vs "mac demarco") and `createMany` then tries to insert a
 * lowercase row against a unique index that already holds the twin - which on
 * Postgres is a `skipDuplicates` no-op, so no error, and the caller is handed
 * a map that either lacks the name or maps it to the wrong id. The
 * `UPPER(name) = ANY(...)` second pass is the fix, and it is parameterised, so
 * an artist called `Guns N' Roses` can never break the statement.
 *
 * That pass is exactly the thing the existing `.db.test.ts` proves against a
 * real database. This file proves the SHAPE: which queries run, in what order,
 * with which arguments, and that a failure in any of them is a failure rather
 * than a quietly short map.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

/** The columns the bulk pass selects, straight off the `Artist` model. */
const artistRow = (over: Args = {}) => ({ artistId: 1, name: 'radiohead', ...over });

const rawCallOf = (fn: unknown, index = 0): { sql: string; values: unknown[] } => {
  const call = (fn as { mock: { calls: unknown[][] } }).mock.calls[index];
  if (!call) throw new Error('no raw query was issued');
  return { sql: (call[0] as TemplateStringsArray).join('?'), values: call.slice(1) };
};

const makePrisma = () => ({
  artist: {
    findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => artistRow()),
    createMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    update: vi.fn(async (..._args: unknown[]) => artistRow()),
  },
  $queryRaw: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: ArtistRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new ArtistRepository(d as unknown as PrismaClient);
});

describe('ArtistRepository.getArtistByName', () => {
  it('lowercases the requested name AND matches insensitively', async () => {
    d.artist.findFirst.mockResolvedValue(artistRow({ artistId: 9 }) as never);

    const got = await repo.getArtistByName('Mac DeMarco');

    // Both halves matter: the lowercase is the storage convention, and the
    // `mode` is what lets a ProperCase row be found at all.
    expect(got?.artistId).toBe(9);
    expect(callArg(d.artist.findFirst)).toEqual({
      where: { name: { equals: 'mac demarco', mode: 'insensitive' } },
    });
  });

  it('returns null for an artist that is not in the catalogue', async () => {
    d.artist.findFirst.mockResolvedValue(null as never);
    expect(await repo.getArtistByName('Nobody')).toBeNull();
  });

  it('propagates a read failure rather than reporting "unknown artist"', async () => {
    d.artist.findFirst.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getArtistByName('Radiohead')).rejects.toThrow('connection reset');
  });
});

describe('ArtistRepository.getArtistById', () => {
  it('uses findUnique on the primary key, not findFirst on a name', async () => {
    d.artist.findUnique.mockResolvedValue(artistRow({ artistId: 9 }) as never);

    expect((await repo.getArtistById(9))?.artistId).toBe(9);
    expect(callArg(d.artist.findUnique)).toEqual({ where: { artistId: 9 } });
  });

  it('returns null for an id that is not in the catalogue', async () => {
    expect(await repo.getArtistById(404)).toBeNull();
  });

  it('propagates a read failure rather than reporting "no such artist"', async () => {
    d.artist.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getArtistById(9)).rejects.toThrow('connection reset');
  });
});

describe('ArtistRepository image writers', () => {
  it('setSpotifyImage writes the url and the date it was SEEN, not now', async () => {
    const seen = new Date('2026-04-04T12:00:00Z');
    await repo.setSpotifyImage(9, 'https://img/9.png', seen);

    // The date exists so a stale cover can be re-checked later. Writing
    // `new Date()` here would make every row look freshly verified.
    expect(callArg(d.artist.update)).toEqual({
      where: { artistId: 9 },
      data: { spotifyImageUrl: 'https://img/9.png', spotifyImageDate: seen },
    });
  });

  it('setDeezerImage widens the deezer id to BigInt, not a JS number', async () => {
    await repo.setDeezerImage(9, 12345678901234, 'https://img/9.jpg');

    // `deezer_artist_id` is `BigInt?`. A JS number would lose precision on a
    // 14-digit id and write a DIFFERENT artist id than the one fetched.
    expect(callArg(d.artist.update)).toEqual({
      where: { artistId: 9 },
      data: { deezerArtistId: 12345678901234n, deezerImageUrl: 'https://img/9.jpg' },
    });
  });

  it('setAppleMusicUrl writes only the url', async () => {
    await repo.setAppleMusicUrl(9, 'https://music.example/artist/9');
    expect(callArg(d.artist.update)).toEqual({
      where: { artistId: 9 },
      data: { appleMusicUrl: 'https://music.example/artist/9' },
    });
  });

  it('propagates a write failure rather than resolving on a silent no-op', async () => {
    d.artist.update.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.setSpotifyImage(9, 'u', new Date())).rejects.toThrow('write failed');
  });
});

describe('ArtistRepository.getOrCreateArtistsBulk', () => {
  it('returns an empty map and touches the database not at all for no input', async () => {
    expect((await repo.getOrCreateArtistsBulk([])).size).toBe(0);
    expect(d.artist.findMany).not.toHaveBeenCalled();
    expect(d.artist.createMany).not.toHaveBeenCalled();
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });

  it('drops empty names and collapses case variants to ONE lookup key', async () => {
    d.artist.findMany.mockResolvedValue([artistRow({ artistId: 5, name: 'radiohead' })] as never);

    const map = await repo.getOrCreateArtistsBulk(['Radiohead', 'radiohead', 'RADIOHEAD', '']);

    expect(map.get('radiohead')).toBe(5);
    // The IN list is lowercased and deduped, so the query is not three times
    // the size it needs to be.
    expect(callArg<{ where: { name: { in: string[] } } }>(d.artist.findMany).where.name.in).toEqual([
      'radiohead',
    ]);
  });

  it('keys the map by the REQUESTED name, not the stored spelling', async () => {
    // The exact pass is case-insensitive by convention (storage is lowercase),
    // so the row comes back ProperCase when an older row predates the
    // convention. The key is lowercased either way, because the caller looks
    // the map up with a lowercased name.
    d.artist.findMany.mockResolvedValue([artistRow({ artistId: 5, name: 'Mac DeMarco' })] as never);

    const map = await repo.getOrCreateArtistsBulk(['mac demarco']);

    expect(map.get('mac demarco')).toBe(5);
  });

  it('skips the raw twin pass entirely when the exact pass matched everything', async () => {
    d.artist.findMany.mockResolvedValue([artistRow({ artistId: 5 })] as never);

    await repo.getOrCreateArtistsBulk(['radiohead']);

    // One query, not three. The twin pass is the expensive one.
    expect(d.artist.findMany).toHaveBeenCalledTimes(1);
    expect(d.$queryRaw).not.toHaveBeenCalled();
    expect(d.artist.createMany).not.toHaveBeenCalled();
  });

  it('resolves a ProperCase twin through the parameterised UPPER() pass', async () => {
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([{ artistId: 5, name: 'Mac DeMarco' }] as never);

    const map = await repo.getOrCreateArtistsBulk(['mac demarco']);

    expect(map.get('mac demarco')).toBe(5);
    const { sql, values } = rawCallOf(d.$queryRaw);
    expect(sql).toMatch(/UPPER\(name\) = ANY\(\?\)/);
    // The name is a BOUND parameter, never interpolated: an artist called
    // `Guns N' Roses` would otherwise close the quotes and change the statement.
    expect(values).toEqual([['MAC DEMARCO']]);
    expect(d.artist.createMany).not.toHaveBeenCalled();
  });

  it('does not treat a name that is a PREFIX of another as a twin', async () => {
    d.artist.findMany.mockResolvedValue([artistRow({ artistId: 1, name: 'radio' })] as never);
    d.$queryRaw.mockResolvedValue([{ artistId: 2, name: 'radiohead' }] as never);

    const map = await repo.getOrCreateArtistsBulk(['radiohead']);

    // `UPPER(name) = ANY(...)` is an equality, not a prefix match. A LIKE here
    // would map "radiohead" to whatever artist happened to be called "radio".
    expect(map.get('radiohead')).toBe(2);
    expect(rawCallOf(d.$queryRaw).values).toEqual([['RADIOHEAD']]);
  });

  it('creates what is still missing and re-reads to learn the new ids', async () => {
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([] as never);
    d.artist.findMany.mockResolvedValueOnce([] as never);
    d.artist.findMany.mockResolvedValueOnce([artistRow({ artistId: 8, name: 'radiohead' })] as never);

    const map = await repo.getOrCreateArtistsBulk(['radiohead']);

    expect(d.artist.createMany).toHaveBeenCalledWith({
      data: [{ name: 'radiohead' }],
      skipDuplicates: true,
    });
    // Without the re-read there is no id to return, and a map with no ids is
    // indistinguishable from "this artist does not exist".
    expect(map.get('radiohead')).toBe(8);
    expect(d.artist.findMany).toHaveBeenCalledTimes(2);
  });

  it('asks the database to skip duplicates on the insert', async () => {
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([] as never);
    await repo.getOrCreateArtistsBulk(['radiohead']);
    // Two syncs racing on the same new artist is normal, and the loser must
    // not raise a unique violation out of an index build.
    expect(callArg<{ skipDuplicates: boolean }>(d.artist.createMany).skipDuplicates).toBe(true);
  });

  it('re-reads over the whole MISSING set, not just the newly created remainder', async () => {
    // `missing` is a superset of `stillMissing`: it also contains the names the
    // twin pass resolved. Re-reading it is redundant rather than wrong, and it
    // is pinned so tightening it is a visible edit.
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([{ artistId: 2, name: 'Muse' }] as never);
    d.artist.findMany.mockResolvedValueOnce([] as never);
    d.artist.findMany.mockResolvedValueOnce([artistRow({ artistId: 8, name: 'radiohead' })] as never);

    const map = await repo.getOrCreateArtistsBulk(['radiohead', 'muse']);

    expect(callArg<{ where: { name: { in: string[] } } }>(d.artist.findMany, 1).where.name.in).toEqual([
      'radiohead',
      'muse',
    ]);
    expect(map.get('radiohead')).toBe(8);
    expect(map.get('muse')).toBe(2);
  });

  it('resolves every requested name or none of them is reported as found', async () => {
    d.artist.findMany.mockResolvedValue([artistRow({ artistId: 1, name: 'radiohead' })] as never);
    d.$queryRaw.mockResolvedValue([{ artistId: 2, name: 'Muse' }] as never);

    const map = await repo.getOrCreateArtistsBulk(['radiohead', 'muse']);

    expect(map.get('radiohead')).toBe(1);
    expect(map.get('muse')).toBe(2);
  });

  it('chunks at 500 and keeps every name resolvable across the boundary', async () => {
    const names = Array.from({ length: 501 }, (_, n) => `artist ${n}`);
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([] as never);
    d.artist.findMany.mockResolvedValueOnce([] as never);
    d.artist.findMany.mockResolvedValueOnce([artistRow({ artistId: 1, name: 'artist 0' })] as never);

    const map = await repo.getOrCreateArtistsBulk(names);

    // Two chunks of 500 and 1, and BOTH are processed. An off-by-one in the
    // slice arithmetic loses exactly the tail, and a map without it is
    // silently short rather than wrong-looking.
    const inLists = d.artist.findMany.mock.calls
      .map((c) => (c[0] as { where: { name: { in: string[] } } }).where.name.in.length);
    expect(inLists).toEqual([500, 500, 1, 1]);
    // The first two are the exact pass, the last two the post-insert re-read.
    expect(map.get('artist 0')).toBe(1);
  });

  it('propagates a failure from the exact pass rather than returning a short map', async () => {
    d.artist.findMany.mockRejectedValue(new Error('connection reset') as never);
    // A short map is silently used by the caller: the missing artists just
    // never get ids, and nothing downstream says so.
    await expect(repo.getOrCreateArtistsBulk(['radiohead'])).rejects.toThrow('connection reset');
  });

  it('propagates a failure from the raw twin pass rather than creating duplicates', async () => {
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockRejectedValue(new Error('syntax error') as never);
    // Continuing past this would insert a lowercase row that collides with the
    // ProperCase twin already in the table.
    await expect(repo.getOrCreateArtistsBulk(['mac demarco'])).rejects.toThrow('syntax error');
    expect(d.artist.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failure from createMany', async () => {
    d.artist.findMany.mockResolvedValue([] as never);
    d.$queryRaw.mockResolvedValue([] as never);
    d.artist.createMany.mockRejectedValue(new Error('deadlock detected') as never);
    await expect(repo.getOrCreateArtistsBulk(['radiohead'])).rejects.toThrow('deadlock detected');
  });
});
