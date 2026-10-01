import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ArtistsService } from '../artistsService';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The seven raw queries behind the artist top-lists.
 *
 * They all share one shape: aggregate user_plays by artist, optionally scoped
 * to one user, and the artist match is `LOWER(artist_name) = LOWER($n)`. That
 * case-insensitive comparison is the thing worth proving against a real
 * Postgres rather than a mock, because a mock agrees with whatever the code
 * does - it cannot tell a case-sensitive match from an insensitive one.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: ArtistsService | null = null;
let userId = 1;

const at = (iso: string) => new Date(iso);
/** Distinct seconds: the dedup index collapses same-second plays. */
const plays = (artist: string, track: string, seconds: number, album?: string) =>
  Array.from({ length: seconds }, (_, i) => ({
    userId,
    artistName: artist,
    trackName: track,
    albumName: album,
    timePlayed: at(`2021-01-01T00:00:${String(i).padStart(2, '0')}Z`),
  }));

/** A cache double; these methods only consult it behind `useCache`. */
const cache = { get: async () => null, set: async () => undefined };

suite('ArtistsService raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    // prisma is the FIFTH parameter, not the first. Passing it first compiles
    // fine when the rest are `as never`, and every query then fails inside the
    // service's own `catch { return [] }` - which looks exactly like "no data".
    service = new ArtistsService(
      { getArtistInfo: async () => null, getTopArtists: async () => [] } as never,
      cache as never,
      undefined,
      undefined,
      prisma,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await seedUser(prisma, userId);
  });

  it('returns an empty list rather than failing when the user has no plays', async () => {
    await expect(service!.getUserAllTimeTopArtists(userId)).resolves.toEqual([]);
    await expect(service!.getTopTracksForArtist(userId, 'Nobody')).resolves.toEqual([]);
    await expect(service!.getTopAlbumsForArtist(userId, 'Nobody')).resolves.toEqual([]);
  });

  it('ranks artists by playcount descending', async () => {
    await seedPlays(prisma!, [
      ...plays('Rare Artist', 't', 1),
      ...plays('Top Artist', 't', 3),
    ]);
    const result = await service!.getUserAllTimeTopArtists(userId);
    expect(result[0]?.name).toBe('Top Artist');
    expect(result[0]?.playcount).toBe(3);
    expect(result[1]?.playcount).toBe(1);
  });

  it('counts a bigint playcount as a JS number, not a string', async () => {
    // COUNT(*) comes back as bigint; the map has to convert or every
    // downstream comparison silently does string maths.
    await seedPlays(prisma!, plays('Solo', 't', 2));
    const [first] = await service!.getUserAllTimeTopArtists(userId);
    expect(typeof first?.playcount).toBe('number');
  });

  it('scopes the top-tracks query to one user', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      ...plays('Shared', 'Mine', 2),
      { userId: other, artistName: 'Shared', trackName: 'Theirs', timePlayed: at('2021-02-01T00:00:00Z') },
    ]);
    const mine = await service!.getTopTracksForArtist(userId, 'Shared');
    expect(mine.map((t) => t.name)).toEqual(['Mine']);
    expect(mine[0]?.userId).toBe(userId);
  });

  it('matches the artist name case-insensitively', async () => {
    await seedPlays(prisma!, plays('Radiohead', 'Airbag', 1));
    const lower = await service!.getTopTracksForArtist(userId, 'radiohead');
    const upper = await service!.getTopTracksForArtist(userId, 'RADIOHEAD');
    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
  });

  it('drops a NULL track name rather than listing a blank row', async () => {
    await seedPlays(prisma!, [
      ...plays('Artist', 'Real Track', 1),
      { userId, artistName: 'Artist', trackName: null, timePlayed: at('2021-03-01T00:00:00Z') },
    ]);
    const tracks = await service!.getTopTracksForArtist(userId, 'Artist');
    expect(tracks.map((t) => t.name)).toEqual(['Real Track']);
  });

  it('excludes a NULL or empty album name from the album list', async () => {
    await seedPlays(prisma!, [
      ...plays('Artist', 't', 1, 'Real Album'),
      { userId, artistName: 'Artist', trackName: 'x', albumName: '', timePlayed: at('2021-04-01T00:00:00Z') },
      { userId, artistName: 'Artist', trackName: 'y', albumName: null, timePlayed: at('2021-04-02T00:00:00Z') },
    ]);
    const albums = await service!.getTopAlbumsForArtist(userId, 'Artist');
    expect(albums.map((a) => a.name)).toEqual(['Real Album']);
  });

  it('aggregates across every user for the global album and track lists', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      ...plays('Global', 'Shared Track', 2, 'Shared Album'),
      { userId: other, artistName: 'Global', trackName: 'Shared Track', albumName: 'Shared Album', timePlayed: at('2021-05-01T00:00:00Z') },
    ]);
    const albums = await service!.getTopAlbumsForArtistGlobal('Global');
    const tracks = await service!.getTopTracksForArtistGlobal('Global');
    expect(albums[0]?.playcount).toBe(3);
    expect(tracks[0]?.playcount).toBe(3);
  });

  it('honours the limit passed into the global queries', async () => {
    await seedPlays(prisma!, [
      ...plays('Limiter', 'A', 1),
      ...plays('Limiter', 'B', 1).map((p) => ({ ...p, timePlayed: at('2021-06-01T00:00:00Z') })),
      ...plays('Limiter', 'C', 1).map((p) => ({ ...p, timePlayed: at('2021-06-02T00:00:00Z') })),
    ]);
    await expect(service!.getTopTracksForArtistGlobal('Limiter', 2)).resolves.toHaveLength(2);
  });
});
