import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The `audit` CI gate, with a named allowlist instead of a blanket level.
 *
 * `npm audit --audit-level=high` is a boolean: any new HIGH anywhere fails the
 * build, but it also fails on advisories with no safe fix (a downgrade-only
 * remediation, or a vendor major that Prisma has not shipped). A boolean gate
 * on unfixable findings gets muted the first time it blocks a release — and
 * then it guards nothing.
 *
 * So this gate fails on any high/critical advisory NOT in
 * `scripts/audit-allowlist.json`. Each entry names the GHSA, why it is not
 * exploitable in this repo, and what change retires the entry. Adding an entry
 * is a deliberate, reviewed act; everything else still fails the build.
 */

interface AuditVia {
  url?: string;
  title?: string;
  severity?: string;
}

interface AuditReport {
  vulnerabilities: Record<string, { severity: string; via: Array<string | AuditVia> }>;
}

interface Allowlist {
  [ghsaUrl: string]: { reason: string; revisitWhen: string };
}

const main = (): void => {
  const allowlist = JSON.parse(
    readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf-8'),
  ) as Allowlist;

  let report: AuditReport;
  try {
    const raw = execFileSync('npm', ['audit', '--json'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    report = JSON.parse(raw) as AuditReport;
  } catch (err: unknown) {
    // `npm audit` exits non-zero when vulnerabilities exist, but still prints
    // the JSON report to stdout. Anything else (no JSON) is a real failure.
    const stdout = (err as { stdout?: string })?.stdout;
    if (!stdout) throw err;
    report = JSON.parse(stdout) as AuditReport;
  }

  const unlisted = new Map<string, string>();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string') continue;
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      if (!via.url || allowlist[via.url]) continue;
      unlisted.set(via.url, `${(via.severity ?? 'unknown').toUpperCase()} ${via.title ?? via.url}`);
    }
  }

  if (unlisted.size > 0) {
    console.error(
      `audit gate failed, ${unlisted.size} unlisted high/critical advisorie(s):\n  ${[...unlisted.values()].join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(`audit gate ok (${Object.keys(allowlist).length} allowlisted, 0 unlisted high/critical)`);
};

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-audit.ts')) main();
