/**
 * One number per kind of debt, each with a recorded budget that may only go DOWN.
 *
 * Every ratchet added so far counted one thing in one file: escapes in one
 * module, cycles in one graph, coverage in one config. That does not survive.
 * The next person adds a sixth escape type and writes a sixth script. This file
 * is the generalisation: measure a named list of debt kinds, compare each
 * against its budget, fail on any increase, print the trend.
 *
 * Two design rules, both learned the hard way:
 *
 *  1. A ratchet that starts red can only be made green by deleting the ratchet.
 *     Every budget here is the real measured number on the day it was added.
 *     Nothing is aspirational. Raising a budget is a deliberate act a reviewer
 *     can see in the diff, which is the point - it must never happen silently.
 *
 *  2. A debt count that includes test files is a debt count nobody can act on.
 *     Tests legitimately cast, and `as unknown as X` is the documented way this
 *     codebase reaches privates. Production only, always.
 *
 * Run: npm run debt                       (fails if anything regressed)
 *      npm run debt -- --report            (never fails; print only)
 *      npm run debt -- --set=<kind>=<n>    (raise/lower a budget deliberately)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const BUDGET_FILE = path.join(ROOT, 'scripts', 'debt-budget.json');
const SRC = path.join(ROOT, 'src');

const REPORT_ONLY = process.argv.includes('--report');
const SET_ARGS = process.argv.filter((a) => a.startsWith('--set='));

/**
 * Debt kinds. Each returns a count from the production source files only.
 *
 * `ts.Program` is built once and shared - constructing one per rule would
 * reparse the whole tree a dozen times and the script would take minutes.
 */
/**
 * Each kind returns a count, and may push offender paths into `where` so a
 * regression can be found without re-deriving the measurement by hand.
 */
let WHERE: string[] = [];
const record = (file: string, line: number): void => {
  WHERE.push(`${file}:${line}`);
};

type KindFn = (program: ts.Program) => number;

const KINDS: Record<string, KindFn> = {
  /**
   * `: any` / `<any>` / `as any` in production code.
   * The original debt was 392. AGENTS.md golden rule 9 is the sibling rule
   * this exists to enforce: an unchecked escape is how a refactor silently
   * changes shape and only fails at runtime.
   */
  'explicit-any': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const text = sf.getFullText();
      // Prefer the AST: a string containing ": any" is not an escape.
      void text;
      sf.forEachChild((node) => {
        n += countAnyNodes(node);
      });
    }
    return n;
  },

  /**
   * `catch (err: any)` / `catch (err: unknown as any)`.
   * Counted separately from explicit-any because the fix is different: these
   * need narrowing at the catch site, not a type annotation.
   */
  'typed-catch': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCatchClause(node) &&
          node.variableDeclaration?.type &&
          /\bany\b/.test(node.variableDeclaration.type.getText(sf))
        ) {
          n += 1;
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
    return n;
  },

  /**
   * `container.resolve` outside the three files the plan allows.
   *
   * The plan names `startup.ts`, `textCommands/index.ts` and
   * `slashCommands/index.ts` as the composition roots, and everything else as
   * debt with a target under 30. Those three are excluded here because they are
   * supposed to construct things; counting them would make the number mean
   * nothing.
   *
   * Counted from the AST rather than a regex so a `container.resolve` inside a
   * comment or a string does not inflate the total.
   */
  'container-resolve-outside-root': (program) => {
    const ROOTS = ['/bot/startup.ts', '/bot/textCommands/index.ts', '/bot/slashCommands/index.ts'];
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      if (ROOTS.some((r) => p.endsWith(r))) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'resolve' &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'container'
        ) {
          n += 1;
        }
        node.forEachChild(visit);
      };
        visit(sf);
      }
    return n;
  },

  /**
   * `container.resolve` inside a CONSTRUCTOR body, outside the composition roots.
   *
   * Counted separately from the total because the two mean different things.
   *
   * A resolve in a constructor is eager: it runs at construction, it hides the
   * dependency from the wiring graph, and the container cannot build the class
   * without knowing about it. `interactionHandler` had 37 of these. That is the
   * architectural debt the plan means.
   *
   * A resolve inside a method is lazy. `fmFooterResolver` resolves PrismaClient
   * only when the "artist plays" footer is enabled - that is a deliberate
   * tradeoff, not an oversight, and converting it would pay for construction
   * the feature may never use. Counting it the same as an eager resolve makes
   * a single number meaningless.
   *
   * Both are ratcheted, both only ever go down, and this one is the stricter
   * constraint on the constructor case.
   */
  'container-resolve-in-constructor': (program) => {
    const ROOTS = ['/bot/startup.ts', '/bot/textCommands/index.ts', '/bot/slashCommands/index.ts'];
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      if (ROOTS.some((r) => p.endsWith(r))) continue;
      const visitClass = (node: ts.ClassDeclaration): void => {
        for (const member of node.members) {
          if (!ts.isConstructorDeclaration(member) || !member.body) continue;
          const inCtor = (x: ts.Node): void => {
            if (
              ts.isCallExpression(x) &&
              ts.isPropertyAccessExpression(x.expression) &&
              ts.isIdentifier(x.expression.expression) &&
              x.expression.expression.text === 'container' &&
              x.expression.name.text === 'resolve'
            ) {
              n += 1;
              // Use the source file already in scope: node.getSourceFile() can
              // be undefined for synthesized nodes inside a ts.Program.
              const { line } = sf.getLineAndCharacterOfPosition(x.getStart(sf));
              record(p.split('/src/')[1] ?? p, line + 1);
            }
            // Do NOT cross a function boundary. `topInteractions` registers
            // `registerModalHandler('overview-jump', async () => { ... })`
            // inside its constructor, so a resolve inside that arrow is
            // lexically in the constructor but runs when the modal is clicked.
            // Counting it made the metric report 6 where 4 were eager.
            if (
              ts.isArrowFunction(x) ||
              ts.isFunctionExpression(x) ||
              ts.isFunctionDeclaration(x) ||
              ts.isMethodDeclaration(x)
            ) {
              return;
            }
            x.forEachChild(inCtor);
          };
          member.body.forEachChild(inCtor);
        }
      };
      const walk = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) visitClass(node);
        node.forEachChild(walk);
      };
      walk(sf);
    }
    return n;
  },

  /**
   * `as unknown as T` in production code.
   *
   * The plan allows these in exactly one place - a moonlink type adapter,
   * because moonlink's published types do not match what it actually sends at
   * runtime. Everywhere else, `as unknown as` is the loudest possible way to
   * say "I have not checked this".
   *
   * 117 today. The honest reduction is not "type it properly everywhere" but
   * "move the ones that are genuinely moonlink's problem into the adapter, and
   * delete the rest".
   */
  'as-unknown-as': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isAsExpression(node)) {
          const inner = node.expression;
          if (ts.isAsExpression(inner)) {
            const t = inner.type.getText(sf);
            if (/^(unknown|any)$/.test(t)) n += 1;
          }
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
    return n;
  },
};

/** Production source only: under src/, not a test, not a declaration. */
const isProduction = (sf: ts.SourceFile): boolean => {
  const p = path.resolve(sf.fileName).replace(/\\/g, '/');
  if (!p.includes('/src/')) return false;
  if (/\.(test|spec)\.tsx?$/.test(p)) return false;
  if (/\.d\.ts$/.test(p)) return false;
  if (p.includes('/migrations/')) return false;
  return true;
};

/** Count escape sites in one subtree. */
const countAnyNodes = (node: ts.Node): number => {
  let n = 0;
  // SyntaxKind.AnyKeyword, not ts.isAnyKeyword - the latter is internal and
  // is not exported by every supported TypeScript version.
  if (node.kind === ts.SyntaxKind.AnyKeyword) n += 1;
  node.forEachChild((child) => {
    n += countAnyNodes(child);
  });
  return n;
};

const buildProgram = (): ts.Program => {
  const configPath = path.join(ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  return ts.createProgram(parsed.fileNames, parsed.options);
};

const loadBudgets = (): Record<string, number> => {
  if (!fs.existsSync(BUDGET_FILE)) {
    throw new Error(
      `no debt budget at ${BUDGET_FILE}. Run with --set=<kind>=<n> to record today's real number.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Record<string, number>;
  for (const kind of Object.keys(KINDS)) {
    if (typeof parsed[kind] !== 'number') {
      throw new Error(`debt budget has no entry for "${kind}" - record it with --set=${kind}=<n>`);
    }
  }
  return parsed;
};

const applySets = (budgets: Record<string, number>): void => {
  let changed = false;
  for (const arg of SET_ARGS) {
    const [rawKind, rawValue] = arg.slice('--set='.length).split('=');
    if (!(rawKind in KINDS)) {
      throw new Error(`unknown debt kind "${rawKind}". Known: ${Object.keys(KINDS).join(', ')}`);
    }
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`--set=${rawKind}=${rawValue} must be a non-negative integer`);
    }
    if (budgets[rawKind] !== value) {
      budgets[rawKind] = value;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(budgets, null, 2)}\n`, 'utf8');
  }
};

const main = (): void => {
  const budgets = loadBudgets();
  applySets(budgets);

  const program = buildProgram();
  const measured: Record<string, number> = {};
  const offenders: Record<string, string[]> = {};
  for (const [kind, count] of Object.entries(KINDS)) {
    WHERE = [];
    measured[kind] = count(program);
    if (WHERE.length) offenders[kind] = WHERE;
  }

  // `--where` exists because a ratchet you cannot locate is a ratchet you
  // cannot act on. Printing the number alone means re-deriving the measurement
  // by hand every time one moves.
  if (process.argv.includes('--where')) {
    for (const [kind, where] of Object.entries(offenders)) {
      console.log(`\n${kind}:`);
      for (const w of where) console.log(`  ${w}`);
    }
    return;
  }

  const w = Math.max(...Object.keys(KINDS).map((k) => k.length));
  console.log(`${'kind'.padEnd(w)}  measured  budget  change`);
  const regressions: string[] = [];
  for (const kind of Object.keys(KINDS)) {
    const now = measured[kind];
    const max = budgets[kind];
    const delta = now - max;
    const verdict = delta > 0 ? `+${delta} WORSE` : delta === 0 ? 'at budget' : `${delta} better`;
    console.log(`${kind.padEnd(w)}  ${String(now).padStart(8)}  ${String(max).padStart(6)}  ${verdict}`);
    if (delta > 0) regressions.push(`${kind}: ${now} > ${max}`);
  }

  if (regressions.length && !REPORT_ONLY) {
    console.error('\nDEBT RATCHET FAILED');
    for (const r of regressions) console.error(`  ${r}`);
    console.error('\nDo not raise a budget to make this pass unless the debt is a false positive.');
    process.exit(1);
  }
};

main();

/** Unused import guard: keeps `execFileSync` from being flagged if sets are added. */
void execFileSync;
