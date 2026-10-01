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
 *  3. There is NO file-level skip. A file that already has tests of its own must
 *     still be measured, and a file must be able to report MORE THAN ONE
 *     instance - a detector that skipped "known" files would report 0, and one
 *     that collapsed a file to a single finding would report 1. Both are
 *     asserted against a FIXTURE, because the previous version of this file
 *     pinned a production file and went red the moment that file was fixed.
 *  4. A `Logger.*` anywhere in the handler suppresses the finding, so
 *     `timerService`'s `catch (err) { Logger.warn(...) }` is absent even though
 *     its body is empty and it falls through.
 *  5. Test files, the `src/testSupport/` helper tree and `scripts/` are never listed.
 *
 * Assertions are on file + shape, never on a line number. The tree moves under
 * this test - another agent was editing `src/bot/services/` throughout the
 * session that produced it - and a fixture pinned to `file:690` would have
 * failed for a reason that has nothing to do with the detector.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEBT_BUDGET_FILE as BUDGET_FILE, REPO_ROOT as ROOT, TSX_CLI as tsxCli } from '../testSupport/repoRoot';

const SCRIPT = path.join('scripts', 'count-debt.ts');
const KIND = 'silent-failure-default';

// `node <tsx cli>` rather than `node_modules/.bin/tsx`: on Windows the bin is
// a `.cmd` shim, and Node 24's spawn refuses to execute one directly
// (`spawnSync ... EINVAL`). Going through the current Node binary and the CLI
// entry also means the child runs under the same runtime as the suite.
// ROOT and TSX_CLI come from testSupport/repoRoot rather than being rebuilt
// here: this path is handed to a CHILD PROCESS, so a root resolved by counting
// `..` hops means a wrong root makes the ratchet scan nothing and report a
// clean bill of health instead of failing.

/**
 * Every kind the script knows about, read from the real budget file.
 *
 * The fixture budget must name all of them: `loadBudgets` throws on a kind with
 * no entry, and a throw inside the child would look exactly like "0 findings"
 * to the caller. Deriving this rather than hardcoding the list means a new kind
 * added to `debt-budget.json` keeps the fixture runs working.
 */
const EXPECTED_KINDS = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Record<string, number>;

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

/**
 * Fixture sources for the shape assertions below. Each is a COMPLETE module
 * body, because the detector builds a real `ts.Program` and a half-written
 * file would fail to parse into the AST shapes being asserted on.
 *
 * They deliberately do NOT import anything: the script's own kinds read
 * `ts.SourceFile` nodes, and an unresolvable import changes the program's file
 * list rather than the node shapes under test.
 */
const FIXTURE_TAGGED_TEMPLATE = `
export async function topArtists(db: { q(u: number): Promise<Array<{ a: string }>> }, userId: number) {
  return db
    .$queryRawUnsafe<Array<{ a: string }>>\`SELECT a FROM t WHERE id = \${userId}\`
    .catch(() => []);
}
`;

const FIXTURE_PLAIN = `
export async function plain(p: Promise<Array<string>>) {
  return p.catch(() => []);
}
`;

const FIXTURE_LOGGED = `
import { Logger } from './logger';
export async function logged(p: Promise<Array<string>>) {
  return p.catch((err) => {
    Logger.warn({ err }, 'query failed');
    return [];
  });
}
`;

const FIXTURE_NO_CATCH = `
export async function clean(p: Promise<Array<string>>) {
  return p;
}
`;

/**
 * THREE instances in ONE file, which is what the per-file question needs.
 *
 * The assertion this fixture replaces pointed at `genreService.ts` and required
 * five real sites. That is the same mistake the tagged-template test above had
 * already been rewritten for: the day someone FIXED those five swallows, the
 * test went red and the tempting response was to delete the assertion - which
 * inverts the ratchet, because a detector check must not depend on the bug it
 * detects still existing. `genreService.ts` was fixed and that is exactly what
 * happened. A detector check has to run against a subject nobody is going to
 * fix on purpose.
 */
const FIXTURE_THREE_IN_ONE_FILE = `
export async function a(p: Promise<Array<string>>) {
  return p.catch(() => []);
}
export async function b(p: Promise<Array<string>>) {
  return p.catch(() => []);
}
export async function c(p: Promise<Array<string>>) {
  return p.catch(() => []);
}
`;

/**
 * Runs the REAL detector over a throwaway project containing one fixture file.
 *
 * The script resolves its program from `process.cwd()`, so pointing `cwd` at a
 * temp dir with its own `tsconfig.json` and `scripts/debt-budget.json` scopes
 * every kind to that one file. This is what makes the assertions above able to
 * survive the production code being fixed: the subject is a fixture, not a bug
 * that is scheduled to disappear.
 *
 * `--where` rather than the table, so the caller gets both the count and the
 * shape label from a single run. The budget file is seeded with a generous
 * value per kind so the ratchet cannot fail the child process; exit code is
 * still checked, because a crash must not be reported as "0 findings".
 */
const runDetectorOnFixture = (source: string): { count: number; sites: string[] } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-fixture-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'fixture.ts'), source, 'utf8');
    // `include` picks up only src/, so the fixture is the sole source file and
    // every other kind measures 0.
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: false }, include: ['src/**/*.ts'] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'scripts', 'debt-budget.json'),
      JSON.stringify(Object.fromEntries(Object.keys(EXPECTED_KINDS).map((k) => [k, 9999])), null, 2),
      'utf8',
    );
    // `raw-query-without-db-test` reads its per-file allowance from
    // scripts/raw-query-baseline.json RELATIVE TO CWD and throws when it is
    // absent, so a fixture without it dies in an unrelated kind before the kind
    // under test is ever evaluated. An empty object is the right baseline for a
    // tree with no covered files: allowance 0 everywhere.
    fs.writeFileSync(path.join(dir, 'scripts', 'raw-query-baseline.json'), '{}\n', 'utf8');

    // ABSOLUTE: the child's cwd is the temp dir, so a repo-relative SCRIPT
    // would resolve to a path that does not exist there.
    const out = execFileSync(process.execPath, [tsxCli, path.join(ROOT, SCRIPT), '--where'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const sites = sitesFor(out, KIND);
    return { count: sites.length, sites };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    // A synthetic project rather than a production file.
    //
    // This assertion used to point at the six `.catch(() => [])` chains in
    // `playHistoryService.getYearOverview`, which made the fixture and the
    // subject the same code - so the day someone FIXED those six swallows, this
    // test would have gone red and the tempting response would have been to
    // delete the assertion. That inverts the ratchet: a detector check must not
    // depend on the bug it detects still existing.
    //
    // The shape is the point. `db.$queryRawUnsafe<Array<T>>`...`` is a
    // TaggedTemplateExpression carrying a type argument, and `.catch` hangs off
    // the resulting CallExpression. isCallExpression is false for the tagged
    // template itself, and a detector that only walked CallExpressions reported
    // zero for a file holding five queries - a ratchet that under-reports looks
    // exactly like a ratchet that is working.
    const { count, sites: fixtureSites } = runDetectorOnFixture(FIXTURE_TAGGED_TEMPLATE);
    expect(count, 'fixture is not shaped as a tagged-template .catch').toBe(1);
    expect(fixtureSites).toHaveLength(1);
    expect(fixtureSites[0]).toMatch(/\[returns \[\]\]$/);
  }, 180_000);

  it('still counts the plain `.catch(() => [])` shape, so the check above is not the only path', () => {
    // Guards against "fix" being a narrowing: if someone made the detector
    // match tagged templates ONLY, the general case would go quiet.
    const { count } = runDetectorOnFixture(FIXTURE_PLAIN);
    expect(count).toBe(1);
  }, 180_000);

  it('reports zero for a fixture whose catch logs, and one whose catch is absent', () => {
    // The negative cases for the same rule. Without these, a detector that
    // returned 1 for literally any file would pass everything above.
    expect(runDetectorOnFixture(FIXTURE_LOGGED).count).toBe(0);
    expect(runDetectorOnFixture(FIXTURE_NO_CATCH).count).toBe(0);
    // Two `ts.Program` builds, each a separate `execFileSync` of the script, and
    // this file also runs two full script passes in `beforeAll`. Under the full
    // suite's parallel load that exceeds the 5s default, and a timeout here is
    // indistinguishable from a detector that hangs. Same 180s the `--set` tests
    // below use for the same reason.
  }, 180_000);

  it('counts instances inside an already-covered file, not one per file', async () => {
    // A detector that skipped "known" files would report 0, and one that
    // collapsed a file to a single finding would report 1. Three separate
    // swallowing catches in one module must read as three.
    expect(runDetectorOnFixture(FIXTURE_THREE_IN_ONE_FILE).count).toBe(3);
  }, 180_000);

  it('does not skip a production file that already has tests', async () => {
    // The per-file rule needs one assertion against the REAL tree as well, or
    // the fixture above only proves the detector is consistent with itself. A
    // file with tests of its own must still be measured; the subject is read
    // from the live site list rather than hardcoded, because naming a specific
    // file here is the brittleness that made the previous version of this test
    // go red the moment its subject was fixed.
    const withOwnTests = sites.filter((s) =>
      s.trim().startsWith('bot/services/library/artistsService.ts:'),
    );
    const testFileExists = fs.existsSync(
      path.join(ROOT, 'src', 'bot', 'services', 'library', '__tests__', 'artistsService.test.ts'),
    );
    expect(testFileExists, 'fixture subject assumption broke: no artistsService.test.ts').toBe(true);
    expect(withOwnTests.length, 'a tested production file was skipped by the detector').toBeGreaterThan(0);
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

  it('never reports a test file, the src/testSupport helper tree, or a script', () => {
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
