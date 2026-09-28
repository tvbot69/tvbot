/**
 * Read-only: is the `play_source` enum -> text cast IMMUTABLE?
 *
 * The dedup index failed with SqlState 42P17. `play_source` is a Postgres enum
 * and the index casts it to text, so this cast is the prime suspect. Ask
 * pg_cast rather than reason about it.
 *
 * Read-only. Usage: npx tsx scripts/probe-enum-cast.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VOLATILE = { i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' } as Record<string, string>;

const main = async (): Promise<void> => {
  const casts = await prisma.$queryRawUnsafe<
    { proname: string; provolatile: string; src: string; tgt: string }[]
  >(
    `SELECT p.proname, p.provolatile,
            c.castsource::regtype::text AS src,
            c.casttarget::regtype::text AS tgt
       FROM pg_cast c
       JOIN pg_proc p ON p.oid = c.castfunc
      WHERE c.castsource::regtype::text = 'play_source'
        AND c.casttarget::regtype::text = 'text'`,
  );
  console.log('\nplay_source -> text casts:');
  for (const c of casts) {
    console.log(`  ${c.proname}  ${VOLATILE[c.provolatile] ?? c.provolatile}`);
  }
  if (casts.every((c) => c.provolatile !== 'i')) {
    console.log(
      '\n=> NOT immutable. This is why the index failed: Postgres refuses to\n' +
        '   build an index whose expression calls a non-immutable function, so\n' +
        '   the fix is to index the column itself and normalise at write time or\n' +
        '   in the query, not to cast it in the index expression.',
    );
  }
};

main()
  .catch((e: unknown) => {
    console.error('probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
