/**
 * Read-only: is the enum -> text I/O conversion immutable?
 *
 * The dedup index failed with SqlState 42P17. `play_source` is a Postgres enum
 * and the index expression casts it with `coalesce(play_source::text, '')`.
 *
 * The cast does NOT appear in `pg_cast` - I/O conversions are not catalogued as
 * casts - so the earlier probe returned nothing and proved nothing. The decisive
 * question is the volatility of the function behind the conversion, `enum_out`.
 *
 * Read-only. Usage: npx tsx scripts/probe-enum-io-cast.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const VOLATILE = { i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' } as Record<string, string>;

const main = async (): Promise<void> => {
  const fns = await prisma.$queryRawUnsafe<{ proname: string; provolatile: string; prorettype: string }[]>(
    `SELECT proname, provolatile, format_type(prorettype, NULL) AS prorettype
       FROM pg_proc WHERE proname IN ('enum_out', 'textin', 'textout', 'lower', 'coalesce')`,
  );
  console.log('\nfunction volatility (i=IMMUTABLE, s=STABLE, v=VOLATILE):');
  for (const f of fns) {
    console.log(`  ${f.proname.padEnd(10)} ${(VOLATILE[f.provolatile] ?? f.provolatile).padEnd(10)} -> ${f.prorettype}`);
  }

  const enumOut = fns.find((f) => f.proname === 'enum_out');
  console.log(
    enumOut
      ? `\n=> enum_out is ${VOLATILE[enumOut.provolatile]}. ` +
        (enumOut.provolatile === 'i'
          ? 'So the enum->text cast is NOT the cause; something else in the expression is.'
          : 'So coalesce(play_source::text, ...) is NOT a valid index expression. Index the column directly.')
      : '\n=> enum_out not found (older server?); the cast is then via a type-specific output function.',
  );

  // Also: is play_source nullable? That decides whether NULLS NOT DISTINCT or a
  // NOT NULL assumption is the right fix.
  const col = await prisma.$queryRawUnsafe<{ is_nullable: string; data_type: string }[]>(
    `SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_name = 'user_plays' AND column_name = 'play_source'`,
  );
  console.log(`\nplay_source: ${JSON.stringify(col[0] ?? {})}`);
};

main()
  .catch((e: unknown) => {
    console.error('probe failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
