import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PlayHistoryService } from '@bot/services/library/playHistoryService';
import { PlayRepository } from '@persistence/repositories/playRepository';
import {
  connect,
  resetTables,
  seedPlays,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../../testSupport/dbHarness';

/**
 * getYearOverview is SIX raw SQL queries in one method, and the unit suite
 * mocks the database, so none of them had ever been parsed by Postgres. A
 * renamed column or a GROUP BY Postgres rejects is a runtime failure with a
 * green build - which is the whole reason this suite exists.
 *
 * Seeding goes through dbHarness.seedPlays rather than hand-written INSERTs.
 * Prisma sends `$1` untyped and Postgres cannot resolve an untyped parameter
 * in an INSERT VALUES list, so the obvious inline version fails with 42804.
 * That is the single most common way to get this suite wrong, so it lives in
 * one place instead of in every test.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let service: PlayHistoryService | null = null;
let userId = 1;

const at = (iso: string) => new Date(iso);

suite('PlayHistoryService.getYearOverview against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    service = new PlayHistoryService(new PlayRepository(prisma) as never, {} as never, prisma);
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

  it('returns zeros for a year with no plays rather than failing', async () => {
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.totalPlays).toBe(0);
    expect(data.totalArtists).toBe(0);
    expect(data.topArtists).toEqual([]);
    expect(data.monthlyPlays).toHaveLength(12);
    expect(data.monthlyPlays.every((n) => n === 0)).toBe(true);
  });

  it('counts plays inside the year and excludes the neighbouring years', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at('2021-05-01T00:00:00Z') },
      { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at('2021-06-01T00:00:00Z') },
      { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at('2022-01-01T00:00:00Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.totalPlays).toBe(2);
    expect(data.topArtists[0]).toEqual({ name: 'Radiohead', playcount: 2 });
  });

  it('files a NULL track under "Unknown Track" rather than dropping it', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Mystery', trackName: null, timePlayed: at('2021-07-01T00:00:00Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.totalPlays).toBe(1);
    expect(data.topTracks[0]?.trackName).toBe('Unknown Track');
  });

  it('excludes an empty album name from the album list', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Aphex Twin', trackName: 'Xtal', albumName: '', timePlayed: at('2021-08-01T00:00:00Z') },
      // Distinct seconds: the dedup identity excludes user_play_id, so two plays
      // of the same track in the same second are ONE play whatever their ids.
      { userId, artistName: 'Aphex Twin', trackName: 'Xtal', albumName: 'SAW', timePlayed: at('2021-08-01T00:00:01Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.topAlbums.map((a) => a.albumName)).toEqual(['SAW']);
  });

  it('builds a 12-slot monthly array indexed by calendar month', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Boards', trackName: 'Roygbiv', timePlayed: at('2021-03-15T00:00:00Z') },
      { userId, artistName: 'Boards', trackName: 'Roygbiv', timePlayed: at('2021-03-20T00:00:00Z') },
      { userId, artistName: 'Boards', trackName: 'Roygbiv', timePlayed: at('2021-11-02T00:00:00Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.monthlyPlays[2]).toBe(2);
    expect(data.monthlyPlays[10]).toBe(1);
    expect(data.monthlyPlays[0]).toBe(0);
  });

  it('counts distinct artists case-insensitively', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'Radiohead', trackName: 'Airbag', timePlayed: at('2021-05-01T00:00:00Z') },
      { userId, artistName: 'RADIOHEAD', trackName: 'Karma Police', timePlayed: at('2021-05-02T00:00:00Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.totalArtists).toBe(1);
    expect(data.totalPlays).toBe(2);
  });

  it('reports the previous year total so a chart can show a delta', async () => {
    await seedPlays(prisma!, [
      { userId, artistName: 'A', trackName: 't', timePlayed: at('2020-05-01T00:00:00Z') },
      { userId, artistName: 'A', trackName: 't', timePlayed: at('2021-05-01T00:00:00Z') },
    ]);
    const data = await service!.getYearOverview(userId, 2021);
    expect(data.previousTotalPlays).toBe(1);
    expect(data.totalPlays).toBe(1);
  });

  it('does not leak one user plays into another', async () => {
    const other = userId + 5000;
    await seedUser(prisma!, other);
    await seedPlays(prisma!, [
      { userId, artistName: 'Mine', trackName: 't', timePlayed: at('2021-05-01T00:00:00Z') },
      { userId: other, artistName: 'Theirs', trackName: 't', timePlayed: at('2021-05-01T00:00:00Z') },
    ]);
    const mine = await service!.getYearOverview(userId, 2021);
    const theirs = await service!.getYearOverview(other, 2021);
    expect(mine.totalPlays).toBe(1);
    expect(theirs.totalPlays).toBe(1);
    expect(mine.topArtists[0]?.name).toBe('Mine');
    expect(theirs.topArtists[0]?.name).toBe('Theirs');
  });

  it('keeps getArtistPlaycountForDays working against a real count', async () => {
    const now = Date.now();
    await seedPlays(prisma!, [
      { userId, artistName: 'Recent', trackName: 't', timePlayed: new Date(now - 2 * 86400000) },
      { userId, artistName: 'Old', trackName: 't', timePlayed: new Date(now - 90 * 86400000) },
    ]);
    expect(await service!.getArtistPlaycountForDays(userId, 'Recent', 7)).toBe(1);
    expect(await service!.getArtistPlaycountForDays(userId, 'Old', 7)).toBe(0);
  });
});
