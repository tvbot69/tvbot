/**
 * Read-only: why did a migration fail? Prisma records the failure in
 * `_prisma_migrations.logs`. Run this instead of theorising about the cause.
 *
 * Read-only. Usage: npx tsx scripts/migration-failure-logs.ts [nameFilter]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const filter = process.argv[2];

const main = async (): Promise<void> => {
  const rows = await prisma.$queryRawUnsafe<
    { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; logs: string | null }[]
  >(
    `SELECT migration_name, finished_at, rolled_back_at, logs
       FROM "_prisma_migrations" ORDER BY started_at DESC`,
  );

  for (const r of rows) {
    if (filter && !r.migration_name.includes(filter)) continue;
    const state = r.finished_at ? 'applied' : r.rolled_back_at ? 'rolled back' : 'FAILED';
    console.log(`\n${r.migration_name}  [${state}]`);
    if (!r.finished_at && !r.rolled_back_at) {
      console.log(`  ${r.logs?.trim() ?? '(no logs recorded)'}`);
    }
  }
};

main()
  .catch((e: unknown) => {
    console.error('failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
