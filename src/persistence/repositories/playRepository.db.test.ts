import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PlayRepository } from './playRepository';
import { connect, resetTables, skipReason } from '../../tests/dbHarness';
import type { PlayInsert } from '@domain/interfaces/iplayRepository';

/**
 * The real-Postgres proof for playRepository's write path.
 *
 * The unit suite mocks Prisma, so the three things most likely to be wrong
 * here were all untested:
 *
 *  1. CHUNKING. INSERT_CHUNK_SIZE is 500; a slice that drops or duplicates the
 *     tail is invisible to a mock that records calls.
 *  2. THE DEDUP CONSTRAINT. `user_plays_identity_uniq` excludes user_play_id,
 *     so inserting the same batch twice must yield N rows, not 2N. That is the
 *     plan's acceptance criterion for 1.2, and only a real unique index can
 *     prove it.
 *  3. THE RAW TIMING QUERY, which aggregates over a GROUP BY expression -
 *     the shape Postgres rejects when user_id only appears inside it.
 *
 * The retry classification is unit-tested separately against the real Prisma
 * error strings, because provoking a genuine pool timeout here would be
 * flaky; see playRepository.retry.test.ts.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: PlayRepository | null = null;
let userId = 1;

const play = (over: Partial<PlayInsert> = {}): PlayInsert => ({
  userId,
  artistName: 'Radiohead',
  trackName: 'Airbag',
  timePlayed: new Date('2024-03-01T12:00:00.000Z'),
  ...over,
});

suite('PlayRepository against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (prisma) repo = new PlayRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (prisma) await resetTables(prisma);
    userId += 1;
  });

  it('inserts a batch and reports the count', async () => {
    const rows = await repo!.batchInsertPlays([play(), play({ timePlayed: new Date('2024-03-01T12:00:01.000Z') })]);
    expect(rows).toBe(2);
    expect(await prisma!.userPlay.count()).toBe(2);
  });

  it('inserts N rows exactly once when the same batch is submitted twice', async () => {
    // The dedup identity deliberately excludes user_play_id, so two scrobbles
    // of the same track in the same second are ONE play whatever their ids.
    const batch = [play(), play({ timePlayed: new Date('2024-03-01T12:00:05.000Z') })];

    const first = await repo!.batchInsertPlays(batch);
    const second = await repo!.batchInsertPlays(batch);

    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(await prisma!.userPlay.count()).toBe(2);
  });

  it('keeps distinct seconds as distinct plays', async () => {
    // The control for the test above: shift the IDENTITY, not the id.
    await repo!.batchInsertPlays([play()]);
    await repo!.batchInsertPlays([play({ timePlayed: new Date('2024-03-01T12:00:01.000Z') })]);
    expect(await prisma!.userPlay.count()).toBe(2);
  });

  it('treats a NULL track name as part of the identity, not as a wildcard', async () => {
    // NULLS NOT DISTINCT is load-bearing: without it every null track_name
    // would slip past and the guarantee would be partial in exactly the cases
    // most likely to be real.
    await repo!.batchInsertPlays([play({ trackName: undefined })]);
    const second = await repo!.batchInsertPlays([play({ trackName: undefined })]);
    expect(second).toBe(0);
    expect(await prisma!.userPlay.count()).toBe(1);
  });

  it('chunks a large batch without losing or duplicating a row', async () => {
    // 1201 rows spans three chunks (500 + 500 + 201). A bad slice shows up
    // here as a count that is not 1201.
    const base = Date.UTC(2024, 2, 1, 0, 0, 0);
    const many = Array.from({ length: 1201 }, (_, i) =>
      play({ timePlayed: new Date(base + i * 1000) }),
    );

    const inserted = await repo!.batchInsertPlays(many);

    expect(inserted).toBe(1201);
    expect(await prisma!.userPlay.count()).toBe(1201);
  });

  it('defaults a missing play source to LastFm rather than writing null', async () => {
    await repo!.batchInsertPlays([play()]);
    const row = await prisma!.userPlay.findFirstOrThrow();
    expect(row.playSource).toBe('LastFm');
  });

  it('preserves an explicit play source', async () => {
    await repo!.batchInsertPlays([play({ playSource: 'SpotifyImport' })]);
    const row = await prisma!.userPlay.findFirstOrThrow();
    expect(row.playSource).toBe('SpotifyImport');
  });

  it('returns 0 for an empty batch without opening a query', async () => {
    await expect(repo!.batchInsertPlays([])).resolves.toBe(0);
  });

  it('counts plays since a date with the raw aggregate', async () => {
    await repo!.batchInsertPlays([
      play({ timePlayed: new Date('2024-01-01T00:00:00.000Z') }),
      play({ timePlayed: new Date('2024-06-01T00:00:00.000Z') }),
    ]);
    const since = await repo!.getPlayCountSince(userId, new Date('2024-03-01T00:00:00.000Z'));
    expect(since).toBe(1);
  });
});
