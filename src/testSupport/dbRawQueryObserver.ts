import type { PrismaClient } from '@prisma/client';

/**
 * Recording the raw statements a class under test issues, WITHOUT taking its
 * database away from it.
 *
 * WHY THIS EXISTS. Three `*.db.test.ts` files want to assert that a repository
 * opened its case-insensitive "twins" pass - once on the twin path, zero times
 * when the exact pass already answered. The obvious way to count is
 * `vi.spyOn(prisma, '$queryRaw')`, and that is what the first version did. It is
 * a trap with a very specific shape: the spy is installed on THE OBJECT UNDER
 * TEST, so the real method is gone for the rest of the test, and every genuine
 * query the test then makes - including the ones the test itself makes while
 * seeding and asserting - dies with `this.prisma.$queryRaw is not a function`.
 * On 2026-09-29 that was 35 failures across artistRepository, albumRepository
 * and trackRepository, all one cause. A mock applied to the thing being tested
 * cannot tell you whether the thing works; it can only tell you the mock is
 * shaped like the thing.
 *
 * WHAT THIS DOES INSTEAD. `recordRawQueries` returns a NEW client - a Proxy over
 * the real one - for the class under test to hold. The live client is never
 * touched, so the test can keep seeding and asserting on it, and the repository
 * keeps running the real SQL either way. Every call is forwarded to Prisma's
 * own method on the real client; the recorder only watches the call on its way
 * past. A failure therefore means the real query failed, which is information,
 * rather than "the mock is missing a method", which is not.
 *
 * WHY THE COUNT IS WORTH ANYTHING. It is a JavaScript-level count, so it is
 * only meaningful if a Prisma MODEL method does not secretly funnel through
 * `$queryRaw` and inflate it. Measured, not assumed - see
 * dbRawQueryObserver.test.ts, which counts `_request` and `$queryRaw`
 * separately against a real client: `artist.findMany` / `artist.count` /
 * `artist.create` each call `_request` exactly once and `$queryRaw` zero times,
 * while `$queryRaw` itself calls both exactly once. Model delegates and
 * `$queryRaw` are SIBLING callers of the same private `_request`, so this count
 * sees raw calls and only raw calls. The same measurement is why the record
 * carries the statement text and the rows: a count alone would be satisfied by
 * any raw call at all, and the text plus the rows are what make the assertion
 * about the twin pass specifically.
 *
 * The rows are the load-bearing part. They are whatever Postgres actually
 * returned, captured on the way past the recorder, so a test can assert that
 * the repository consumed the real row - not merely that something was called.
 */

/** The raw methods a recorder watches. `$executeRaw*` return a count, not rows. */
const RAW_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$queryRawTyped',
  '$executeRaw',
  '$executeRawUnsafe',
]);

/** What one raw call did, as the database saw it. */
export interface RawQueryRecord {
  /**
   * The statement, one `?` per bound parameter. This is the text Prisma itself
   * builds for a tagged template, so a test can compare it against the query it
   * believes is in the repository - and a rewrite of that query (say `ILIKE` in
   * place of `= ANY`) fails the test instead of passing it.
   */
  sql: string;
  /** The interpolated values, in order. Prisma rewrites `?` to `$n` for Postgres. */
  values: unknown[];
  /**
   * Stable identity of `sql` for per-query ratcheting. Two spellings of the
   * same statement (different indentation) share a hash; a rewritten predicate
   * does not. Recorded at call time so a failed statement still carries one -
   * "the call failed" is exactly when the identity matters most.
   */
  hash: string;
  /**
   * What the call resolved to: rows for the `$queryRaw*` family, an
   * affected-row count for `$executeRaw*`. Undefined when the call threw, which
   * is why the record is pushed BEFORE the call settles - a failed test must
   * not be able to land a record in the next test's window.
   */
  result?: unknown;
}

export interface RawQueryRecorder {
  /**
   * The client to hand to the class under test. Nothing on the real client is
   * replaced, so model delegates, `$connect` and the rest behave exactly as they
   * would have.
   */
  client: PrismaClient;
  /**
   * Every raw call made through `client` so far, oldest first. Live, so a caller
   * can inspect it after a call that threw - `run` cannot return its snapshot in
   * that case, and "the call failed" is exactly when the record matters most.
   */
  records: readonly RawQueryRecord[];
  /**
   * Runs `body` and reports its result plus every raw statement issued while it
   * ran. The window is cleared before and after, so a throwing test cannot leak
   * a record into the next one.
   */
  run: <T>(body: () => Promise<T>) => Promise<{ result: T; raw: RawQueryRecord[] }>;
}

/**
 * Collapse whitespace so a statement can be compared to a readable literal.
 *
 * The text Prisma builds out of a tagged template carries whatever indentation
 * the source had, so two spellings of the same statement would otherwise be two
 * different strings. Squashing is the only normalisation applied - nothing is
 * removed, so a changed predicate still shows up as a changed string.
 */
export const normaliseSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * Stable per-query identity: FNV-1a over the normalised statement.
 *
 * The ratchet in scripts/count-debt.ts duplicates this function rather than
 * importing it, because importing `src/` from `scripts/` would drag a file
 * outside `rootDir` into `tsc` and break `npm run build`. The two copies must
 * stay identical: same normalisation, same hash, or a production shape and the
 * test that proves it will disagree about what they are looking at.
 */
export const hashNormalizedSql = (sql: string): string => {
  const s = normaliseSql(sql);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * Distinct query shapes executed, oldest hash first is NOT guaranteed - sorted,
 * so a test comparing against an expected set is order-independent.
 */
export const queryHashes = (records: readonly RawQueryRecord[]): string[] => [
  ...new Set(records.map((r) => r.hash)),
].sort();

/** How many times each query shape ran. */
export const countByQueryHash = (records: readonly RawQueryRecord[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of records) out[r.hash] = (out[r.hash] ?? 0) + 1;
  return out;
};

/**
 * Assert the executed shapes are exactly the expected ones.
 *
 * Both directions matter: a new untested shape throws, and so does a missing
 * one - while an empty run against an empty expectation passes, so a genuine
 * "no query was opened" is still distinguishable from "it returned nothing".
 */
export const assertExpectedQueries = (
  raw: readonly RawQueryRecord[],
  expectedSql: readonly string[],
): void => {
  const actual = queryHashes(raw);
  const expected = [...new Set(expectedSql.map(hashNormalizedSql))].sort();
  if (actual.length !== expected.length || !actual.every((h, i) => h === expected[i])) {
    throw new Error(
      `expected queries ${JSON.stringify(expected)} but executed ${JSON.stringify(actual)}`,
    );
  }
};

/**
 * Rebuild `(sql, values)` from a raw call's arguments.
 *
 * Three call shapes exist and all three reach this code: the tagged template
 * (`$queryRaw` followed by a backtick), the `sql` tagged template
 * (`$queryRaw(Prisma.sql`...), and the string form
 * (`$queryRawUnsafe('SELECT ...', a, b)`). Only the first two are used by the
 * repositories under test; the third is handled so a rewrite to the unsafe
 * spelling is recorded rather than silently skipped.
 */
const readCall = (args: unknown[]): { sql: string; values: unknown[] } => {
  const [first, ...rest] = args;
  if (Array.isArray(first) && Array.isArray((first as { raw?: unknown }).raw)) {
    return { sql: (first as string[]).join('?'), values: rest };
  }
  if (first !== null && typeof first === 'object' && 'strings' in first && 'values' in first) {
    const template = first as { strings: string[]; values: unknown[] };
    return { sql: template.strings.join('?'), values: template.values };
  }
  return { sql: typeof first === 'string' ? first : '<unrecognised raw call>', values: rest };
};

/**
 * A recorder over a real client. Nothing on `real` is replaced.
 *
 * The repository under test is constructed with `recorder.client`; the test
 * keeps using `real` for everything it does itself.
 */
export const recordRawQueries = (real: PrismaClient): RawQueryRecorder => {
  const records: RawQueryRecord[] = [];

  const client = new Proxy(real, {
    // `target` as the receiver, not the proxy: Prisma's own accessors resolve
    // model delegates against the real client, and a model delegate holds a
    // direct reference to it. That is deliberate - a model call must reach the
    // real client completely untouched, and must not be recorded as a raw call.
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== 'string' || !RAW_METHODS.has(prop) || typeof value !== 'function') {
        return value;
      }
      const original = value as (...callArgs: unknown[]) => unknown;
      return (...callArgs: unknown[]): Promise<unknown> => {
        const seen = readCall(callArgs);
        const record: RawQueryRecord = { ...seen, hash: hashNormalizedSql(seen.sql) };
        records.push(record);
        // A single-argument `then` passes a rejection straight through, so a
        // failing statement propagates the real Prisma error untouched while the
        // record stays in place with `result` unset.
        return Promise.resolve(original.apply(target, callArgs)).then((result) => {
          record.result = result;
          return result;
        });
      };
    },
  });

  return {
    client,
    records,
    run: async <T>(body: () => Promise<T>): Promise<{ result: T; raw: RawQueryRecord[] }> => {
      records.length = 0;
      try {
        return { result: await body(), raw: [...records] };
      } finally {
        records.length = 0;
      }
    },
  };
};
