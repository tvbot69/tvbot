import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { connect, resetTables, seedUser, skipReason, useScratchSchema } from '../../../testSupport/dbHarness';
import type { PlayInsert } from '@domain/interfaces/ports/iplayRepository';

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
    if (prisma) {
      await useScratchSchema(prisma);
      repo = new PlayRepository(prisma);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    // The scratch database starts empty and user_plays.user_id is a foreign
    // key, so every insert needs a user row to point at.
    await seedUser(prisma, userId);
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

  it('uses the (user_id, lower(artist)) index for the artist-only week/month window', async () => {
    // Mirrors getRecentEntityPlaycounts artist-only shape. Mutation check:
    // dropping the migration removes the index from pg_indexes (red), while
    // plan-choice on a tiny table is not deterministic — EXPLAIN may pick any
    // valid index even with enable_seqscan=OFF — so the plan name itself is
    // not asserted.
    await repo!.batchInsertPlays([
      play({ artistName: 'Radiohead', timePlayed: new Date('2024-02-10T12:00:00.000Z') }),
      play({ artistName: 'Radiohead', timePlayed: new Date('2024-02-10T12:00:01.000Z') }),
    ]);
    const monthAgo = new Date('2024-02-01T00:00:00.000Z');
    const weekAgo = new Date('2024-02-20T00:00:00.000Z');
    const sql =
      'SELECT (COUNT(*) FILTER (WHERE time_played >= $4))::int AS week, COUNT(*)::int AS month ' +
      'FROM user_plays WHERE user_id = $1 AND time_played >= $2 AND LOWER(artist_name) = LOWER($3)';
    const rows = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = OFF');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF) ${sql}`,
        userId,
        monthAgo,
        'Radiohead',
        weekAgo,
      );
    });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).not.toContain('Seq Scan');
    const indexes = await prisma!.$queryRawUnsafe<Array<{ indexname: string }>>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_plays'",
    );
    expect(indexes.map((r) => r.indexname)).toContain('user_plays_user_lower_artist_idx');
  });

  it('uses the (user_id, lower(artist), lower(album)) index for the album week/month window', async () => {
    // Mirrors getRecentEntityPlaycounts with albumName supplied.
    await repo!.batchInsertPlays([
      play({
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        timePlayed: new Date('2024-02-10T12:00:00.000Z'),
      }),
      play({
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        timePlayed: new Date('2024-02-10T12:00:01.000Z'),
      }),
    ]);
    const monthAgo = new Date('2024-02-01T00:00:00.000Z');
    const weekAgo = new Date('2024-02-20T00:00:00.000Z');
    const sql =
      'SELECT (COUNT(*) FILTER (WHERE time_played >= $5))::int AS week, COUNT(*)::int AS month ' +
      'FROM user_plays WHERE user_id = $1 AND time_played >= $2 AND LOWER(artist_name) = LOWER($3) ' +
      'AND LOWER(album_name) = LOWER($4)';
    const rows = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = OFF');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF) ${sql}`,
        userId,
        monthAgo,
        'Radiohead',
        'OK Computer',
        weekAgo,
      );
    });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('user_plays_user_lower_artist_album_idx');
    expect(plan).not.toContain('Seq Scan');
  });

  it('uses the (user_id, lower(artist), lower(track)) index for the track week/month window', async () => {
    // Mirrors getRecentEntityPlaycounts with trackName supplied.
    await repo!.batchInsertPlays([
      play({ artistName: 'Radiohead', trackName: 'Airbag', timePlayed: new Date('2024-02-10T12:00:00.000Z') }),
      play({ artistName: 'Radiohead', trackName: 'Airbag', timePlayed: new Date('2024-02-10T12:00:01.000Z') }),
    ]);
    const monthAgo = new Date('2024-02-01T00:00:00.000Z');
    const weekAgo = new Date('2024-02-20T00:00:00.000Z');
    const sql =
      'SELECT (COUNT(*) FILTER (WHERE time_played >= $5))::int AS week, COUNT(*)::int AS month ' +
      'FROM user_plays WHERE user_id = $1 AND time_played >= $2 AND LOWER(artist_name) = LOWER($3) ' +
      'AND LOWER(track_name) = LOWER($4)';
    const rows = await prisma!.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = OFF');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF) ${sql}`,
        userId,
        monthAgo,
        'Radiohead',
        'Airbag',
        weekAgo,
      );
    });
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('user_plays_user_lower_artist_track_idx');
    expect(plan).not.toContain('Seq Scan');
  });
});
