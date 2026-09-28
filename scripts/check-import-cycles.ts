/**
 * Fail if the number of import cycles increases.
 *
 * Runs madge TWICE, because there are two different questions and reporting
 * one number for both makes the answer useless:
 *
 *   RUNTIME cycles  - `import type` edges excluded. These are real: they change
 *                     module load order and are what a cycle actually costs.
 *                     Budget: 0.
 *   TYPE cycles     - including `import type`. A DTO type declared beside the
 *                     implementation that produces it is normal and harmless,
 *                     so these get a separate, looser budget.
 *
 * All four cycles madge reports by default turned out to be type-only on one
 * side, so the runtime number is already 0. Reporting "4 cycles" without that
 * distinction overstates the problem and produces a check nobody can act on.
 *
 * Run: npm run deps:cycles        (fails if either budget is exceeded)
 *      npm run deps:cycles -- --report   (never fails; prints both numbers)
 */
import madge from 'madge';
import fs from 'node:fs';
import path from 'node:path';

/** RUNTIME cycles, type-only edges excluded. Must be 0. */
const MAX_RUNTIME_CYCLES = 0;
/** Cycles including `import type`. Real coupling, but not load-order risk. */
const MAX_TOTAL_CYCLES = 4;

const BUDGET_FILE = path.join(process.cwd(), 'scripts', 'cycle-budget.json');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * Run madge programmatically rather than shelling out.
 *
 * Two reasons. madge EXITS NON-ZERO when it finds cycles - the case we care
 * about - so a spawned process throws before stdout can be read. And madge 8
 * has no `--config` flag at all, so detective options can only be passed
 * through the API.
 */
const runMadge = async (skipTypeImports: boolean): Promise<string[]> => {
  const result = await madge(process.cwd() + '/src', {
    circular: true,
    fileExtensions: ['ts'],
    tsConfig: path.join(process.cwd(), 'tsconfig.json'),
    // excludeTestFiles keeps *.test.ts out; a test importing the module under
    // test is not a production dependency edge.
    excludeTestFiles: true,
    detectiveOptions: { ts: { skipTypeImports } },
  });
  return result.circular();
};

const main = async (): Promise<void> => {
  if (!fs.existsSync(path.join(process.cwd(), 'node_modules', 'madge'))) {
    throw new Error('madge is not installed - run npm ci');
  }

  const runtime = await runMadge(true);
  const total = await runMadge(false);

  console.log(`runtime cycles (type imports excluded): ${runtime.length}  (allowed ${MAX_RUNTIME_CYCLES})`);
  for (const c of runtime) console.log(`    ${c}`);
  console.log(`all cycles (including type imports):    ${total.length}  (allowed ${MAX_TOTAL_CYCLES})`);
  for (const c of total) console.log(`    ${c}`);

  fs.writeFileSync(
    BUDGET_FILE,
    `${JSON.stringify(
      { maxRuntime: MAX_RUNTIME_CYCLES, maxTotal: MAX_TOTAL_CYCLES, runtime, total },
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (REPORT_ONLY) return;

  const failures: string[] = [];
  if (runtime.length > MAX_RUNTIME_CYCLES) {
    failures.push(`runtime cycles: ${runtime.length} > ${MAX_RUNTIME_CYCLES}`);
  }
  if (total.length > MAX_TOTAL_CYCLES) {
    failures.push(`total cycles: ${total.length} > ${MAX_TOTAL_CYCLES}`);
  }
  if (failures.length) {
    console.error('\nIMPORT CYCLE RATCHET FAILED');
    for (const f of failures) console.error(`  ${f}`);
    console.error('\nDo not raise the budget to make this pass. Break a cycle instead.');
    process.exit(1);
  }
};

main().catch((err: unknown) => {
  console.error('import cycle check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
