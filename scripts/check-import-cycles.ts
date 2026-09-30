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
import os from 'node:os';
import path from 'node:path';

/** RUNTIME cycles, type-only edges excluded. Must be 0. */
const MAX_RUNTIME_CYCLES = 0;
/**
 * Cycles including `import type`. Real coupling, but not load-order risk.
 *
 * THREE REAL ONES, listed in the comment below. This was `4`, and the fourth
 * was a `__cycleprobe/a.ts` entry: a throwaway fixture a subagent's mutation
 * run wrote into this file, which the script then re-wrote on its next run and
 * which got committed. It granted a phantom allowance, so the check had room
 * for one more real cycle than it should. **Every number here must be backed by
 * a real pair, and `deps:cycles` prints the pairs it counted precisely so a
 * human can see whether the budget matches reality.**
 *
 * The three real cycles, all `import type` on one side and all deliberate:
 *   userService        -> commandDispatcher
 *   autopostService    -> autopostRepository
 *   ytResolver         -> descriptionChapters
 */
const MAX_TOTAL_CYCLES = 3;

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

  // SNAPSHOT ONLY, and it must never sit in the working tree.
  //
  // This file used to be written to `scripts/cycle-budget.json` on every run.
  // That is a trap twice over: the ratchet read NOTHING from it (the budgets
  // are the constants above), so it was an output masquerading as a config, and
  // because it lived in the repo a throwaway fixture a subagent's run created
  // was committed into it. Anyone reading it reasonably concluded the budgets
  // lived there.
  //
  // It is now written to the OS temp directory and is not tracked. If you want
  // the last snapshot, read it there; if you want to change a budget, change
  // the constant in this file, which is what the test above and CI both read.
  const snapshot = path.join(os.tmpdir(), 'tvbot-cycle-snapshot.json');
  fs.writeFileSync(
    snapshot,
    `${JSON.stringify(
      { maxRuntime: MAX_RUNTIME_CYCLES, maxTotal: MAX_TOTAL_CYCLES, runtime, total },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\nsnapshot (untracked): ${snapshot}`);

  if (REPORT_ONLY) return;

  const failures: string[] = [];
  if (runtime.length > MAX_RUNTIME_CYCLES) {
    failures.push(`runtime cycles: ${runtime.length} > ${MAX_RUNTIME_CYCLES}`);
  }
  if (total.length > MAX_TOTAL_CYCLES) {
    failures.push(`total cycles: ${total.length} > ${MAX_TOTAL_CYCLES}`);
  }
  // A budget with slack and no explanation is how a phantom entry survives: 4
  // allowed, 3 real, nobody asks which is the fourth. Say so out loud.
  if (!REPORT_ONLY && total.length < MAX_TOTAL_CYCLES) {
    console.log(
      `\nNOTE: ${MAX_TOTAL_CYCLES - total.length} cycle slot(s) unused. If a cycle was deleted,\n` +
        `      lower MAX_TOTAL_CYCLES in this file so the budget tracks reality.`,
    );
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
