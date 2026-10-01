import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repository root and the two directories the path-walking tests need.
 *
 * Six invariant tests read the source tree from disk: customIdParity and
 * componentsV2Guard enumerate `src/bot/interactions`, architectureInvariants
 * and commandRegistryInvariants scan all of `src`, helpAccuracy reads the
 * command trees, countDebtSilentFailure executes `scripts/count-debt.ts`, and
 * startupService walks its own service directory.
 *
 * Each of those used to spell the location as `path.resolve(__dirname, '..',
 * '..', '..')` - a fixed number of hops that is correct for exactly one
 * directory depth and silently wrong at every other, including after any move.
 * `countDebtSilentFailure` is the dangerous one: it feeds that path to a child
 * process, so a wrong root made the ratchet scan nothing and report a clean
 * bill of health rather than failing.
 *
 * So the root is found by walking up to `package.json` instead of by counting
 * hops, which makes every one of these immune to the next reorganisation.
 * Bounded to 12 levels so a misconfigured checkout fails loudly rather than
 * walking off the filesystem.
 */
export const REPO_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repoRoot: no package.json found above ${__dirname}`);
})();

/** Product source. */
export const SRC_ROOT = join(REPO_ROOT, 'src');

/** Tooling that tests execute as child processes or read budgets from. */
export const SCRIPTS_ROOT = join(REPO_ROOT, 'scripts');

/** Ratchet budgets, so a test never has to hardcode `scripts/`. */
export const DEBT_BUDGET_FILE = join(SCRIPTS_ROOT, 'debt-budget.json');

/** tsx's CLI entrypoint, resolved rather than assumed. */
export const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');