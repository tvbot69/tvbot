import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PlayRepository } from '../playRepository';
import type { PlayInsert } from '@domain/interfaces/iplayRepository';

/**
 * playRepository's insert path, which is where duplicate plays come from.
 *
 * THREE THINGS ARE WORTH HOLDING HERE, and none of them are about SQL:
 *
 *  1. CHUNKING. `batchInsertPlays` slices the input into INSERT_CHUNK_SIZE
 *     pieces. If the chunk size changes, or the slice arithmetic is off by one,
 *     plays are silently dropped - and a dropped play is a wrong scrobble count
 *     that nobody notices for weeks.
 *
 *  2. RETRY CLASSIFICATION. Only transient errors are retried; a genuine
 *     constraint violation must fail immediately. Retrying that would either
 *     mask a real bug or, worse, keep hammering a poisoned connection.
 *
 *  3. THE KNOWN DOUBLE-INSERT WINDOW. If a chunk commits and the ACK is lost -
 *     a timeout after the server applied it - the retry re-sends the same rows.
 *     `skipDuplicates: true` is meant to absorb that, but as documented in
 *     AGENTS.md the only unique key on user_play is the autoincrement
 *     userPlayId, so there is nothing for it to skip. These tests assert the
 *     CURRENT behaviour of that window rather than pretending it is safe; the
 *     fix is a real unique index, and these are the call sites it would cover.
 */

const INSERT_CHUNK_SIZE = 500;

// The real interface, so the fixtures cannot drift from what production accepts.
// A local copy with playSource?: string compiled fine under vitest and failed
// tsc - the arity/type trap AGENTS.md warns about, in a different guise.
type Insert = PlayInsert;



const makeInsert = (i: number): Insert => ({
  userId: 1,
  artistId: i,
  artistName: `Artist ${i}`,
  albumName: `Album ${i}`,
  trackName: `Track ${i}`,
  timePlayed: new Date('2026-01-01T00:00:00Z'),
  msPlayed: 200000,
  playSource: 'LastFm',
});

/** A Prisma double that records the chunk boundaries it was asked to insert. */
const makePrisma = () => {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  return { userPlay: { createMany, count: vi.fn(async () => 0) }, createMany };
};

const repo = (prisma: unknown) => new PlayRepository(prisma as never);

/** First createMany payload, typed. mock.calls[0] is possibly-undefined under
 * noUncheckedIndexedAccess, and the alternative - a non-null assertion - is a
 * type escape in a file whose subject is type safety. */
const firstPayload = (spy: { mock: { calls: unknown[][] } }): { data: Array<Record<string, unknown>>; skipDuplicates?: boolean } => {
  const call = spy.mock.calls[0];
  if (!call) throw new Error('createMany was never called');
  return call[0] as { data: Array<Record<string, unknown>> };
};

describe('PlayRepository.batchInsertPlays chunking', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => { prisma = makePrisma(); });
  afterEach(() => vi.useRealTimers());

  it('returns 0 for an empty batch without touching the database', async () => {
    const r = repo(prisma);
    await expect(r.batchInsertPlays([])).resolves.toBe(0);
    expect(prisma.createMany).not.toHaveBeenCalled();
  });

  it('sends a single chunk when the batch fits', async () => {
    const r = repo(prisma);
    const plays = Array.from({ length: 10 }, (_, i) => makeInsert(i));

    await expect(r.batchInsertPlays(plays)).resolves.toBe(10);
    expect(prisma.createMany).toHaveBeenCalledTimes(1);
  });

  it('splits at the chunk boundary without losing or duplicating a row', async () => {
    const r = repo(prisma);
    const total = INSERT_CHUNK_SIZE * 2 + 7; // deliberately not a multiple
    const plays = Array.from({ length: total }, (_, i) => makeInsert(i));

    const inserted = await r.batchInsertPlays(plays);

    expect(inserted).toBe(total);
    // Every row must appear exactly once across all chunks. This is the
    // assertion that catches an off-by-one in the slice arithmetic.
    const seen: unknown[] = [];
    for (const call of prisma.createMany.mock.calls) {
      const rows = (call[0] as { data: Array<{ artistId?: number }> } | undefined)?.data ?? [];
      seen.push(...rows.map((r2) => r2.artistId ?? -1));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen.sort((a, b) => (a as number) - (b as number))).toEqual(
      plays.map((p) => p.artistId).sort((a, b) => (a as number) - (b as number)),
    );
  });

  it('sums the counts across chunks', async () => {
    const r = repo(prisma);
    const total = INSERT_CHUNK_SIZE + 5;
    await expect(r.batchInsertPlays(Array.from({ length: total }, (_, i) => makeInsert(i)))).resolves.toBe(total);
  });

  it('defaults a missing artistId to null rather than dropping the field', async () => {
    // A null artistId is meaningful: a scrobble with an unresolvable artist
    // still counts. Omitting the key would let Prisma apply its own default.
    const r = repo(prisma);
    await r.batchInsertPlays([{ ...makeInsert(1), artistId: undefined, albumId: undefined, trackId: undefined }]);

    const row = firstPayload(prisma.createMany).data[0] ?? {};
    expect(row).toHaveProperty('artistId', null);
    expect(row).toHaveProperty('albumId', null);
    expect(row).toHaveProperty('trackId', null);
  });

  it('defaults a missing playSource to LastFm', async () => {
    const r = repo(prisma);
    await r.batchInsertPlays([{ ...makeInsert(1), playSource: undefined }]);

    const row = firstPayload(prisma.createMany).data[0] ?? {};
    expect(row.playSource).toBe('LastFm');
  });

  it('asks the database to skip duplicates', async () => {
    // Pinned as current behaviour, not as a guarantee: see the note at the top
    // of this file about there being no unique key for it to act on.
    const r = repo(prisma);
    await r.batchInsertPlays([makeInsert(1)]);

      expect(firstPayload(prisma.createMany).skipDuplicates).toBe(true);
  });
});

describe('PlayRepository retry classification', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  // The p2024 clause in isTransientDbError is redundant TODAY - Prisma's real
  // wording is 'Timed out fetching a new connection...', which the lowercased
  // text match already catches - so removing that clause changes no behaviour and
  // no mutation can separate the two. It is kept deliberately as future
  // proofing against a wording change upstream, and the test below uses the
  // real string so the text match is the thing being exercised.
  const TRANSIENT = [
    'Error: Server has closed the connection unexpectedly',
    'Error: Timed out fetching a new connection from the connection pool',
    'Invalid `prisma.userPlay.createMany()` invocation: P1017',
    'P1001: Can\'t reach database server',
  ];
  const PERMANENT = [
    'Invalid `prisma.userPlay.createMany()` invocation: constraint failed',
    'Foreign key constraint failed on the constraint: `play_artist_fkey`',
  ];

  it.each(TRANSIENT)('retries a transient failure: %s', async (message) => {
    vi.useFakeTimers();
    const prisma = makePrisma();
    const createMany = prisma.createMany
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ count: 1 });
    prisma.userPlay.createMany = createMany;
    const r = repo(prisma);

    // The guard handler is what keeps this from being an unhandled rejection.
    // Advancing fake timers lets the retry loop run, and if it exhausts and
    // rejects while only the assertion is waiting, Node reports an unhandled
    // rejection and vitest exits 1 with every assertion green. Attaching a
    // no-op catch first is the standard fix; the assertion below still proves
    // the promise rejected.
    const pending = r.batchInsertPlays([makeInsert(1)]);
    pending.catch(() => undefined);

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(1);
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it.each(PERMANENT)('fails fast on a permanent failure: %s', async (message) => {
    // A constraint violation is not transient. Retrying it would hammer a
    // connection that is fine and bury the real cause.
    vi.useFakeTimers();
    const prisma = makePrisma();
    prisma.userPlay.createMany = prisma.createMany.mockRejectedValue(new Error(message));
    const r = repo(prisma);

    const pending = r.batchInsertPlays([makeInsert(1)]);
    pending.catch(() => undefined);

    await expect(pending).rejects.toThrow(message);
    // Exactly one attempt: no retry.
    expect(prisma.createMany).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error once the retries are exhausted', async () => {
    vi.useFakeTimers();
    const prisma = makePrisma();
    prisma.userPlay.createMany = prisma.createMany.mockRejectedValue(
      new Error('Server has closed the connection unexpectedly'),
    );
    const r = repo(prisma);

    const pending = r.batchInsertPlays([makeInsert(1)]);
    pending.catch(() => undefined);

    // Advance generously: the delays are a few seconds each and the loop runs
    // once per delay, so an under-advanced timer leaves it mid-wait and the
    // assertion below times out rather than observing the throw.
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).rejects.toThrow('Server has closed the connection unexpectedly');
  });

  it('does NOT call $disconnect on the shared client while retrying', async () => {
    // The comment in the source records why: reconnect() called $disconnect on
    // the SHARED client, tearing down the pool for every in-flight query in the
    // process, so one stats write turned unrelated commands into pool timeouts.
    vi.useFakeTimers();
    const prisma = { ...makePrisma(), $disconnect: vi.fn(async () => undefined), $connect: vi.fn(async () => undefined) };
    prisma.userPlay.createMany = prisma.createMany
      .mockRejectedValueOnce(new Error('Server has closed the connection unexpectedly'))
      .mockResolvedValueOnce({ count: 1 });
    const r = repo(prisma);

    const pending = r.batchInsertPlays([makeInsert(1)]);
    pending.catch(() => undefined);

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(1);

    expect(prisma.$disconnect).not.toHaveBeenCalled();
  });
});

describe('PlayRepository.getPlayCountSince', () => {
  it('omits the time filter when no date is given', async () => {
    // An all-time count must not become "since epoch", which happens to be
    // equivalent today and breaks the moment the column semantics change.
    const prisma = { userPlay: { count: vi.fn(async () => 42), createMany: vi.fn() } };
    const r = repo(prisma);

    await expect(r.getPlayCountSince(7)).resolves.toBe(42);
    expect(prisma.userPlay.count).toHaveBeenCalledWith({ where: { userId: 7 } });
  });

  it('includes a gte filter when a date is given', async () => {
    const prisma = { userPlay: { count: vi.fn(async () => 3), createMany: vi.fn() } };
    const r = repo(prisma);
    const since = new Date('2026-01-01T00:00:00Z');

    await r.getPlayCountSince(7, since);
    expect(prisma.userPlay.count).toHaveBeenCalledWith({
      where: { userId: 7, timePlayed: { gte: since } },
    });
  });
});
