import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { FmFooterRepository } from './fmFooterRepository';

/**
 * The footer runs on the now-playing hot path, and every field on it is a
 * promise someone is waiting to render. Two things are worth holding here, and
 * neither is visible in the resolver's own tests because they double the
 * repository too:
 *
 *  - The **query shapes**. A case-sensitive `equals`, a missing `userId`, or a
 *    `select` that drops a column all still return "a number" or "a row", so
 *    every assertion in the resolver suite stays green while the field quietly
 *    reads zero. These tests pin the arguments.
 *  - **`null` versus `0`**. A rollup row that does not exist and a rollup row
 *    that sums to zero are different answers, and only the caller can render
 *    them differently. Collapsing them in here is a one-character change that
 *    is very hard to see.
 */
const makePrisma = (over: Record<string, unknown> = {}) => ({
  userArtist: { aggregate: vi.fn(async () => ({ _sum: { playcount: 11 } })) },
  userAlbum: { aggregate: vi.fn(async () => ({ _sum: { playcount: 12 } })) },
  userTrack: { aggregate: vi.fn(async () => ({ _sum: { playcount: 13 } })) },
  userPlay: { count: vi.fn(async () => 7) },
  album: { findFirst: vi.fn(async () => ({ albumId: 99 })) },
  track: { findFirst: vi.fn(async () => ({ trackId: 88 })) },
  ...over,
});

describe('FmFooterRepository - per-user playcount fallbacks', () => {
  it('sums the user_artists rollup for one user and artist, case-insensitively', async () => {
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).getUserArtistPlaycount(123, 'Gunna');

    expect(prisma.userArtist.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'Gunna', mode: 'insensitive' } },
    });
  });

  it('sums the user_albums rollup for one user and album', async () => {
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).getUserAlbumPlaycount(123, 'A Gift & a Curse');

    expect(prisma.userAlbum.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'A Gift & a Curse', mode: 'insensitive' } },
    });
  });

  it('sums the user_tracks rollup for one user and track', async () => {
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).getUserTrackPlaycount(123, 'fukumean');

    expect(prisma.userTrack.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'fukumean', mode: 'insensitive' } },
    });
  });

  it('returns the summed playcount', async () => {
    const repo = new FmFooterRepository(makePrisma() as never);

    await expect(repo.getUserArtistPlaycount(123, 'Gunna')).resolves.toBe(11);
    await expect(repo.getUserAlbumPlaycount(123, 'A Gift & a Curse')).resolves.toBe(12);
    await expect(repo.getUserTrackPlaycount(123, 'fukumean')).resolves.toBe(13);
  });

  it('reports a genuinely absent row as null, not zero', async () => {
    // Prisma sums to null when no row matched. Reporting 0 here would hand the
    // caller a number it cannot distinguish from a real zero-playcount row.
    const prisma = makePrisma({
      userArtist: { aggregate: vi.fn(async () => ({ _sum: { playcount: null } })) },
    });

    await expect(new FmFooterRepository(prisma as never).getUserArtistPlaycount(123, 'Gunna'))
      .resolves.toBeNull();
  });

  it('passes a real zero straight through, so the caller can tell it from null', async () => {
    const prisma = makePrisma({
      userArtist: { aggregate: vi.fn(async () => ({ _sum: { playcount: 0 } })) },
    });

    await expect(new FmFooterRepository(prisma as never).getUserArtistPlaycount(123, 'Gunna'))
      .resolves.toBe(0);
  });
});

describe('FmFooterRepository - artist plays this week', () => {
  it('counts scrobbles at or after the caller-supplied window', async () => {
    const prisma = makePrisma();
    const weekAgo = new Date('2026-09-21T00:00:00Z');

    await new FmFooterRepository(prisma as never).countUserArtistPlaysSince(123, 'Gunna', weekAgo);

    expect(prisma.userPlay.count).toHaveBeenCalledWith({
      where: {
        userId: 123,
        artistName: { equals: 'Gunna', mode: 'insensitive' },
        timePlayed: { gte: weekAgo },
      },
    });
  });

  it('uses the given window rather than one of its own', async () => {
    // "This week" is footer policy. A repository that re-derived its own window
    // would be unfixable from the caller without editing this file.
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).countUserArtistPlaysSince(123, 'Gunna', new Date(0));

    const calls = prisma.userPlay.count.mock.calls as unknown as Array<[{
      where: { timePlayed: { gte: Date } };
    }]>;
    expect(calls[0]![0].where.timePlayed.gte).toEqual(new Date(0));
  });

  it('returns a genuine zero rather than null', async () => {
    const prisma = makePrisma({ userPlay: { count: vi.fn(async () => 0) } });

    await expect(new FmFooterRepository(prisma as never).countUserArtistPlaysSince(123, 'Gunna', new Date()))
      .resolves.toBe(0);
  });
});

describe('FmFooterRepository - catalogue id lookups', () => {
  it('resolves an album id by name and artist', async () => {
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).findAlbumByNameAndArtist('A Gift & a Curse', 'Gunna');

    expect(prisma.album.findFirst).toHaveBeenCalledWith({
      where: {
        name: { equals: 'A Gift & a Curse', mode: 'insensitive' },
        artist: { name: { equals: 'Gunna', mode: 'insensitive' } },
      },
    });
  });

  it('resolves a track id by name and artist', async () => {
    const prisma = makePrisma();

    await new FmFooterRepository(prisma as never).findTrackByNameAndArtist('fukumean', 'Gunna');

    expect(prisma.track.findFirst).toHaveBeenCalledWith({
      where: {
        name: { equals: 'fukumean', mode: 'insensitive' },
        artist: { name: { equals: 'Gunna', mode: 'insensitive' } },
      },
    });
  });

  it('returns only the id, so a who-knows lookup cannot reach the rest of the row', async () => {
    const repo = new FmFooterRepository(makePrisma() as never);

    await expect(repo.findAlbumByNameAndArtist('A Gift & a Curse', 'Gunna'))
      .resolves.toEqual({ albumId: 99 });
    await expect(repo.findTrackByNameAndArtist('fukumean', 'Gunna'))
      .resolves.toEqual({ trackId: 88 });
  });

  it('returns null when the album is not in the catalogue', async () => {
    const prisma = makePrisma({ album: { findFirst: vi.fn(async () => null) } });

    await expect(new FmFooterRepository(prisma as never).findAlbumByNameAndArtist('X', 'Gunna'))
      .resolves.toBeNull();
  });

  it('returns null when the track is not in the catalogue', async () => {
    const prisma = makePrisma({ track: { findFirst: vi.fn(async () => null) } });

    await expect(new FmFooterRepository(prisma as never).findTrackByNameAndArtist('x', 'Gunna'))
      .resolves.toBeNull();
  });
});
