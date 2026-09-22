import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ArtistRepository } from './artistRepository';

describe('ArtistRepository case-insensitive canonicalization', () => {
  it('reuses a ProperCase twin instead of creating a lowercase dupe', async () => {
    const findFirst = vi.fn(async () => ({ artistId: 2, name: 'Mac DeMarco' }));
    const create = vi.fn(async () => {
      throw new Error('must not create');
    });
    const repo = new ArtistRepository({ artist: { findFirst, create } } as never);
    const row = await repo.getOrCreateArtist('mac demarco');
    expect(row.artistId).toBe(2);
    expect(findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'mac demarco', mode: 'insensitive' } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates lowercase when nothing matches', async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async (args: unknown) => ({ artistId: 9, ...(args as { data: object }).data }));
    const repo = new ArtistRepository({ artist: { findFirst, create } } as never);
    const row = await repo.getOrCreateArtist('New Artist');
    expect(row.artistId).toBe(9);
    expect(create).toHaveBeenCalledWith({ data: { name: 'new artist' } });
  });
});
