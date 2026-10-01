import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SRC_ROOT } from '../testSupport/repoRoot';

/**
 * Self-enforcing guards for the test tree layout introduced in 941ed51.
 *
 * Before that commit the tree held a mixture of colocated tests and a separate
 * `src/tests/` folder. That is not a style preference - each half of it caused a
 * real class of bug:
 *
 * 1. A test that lives beside its subject is invisible to every tool that
 *    reasons about a folder's contents: `rg --files src/bot/services | grep
 *    test` and a tree view both under-report, so "did we cover this module?"
 *    gets answered by a guess. And a colocated `foo.test.ts` next to `foo.ts`
 *    makes the two look like a matched pair to anything that groups by
 *    basename, which is exactly how the old layout hid a duplicate-name
 *    collision.
 * 2. `src/tests/` could never be cleaned up. Moving production code left the
 *    test behind in a folder whose location said nothing about what it tested,
 *    so nobody could tell whether a file there was current, or abandoned. Git
 *    does not track empty directories, which means the leftover folders stayed
 *    on disk forever and made "is it gone yet?" unanswerable.
 * 3. Shared harness code mixed in with production modules meant `src/` alone
 *    did not describe the shipped bot. `dbHarness.ts` is test-only; shipping it
 *    in the import graph is how a suite ends up importing a module that opens
 *    a real database connection at import time.
 * 4. A production module parked in `__tests__/` is worse than a test parked in
 *    production: it passes every "does this test file have tests in it?" check
 *    and never runs.
 *
 * So each rule below names the file that breaks it. A layout violation found
 * by CI is a two-second fix; the same violation found by a future contributor
 * six months from now is a mystery.
 *
 * Paths come from `SRC_ROOT`, never `__dirname` with a fixed number of `..`
 * hops: six invariant tests were broken by exactly that, because the hop count
 * is correct at one directory depth and silently wrong everywhere else. This
 * file is itself inside `__tests__/`, so it is the first case where the count
 * would have changed - it uses the shared helper for that reason.
 */

/** What counts as a test file, by name. */
const TEST_FILE = /\.test\.tsx?$/;
/** Alternative suffix some tools default to; the repo does not use it. */
const SPEC_FILE = /\.spec\.tsx?$/;
const ANY_TEST_FILE = /\.(test|spec)\.tsx?$/;

const TEST_SUPPORT_ROOT = join(SRC_ROOT, 'testSupport');
const LEGACY_TESTS_ROOT = join(SRC_ROOT, 'tests');
const TESTS_FOLDER = '__tests__';

/**
 * The shared harness modules. Everything directly under `src/testSupport/` must
 * be one of these, so a new helper has to be added here deliberately rather than
 * appearing as an anonymous extra.
 */
const KNOWN_HARNESS_MODULES = [
  'dbHarness.ts',
  'dbRawQueryObserver.ts',
  'renderPixelAssert.ts',
  'repoRoot.ts',
  'setupEnv.ts',
  'uncooperativePlayer.ts',
];

interface WalkedFile {
  /** Path below `src`, forward-slashed, so assertion messages are portable. */
  srcRelative: string;
  /** Basename, e.g. `artworkService.ts`. */
  name: string;
}

/** Files only, recursively, skipping directories git cannot track. */
const walkFiles = (root: string): WalkedFile[] => {
  if (!existsSync(root)) return [];

  const out: WalkedFile[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        out.push({
          srcRelative: relative(SRC_ROOT, absolute).split(sep).join('/'),
          name: entry.name,
        });
      }
    }
  };

  visit(root);
  return out;
};

const SRC_FILES = walkFiles(SRC_ROOT);
const SRC_TESTS_DIRS = SRC_FILES
  .map((f) => f.srcRelative)
  .filter((p) => p.split('/').includes(TESTS_FOLDER));

const isTestFile = (f: WalkedFile): boolean => ANY_TEST_FILE.test(f.name);

/** `src/bot/services/x.test.ts` -> `src/bot/services/__tests__` */
const parentTestsFolder = (f: WalkedFile): string => {
  const segments = f.srcRelative.split('/');
  segments.pop();
  return segments.join('/');
};

const describePaths = (paths: string[]): string =>
  paths.length === 0 ? 'none' : paths.map((p) => `  - ${p}`).join('\n');

describe('every test file lives in a __tests__ folder', () => {
  it('finds no test file outside __tests__ anywhere under src', () => {
    // A test beside its subject is what the 941ed51 cleanup deleted. It hides
    // itself from folder-level tooling and makes basename grouping lie.
    const stray = SRC_FILES.filter(
      (f) => isTestFile(f) && !f.srcRelative.split('/').includes(TESTS_FOLDER),
    );

    expect(
      stray.map((f) => f.srcRelative),
      `Move each of these into a __tests__ folder next to the code it tests:\n${describePaths(
        stray.map((f) => f.srcRelative),
      )}`,
    ).toEqual([]);
  });

  it('finds no *.spec.ts file at all, because the repo names them *.test.ts', () => {
    // Two suffixes for one thing means a grepless future contributor adds the
    // other one and half the tooling never sees it.
    const specs = SRC_FILES.filter((f) => SPEC_FILE.test(f.name));

    expect(
      specs.map((f) => f.srcRelative),
      `Rename these to *.test.ts:\n${describePaths(specs.map((f) => f.srcRelative))}`,
    ).toEqual([]);
  });

  it('actually looked at a plausible number of files, so the guard cannot pass by scanning nothing', () => {
    // The dangerous shape here is a broken root or an over-narrow filter: the
    // walk returns nothing, every assertion above passes, and the guard guards
    // nothing. A tree with 388 production files cannot have 12.
    expect(
      SRC_FILES.length,
      `Tree walk under ${SRC_ROOT} found only ${SRC_FILES.length} files. If SRC_ROOT is wrong or the walk filters too much, every assertion in this file is vacuous.`,
    ).toBeGreaterThan(300);

    expect(SRC_FILES.filter((f) => TEST_FILE.test(f.name)).length).toBeGreaterThan(
      300,
    );
  });
});

describe('the legacy src/tests tree is gone of files', () => {
  it('src/tests contains no files, empty leftover directories included', () => {
// Deliberately asserted on files, not on the directory. `src/tests/` and
      // its `domain/`, `musicBot/` and `probe/` subfolders survived the move as
      // empty shells for a while, because Git does not track empty directories -
      // so they were present on a contributor's machine and absent from a fresh
      // clone. Asserting on their EXISTENCE would therefore fail CI for a reason
      // that is not a defect, and would train people to ignore this test. Both
      // cases must pass: no files in the tree, and no tree at all.
      const stranded = walkFiles(LEGACY_TESTS_ROOT);

    expect(
      stranded.map((f) => f.srcRelative),
      `The old src/tests tree is supposed to be empty. These files are stranded in it and belong in a __tests__ folder under the module they test:\n${describePaths(
        stranded.map((f) => f.srcRelative),
      )}`,
    ).toEqual([]);
  });

  it('no src/tests subfolder holds anything but empty folders', () => {
    // The walk above catches any file, including one at the top level. This one
    // enumerates the directories themselves and asserts each is empty, so a
    // leftover that only holds nested empty shells is still described by name
    // rather than passing silently.
    //
    // A fully-deleted tree is the best possible state, not a failure: Git leaves
    // the empty shells behind on whoever's machine ran the move, and every other
    // contributor gets a clean clone with nothing here. Reading the directory
    // without checking first threw ENOENT on the clean case, which is the
    // opposite of what a convention test should do.
    const legacyTreeExists = existsSync(LEGACY_TESTS_ROOT);

    expect(
      legacyTreeExists,
      'src/tests still exists. Move any files it holds into a __tests__ folder beside the module they test, then delete the tree.',
    ).toBe(false);

    if (!legacyTreeExists) return;

    const dirs: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          dirs.push(`${relative(SRC_ROOT, join(dir, entry.name)).split(sep).join('/')}`);
          continue;
        }
        expect(
          readdirSync(join(dir, entry.name), { withFileTypes: true }).filter(
            (e) => e.isFile(),
          ).length,
          `${relative(SRC_ROOT, join(dir, entry.name))} still holds files. Move them into a __tests__ folder beside the module they test, then delete the src/tests tree.`,
        ).toBe(0);
        visit(join(dir, entry.name));
      }
    };

    visit(LEGACY_TESTS_ROOT);

    expect(dirs, 'src/tests still holds files. See the messages above.').toEqual([]);
  });
});

describe('src/testSupport holds only harness modules', () => {
  it('every file directly under src/testSupport is a known harness module', () => {
    const known = new Set(KNOWN_HARNESS_MODULES);
    const loose: string[] = [];

    for (const entry of readdirSync(TEST_SUPPORT_ROOT, { withFileTypes: true })) {
      if (entry.isFile() && !known.has(entry.name)) loose.push(entry.name);
    }

    expect(
      loose,
      `These files sit directly under src/testSupport but are not in KNOWN_HARNESS_MODULES in ${SRC_ROOT.replace(
        /\\/g,
        '/',
      )}/__tests__/treeConventions.test.ts. Either move the file out, or add it to the list if it really is shared harness code:\n${describePaths(
        loose,
      )}`,
    ).toEqual([]);
  });

  it('src/testSupport itself contains no test file', () => {
    // Harness tests go in src/testSupport/__tests__/. A *.test.ts sitting beside
    // the harness it tests is the exact colocated shape this file exists to ban.
    const loose = readdirSync(TEST_SUPPORT_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ANY_TEST_FILE.test(entry.name))
      .map((entry) => entry.name);

    expect(
      loose,
      `Move these into ${TESTS_FOLDER} inside src/testSupport:\n${describePaths(loose)}`,
    ).toEqual([]);
  });

  it('every known harness module is still present', () => {
    // The list above is a ratchet in both directions: an allowed-name list that
    // only grows lets modules get deleted while their tests keep importing them,
    // and the test above stays green because an absent file is not a loose file.
    const present = new Set(
      readdirSync(TEST_SUPPORT_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
    const missing = KNOWN_HARNESS_MODULES.filter((name) => !present.has(name));

    expect(
      missing,
      `src/testSupport is missing ${missing.join(', ')}. If it was deleted on purpose, remove it from KNOWN_HARNESS_MODULES here and from the repo AGENTS.md.`,
    ).toEqual([]);
  });
});

describe('no production file is named like a test', () => {
  it('finds no *.test.ts outside a __tests__ folder', () => {
    // Restated as a production-side claim: a `foo.test.ts` next to `foo.ts` is
    // production code wearing a test's name, which is how a real module ends up
    // skipped by every suite glob and by the coverage config.
    const offenders = SRC_FILES.filter(
      (f) => TEST_FILE.test(f.name) && !f.srcRelative.split('/').includes(TESTS_FOLDER),
    );

    expect(
      offenders.map((f) => f.srcRelative),
      `These files are named like tests but do not live in a ${TESTS_FOLDER} folder:\n${describePaths(
        offenders.map((f) => f.srcRelative),
      )}`,
    ).toEqual([]);
  });
});

describe('__tests__ folders hold only tests', () => {
  it('no non-test file sits inside a __tests__ folder', () => {
    // A production module parked in __tests__ is the worst of both worlds: every
    // check that a folder contains tests passes, and the module never runs.
    const offenders = SRC_FILES.filter(
      (f) => f.srcRelative.split('/').includes(TESTS_FOLDER) && !isTestFile(f),
    );

    expect(
      offenders.map((f) => f.srcRelative),
      `Move these out of their ${TESTS_FOLDER} folder and back beside the code they belong to:\n${describePaths(
        offenders.map((f) => f.srcRelative),
      )}`,
    ).toEqual([]);
  });

  it('found the test folders it is guarding', () => {
    // A guard over zero folders is not a guard. The repo has one per subsystem
    // folder, so a count in the dozens is the floor, not the ceiling.
    expect(
      SRC_TESTS_DIRS.length,
      `Found only ${SRC_TESTS_DIRS.length} __tests__ folders under ${SRC_ROOT}.`,
    ).toBeGreaterThan(10);
  });
});

describe('test file basenames are unambiguous', () => {
  it('no two test files share a basename inside the same __tests__ folder', () => {
    // On a case-insensitive filesystem two names differing only in case collide
    // on checkout, and the loser silently overwrites the winner. Grouping a
    // folder by basename also has to be able to say which file it means.
    const byFolder = new Map<string, string[]>();

    for (const f of SRC_FILES) {
      if (!isTestFile(f)) continue;
      const folder = parentTestsFolder(f);
      const bucket = byFolder.get(folder);
      if (bucket) bucket.push(f.srcRelative);
      else byFolder.set(folder, [f.srcRelative]);
    }

    const duplicates = [...byFolder.entries()]
      .filter(([, names]) => names.length > 1)
      .flatMap(([folder, names]) => {
        const seen = new Map<string, string[]>();
        for (const path of names) {
          const base = path.split('/').pop() ?? path;
          const bucket = seen.get(base.toLowerCase());
          if (bucket) bucket.push(path);
          else seen.set(base.toLowerCase(), [path]);
        }
        return [...seen.entries()]
          .filter(([, paths]) => paths.length > 1)
          .map(([base, paths]) => `${folder}: ${base} -> ${paths.join(', ')}`);
      });

    expect(
      duplicates,
      `These basenames collide inside one ${TESTS_FOLDER} folder. Rename one in each pair:\n${describePaths(
        duplicates,
      )}`,
    ).toEqual([]);
  });

  it('no __tests__ folder holds a test file whose name also exists one level up', () => {
    // Convention 4. "A test file must never be named identically to a production
    // file it sits beside." Since every test now lives in `__tests__`, "beside"
    // means the folder above it - so the collision to look for is a leftover
    // `X.test.ts` in `src/foo/` paired with the real `src/foo/__tests__/X.test.ts`
    // that a partial move leaves behind. Two files, same name, one directory
    // apart: nobody meant that, and a basename-based tool cannot tell them apart.
    const filesByFolder = new Map<string, Set<string>>();

    for (const f of SRC_FILES) {
      const folder = f.srcRelative.split('/').slice(0, -1).join('/');
      const names = filesByFolder.get(folder);
      if (names) names.add(f.name.toLowerCase());
      else filesByFolder.set(folder, new Set([f.name.toLowerCase()]));
    }

    const offenders = SRC_FILES.filter((f) => {
      if (!isTestFile(f)) return false;
      const segments = f.srcRelative.split('/');
      segments.pop();
      // One level above the __tests__ folder.
      segments.pop();
      return filesByFolder.get(segments.join('/'))?.has(f.name.toLowerCase()) ?? false;
    }).map((f) => f.srcRelative);

    expect(
      offenders,
      `These test files have a namesake one directory above, the shape a half-finished move out of src/tests leaves behind. Delete the stray copy:\n${describePaths(
        offenders,
      )}`,
    ).toEqual([]);
  });
});