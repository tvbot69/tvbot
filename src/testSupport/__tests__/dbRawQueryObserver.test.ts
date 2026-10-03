import { describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertExpectedQueries,
  countByQueryHash,
  hashNormalizedSql,
  normaliseSql,
  queryHashes,
  recordRawQueries,
} from '../dbRawQueryObserver';
import type { PrismaClient as PrismaClientType } from '@prisma/client';

/**
 * The raw-query recorder, tested with no database at all.
 *
 * This file exists because of a specific failure. Three `*.db.test.ts` files
 * used `vi.spyOn(prisma, '$queryRaw')` to count the repository's twin pass, and
 * the spy was installed on THE OBJECT UNDER TEST: the real method was gone for
 * the rest of each test, so every genuine query after it - the repository's own,
 * and the test's own seeding and assertions - died with
 * `this.prisma.$queryRaw is not a function`. 35 failures across three files,
 * one cause.
 *
 * That class of failure needs a database to notice, which means it reached CI
 * before anyone saw it. The recorder replaces the mechanism, so its contract is
 * testable HERE, with a client pointed at a port nothing listens on: if the
 * recorder ever stopped delegating, the failure would be a Prisma error about a
 * connection rather than a TypeError about a missing function, and that
 * difference is exactly the regression this asserts.
 */

/**
 * A real client aimed at a dead port.
 *
 * Nothing connects, and that is the point: the recorder must be able to hand a
 * client to a class under test and have every real call reach Prisma, so the
 * evidence that it delegated is a Prisma ENGINE error. A stub could not make
 * that argument - a stub returning a fixed value is compatible with a recorder
 * that quietly swallowed the call.
 */
const unreachable = (): PrismaClientType =>
  new PrismaClient({ datasources: { db: { url: 'postgresql://u:p@127.0.0.1:1/nope' } } });

/** A stand-in for Prisma, for the parts of the contract that need a known answer. */
const stubClient = (rows: unknown[]): PrismaClientType => {
  const stub = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      stub.lastSql = strings.join('?');
      stub.lastValues = values;
      return Promise.resolve(rows);
    },
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => {
      stub.lastSql = sql;
      stub.lastValues = values;
      return Promise.resolve(rows);
    },
  } as unknown as PrismaClientType & { lastSql?: string; lastValues?: unknown[] };
  return stub;
};

describe('normaliseSql', () => {
  it('collapses the indentation a tagged template carries into the source', () => {
    const fromSource = `
          SELECT artist_id AS "artistId", name FROM artists
          WHERE UPPER(name) = ANY(?)`;
    expect(normaliseSql(fromSource)).toBe(
      'SELECT artist_id AS "artistId", name FROM artists WHERE UPPER(name) = ANY(?)',
    );
  });

  it('changes nothing a reader could act on, so a rewritten predicate still shows', () => {
    // The reason the twins tests can assert on the statement text at all: the
    // only normalisation is whitespace, so `= ANY` -> `ILIKE` is still a
    // different string and still fails.
    expect(normaliseSql('SELECT 1 WHERE name ILIKE ?')).not.toBe(normaliseSql('SELECT 1 WHERE name = ?'));
  });
});

describe('recordRawQueries', () => {
  describe('it delegates rather than replacing - the 35-failure regression', () => {
    it('leaves $queryRaw callable on the recorded client, so nothing can be "not a function"', async () => {
      const real = unreachable();
      const { client } = recordRawQueries(real);
      expect(typeof client.$queryRaw).toBe('function');
      expect(typeof client.$queryRawUnsafe).toBe('function');
      await real.$disconnect().catch(() => undefined);
    });

    it('reaches Prisma on a raw call: the failure is the engine, not a missing method', async () => {
      const real = unreachable();
      const { client } = recordRawQueries(real);

      // This is the assertion that would have caught the original bug. With a
      // spy on the client under test, the call below throws
      // `TypeError: this.prisma.$queryRaw is not a function` - a failure of the
      // TEST. Here it throws a PrismaClientInitializationError from the ENGINE -
      // a failure of the DATABASE, which is the only thing this assertion can
      // accept.
      const thrown = await client.$queryRaw`SELECT 1`.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect((thrown as Error).constructor.name).toBe('PrismaClientInitializationError');
      await real.$disconnect().catch(() => undefined);
    });

    it('reaches Prisma on a model call too, which is the half a spy broke', async () => {
      const real = unreachable();
      const { client, records } = recordRawQueries(real);

      const thrown = await client.artist.findMany({ select: { artistId: true } }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(TypeError);
      // And a model call is not a raw call, so it is not recorded. This is the
      // measurement that makes the counts in the twins files meaningful: if
      // `artist.findMany` funnelled through `$queryRaw`, every one of those
      // counts would be inflated by the repository's own model calls.
      expect(records).toEqual([]);
      await real.$disconnect().catch(() => undefined);
    });

    it('does not modify the real client, so the test can keep seeding and asserting on it', async () => {
      const real = unreachable();
      const before = real.$queryRaw;
      const { client } = recordRawQueries(real);
      expect(real.$queryRaw).toBe(before);
      expect(client.$queryRaw).not.toBe(before);
      expect(client.artist).toBe(real.artist);
      await real.$disconnect().catch(() => undefined);
    });
  });

  describe('what it records', () => {
    it('records the statement Prisma itself would build for the same tag', async () => {
      // Not a re-implementation of the join rule - a comparison against
      // Prisma's own. If Prisma ever changes how it assembles a tagged
      // template, this fails rather than the twins files quietly comparing the
      // wrong string.
      const real = stubClient([{ artistId: 7, name: 'Mac DeMarco' }]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(() =>
        recorder.client.$queryRaw<Array<{ artistId: number; name: string }>>`
          SELECT artist_id AS "artistId", name FROM artists
          WHERE UPPER(name) = ANY(${{ mac: 'mac demarco' }.mac ? ['MAC DEMARCO'] : []})`,
      );

      expect(raw).toHaveLength(1);
      expect(normaliseSql(raw[0]!.sql)).toBe(normaliseSql(Prisma.sql`SELECT artist_id AS "artistId", name FROM artists
          WHERE UPPER(name) = ANY(${['MAC DEMARCO']})`.sql));
      expect(raw[0]!.values).toEqual([['MAC DEMARCO']]);
    });

    it('records the rows the database returned, which is what proves the SQL ran', async () => {
      const rows = [{ artistId: 7, name: 'Mac DeMarco' }];
      const real = stubClient(rows);
      const recorder = recordRawQueries(real);

      const { result, raw } = await recorder.run(async () => recorder.client.$queryRaw`SELECT 1`);

      // The call-through result and the recorded result are the same array, so a
      // recorder that dropped or rewrote them could not satisfy both.
      expect(result).toBe(rows);
      expect(raw[0]!.result).toBe(rows);
    });

    it('counts every raw call, so two chunks means two statements', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(async () => {
        await recorder.client.$queryRaw`SELECT 1`;
        await recorder.client.$queryRaw`SELECT 2`;
      });

      expect(raw.map((r) => normaliseSql(r.sql))).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('records the string form, so a rewrite to $queryRawUnsafe is not invisible', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(() => recorder.client.$queryRawUnsafe('SELECT 1', 1));

      expect(raw).toHaveLength(1);
      expect(raw[0]!.sql).toBe('SELECT 1');
      expect(raw[0]!.values).toEqual([1]);
    });

    it('records a failed raw call, so "no query was opened" is distinguishable from "it returned nothing"', async () => {
      const real = {
        $queryRaw: () => Promise.reject(new Error('42703 column does not exist')),
      } as unknown as PrismaClientType;
      const recorder = recordRawQueries(real);

      const thrown = await recorder
        .run(() => recorder.client.$queryRaw`SELECT bad`)
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect((thrown as Error).message).toMatch(/42703/);
    });
  });

  describe('the observation window', () => {
    it('starts empty for each run, so tests cannot see each other', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const first = await recorder.run(() => recorder.client.$queryRaw`SELECT 1`);
      const second = await recorder.run(async () => 42);

      expect(first.raw).toHaveLength(1);
      expect(second.raw).toEqual([]);
      expect(second.result).toBe(42);
    });

    it('clears itself after a throwing run, so a failure cannot leak into the next test', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      await expect(
        recorder.run(async () => {
          await recorder.client.$queryRaw`SELECT 1`;
          throw new Error('assertion blew up after the query');
        }),
      ).rejects.toThrow(/blew up/);

      // The record was pushed BEFORE the call settled, so the late-push race is
      // the one thing that could put a stale record in the next window.
      const { raw } = await recorder.run(async () => 1);
      expect(raw).toEqual([]);
    });
  });

  describe('per-query identity: one hash per shape', () => {
    it('is stable across whitespace, so indentation is not a new query', () => {
      expect(hashNormalizedSql('SELECT  1')).toBe(hashNormalizedSql('SELECT 1'));
      expect(hashNormalizedSql('SELECT\n  artist_id\nFROM artists')).toBe(
        hashNormalizedSql('SELECT artist_id FROM artists'),
      );
    });

    it('changes when the predicate changes, so a rewrite is a new shape', () => {
      expect(hashNormalizedSql('SELECT 1 WHERE name = ?')).not.toBe(
        hashNormalizedSql('SELECT 1 WHERE name ILIKE ?'),
      );
      expect(hashNormalizedSql('SELECT artist_id FROM artists WHERE UPPER(name) = ANY(?)')).not.toBe(
        hashNormalizedSql('SELECT artist_id FROM artists WHERE UPPER(name) = ?'),
      );
    });

    it('is recorded on every call, including the string form', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(async () => {
        await recorder.client.$queryRaw`SELECT 1`;
        await recorder.client.$queryRaw`SELECT  1`;
        await recorder.client.$queryRawUnsafe('SELECT 2', 1);
      });

      expect(raw).toHaveLength(3);
      expect(raw[0]!.hash).toBe(hashNormalizedSql('SELECT 1'));
      // Same shape twice: same hash, counted twice.
      expect(raw[1]!.hash).toBe(raw[0]!.hash);
      expect(raw[2]!.hash).toBe(hashNormalizedSql('SELECT 2'));
      expect(queryHashes(raw)).toEqual([raw[0]!.hash, raw[2]!.hash].sort());
      expect(countByQueryHash(raw)).toEqual({ [raw[0]!.hash]: 2, [raw[2]!.hash]: 1 });
    });

    it('is present even when the call failed, so the shape is known', async () => {
      const real = {
        $queryRaw: () => Promise.reject(new Error('42703 column does not exist')),
      } as unknown as PrismaClientType;
      const recorder = recordRawQueries(real);

      await recorder.client.$queryRaw`SELECT bad`.then(
        () => undefined,
        () => undefined,
      );

      expect(recorder.records).toHaveLength(1);
      expect(recorder.records[0]!.hash).toBe(hashNormalizedSql('SELECT bad'));
      expect(recorder.records[0]!.result).toBeUndefined();
    });
  });

  describe('assertExpectedQueries: both directions', () => {
    it('passes for the exact set, regardless of whitespace or order', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(async () => {
        await recorder.client.$queryRaw`SELECT 2`;
        await recorder.client.$queryRaw`SELECT
          1`;
      });

      expect(() => assertExpectedQueries(raw, ['SELECT 1', 'SELECT 2'])).not.toThrow();
    });

    it('throws for a new untested shape, which is the mutation that matters', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(async () => {
        await recorder.client.$queryRaw`SELECT 1`;
        await recorder.client.$queryRaw`SELECT 2`;
      });

      expect(() => assertExpectedQueries(raw, ['SELECT 1'])).toThrow(/expected queries/);
    });

    it('throws for a missing shape, so a deleted query cannot hide', async () => {
      const real = stubClient([]);
      const recorder = recordRawQueries(real);

      const { raw } = await recorder.run(() => recorder.client.$queryRaw`SELECT 1`);

      expect(() => assertExpectedQueries(raw, ['SELECT 1', 'SELECT 2'])).toThrow(
        /expected queries/,
      );
    });

    it('a genuine empty run still passes against an empty expectation', () => {
      expect(() => assertExpectedQueries([], [])).not.toThrow();
      expect(() => assertExpectedQueries([], ['SELECT 1'])).toThrow(/expected queries/);
    });
  });
});
