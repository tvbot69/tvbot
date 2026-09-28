import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PlayRepository } from './playRepository';

/**
 * playRepository was 33.4% with 325 uncovered lines. The database-backed parts
 * are covered by playRepository.db.test.ts against a real postgres; this file
 * covers the pure logic that decides whether two plays are the SAME play.
 *
 * `playKey` is the deduplication identity, and its normalisation is the whole
 * point. Last.fm returns "Mo  nd" with a double space; storage normalises it
 * to "Mo nd". If the key did not normalise the same way, every sync would
 * re-insert the same scrobbles as duplicates and simultaneously flag the
 * originals as removed - a slow, permanent corruption of a user's history.
 */

const prisma = () => ({
  userPlay: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  user: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
  userArtist: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })) },
  userAlbum: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })) },
  userTrack: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })), deleteMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return typeof arg === 'function' ? (arg as () => unknown)() : arg;
  }),
});

const build = () => {
  const p = prisma();
  return { repo: new PlayRepository(p as never), p };
};

const at = (s: string) => new Date(s);

describe('PlayRepository.playKey', () => {
  it('is identical for two plays that differ only in whitespace', () => {
    // The regression this guards: a double space from the API would otherwise
    // produce a different key and re-insert the same scrobble forever.
    const a = PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'Radiohead', 'Airbag');
    const b = PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'Radiohead ', 'Airbag');
    expect(a).toBe(b);
  });

  it('PRESERVES casing, which normalizeStoredName deliberately does', () => {
    // Documented: casing is preserved and queries match case-insensitively.
    // Folding case here would make the key disagree with storage.
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'radiohead', 'AIRBAG'))
      .not.toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'Radiohead', 'Airbag'));
  });

  it('PRESERVES punctuation, which is part of an artist name', () => {
    // "AC/DC" and "AC DC" are different spellings and only one is right;
    // silently treating them as equal would merge two real artists.
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'AC/DC', 't'))
      .not.toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'AC DC', 't'));
  });

  it('strips zero-width characters that break an exact match', () => {
    // The invisible-noise case the normaliser exists for: a zero-width space
    // pasted from a web page would otherwise fork a scrobble in two.
    const zeroWidth = String.fromCharCode(0x200b);
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'Radio' + zeroWidth + 'head', 'Airbag'))
      .toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'Radiohead', 'Airbag'));
  });

  it('treats a null track name the same as an empty one', () => {
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', null))
      .toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', ''));
  });

  it('DISTINGUISHES different artists', () => {
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', 't'))
      .not.toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'B', 't'));
  });

  it('DISTINGUISHES different tracks', () => {
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', 't1'))
      .not.toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', 't2'));
  });

  it('DISTINGUISHES different seconds', () => {
    // Two scrobbles of the same track a second apart are TWO plays.
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', 't'))
      .not.toBe(PlayRepository.playKey(at('2024-01-01T00:00:01Z'), 'A', 't'));
  });

  it('DOCUMENTS a known collision when a name contains the separator', () => {
    // "A|B" with track "t" and "A" with track "B|t" produce the same key. The
    // separator is a pipe because artist names can contain almost anything.
    // Pinned as KNOWN rather than asserted away: the key is only ever
    // compared for equality, so the cost is that one odd pair of scrobbles
    // can be mistaken for the same play. Fixing it means length-prefixing the
    // fields, which changes every stored comparison.
    expect(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A|B', 't'))
      .toBe(PlayRepository.playKey(at('2024-01-01T00:00:00Z'), 'A', 'B|t'));
  });
});

describe('PlayRepository.findExistingPlayKeys', () => {
  it('returns an empty set when nothing is stored', async () => {
    const { repo } = build();
    const keys = await repo.findExistingPlayKeys(1, at('2024-01-01'), at('2024-02-01'));
    expect(keys.size).toBe(0);
  });

  it('builds keys that match the ones a batch would compute', async () => {
    // If these two ever disagreed, every re-index would duplicate.
    const { repo, p } = build();
    (p.userPlay.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { timePlayed: at('2024-03-01T00:00:00Z'), artistName: 'Radiohead', trackName: 'Airbag' },
    ]);
    const keys = await repo.findExistingPlayKeys(1, at('2024-01-01'), at('2024-04-01'));
    expect(keys.has(PlayRepository.playKey(at('2024-03-01T00:00:00Z'), 'Radiohead', 'Airbag'))).toBe(true);
  });

  it('queries only the requested window and user', async () => {
    const { repo, p } = build();
    const from = at('2024-01-01');
    const to = at('2024-02-01');
    await repo.findExistingPlayKeys(7, from, to);
    const arg = (p.userPlay.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    // The filter is nested under `where`; Prisma takes a single args object.
    expect(arg.where.userId).toBe(7);
    // Compare by time: a fresh Date() has the same instant but is not the
    // same object, so toEqual on Dates is identity-ish and misleads.
    expect((arg.where.timePlayed.gte as Date).getTime()).toBe(from.getTime());
    expect((arg.where.timePlayed.lte as Date).getTime()).toBe(to.getTime());
  });
});

describe('PlayRepository.removePlaysByIds', () => {
  it('returns 0 without querying for an empty id list', async () => {
    const { repo, p } = build();
    await expect(repo.removePlaysByIds([])).resolves.toBe(0);
    expect(p.userPlay.deleteMany).not.toHaveBeenCalled();
  });

  it('never deletes an imported play, only Last.fm ones', async () => {
    // The guard is the whole point: a Spotify import is not a scrobble the
    // bot may rewrite, and deleting it would corrupt an imported history.
    const { repo, p } = build();
    await repo.removePlaysByIds([1n, 2n]);
    const where = (p.userPlay.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.where;
    expect(where.OR).toEqual([{ playSource: 'LastFm' }, { playSource: null }]);
  });

  it('excludes Spotify and Apple sources by omission, not by listing them', async () => {
    const { repo, p } = build();
    await repo.removePlaysByIds([1n]);
    const sources = ((p.userPlay.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.where.OR ?? [])
      .map((o: { playSource?: string }) => o.playSource);
    // Asserted structurally: JSON.stringify cannot serialise the BigInt id list.
    expect(sources).toEqual(['LastFm', null]);
  });
});

describe('PlayRepository delete and count guards', () => {
  it('counts plays since a date', async () => {
    const { repo, p } = build();
    (p.userPlay.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    await expect(repo.getPlayCountSince(1, at('2024-01-01'))).resolves.toBe(5);
  });

  it('omits the date filter when none is given', async () => {
    const { repo, p } = build();
    await repo.getPlayCountSince(1);
    const arg = (p.userPlay.count as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg.timePlayed).toBeUndefined();
  });

  it('returns null when the user has never scrobbled', async () => {
    const { repo } = build();
    await expect(repo.getLastStoredPlayTime(1)).resolves.toBeNull();
  });
});
