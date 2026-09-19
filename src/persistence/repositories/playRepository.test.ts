import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlayRepository } from './playRepository';

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
