/**
 * Verify the missing-tables migration actually CREATES its objects, without
 * touching anything real.
 *
 * A migration made entirely of IF NOT EXISTS is safe on production precisely
 * because it is a no-op there - which also means running it in production
 * proves nothing about the creating half. This creates a scratch schema, points
 * search_path at it, runs the migration so the foreign keys resolve against
 * public, checks every table and index exists, and drops the schema.
 *
 * Nothing outside the scratch schema is read or written. The DROP is in a finally
 * block so it runs even when the migration fails partway.
 *
 * Usage: npx tsx scripts/verify-missing-tables-migration.ts [migrationFile]
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FILE =
  process.argv[2] ??
  'src/persistence/prisma/migrations/20260928120000_missing_tables_from_db_push_era/migration.sql';

const TABLES = ['user_fm_settings', 'artist_genres', 'user_crowns', 'guild_autoposts'];
const SCHEMA = 'scratch_missing_tables_verify';

const main = async (): Promise<void> => {
  const sql = readFileSync(FILE, 'utf8');
  await prisma.$queryRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$queryRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

  let created = 0;
  try {
    // search_path puts the scratch schema first so the CREATE TABLEs land here,
    // and keeps public in it so the foreign keys resolve to the real tables.
    await prisma.$queryRawUnsafe(`SET search_path TO "${SCHEMA}", public`);

    // Strip comment LINES rather than dropping any chunk that starts with `--`.
    // The header is a comment block immediately followed by the first
    // CREATE TABLE in the same split chunk, so the original filter threw the
    // first table away and reported it as missing - the migration was fine, the
    // verifier was lying.
    const stmts = sql
      .split(/;\s*\r?\n/)
      .map((s) =>
        s
          .split(/\r?\n/)
          .filter((line) => !/^\s*--/.test(line))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.length > 0);

    for (const stmt of stmts) {
      await prisma.$queryRawUnsafe(stmt);
      created += 1;
    }
    console.log(`\nran ${created} statements from the migration against scratch schema "${SCHEMA}"`);

    const found = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = $1 ORDER BY tablename`,
      SCHEMA,
    );
    const names = found.map((f) => f.tablename);
    console.log(`\ntables created (${names.length}):`);
    for (const t of TABLES) {
      console.log(`  ${names.includes(t) ? 'OK     ' : 'MISSING'} ${t}`);
    }

    const idx = await prisma.$queryRawUnsafe<{ indexname: string; tablename: string }[]>(
      `SELECT indexname, tablename FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`,
      SCHEMA,
    );
    console.log(`\nindexes created (${idx.length}):`);
    for (const i of idx) console.log(`  ${i.tablename}: ${i.indexname}`);

    const missing = TABLES.filter((t) => !names.includes(t));
    if (missing.length) {
      console.error(`\nFAILED: the migration did not create: ${missing.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('\nOK: every table is created. Now the real question - is it a no-op on production?');
    }
  } finally {
    await prisma.$queryRawUnsafe('SET search_path TO public');
    await prisma.$queryRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    console.log(`\nscratch schema dropped. Nothing outside it was touched.`);
  }
};

main()
  .catch((e: unknown) => {
    console.error('verification failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
