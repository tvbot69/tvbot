/**
 * Replay the ENTIRE migration history into a scratch schema, from empty.
 *
 * This exists because a fresh database failed on
 * 20260919000000_hot_path_indexes with 42P01 "relation user_crowns does not
 * exist" - a migration referenced a table that no earlier migration created.
 * Production never saw it, because production has those tables from the
 * `prisma db push` era. So the history could not reproduce the schema it
 * described, and nothing in CI noticed.
 *
 * A CI job that runs `prisma migrate deploy` against postgres:16 now catches
 * that, but only after a push. This runs the same check on demand, against the
 * live server, without touching anything real.
 *
 * SAFETY. A scratch schema is created, search_path points at it ALONE so every
 * unqualified name resolves there and nothing can silently fall through to
 * public, and the schema is dropped in a finally block. No migration in this
 * repo contains CREATE EXTENSION, a `public.`-qualified name, or a DROP, all of
 * which were checked before this script was written - those would escape the
 * scratch schema. None do.
 *
 * Usage: npx tsx scripts/replay-migrations-fresh.ts
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DIR = 'src/persistence/prisma/migrations';
const SCHEMA = 'scratch_migration_replay';

/**
 * Strip comment lines, then split into statements.
 *
 * Dollar-quoted blocks (`DO $$ ... $$`) are kept whole. Splitting on every `;`
 * tore them apart and produced a bogus 42601 on 20260920000000_guild_music_settings
 * - a failure in this script, not in the migration. Prisma's own migrator handles
 * them correctly, which the CI log proves.
 */
const statementsOf = (sql: string): string[] => {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  const out: string[] = [];
  let i = 0;
  while (i < withoutComments.length) {
    // A `;` inside a dollar-quoted block is not a statement boundary. Track
    // whether we are inside one rather than looking for `$$` at the start of a
    // statement - the block here is introduced by `DO $$`, so a startsWith test
    // missed it and split the DO block into three broken pieces.
    const semi = withoutComments.indexOf(';', i);
    const chunk = semi === -1 ? withoutComments.slice(i) : withoutComments.slice(i, semi);
    if (chunk.includes('$$')) {
      // Find the closing tag: whichever of $$/$body$ follows.
      const open = /(\$\$|\$[a-zA-Z_]*\$)/.exec(chunk);
      const tag = open ? open[1] : '$$';
      const after = semi === -1 ? withoutComments.length : semi + 1;
      const close = withoutComments.indexOf(tag, after);
      if (close !== -1) {
        const stop = close + tag.length;
        out.push(withoutComments.slice(i, stop).trim());
        i = stop + 1;
        continue;
      }
    }
    if (semi === -1) {
      const rest = withoutComments.slice(i).trim();
      if (rest) out.push(rest);
      break;
    }
    const stmt = withoutComments.slice(i, semi).trim();
    if (stmt) out.push(stmt);
    i = semi + 1;
  }
  return out.filter((s) => s.length > 0);
};

const main = async (): Promise<void> => {
  const dirs = readdirSync(DIR)
    .filter((d) => existsSync(join(DIR, d, 'migration.sql')))
    .sort();

  await prisma.$queryRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$queryRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

  const failures: { migration: string; message: string }[] = [];
  let applied = 0;

  try {
    // ALONE, not "scratch, public". Falling through to public is what would hide
    // a missing table and make this replay prove nothing.
    await prisma.$queryRawUnsafe(`SET search_path TO "${SCHEMA}"`);

    for (const dir of dirs) {
      const sql = readFileSync(join(DIR, dir, 'migration.sql'), 'utf8');
      try {
        for (const stmt of statementsOf(sql)) {
          await prisma.$queryRawUnsafe(stmt);
        }
        applied += 1;
        process.stdout.write(`  ok   ${dir}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ migration: dir, message: msg });
        process.stdout.write(`  FAIL ${dir}\n`);
        // Stop at the first failure: later migrations assume this one ran, so
        // cascading errors would bury the real one.
        break;
      }
    }

    if (!failures.length) {
      const tables = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1`,
        SCHEMA,
      );
      const types = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = $1 AND t.typtype = 'e'`,
        SCHEMA,
      );
      console.log(`\nALL ${applied} MIGRATIONS REPLAYED FROM EMPTY.`);
      console.log(`  tables created: ${tables[0]?.n}`);
      console.log(`  enum types:     ${types[0]?.n}`);
    } else {
      const f = failures[0];
      const code = /\b(\d{5})\b/.exec(f.message)?.[1] ?? '?';
      console.error(`\nREPLAY FAILED at ${f.migration} (SqlState ${code})`);
      console.error(`  ${f.message.split('\n')[0].slice(0, 200)}`);
    }
  } finally {
    await prisma.$queryRawUnsafe('SET search_path TO public');
    await prisma.$queryRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    console.log(`\nscratch schema dropped. Nothing outside it was touched.`);
  }

  if (failures.length) process.exit(1);
};

main()
  .catch((e: unknown) => {
    console.error('replay failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
