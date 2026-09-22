import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlayRepository, sumEntriesById } from './playRepository';

const makeRepo = (existing: Array<{ artistId?: number; albumId?: number; trackId?: number; playcount: number }>) => {
  const txOps: unknown[] = [];
  const prisma = {
    userArtist: {
      findMany: vi.fn(async () => existing.filter((e) => e.artistId !== undefined)),
      delete: vi.fn((a: unknown) => ({ op: 'delete', a })),
      update: vi.fn((a: unknown) => ({ op: 'update', a })),
      create: vi.fn((a: unknown) => ({ op: 'create', a })),
    },
    userAlbum: {
      findMany: vi.fn(async () => existing.filter((e) => e.albumId !== undefined)),
      delete: vi.fn((a: unknown) => ({ op: 'delete', a })),
      update: vi.fn((a: unknown) => ({ op: 'update', a })),
      create: vi.fn((a: unknown) => ({ op: 'create', a })),
    },
    userTrack: {
      findMany: vi.fn(async () => existing.filter((e) => e.trackId !== undefined)),
      delete: vi.fn((a: unknown) => ({ op: 'delete', a })),
      update: vi.fn((a: unknown) => ({ op: 'update', a })),
      create: vi.fn((a: unknown) => ({ op: 'create', a })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => {
      txOps.push(...ops);
      return ops;
    }),
  };
  return { repo: new PlayRepository(prisma as never), prisma, txOps };
};

describe('PlayRepository batched deltas (Phase 1.2)', () => {
  it('reads once and writes once per batch for artist deltas', async () => {
    const { repo, prisma, txOps } = makeRepo([
      { artistId: 1, playcount: 10 },
      { artistId: 2, playcount: 5 },
    ]);

    await repo.applyArtistDeltas(9, [
      { name: 'A', artistId: 1, delta: 3 },
      { name: 'B', artistId: 2, delta: -5 },
      { name: 'C', artistId: 3, delta: 2 },
      { name: 'Zero', artistId: 4, delta: 0 },
    ]);

    expect(prisma.userArtist.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.userArtist.findMany).toHaveBeenCalledWith({
      where: { userId: 9, artistId: { in: [1, 2, 3] } },
      select: { artistId: true, playcount: true },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txOps).toHaveLength(3);
  });

  it('deletes zeroed rows and skips negative creates', async () => {
    const { repo, txOps } = makeRepo([{ trackId: 7, playcount: 2 }]);

    await repo.applyTrackDeltas(9, [
      { name: 'Gone', artistId: 1, trackId: 7, delta: -2 },
      { name: 'Ghost', artistId: 1, trackId: 8, delta: -1 },
    ]);

    const kinds = (txOps as Array<{ op: string }>).map((o) => o.op).sort();
    expect(kinds).toEqual(['delete']);
  });
});

describe('sumEntriesById (case-variant collision guard)', () => {
  it('sums colliding spellings and keeps the top entry name', () => {
    const out = sumEntriesById(
      [
        { artistId: 66, name: 'mac demarco', playcount: 50 },
        { artistId: 66, name: 'Mac DeMarco', playcount: 150 },
      ],
      (e) => `${e.artistId}`,
    );
    expect(out).toEqual([{ artistId: 66, name: 'Mac DeMarco', playcount: 200 }]);
  });

  it('keeps distinct ids apart', () => {
    const out = sumEntriesById(
      [
        { artistId: 2, name: 'Mac DeMarco', playcount: 150 },
        { artistId: 66, name: 'mac demarco', playcount: 50 },
      ],
      (e) => `${e.artistId}`,
    );
    expect(out).toHaveLength(2);
    expect(out.reduce((s, e) => s + e.playcount, 0)).toBe(200);
  });
});

describe('playKey normalization', () => {
  it('keys structural variants identically (whitespace/zero-width)', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(PlayRepository.playKey(t, 'Mo  nd', 'Song')).toBe(PlayRepository.playKey(t, 'Mo nd', 'Song'));
    expect(PlayRepository.playKey(t, 'Mond ', 'Song')).toBe(PlayRepository.playKey(t, 'Mond', 'Song'));
  });

  it('keys distinct songs differently', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(PlayRepository.playKey(t, 'A', 'X')).not.toBe(PlayRepository.playKey(t, 'A', 'Y'));
    expect(PlayRepository.playKey(t, 'A', 'X')).not.toBe(
      PlayRepository.playKey(new Date('2026-01-01T00:00:01Z'), 'A', 'X'),
    );
  });
});
