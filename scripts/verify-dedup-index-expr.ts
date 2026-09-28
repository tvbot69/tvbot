/**
 * Dry-run the dedup index expression against the real column types, without
 * building it on `user_plays`.
 *
 * This exists because the first version of that migration failed on production
 * with SqlState 42P17, and the whole database was then blocked by P3009. A
 * syntax-valid migration is not a working migration, so the expression gets
 * tested on a temp table carrying the same column types first.
 *
 * Creates and drops a TEMP table only. Touches nothing in public, nothing
 * persistent, and nothing in user_plays.
 *
 * Usage: npx tsx scripts/verify-dedup-index-expr.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Mirrors the real column types: user_id int, time_played timestamptz, two text, one enum. */
const SETUP = [
  `CREATE TEMP TABLE dedup_expr_probe (
     "user_id"       integer,
     "time_played"   timestamp with time zone,
     "artist_name"   text,
     "track_name"    text,
     "play_source"   "PlaySource"
   )`,
];

const EXPRESSIONS: { label: string; sql: string }[] = [
  {
    label: 'the OLD expression (enum cast) - expected to fail 42P17',
    sql: `(coalesce("play_source"::text, ''))`,
  },
  {
    label: 'the NEW expression (enum indexed directly)',
    sql: `("play_source")`,
  },
  {
    label: 'full NEW composite, as the migration will create it',
    sql: `("user_id", "time_played", lower("artist_name"), coalesce(lower("track_name"), ''), "play_source")`,
  },
];

const main = async (): Promise<void> => {
  await prisma.$queryRawUnsafe('DROP TABLE IF EXISTS dedup_expr_probe');
  for (const stmt of SETUP) await prisma.$queryRawUnsafe(stmt);

  console.log('\nindex-expression dry run (temp table, real column types):');
  let failures = 0;
  let i = 0;
  for (const { label, sql } of EXPRESSIONS) {
    i += 1;
    // A distinct name per test: reusing one made the second success leak into
    // the third as "relation already exists", which read like a bad expression.
    const indexName = `dedup_probe_idx_${i}`;
    try {
      await prisma.$queryRawUnsafe(
        `CREATE UNIQUE INDEX ${indexName} ON dedup_expr_probe ${sql} NULLS NOT DISTINCT`,
      );
      console.log(`  OK        ${label}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /\b(42P17|42P01|42601|42883|42P07)\b/.exec(msg)?.[1] ?? msg.slice(0, 50);
      console.log(`  ${code}  ${label}`);
      // 42P07 would mean a leaked index name, not a bad expression.
      if (code !== '42P07') failures += 1;
    }
  }
  await prisma.$queryRawUnsafe('DROP TABLE IF EXISTS dedup_expr_probe');

  // Exactly one failure is expected and correct: the OLD expression is the bug.
  if (failures !== 1) {
    console.error(`\nUNEXPECTED: expected the old expression to be the only failure (got ${failures}).`);
    process.exit(1);
  }
  console.log('\nOK: only the old enum-cast expression is rejected. The new one builds.');
};

main()
  .catch((e: unknown) => {
    console.error('dry run failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
