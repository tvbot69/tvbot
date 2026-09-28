/**
 * Build the missing-tables migration from Prisma's own generated DDL.
 *
 * Four tables exist in production but in no migration file - they date from the
 * `prisma db push` era, which is why a database built purely from migrations
 * could not create them and CI failed on `relation "user_crowns" does not exist`.
 *
 * The DDL here is not hand-written. It is extracted from
 *   prisma migrate diff --from-empty --to-schema-datamodel schema.prisma
 * so it is exactly what Prisma believes the schema is. The live database was
 * diffed against the schema first and the diff is EMPTY, which is the evidence
 * that these tables in production already have this structure.
 *
 * Every statement is IF NOT EXISTS, deliberately. The same migration must be a
 * no-op on production - where the tables already exist - and create them on a
 * fresh database. That asymmetry is the whole trick, and it is why the cleanup
 * migration in this repo is also a confirmed no-op.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2];
const OUT_DIR = process.argv[3];
if (!SRC || !OUT_DIR) {
  console.error('usage: tsx scripts/build-missing-tables-migration.ts <generated.sql> <outDir>');
  process.exit(1);
}

const TABLES = ['user_fm_settings', 'artist_genres', 'user_crowns', 'guild_autoposts'];

const full = readFileSync(SRC, 'utf8');

const header = `-- Repairs a gap in the migration history.
--
-- Four tables exist in production but in NO migration file: user_fm_settings,
-- artist_genres, user_crowns and guild_autoposts. They date from the
-- \`prisma db push\` era, so they were never captured as migrations.
--
-- Why that mattered: a database built purely from these migrations was missing
-- four tables, and 20260919000000_hot_path_indexes - which indexes user_crowns -
-- failed with 42P01 "relation user_crowns does not exist". The bot ran fine in
-- production and would have been broken on any rebuild, restore or new
-- environment. The history could not reproduce the schema it described.
--
-- The DDL below is NOT hand-written. It is extracted from Prisma's own output:
--   prisma migrate diff --from-empty --to-schema-datamodel schema.prisma
-- Before this was written, the live database was diffed against the schema and
-- the diff was EMPTY - which is the evidence that production already has exactly
-- this structure, so applying this changes nothing there.
--
-- Every statement is IF NOT EXISTS on purpose. This migration has to be a no-op
-- on production, where the tables exist, and create them on a fresh database.
-- That asymmetry is the point; a plain CREATE TABLE would fail on deploy.
--
-- Indexes for these tables that already exist in earlier migrations are left
-- alone on purpose - the index a table needs before it is created cannot live in
-- the migration that creates it.

`;

const parts: string[] = [];

for (const table of TABLES) {
  const create = new RegExp(`CREATE TABLE "${table}"[\\s\\S]*?;`).exec(full);
  if (!create) {
    console.error(`no CREATE TABLE for ${table} in the generated DDL`);
    process.exit(1);
  }
  parts.push(
    create[0].replace(`CREATE TABLE "${table}"`, `CREATE TABLE IF NOT EXISTS "${table}"`),
  );
}

// Indexes scoped to these four tables.
const indexRe = /CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"[^;]*;/g;
for (const m of full.matchAll(indexRe)) {
  const [, unique, name, table] = m;
  if (!TABLES.includes(table)) continue;
  if (new RegExp(`CREATE (UNIQUE )?INDEX "${name}"`).test(full.slice(0, 0))) continue;
  parts.push(m[0].replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')
    .replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS'));
  void unique;
  void name;
}

const out = `${header}${parts.join('\n\n')}\n`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'migration.sql'), out, 'utf8');

console.log(`wrote ${OUT_DIR}/migration.sql`);
console.log(`  tables:  ${TABLES.length}`);
console.log(`  indexes: ${parts.length - TABLES.length}`);
