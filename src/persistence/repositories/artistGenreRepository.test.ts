import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ArtistGenreRepository } from './artistGenreRepository';

/**
 * artistGenreRepository had NO unit test at all. It is the storage half of the
 * genre-anchoring feature, and the normalisation in `setForArtistId` is the
 * product: the same artist is tagged `Indie Rock`, `indie rock` and ` indie-rock `
 * by three different people, and if those become three rows the card shows the
 * same genre three times.
 *
 * The four-tag cap is a layout decision that lives here, so it is asserted as
 * an exact number rather than as "at least one". The delete-then-insert is one
 * transaction, and the emptiness case matters: clearing every tag must still
 * DELETE and must NOT call `createMany` with an empty array, which Prisma takes
 * as a no-op and which is a pointless round trip besides.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

const makePrisma = () => ({
  artist: {
    findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  },
  artistGenre: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    createMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
  },
  $transaction: vi.fn(async (..._args: unknown[]) => undefined),
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: ArtistGenreRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new ArtistGenreRepository(d as unknown as PrismaClient);
});

/**
 * Runs the callback `setForArtistId` handed to `$transaction` against a tx
 * double, which is what Prisma does in production. Asserting on the root
 * client's delegates instead would assert nothing: nothing on the root client
 * is ever called on this path.
 */
const runTransaction = async (): Promise<{
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
}> => {
  const callback = callArg<(tx: unknown) => Promise<void>>(d.$transaction);
  const deleteMany = vi.fn(async (..._args: unknown[]) => ({ count: 0 }));
  const createMany = vi.fn(async (..._args: unknown[]) => ({ count: 0 }));
  await callback({ artistGenre: { deleteMany, createMany } });
  return { deleteMany, createMany };
};

describe('ArtistGenreRepository.getForArtistId', () => {
  it('projects the name alone and returns a plain string list', async () => {
    d.artistGenre.findMany.mockResolvedValue([{ name: 'indie rock' }, { name: 'shoegaze' }] as never);

    expect(await repo.getForArtistId(7)).toEqual(['indie rock', 'shoegaze']);
    expect(callArg(d.artistGenre.findMany)).toEqual({
      where: { artistId: 7 },
      select: { name: true },
    });
  });

  it('returns an empty list for an artist with no tags', async () => {
    d.artistGenre.findMany.mockResolvedValue([] as never);
    expect(await repo.getForArtistId(7)).toEqual([]);
  });

  it('propagates a read failure rather than reporting "this artist has no genres"', async () => {
    d.artistGenre.findMany.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getForArtistId(7)).rejects.toThrow('connection reset');
  });
});

describe('ArtistGenreRepository.getForArtistName', () => {
  it('resolves the name case-insensitively, then reads that artist id', async () => {
    d.artist.findFirst.mockResolvedValue({ artistId: 42 } as never);
    d.artistGenre.findMany.mockResolvedValue([{ name: 'idm' }] as never);

    expect(await repo.getForArtistName('Boards of Canada')).toEqual(['idm']);
    // Last.fm sends whatever the tagger typed, so an exact match silently
    // finds nothing and the card loses its genre anchor.
    expect(callArg(d.artist.findFirst)).toEqual({
      where: { name: { equals: 'Boards of Canada', mode: 'insensitive' } },
      select: { artistId: true },
    });
    expect(callArg(d.artistGenre.findMany)).toEqual({ where: { artistId: 42 }, select: { name: true } });
  });

  it('returns empty for an artist that is not in the catalogue, and does not query genres', async () => {
    d.artist.findFirst.mockResolvedValue(null as never);
    expect(await repo.getForArtistName('Nobody')).toEqual([]);
    expect(d.artistGenre.findMany).not.toHaveBeenCalled();
  });

  it('propagates a catalogue lookup failure rather than reporting no genres', async () => {
    d.artist.findFirst.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getForArtistName('Radiohead')).rejects.toThrow('connection reset');
  });
});

describe('ArtistGenreRepository.setForArtistId', () => {
  it('does the delete and the insert inside ONE transaction', async () => {
    await repo.setForArtistId(7, ['idm']);
    // A delete outside the transaction would leave the artist with no genres
    // if the insert failed - and genre tags are exactly the kind of data a
    // user would only notice missing after a restart.
    expect(d.$transaction).toHaveBeenCalledTimes(1);
    expect(callArg(d.$transaction)).toBeInstanceOf(Function);
  });

  it('deletes every row for the artist, and only that artist', async () => {
    await repo.setForArtistId(7, ['idm']);
    const { deleteMany } = await runTransaction();
    expect(deleteMany).toHaveBeenCalledWith({ where: { artistId: 7 } });
  });

  it('lowercases and trims, so three spellings of one tag become one row', async () => {
    await repo.setForArtistId(7, ['  Indie Rock ', 'indie rock', 'INDIE ROCK']);
    const { createMany } = await runTransaction();

    // A deduped lowercase row: without it the card renders the same genre
    // three times, and `@@unique([artistId, name])` fights `skipDuplicates`.
    expect(createMany).toHaveBeenCalledWith({
      data: [{ artistId: 7, name: 'indie rock' }],
      skipDuplicates: true,
    });
  });

  it('DROPS tags that are only whitespace', async () => {
    await repo.setForArtistId(7, ['idm', '   ', '']);
    const { createMany } = await runTransaction();

    // The truthy check runs AFTER the trim+lowercase, so both `'   '` and `''`
    // become '' and are filtered. An empty-string tag row would render a stray
    // bullet on the card.
    expect(createMany).toHaveBeenCalledWith({ data: [{ artistId: 7, name: 'idm' }], skipDuplicates: true });
  });

  it('keeps at most FOUR tags, and keeps the FIRST four in caller order', async () => {
    await repo.setForArtistId(7, ['a', 'b', 'c', 'd', 'e', 'f']);
    const { createMany } = await runTransaction();

    // The cap is a layout decision (four chips fit the card) and it lives here,
    // so it is an exact number. It is applied AFTER dedupe, so duplicates
    // cannot eat a slot.
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { artistId: 7, name: 'a' },
        { artistId: 7, name: 'b' },
        { artistId: 7, name: 'c' },
        { artistId: 7, name: 'd' },
      ],
      skipDuplicates: true,
    });
  });

  it('CLEARING every tag still deletes, and never calls createMany', async () => {
    // "Remove all tags" is a real user action. An empty `createMany` is a
    // pointless round trip and, if Prisma ever starts validating it, a throw
    // inside the transaction AFTER the delete has already run.
    await repo.setForArtistId(7, []);
    const { deleteMany, createMany } = await runTransaction();

    expect(deleteMany).toHaveBeenCalledWith({ where: { artistId: 7 } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('clearing with only whitespace tags behaves the same as clearing with none', async () => {
    await repo.setForArtistId(7, ['  ', '']);
    const { deleteMany, createMany } = await runTransaction();

    expect(deleteMany).toHaveBeenCalledWith({ where: { artistId: 7 } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('asks the database to skip duplicates even though they were deduped in JS', async () => {
    // Belt and braces: the JS dedupe and the unique index can disagree if a
    // name differs only by case AFTER lowercasing by some other route, and the
    // insert must not blow up the transaction.
    await repo.setForArtistId(7, ['idm']);
    const { createMany } = await runTransaction();
    expect(callArg<{ skipDuplicates: boolean }>(createMany).skipDuplicates).toBe(true);
  });

  it('propagates a transaction failure rather than reporting the tags were saved', async () => {
    d.$transaction.mockRejectedValue(new Error('deadlock detected') as never);
    // Reporting success here is the exact A1 failure: the user is told their
    // genre tags were updated and they were not.
    await expect(repo.setForArtistId(7, ['idm'])).rejects.toThrow('deadlock detected');
  });
});

describe('ArtistGenreRepository.getForArtistNames', () => {
  it('returns an empty map WITHOUT querying for an empty request', async () => {
    const got = await repo.getForArtistNames([]);

    expect(got.size).toBe(0);
    expect(d.artist.findMany).not.toHaveBeenCalled();
  });

  it('matches names case-insensitively and keys the map by LOWERCASE name', async () => {
    d.artist.findMany.mockResolvedValue([
      { name: 'Boards of Canada', genres: [{ name: 'idm' }, { name: 'ambient' }] },
    ] as never);

    const got = await repo.getForArtistNames(['Boards of Canada']);

    // The caller looks the map up by the lowercased requested name, so a
    // ProperCase key would miss and the card would render no genres at all.
    expect(got.get('boards of canada')).toEqual(['idm', 'ambient']);
    expect(got.has('Boards of Canada')).toBe(false);
    expect(callArg(d.artist.findMany)).toEqual({
      where: { name: { in: ['boards of canada'], mode: 'insensitive' } },
      select: { name: true, genres: { select: { name: true } } },
    });
  });

  it('resolves several artists in ONE query', async () => {
    d.artist.findMany.mockResolvedValue([
      { name: 'Aphex Twin', genres: [{ name: 'idm' }] },
      { name: 'Autechre', genres: [] },
    ] as never);

    const got = await repo.getForArtistNames(['Aphex Twin', 'Autechre']);

    expect(d.artist.findMany).toHaveBeenCalledTimes(1);
    expect(got.get('aphex twin')).toEqual(['idm']);
    // An artist with no tags is an EMPTY list, not a missing key: the caller
    // distinguishes "no genres recorded" from "artist not in the catalogue".
    expect(got.get('autechre')).toEqual([]);
    expect(got.has('autechre')).toBe(true);
  });

  it('trims and lowercases the requested names before querying', async () => {
    d.artist.findMany.mockResolvedValue([] as never);

    await repo.getForArtistNames(['  Aphex Twin  ']);

    expect(callArg<{ where: { name: { in: string[] } } }>(d.artist.findMany).where.name.in).toEqual([
      'aphex twin',
    ]);
  });

  it('deduplicates requested names so the IN list has no repeats', async () => {
    d.artist.findMany.mockResolvedValue([] as never);

    await repo.getForArtistNames(['Aphex Twin', 'aphex twin', 'APHEX TWIN']);

    expect(callArg<{ where: { name: { in: string[] } } }>(d.artist.findMany).where.name.in).toEqual([
      'aphex twin',
    ]);
  });

  it('omits a requested artist the catalogue does not know', async () => {
    d.artist.findMany.mockResolvedValue([] as never);

    const got = await repo.getForArtistNames(['Nobody At All']);

    // Absent, not an empty list: the caller uses the distinction to decide
    // whether to fall back to a Last.fm lookup.
    expect(got.has('nobody at all')).toBe(false);
  });

  it('propagates a read failure rather than returning a map of no genres', async () => {
    d.artist.findMany.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getForArtistNames(['Aphex Twin'])).rejects.toThrow('connection reset');
  });
});
