/**
 * Fail if the number of circular dependencies increases.
 *
 * A ratchet, not a target: the count is recorded in the file and any increase
 * fails. The plan asks for zero cycles, and that is the goal, but a check that
 * starts red can only be made green by deleting the check.
 *
 * Run: npm run deps:cycles
 * Wired into CI as a blocking step.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Cycles that exist today. Lower this as they are fixed; never raise it. */
const MAX_CYCLES = 4;

const BUDGET_FILE = path.join(process.cwd(), 'scripts', 'cycle-budget.json');

interface CycleResult {
  cycles: number;
  list: string[];
}

/**
 * Invoke madge through its local binary rather than `npx`.
 *
 * Two reasons. A spawned process has a different PATH, so `npx` is ENOENT here
 * even though it works from a shell. And madge EXITS NON-ZERO when it finds
 * cycles - which is the normal case we care about - so `execFileSync` throws
 * before the output can be read. `spawnSync` lets us read stdout either way.
 */
const runMadge = (): CycleResult => {
  const madgeBin = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'madge.cmd' : 'madge',
  );
  if (!fs.existsSync(madgeBin)) {
    throw new Error(`madge not installed at ${madgeBin} - run npm ci`);
  }
  const proc = spawnSync(
    madgeBin,
    ['--circular', '--extensions', 'ts', '--ts-config', 'tsconfig.json', '--json', 'src'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' },
  );
  if (!proc.stdout || proc.stdout.trim() === '') {
    throw new Error(`madge produced no output (stderr: ${proc.stderr?.slice(0, 400) ?? 'none'})`);
  }
  const parsed = JSON.parse(proc.stdout) as unknown;
  // madge's --json is an ARRAY of cycle paths ("a > b > a"). Earlier versions
  // emitted an object keyed by the same paths, so both shapes are accepted
  // rather than silently reporting a list of "0, 1, 2, 3".
  const list = Array.isArray(parsed)
    ? parsed.map(String)
    : Object.keys(parsed as Record<string, string[]>);
  return { cycles: list.length, list };
};

const main = (): void => {
  const { cycles, list } = runMadge();

  if (cycles > MAX_CYCLES) {
    console.error(`\nCIRCULAR DEPENDENCY RATCHET FAILED`);
    console.error(`  allowed: ${MAX_CYCLES}`);
    console.error(`  found:   ${cycles}`);
    for (const c of list) console.error(`    ${c}`);
    console.error(`\nDo not raise MAX_CYCLES to make this pass. Break a cycle instead.`);
    process.exit(1);
  }

  // Persist the live list so a reviewer can see which cycles remain and
  // confirm a change did what it claimed.
  fs.writeFileSync(
    BUDGET_FILE,
    `${JSON.stringify({ max: MAX_CYCLES, cycles, list }, null, 2)}\n`,
    'utf8',
  );

  console.log(`circular dependencies: ${cycles} (allowed ${MAX_CYCLES})`);
  for (const c of list) console.log(`  ${c}`);
  if (cycles === 0) console.log('  none - the plan target is met');
};

main();
