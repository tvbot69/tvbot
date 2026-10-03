/**
 * Read-only probe: does the user_plays unique index actually exist, and is the
 * duplicate count still zero? Run after any change to the dedup migrations.
 *
 * Read-only by construction. It SELECTs from pg_indexes and counts rows; it
 * never writes, so it is safe to point at production.
 *
 * Usage: npx tsx scripts/check-user-plays-index.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const indexes = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'user_plays' ORDER BY indexname`,
  );

  const target = indexes.find((i) => i.indexname === 'user_plays_identity_uniq');
  console.log(`\nuser_plays indexes: ${indexes.length}`);
  for (const i of indexes) console.log(`  ${i.indexname}`);
  console.log(`\nuser_plays_identity_uniq: ${target ? 'PRESENT' : 'MISSING'}`);
  if (target) console.log(`  ${target.indexdef}\n`);

  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM user_plays');
  console.log(`rows in user_plays: ${rows[0]?.n.toString() ?? 'unknown'}`);

  const dupes = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    // Identity mirrors the index exactly: raw "play_source" with no cast and
    // no coalesce. The index is ("user_id", "time_played",
    // lower("artist_name"), coalesce(lower("track_name"), ''), "play_source")
    // NULLS NOT DISTINCT (see
    // src/persistence/prisma/migrations/20260928010000_user_plays_dedup_index/migration.sql).
    // A SELECT may cast (enum_out is STABLE, which SELECT allows), but an index
    // expression may not: enum -> text goes through enum_out, which is STABLE,
    // so coalesce("play_source"::text, '') in an index fails with 42P17. The
    // previous probe used that cast, which grouped the same rows here but
    // taught the wrong expression to the next migrator. GROUP BY already treats
    // NULLs as equal, which is exactly what NULLS NOT DISTINCT means for the
    // index, so the bare column is both correct and instructive.
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM user_plays
        GROUP BY "user_id", "time_played", lower("artist_name"),
                 coalesce(lower("track_name"), ''), "play_source"
       HAVING count(*) > 1
     ) d`,
  );
  console.log(`duplicate identity groups: ${dupes[0]?.n.toString() ?? 'unknown'}`);

  if (!target || (dupes[0]?.n ?? 1n) > 0n) {
    console.error('\nFAILED: the index is missing, or duplicates exist that it would reject.');
    process.exit(1);
  }
  console.log('\nOK: index present and consistent with the data.');
};

main()
  .catch((e: unknown) => {
    console.error('probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
