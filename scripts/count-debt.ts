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
/** `note` is appended after the location so `--where` prints a shape with it. */
const record = (file: string, line: number, note?: string): void => {
  WHERE.push(`${file}:${line}${note ? `  [${note}]` : ''}`);
};

type KindFn = (program: ts.Program) => number;

/**
 * Shared test-support tree: `setupEnv.ts`, the db harness and the player
 * doubles are not named `*.test.ts`, so `isProduction` counts them as product
 * code. Two of the kinds below skip them explicitly, because a test helper
 * swallowing an error so a test can assert the degraded path is legitimate.
 *
 * This was spelled `/src/tests/` before the tree cleanup moved the tree to
 * `src/testSupport/`, and a stale path here is invisible: the exclusion simply
 * stops matching, the count climbs, and the ratchet reports a regression that
 * nobody made.
 */
const isTestSupport = (absPath: string): boolean => absPath.includes('/src/testSupport/');

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
      const rel = (sf.fileName.split('/src/')[1] ?? sf.fileName).replace(/\\/g, '/');
      sf.forEachChild((node) => {
        n += countAnyNodes(node, (line) => record(rel, line), sf);
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
          const rel = (p.split('/src/')[1] ?? p).replace(/\\/g, '/');
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          record(rel, line + 1);
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
            if (/^(unknown|any)$/.test(t)) {
              n += 1;
              const rel = (sf.fileName.split('/src/')[1] ?? sf.fileName).replace(/\\/g, '/');
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              record(rel, line + 1);
            }
          }
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
    return n;
  },

  /**
   * `process.env` read outside `src/config`, in production code.
   *
   * Config discipline is not achievable by editing the files that exist today -
   * it needs a rule, or the next contributor adds a tenth inline read and the
   * count climbs back. `envValidator.ts` is the deliberate exception: it is the
   * thing that validates env, so reading it is its job.
   */
  'process-env-outside-config': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      if (p.includes('/src/config/')) continue;
      if (isTestSupport(p)) continue;
      if (p.endsWith('/bot/configurations/envValidator.ts')) continue;
      const rel = (p.split('/src/')[1] ?? p);
      const visit = (node: ts.Node): void => {
        // Match the `process.env` node itself, not the property read hanging
        // off it. Testing the outer node for name === 'env' never matched
        // `process.env.REDIS_URL`, whose own name is 'REDIS_URL' - which made
        // this rule measure 0 and pass while reading nothing at all. A ratchet
        // whose detector is broken is worse than no ratchet: it reports safety
        // it has not checked.
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'env' &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'process'
        ) {
          n += 1;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          record(rel, line + 1);
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
    return n;
  },

  /**
   * Files under `src/bot` that import `@prisma/client` directly.
   *
   * Counting FILES, not call sites: 135 `prisma.` calls exist, but the debt the
   * plan describes is architectural - `bot/` reaching past the repository layer
   * - and that is a property of a file, not of a line. A file that imports the
   * client is a file that knows the schema.
   *
   * The plan explicitly says do NOT mass-move these. So this is a ratchet at
   * today's real number: it makes the debt visible, keeps it attributable, and
   * fails if it grows. "New code must not add direct Prisma calls in bot/"
   * only means something if something counts.
   */
  'prisma-client-import-in-bot': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      if (!p.includes('/src/bot/')) continue;
      if (p.includes('/src/bot/services/music/')) continue;
      const importsClient = sf.statements.some((st) => {
        if (!ts.isImportDeclaration(st)) return false;
        const mod = st.moduleSpecifier;
        return ts.isStringLiteral(mod) && mod.text === '@prisma/client';
      });
      if (!importsClient) continue;
      n += 1;
      record(p.split('/src/')[1] ?? p, 0);
    }
    return n;
  },

  /**
   * Raw SQL queries with no `*.db.test.ts` that executes them.
   *
   * This is the most valuable ratchet in the file, and it exists because the
   * original audit got this wrong. DoD 2.3 claimed "28 of 28 raw queries
   * covered" because the audit matched `$queryRawUnsafe` only. There are 77 raw
   * queries; the missing 49 were `$queryRaw` tagged templates. That
   * under-count is what let 7 production bugs survive, including four found by
   * the first-ever execution of the suite that did exist.
   *
   * BASELINE IS PER FILE, NOT PER COVERAGE. My first attempt skipped any file
   * that already had a `*.db.test.ts`, and the mutation check killed it: adding
   * a brand-new untested query to an already-covered file still reported 0. That
   * is precisely the way coverage regresses - a covered file grows a new query -
   * so the check was decoration. It now compares each file's query count against
   * a recorded allowance in `scripts/raw-query-baseline.json` and reports the
   * OVERFLOW, which is zero only when no covered file has grown.
   *
   * Files with no test at all contribute their full count, so deleting a
   * `*.db.test.ts` is caught too.
   *
   * PER-QUERY ON TOP OF PER-FILE. Count-vs-allowance alone still misses the
   * shape mutation: a file at exact allowance can swap one query for a
   * different untested shape, or grow under slack, and the count does not move.
   * So each site also carries a hash (normalised SQL, FNV-1a, same function as
   * `hashNormalizedSql` in src/testSupport/dbRawQueryObserver.ts) and an owning
   * method, and the matching `*.db.test.ts` must prove each one:
   *
   * - every query-owning method must be named in its db test, except the four
   *   legacy gaps in KNOWN_UNPROVEN below (mocked elsewhere, never parsed by a
   *   real Postgres - the list may only shrink);
   * - where the db test goes through the observer (`recordRawQueries`), every
   *   production hash must appear among the test's SQL literals, so a rewritten
   *   predicate fails even at the same count. Files not on the observer yet
   *   prove execution by calling each method against a real database; migrating
   *   them to hash assertions is the direction, not a second mechanism.
   *
   * A new untested query in an at-allowance file fails at least one layer: a
   * new site in a covered method fails the count, a new method fails the method
   * check, and a swapped shape in an observer file fails the hash check.
   */
  'raw-query-without-db-test': (program) => {
    // `fs` and `path` are already imported at the top of this file - a local
    // `require()` to reach them was two lint errors for no reason.
    const fsmod = fs;
    const pathmod = path;

    const RAW_NAMES = new Set(['$queryRawUnsafe', '$queryRaw', '$executeRaw', '$executeRawUnsafe']);

    // Duplicated from src/testSupport/dbRawQueryObserver.ts on purpose:
    // importing `src/` from `scripts/` would drag a file outside `rootDir`
    // into `tsc` and break `npm run build`. The two copies must stay
    // identical or production and test will disagree about a shape.
    const normaliseForHash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
    const hashForRatchet = (sql: string): string => {
      const s = normaliseForHash(sql);
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };

    // Legacy gaps: query-owning methods with no real-database execution proof.
    // Each is covered by a mocked unit test instead, so its SQL has never been
    // parsed by Postgres. Grandfathered visibly so the list can only shrink;
    // a new method missing from its db test is debt, not legacy.
    const KNOWN_UNPROVEN: Record<string, string[]> = {
      'bot/services/library/artistsService.ts': ['getIndexedAlbumCoversForArtist', 'getRecentTopArtists'],
      'bot/services/library/playHistoryService.ts': ['getGuildPlayLeaderboard', 'getGuildTimeLeaderboard'],
    };

    const OBSERVER_MARKERS = [
      'dbRawQueryObserver',
      'recordRawQueries',
      'hashNormalizedSql',
      'queryHashes',
      'assertExpectedQueries',
    ];

    const findDbTestPath = (stem: string): string | null => {
      const want = `${stem.replace(/\.ts$/, '')}.db.test.ts`;
      let found: string | null = null;
      const walk = (dir: string): void => {
        if (found) return;
        for (const e of fsmod.readdirSync(dir, { withFileTypes: true })) {
          if (found) return;
          const full = pathmod.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name === want) found = full;
        }
      };
      walk('src');
      return found;
    };

    // `hasDbTest` is subsumed by `findDbTestPath` (which returns the path
    // instead of a boolean); the orphan-key check below is the part that must
    // stay a hard error.

    interface ProdQuery {
      hash: string;
      method: string;
      line: number;
      preview: string;
      dynamic: boolean;
    }

    const templateToSql = (template: ts.TemplateLiteral | ts.NoSubstitutionTemplateLiteral): string | null => {
      if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
      // Tagged/call template: static head plus one `?` per interpolation,
      // which is exactly what Prisma builds and what the observer records.
      return template.head.text + template.templateSpans.map((s) => `?${s.literal.text}`).join('');
    };

    const callArgToSql = (arg: ts.Expression | undefined): string | null => {
      if (!arg) return null;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
      if (ts.isTemplateExpression(arg)) {
        return arg.head.text + arg.templateSpans.map((s) => `?${s.literal.text}`).join('');
      }
      // Interpolated `$queryRawUnsafe('...' + x)` and other computed shapes
      // cannot be fingerprinted statically; the count and method checks still
      // apply, and the hash check skips the file rather than guessing.
      if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) return null;
      return null;
    };

    const extractProductionQueries = (sf: ts.SourceFile): ProdQuery[] => {
      const out: ProdQuery[] = [];
      const visit = (node: ts.Node, currentMethod: string): void => {
        let next = currentMethod;
        if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) next = node.name.text;
        else if (ts.isFunctionDeclaration(node) && node.name) next = node.name.text;
        let sql: string | null = null;
        let isRaw = false;
        if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag)) {
          if (RAW_NAMES.has(node.tag.name.text)) {
            isRaw = true;
            sql = templateToSql(node.template);
          }
        } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (RAW_NAMES.has(node.expression.name.text)) {
            isRaw = true;
            sql = callArgToSql(node.arguments[0]);
          }
        }
        if (isRaw) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          if (sql === null) {
            out.push({ hash: `dynamic:${line + 1}`, method: next, line: line + 1, preview: '<dynamic sql>', dynamic: true });
          } else {
            const norm = normaliseForHash(sql);
            out.push({
              hash: hashForRatchet(norm),
              method: next,
              line: line + 1,
              preview: norm.slice(0, 60),
              dynamic: false,
            });
          }
        }
        node.forEachChild((child) => visit(child, next));
      };
      visit(sf, '<top>');
      return out;
    };

    const evalConstString = (node: ts.Node): string | null => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isParenthesizedExpression(node)) return evalConstString(node.expression);
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return evalConstString(node.expression);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = evalConstString(node.left);
        const right = evalConstString(node.right);
        return left === null || right === null ? null : left + right;
      }
      return null;
    };

    const extractTestSqlHashes = (testSf: ts.SourceFile): Set<string> => {
      const hashes = new Set<string>();
      const visit = (node: ts.Node): void => {
        const value = evalConstString(node);
        if (value !== null && /\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(value)) {
          hashes.add(hashForRatchet(normaliseForHash(value)));
        }
        node.forEachChild(visit);
      };
      visit(testSf);
      return hashes;
    };

    let baseline: Record<string, number> = {};
    try {
      baseline = JSON.parse(fsmod.readFileSync('scripts/raw-query-baseline.json', 'utf8'));
    } catch {
      throw new Error(
        'cannot read scripts/raw-query-baseline.json - it records the per-file query allowance',
      );
    }

    // A baseline key that names no file is not neutral, and this check exists
    // because a bulk tree move produced one without anyone noticing until CI.
    //
    // `baseline[rel] ?? 0` means renaming a file silently drops its allowance to
    // zero, and the ratchet then reports the file as new raw-query debt - which
    // reads like someone wrote a `$queryRawUnsafe` when in fact nothing about the
    // query changed. The count is right; the diagnosis is wrong, and the obvious
    // "fix" is to edit the ratchet instead of the key.
    //
    // So every key is resolved against the tree, and an orphan is named out loud.
    const orphans = Object.keys(baseline)
      .filter((key) => !fsmod.existsSync(pathmod.join('src', key)))
      .sort();
    if (orphans.length) {
      throw new Error(
        `scripts/raw-query-baseline.json has ${orphans.length} key(s) naming no file, so their ` +
          `allowance is silently lost and each is reported as new debt:\n  ${orphans.join('\n  ')}\n` +
          `Rename the key to the file's current path, or delete it if the file is gone.`,
      );
    }

    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      if (p.includes('/dbHarness')) continue;
      const rel = p.split('/src/')[1] ?? p;
      const queries = extractProductionQueries(sf);
      const count = queries.length;
      if (count === 0) continue;
      const testPath = findDbTestPath(pathmod.basename(p));
      const allowed = testPath !== null ? (baseline[rel] ?? 0) : 0;
      const over = count - allowed;
      if (over > 0) {
        n += over;
        record(`${rel} (${count} queries, allowance ${allowed})`, 0);
        continue;
      }
      // At or under allowance: prove each query shape, not just the total.
      // A new untested query in an at-allowance file must fail here even
      // though the count did not grow past the budget.
      if (testPath === null) continue;
      let testText = '';
      try {
        testText = fsmod.readFileSync(testPath, 'utf8');
      } catch {
        continue;
      }
      const grandfathered = new Set(KNOWN_UNPROVEN[rel] ?? []);
      const methods = [...new Set(queries.map((q) => q.method))].filter(
        (m) => m !== '<top>' && !grandfathered.has(m),
      );
      for (const method of methods) {
        if (!testText.includes(method)) {
          n += 1;
          record(`${rel} (query in ${method} has no db-test execution proof)`, 0);
        }
      }
      // Shape proof where the test states the SQL: every production hash must
      // appear among the test's SQL literals. Dynamic shapes skip this layer
      // rather than guessing; the count and method checks still apply.
      if (queries.some((q) => q.dynamic)) continue;
      if (!OBSERVER_MARKERS.some((marker) => testText.includes(marker))) continue;
      let testSf: ts.SourceFile;
      try {
        testSf = ts.createSourceFile(testPath, testText, ts.ScriptTarget.ES2022, true);
      } catch {
        continue;
      }
      const proven = extractTestSqlHashes(testSf);
      for (const q of queries) {
        if (!proven.has(q.hash)) {
          n += 1;
          record(`${rel}:${q.line} (query hash ${q.hash} in ${q.method} not proven by db test; ${q.preview})`, 0);
        }
      }
    }
    return n;
  },

  /**
   * SILENT FAILURES: a catch that swallows the error and fabricates a
   * plausible answer, with no `Logger.*` anywhere in its body.
   *
   * This is the bug class that hid two production defects. The 114-test real
   * Postgres suite found `getAverageTrackAudioFeaturesForTopTracks` selecting
   * five columns that no migration creates behind `.catch(() => [])` - it had
   * returned all-zeros, silently, for the life of the feature - and
   * `albumService.getUserAllTimeTopAlbumsByReleasePrefix` throwing on 100% of
   * calls while its catch returned the UNFILTERED list. Both rendered total
   * failure as success, and a green test suite approved of both.
   *
   * Three clauses, all required:
   *   1. the caught value is unused, or the catch is bare;
   *   2. the handler's effect is a default-ish value - `[]`, `{}`, `0`,
   *      `null`, `undefined`, `false`, `''`, an empty `Set`/`Map`, an
   *      assignment of one of those, or falling through to the next rung;
   *   3. there is no `Logger.*` call anywhere in the handler body.
   *
   * Clause 3 is what makes this count the *silent* ones. A catch that logs at
   * any level is doing what AGENTS.md golden rule 10 asks for, so it is not
   * this debt. That is the whole reason the class-C majority stays affordable.
   *
   * NOT a file-level check. Nothing here asks whether the file has a test or is
   * already on a list, because a new instance in an existing file is the way
   * this debt actually grows - see the identical trap that killed the first
   * version of `raw-query-without-db-test` above. Every instance is counted and
   * every instance is located, so `--where` gives the per-file attribution
   * without a second baseline file to keep in sync.
   *
   * Both AST shapes are handled. A `catch { }` clause is a `CatchClause`; a
   * `repo.find(x).catch(() => [])` is a `CallExpression` whose callee is a
   * `PropertyAccessExpression` named `catch`. Checking only one of them is the
   * mistake that made the first raw-query detector report zero for a file
   * holding five queries, and a ratchet that reports zero is worse than none.
   */
  'silent-failure-default': (program) => {
    let n = 0;
    for (const sf of program.getSourceFiles()) {
      if (!isProduction(sf)) continue;
      const p = path.resolve(sf.fileName).replace(/\\/g, '/');
      // `isProduction` drops `*.test.ts` and `*.spec.ts` and anything outside
      // `/src/`, which covers `scripts/`. It does NOT drop the shared test tree
      // `src/testSupport/**` - `setupEnv.ts` and the player doubles are not named
      // `*.test.ts` - and a test helper swallowing an error so a test can
      // assert the degraded path is legitimate. Scoped here rather than in
      // `isProduction` so the other seven kinds keep their exact numbers.
      if (isTestSupport(p)) continue;
      const rel = p.split('/src/')[1] ?? p;

      const hit = (node: ts.Node, shape: string): void => {
        n += 1;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        record(rel, line + 1, shape);
      };

      const visit = (node: ts.Node): void => {
        if (ts.isCatchClause(node)) {
          const shape = judgeHandler(node.block, node.variableDeclaration ? [node.variableDeclaration.name] : [], sf);
          if (shape) hit(node, shape);
        } else if (ts.isCallExpression(node) && isCatchCallee(node.expression)) {
          const arg = node.arguments[0];
          if (arg && ts.isFunctionLike(arg)) {
            const shape = judgeHandler(arg.body, arg.parameters.map((prm) => prm.name), sf);
            if (shape) hit(node, shape);
          }
        }
        node.forEachChild(visit);
      };
      visit(sf);
    }
    return n;
  },
};

/** `.catch(...)`: a method call literally named `catch`. */
/**
 * Is this the CALLEE of a `.catch(...)` call?
 *
 * The parameter is the callee, not the call: `isCatchCall(node.expression)`.
 * Passing the CallExpression itself is a mistake that makes this return false
 * for every site in the tree, which is not a crash and not a low number - it
 * is a detector that quietly measures half the population. The mutation check
 * is what found it; nothing else would have.
 */
const isCatchCallee = (e: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(e) && e.name.text === 'catch';

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * True when a `Logger.*` call appears anywhere under `root`.
 * `/logger$/i` matches the exported `Logger` and any `fooLogger` alias. A
 * receipt of the house style: `Logger.debug` is what an expected degradation
 * is *supposed* to look like, so a handler that logs is not silent.
 */
const hasLoggerCall = (root: ts.Node): boolean => {
  let found = false;
  const walk = (x: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const recv = x.expression.expression;
      if (
        ts.isIdentifier(recv) &&
        /logger$/i.test(recv.text) &&
        LOG_METHODS.has(x.expression.name.text)
      ) {
        found = true;
        return;
      }
    }
    x.forEachChild(walk);
  };
  walk(root);
  return found;
};

/** Does `name` appear as an identifier anywhere under `root`? */
const identifierAppears = (name: string, root: ts.Node): boolean => {
  let found = false;
  const walk = (x: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(x) && x.text === name) {
      found = true;
      return;
    }
    x.forEachChild(walk);
  };
  walk(root);
  return found;
};

/** Strip wrappers that do not change the value being produced. */
const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else return cur;
  }
};

/**
 * Is this expression one of the default-ish values a silent failure returns?
 * `undefined` (a bare `return;`, or a missing expression) counts, because
 * `undefined` on a `string[]`-returning method is what a caller renders as
 * "this artist has no countries" - the exact class-B lie.
 */
const isDefaultish = (e: ts.Expression | undefined): boolean => {
  if (!e) return true;
  const x = unwrap(e);
  if (x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(x) && x.text === 'undefined') return true;
  if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.VoidKeyword) return true;
  if (ts.isNumericLiteral(x)) return Number(x.text) === 0;
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text === '';
  if (ts.isArrayLiteralExpression(x)) return x.elements.length === 0;
  if (ts.isObjectLiteralExpression(x)) return x.properties.length === 0;
  // An empty collection, NOT a populated one: `new Set(a)` and `new Set()` are
  // opposite findings and the type argument is noise (`new Set<string>()`).
  if (
    ts.isNewExpression(x) &&
    ts.isIdentifier(x.expression) &&
    (x.expression.text === 'Set' || x.expression.text === 'Map')
  ) {
    return (x.arguments?.length ?? 0) === 0;
  }
  // `x ?? []` / `x || []`: the default is produced on the failure path, which
  // is the shape being counted. The real value still wins when there is one.
  if (
    ts.isBinaryExpression(x) &&
    (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      x.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    x.right
  ) {
    return isDefaultish(x.right);
  }
  return false;
};

const oneLine = (e: ts.Expression, sf: ts.SourceFile): string => e.getText(sf).replace(/\s+/g, ' ').slice(0, 40);

/**
 * Apply the three clauses to one handler and return a shape label, or null.
 *
 * The label goes into `--where` so the number is triageable without opening
 * the file - a ratchet you cannot locate is a ratchet you cannot act on.
 */
const judgeHandler = (
  body: ts.Block | ts.ConciseBody,
  paramNames: readonly ts.BindingName[],
  sf: ts.SourceFile,
): string | null => {
  // Clause 1. A bare catch or a parameter never mentioned in the body.
  for (const nm of paramNames) {
    if (!ts.isIdentifier(nm)) return null;
    if (!identifierAppears(nm.text, body)) continue;
    return null;
  }
  // Clause 3. Any Logger receipt anywhere in the handler.
  if (hasLoggerCall(body)) return null;
  // Clause 2. The effect has to be a default.
  if (ts.isBlock(body)) {
    if (body.statements.length === 0) return 'empty body, falls through';
    for (const st of body.statements) {
      if (ts.isEmptyStatement(st)) continue;
      if (ts.isReturnStatement(st)) {
        if (!isDefaultish(st.expression)) return null;
        return st.expression ? `returns ${oneLine(st.expression, sf)}` : 'returns undefined';
      }
      // `catch { countries = []; }` fabricates exactly as much as
      // `return []` does, and the caller cannot tell. Counting only the
      // `return` form would leave the assignment form as a free hole.
      if (
        ts.isExpressionStatement(st) &&
        ts.isBinaryExpression(st.expression) &&
        st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        st.expression.right
      ) {
        if (!isDefaultish(st.expression.right)) return null;
        return `assigns ${oneLine(st.expression.right, sf)}`;
      }
      return null;
    }
    return 'empty body, falls through';
  }
  return isDefaultish(body) ? `returns ${oneLine(body, sf)}` : null;
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

/**
 * Count escape sites in one subtree, reporting each line.
 *
 * The reporter is a parameter rather than a global so the count and the
 * location list are derived from the SAME walk - a separate pass could
 * disagree and `--where` would point at lines the total does not include.
 */
const countAnyNodes = (
  node: ts.Node,
  report?: (line: number) => void,
  sf?: ts.SourceFile,
): number => {
  let n = 0;
  // SyntaxKind.AnyKeyword, not ts.isAnyKeyword - the latter is internal and
  // is not exported by every supported TypeScript version.
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    n += 1;
    if (report && sf) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      report(line + 1);
    }
  }
  node.forEachChild((child) => {
    n += countAnyNodes(child, report, sf);
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
  // A brand-new kind has no entry yet, and the error below tells the user to run
  // --set to record one. That path was unreachable: this check ran first and
  // threw before applySets ever saw the argument, so the documented recovery
  // could not work. Validate only the kinds the user is not about to set.
  const beingSet = new Set(SET_ARGS.map((a) => a.slice('--set='.length).split('=')[0]));
  for (const kind of Object.keys(KINDS)) {
    if (typeof parsed[kind] !== 'number' && !beingSet.has(kind)) {
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

