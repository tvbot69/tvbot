/**
 * CLI wrapper around the log-invariant monitor.
 *
 *   npx tsx scripts/check-log-invariants.ts <logfile> [...]
 *   railway logs 2>&1 | npx tsx scripts/check-log-invariants.ts -
 *
 * Exits non-zero when a high-severity invariant is violated, so it can be
 * dropped into a shell alias or a post-deploy check.
 */
import { readFileSync } from 'fs';
import { analyseLog, formatFindings, hasHighSeverity } from '../src/bot/diagnostics/logInvariants';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    'usage: npx tsx scripts/check-log-invariants.ts <logfile|->\n' +
      '  -    read stdin, e.g. `railway logs | npx tsx scripts/check-log-invariants.ts -`',
  );
  process.exit(2);
}

let worst = false;

for (const target of args) {
  let text: string;
  try {
    text = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');
  } catch (err) {
    console.error(`cannot read ${target}: ${(err as Error).message}`);
    process.exit(2);
  }

  const findings = analyseLog(text);
  console.log(`\n=== ${target === '-' ? '<stdin>' : target} ===`);
  console.log(formatFindings(findings));
  if (hasHighSeverity(findings)) worst = true;
}

process.exit(worst ? 1 : 0);
