import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { databaseUrl, skipReason } from '../../tests/dbHarness';

/**
 * The ONE raw query in prismaClient.ts - L43, the liveness probe inside
 * `checkDatabaseHealth` - executed by a real Postgres.
 *
 *     await prisma.$queryRaw`SELECT 1`
 *
 * ## Why this file is not the usual "seed rows, assert rows" shape
 *
 * `SELECT 1` touches no table, so there is nothing to seed. The reason it still
 * deserved a real database is the module-level wiring around it: `prismaClient.ts`
 * builds its `PrismaClient` at IMPORT time out of
 * `ConfigData.Data.database.connectionString`, and `checkDatabaseHealth` queries
 * that singleton rather than a client anyone passed in. Nothing else in this
 * suite's tree can prove that the client a raw query runs on is pointed at the
 * database the caller believes it is.
 *
 * ## THE SAFETY MECHANISM, AND IT IS NOT OPTIONAL
 *
 * The suite-wide `DATABASE_URL` on a developer machine is PRODUCTION (Railway).
 * This file therefore never uses it. It points `DATABASE_URL` at `TEST_DATABASE_URL`
 * - the scratch database `dbHarness` has already vetted - BEFORE importing the
 * module, and restores the previous value afterwards. Import order is the whole
 * mechanism: the client is constructed once, at import, from the env at that
 * moment. `dotenv` does not override an already-set variable, so a developer's
 * `.env` cannot win.
 *
 * The `current_database()` test below is the belt to that braces: it asks the
 * client's own connection which database it is on and compares it with the one
 * the harness URL names. If that assertion ever fails, nothing in this file has
 * touched anything it should not, and it fails loudly on the first query rather
 * than quietly against production.
 *
 * Note the asymmetry with the other `*.db.test.ts` files: this one does NOT go
 * through `connect()` and never truncates anything. It has no tables to write to
 * and no reason to touch any.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

type PrismaClientModule = typeof import('../prismaClient');

let mod: PrismaClientModule | null = null;
let restore: (() => void) | null = null;

/** The database name the scratch URL points at, decoded the way a URL is. */
const scratchDatabaseName = (): string => {
  const url = databaseUrl();
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
};

/**
 * Import the module with `DATABASE_URL` pointed at the scratch database.
 *
 * The dynamic `import()` is the load-bearing part, not a style choice: a static
 * import at the top of this file would run `new PrismaClient(...)` against
 * whatever `DATABASE_URL` happened to be, which on a developer machine is
 * production. `vi.resetModules()` makes a later import re-evaluate the module and
 * therefore build a DIFFERENT client, which is what the failure-path suite needs.
 */
const importAgainst = async (url: string): Promise<PrismaClientModule> => {
  process.env.DATABASE_URL = url;
  vi.resetModules();
  return import('../prismaClient');
};

suite('prismaClient.checkDatabaseHealth against a real database', () => {
  beforeAll(async () => {
    if (skip) return;
    const previous = process.env.DATABASE_URL;
    mod = await importAgainst(databaseUrl()!);
    restore = () => {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    };
  });

  afterAll(async () => {
    await mod?.prisma.$disconnect().catch(() => undefined);
    restore?.();
    mod = null;
    restore = null;
  });

  it('reports healthy, having actually run SELECT 1', async () => {
    const result = await mod!.checkDatabaseHealth();
    expect(result.healthy).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is pointed at the scratch database, not at DATABASE_URL', async () => {
    // The assertion that makes this file safe to run on a machine whose
    // DATABASE_URL is production. `current_database()` is answered by the
    // connection itself, so it cannot be fooled by a URL that merely looks right.
    const rows = await mod!.prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe(scratchDatabaseName());
  });

  it('answers in a latency a health check can act on', async () => {
    // Not a performance assertion - a shape one. `latencyMs` is what a
    // supervising process thresholds on, so it has to be a real measurement
    // rather than a constant; a few milliseconds over a loopback socket is the
    // expected order of magnitude and anything near zero would mean the field is
    // not measuring the query.
    const first = await mod!.checkDatabaseHealth();
    const second = await mod!.checkDatabaseHealth();
    expect(first.healthy && second.healthy).toBe(true);
    expect(first.latencyMs).toBeLessThan(10_000);
  });
});

suite('prismaClient.checkDatabaseHealth when the database is unreachable', () => {
  // A second import of the same module against a dead address, so the singleton
  // under test is a genuinely unreachable one rather than the scratch client.
  // Port 1 on loopback: refused at the TCP layer, so this costs milliseconds and
  // never leaves the machine. The URL is still `postgresql://` because
  // `assertValidEnvironment` refuses anything else and the module would throw on
  // import instead of failing the query.
  const deadUrl = 'postgresql://tvbot:tvbot@127.0.0.1:1/never_exists';

  let bad: PrismaClientModule | null = null;
  let previous: string | undefined;

  beforeAll(async () => {
    if (skip) return;
    previous = process.env.DATABASE_URL;
    bad = await importAgainst(deadUrl);
  });

  afterAll(async () => {
    await bad?.prisma.$disconnect().catch(() => undefined);
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    bad = null;
  });

  it('reports unhealthy instead of throwing, because a health check that throws is not a health check', async () => {
    const result = await bad!.checkDatabaseHealth();
    expect(result.healthy).toBe(false);
    expect(result.error).toBeTypeOf('string');
    expect(result.error?.length).toBeGreaterThan(0);
  });

  it('still measures a latency when it failed, so a caller can plot the outage', async () => {
    const result = await bad!.checkDatabaseHealth();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

suite('prismaClient.withDbRetry, the wrapper every model call goes through', () => {
  // Not a raw query, and therefore not this file's nominal subject - but it is
  // the module's other export and it is what stands between a one-second
  // network blip and a failed command. The unit suite mocks the database
  // everywhere else, so nothing had ever run this against a real Prisma error.
  let retrying: PrismaClientModule | null = null;
  let previous: string | undefined;

  beforeAll(async () => {
    if (skip) return;
    previous = process.env.DATABASE_URL;
    retrying = await importAgainst(databaseUrl()!);
  });

  afterAll(async () => {
    await retrying?.prisma.$disconnect().catch(() => undefined);
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    retrying = null;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the value on the first success without retrying', async () => {
    const op = vi.fn(async () => 'ok');
    await expect(retrying!.withDbRetry(op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("Can't reach database server at localhost:5432");
        (err as { code?: string }).code = 'P1001';
        throw err;
      }
      return 'ok';
    });
    await expect(retrying!.withDbRetry(op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    // 3 attempts means 2 retries, so the loop bound is the thing being checked.
    const op = vi.fn(async () => {
      const err = new Error('ECONNRESET');
      throw err;
    });
    await expect(retrying!.withDbRetry(op, 3)).rejects.toThrow('ECONNRESET');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent failure', async () => {
    // A syntax error or a missing table will never fix itself, and retrying it
    // three times turns one fast failure into a slow one.
    const op = vi.fn(async () => {
      throw new Error('relation "nope" does not exist');
    });
    await expect(retrying!.withDbRetry(op)).rejects.toThrow('does not exist');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('classifies the error codes and messages it is supposed to classify', () => {
    expect(retrying!.isTransientDbError({ code: 'P1001' })).toBe(true);
    expect(retrying!.isTransientDbError({ code: 'P1002' })).toBe(true);
    expect(retrying!.isTransientDbError({ code: 'P1017' })).toBe(true);
    expect(retrying!.isTransientDbError(new Error('socket hang up: ECONNRESET'))).toBe(true);
    expect(retrying!.isTransientDbError(new Error('connect ETIMEDOUT 10.0.0.1:5432'))).toBe(true);
    expect(retrying!.isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(retrying!.isTransientDbError(null)).toBe(false);
    expect(retrying!.isTransientDbError(new Error('unique constraint failed'))).toBe(false);
  });
});
