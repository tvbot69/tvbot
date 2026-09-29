/**
 * The `silent-failure-default` ratchet is only useful if it measures the whole
 * population, and that is exactly the property a static count cannot check on
 * its own. So these tests are integration tests against the real script rather
 * than unit tests of its predicates: the predicates are module-private, and
 * importing `scripts/` from `src/` would drag a file outside `rootDir` into
 * `tsc` and break `npm run build`.
 *
 * What they lock, in the order the bugs actually happened:
 *
 *  1. The `.catch()` branch is ALIVE. My first version called
 *     `isCatchCall(node)` instead of `isCatchCall(node.expression)`, so the
 *     predicate was handed a CallExpression where it wanted the callee and
 *     returned false for every `.catch()` in the tree. Nothing crashed. The
 *     count was simply half what it should have been (295 instead of 604) and
 *     every one of the 309 promise-handler sites was invisible. A ratchet that
 *     under-reports is worse than no ratchet, because it looks like coverage.
 *  2. The TaggedTemplateExpression shape is counted. Six
 *     `$queryRawUnsafe<Array<{...}>>` tagged templates carrying a type argument
 *     in `playHistoryService.getYearOverview` are `.catch(() => [])`-ed; the
 *     receiver of that `.catch` is a CallExpression, and the same class of
 *     mistake defeated the raw-query detector in this file before.
 *  3. There is NO file-level skip. `genreService.ts` already had instances and
 *     already has tests, and a detector that skipped "known" files would report
 *     zero for the tenth one added tomorrow. The assertion is on the instance
 *     count within one file, not on the total, for the same reason.
 *  4. A `Logger.*` anywhere in the handler suppresses the finding, so
 *     `timerService`'s `catch (err) { Logger.warn(...) }` is absent even though
 *     its body is empty and it falls through.
 *  5. Test files, the `src/tests/` helper tree and `scripts/` are never listed.
 *
 * Assertions are on file + shape, never on a line number. The tree moves under
 * this test - another agent was editing `src/bot/services/` throughout the
 * session that produced it - and a fixture pinned to `file:690` would have
 * failed for a reason that has nothing to do with the detector.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join('scripts', 'count-debt.ts');
const KIND = 'silent-failure-default';
const BUDGET_FILE = path.join(ROOT, 'scripts', 'debt-budget.json');

// `node <tsx cli>` rather than `node_modules/.bin/tsx`: on Windows the bin is
// a `.cmd` shim, and Node 24's spawn refuses to execute one directly
// (`spawnSync ... EINVAL`). Going through the current Node binary and the CLI
// entry also means the child runs under the same runtime as the suite.
const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const run = (...args: string[]): string =>
  execFileSync(process.execPath, [tsxCli, SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // Without this the child inherits the parent's stderr and the deliberate
    // "unknown kind" test above prints a stack trace into the suite output.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

/** `  path:line  [shape]` lines from the `--where` block for one kind. */
const sitesFor = (where: string, kind: string): string[] => {
  const start = where.indexOf(`\n${kind}:\n`);
  if (start === -1) return [];
  const rest = where.slice(start + kind.length + 3);
  const end = rest.search(/\n\S+:\n/);
  const block = end === -1 ? rest : rest.slice(0, end);
  return block.split('\n').filter((l) => l.trim().length > 0);
};

let where = '';
let table = '';
let sites: string[] = [];
let budget: number = -1;

/** The `measured` column of one row of the debt table. */
const measuredOf = (out: string): number => {
  const row = out.split('\n').find((l) => l.trim().startsWith(KIND));
  expect(row, `${KIND} missing from the debt table:\n${out}`).toBeDefined();
  return Number(row!.trim().split(/\s+/)[1]);
};

beforeAll(() => {
  // One script run shared by every assertion in the file: building the
  // `ts.Program` over the whole tree costs seconds, and these must all read
  // the SAME snapshot or they can disagree with each other.
  table = run();
  where = run('--where');
  sites = sitesFor(where, KIND);
  const recorded = (JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Record<string, unknown>)[KIND];
  budget = typeof recorded === 'number' ? recorded : -1;
}, 180_000);

describe('debt ratchet: silent-failure-default', () => {
  it('reports the kind at or under its recorded budget', () => {
    const measured = measuredOf(table);
    expect(Number.isInteger(measured)).toBe(true);
    expect(budget, 'debt-budget.json has no numeric entry for the kind').toBeGreaterThanOrEqual(0);
    expect(measured).toBeLessThanOrEqual(budget);
  });

  it('the --where list and the summary number are derived from the same walk', () => {
    // A separate pass for the reporter could disagree with the counter, and
    // `--where` would then point at lines the total does not include.
    expect(sites.length).toBe(measuredOf(table));
  });

  it('counts `.catch()` handlers, not only `catch` clauses', () => {
    // The dead-branch bug removed all 309 of them while every other assertion
    // in the script stayed green.
    const dotCatch = sites.filter((s) => /\[\s*returns/.test(s));
    expect(dotCatch.length).toBeGreaterThan(200);
  });

  it('counts a `.catch(() => [])` whose receiver is a type-argument tagged template', () => {
    // playHistoryService.getYearOverview chains six
    // `this.db.$queryRawUnsafe<Array<{...}>>(`...`).catch(() => [])`. The
    // `.catch` callee's receiver is a CallExpression carrying a
    // TaggedTemplateExpression argument; missing that shape reported zero for
    // a file holding five queries once already in this script.
    const inFile = sites.filter((s) => s.trim().startsWith('bot/services/playHistoryService.ts:'));
    const rawQuerySwallows = inFile.filter((s) => /\[returns \[\]\]$/.test(s.trim()));
    expect(rawQuerySwallows.length).toBeGreaterThanOrEqual(6);
  });

  it('counts instances inside an already-covered file, not one per file', () => {
    // genreService.ts already has tests and already has instances. A detector
    // that skipped "known" files would report 0 or 1 here, and the tenth
    // instance added next month would be free.
    const inFile = sites.filter((s) => s.trim().startsWith('bot/services/genreService.ts:'));
    expect(inFile.length).toBeGreaterThanOrEqual(5);
  });

  it('does not report a catch that logs, even when its body is empty', () => {
    // timerService.removePrivacyHiddenPlays has
    // `catch (err) { Logger.warn({ err, userId }, 'Privacy purge failed...'); }`
    // - an empty handler that falls through. Only the Logger call keeps it out.
    const fallsThrough = sites.filter(
      (s) => s.trim().startsWith('bot/services/timerService.ts:') && s.includes('empty body'),
    );
    expect(fallsThrough).toEqual([]);
  });

  it('never reports a test file, the src/tests helper tree, or a script', () => {
    for (const site of sites) {
      const loc = site.trim();
      expect(loc, `test file reported: ${loc}`).not.toMatch(/\.(test|spec)\.tsx?:\d+$/);
      expect(loc, `test helper reported: ${loc}`).not.toMatch(/^src?[\/\\]tests[\/\\]/);
      expect(loc, `script reported: ${loc}`).not.toMatch(/^scripts[\/\\]/);
      expect(loc, `path is not repo-relative: ${loc}`).toMatch(/^[A-Za-z].*:\d+\s+\[/);
    }
  });

  it('reports only the three documented shapes', () => {
    // A closed set. If a future change makes the detector emit a new shape
    // family, this fails and forces a decision about what it means.
    for (const site of sites) {
      const shape = site.slice(site.indexOf('['));
      expect(shape, `undocumented shape: ${site.trim()}`).toMatch(
        /^\[(returns |assigns |empty body, falls through)/,
      );
    }
  });
});

describe('debt ratchet: --set works for a kind that has no budget yet', () => {
  it('accepts a --set for the new kind and leaves the file untouched when the value is unchanged', () => {
    // This is the recovery path the missing-entry error tells the user to run,
    // and it was unreachable once because the validation threw before applySets
    // ever saw the argument. Setting the kind to its own current value is a
    // no-op write, so the assertion is that the run SUCCEEDS and the budget file
    // is byte-identical afterwards.
    const before = fs.readFileSync(BUDGET_FILE, 'utf8');
    expect(budget, 'debt-budget.json has no numeric entry for the kind').toBeGreaterThanOrEqual(0);
    const out = run(`--set=${KIND}=${budget}`);
    expect(out).toContain(KIND);
    expect(fs.readFileSync(BUDGET_FILE, 'utf8')).toBe(before);
  }, 180_000);

  it('rejects an unknown kind by name', () => {
    let stderr = '';
    try {
      run('--set=not-a-real-kind=1');
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(stderr).toContain('unknown debt kind');
  }, 180_000);
});
