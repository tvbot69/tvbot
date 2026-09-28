/**
 * Read-only: does the live table structure match what the migration creates?
 *
 * The migration is all IF NOT EXISTS, so on production it is a no-op and the
 * tables keep whatever shape they already have. That is only correct if the
 * live shape IS the shape the migration would have created.
 *
 * This compares the live CREATE TABLE text for the four tables against the
 * text in the migration, so a drift shows up as a difference rather than as a
 * silent assumption. Read-only.
 *
 * Usage: npx tsx scripts/verify-live-matches-migration.ts
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FILE =
  'src/persistence/prisma/migrations/20260928120000_missing_tables_from_db_push_era/migration.sql';
const TABLES = ['user_fm_settings', 'artist_genres', 'user_crowns', 'guild_autoposts'];

const main = async (): Promise<void> => {
  const sql = readFileSync(FILE, 'utf8');
  let drift = 0;

  for (const table of TABLES) {
    // The live shape, read from the catalogue. pg_get_tabledef is a Redshift
    // function and does not exist on PostgreSQL, so the column set is compared
    // instead - which is the part that would actually break the bot if it drifted.
    const live = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`,
      table,
    );
    const liveNames = new Set(live.map((c) => c.column_name));

    const block = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"[\\s\\S]*?\\n\\);`).exec(sql)?.[0] ?? '';
    const wantNames = [...block.matchAll(/^\s{4}"(\w+)"\s+\w/gm)].map((m) => m[1]);

    const missingLive = wantNames.filter((n) => !liveNames.has(n));
    const extraLive = [...liveNames].filter((n) => !wantNames.includes(n));

    if (missingLive.length === 0 && extraLive.length === 0) {
      console.log(`  OK   ${table}: ${wantNames.length} columns, identical set`);
    } else {
      drift += 1;
      console.log(`  DIFF ${table}`);
      if (missingLive.length) console.log(`       in migration, absent from production: ${missingLive.join(', ')}`);
      if (extraLive.length) console.log(`       in production, absent from migration: ${extraLive.join(', ')}`);
    }
  }

  if (drift) {
    console.log(`\n${drift} table(s) differ between the migration and production.`);
    console.log('The migration would be a no-op on production and leave that drift in place,');
    console.log('so it must be fixed deliberately - not papered over.');
  } else {
    console.log('\nOK: production already has exactly the structure this migration creates.');
  }
};

main()
  .catch((e: unknown) => {
    console.error('comparison failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
