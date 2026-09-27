/**
 * Log-invariant monitor.
 *
 * The suite proved useless for the three multi-hour bugs of 2026-09-27, and
 * every one of them was found by READING THE LOG. So the log itself deserves
 * to be an input we can assert on, not something a human squints at.
 *
 * Each rule below encodes a symptom that was actually observed, in the shape
 * AGENTS.md section 9 warns about. The point is to turn "it looked wrong for a
 * while and I could not say why" into a line of output naming the cause.
 *
 * Pure and dependency-free: `analyseLog` takes text and returns findings, so
 * it is testable against captured logs and needs no bot, no network and no
 * database. CLI wrapper: `scripts/check-log-invariants.ts`.
 */

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  rule: string;
  severity: Severity;
  /** What the operator should believe, stated plainly. */
  message: string;
  /** Every line that contributed, so the report is auditable. */
  lineNumbers: number[];
  evidence: string[];
}

interface LogEvent {
  line: number;
  text: string;
  kind:
    | 'staleRead'
    | 'jumpHeld'
    | 'jumpConfirmed'
    | 'jumpFromSeek'
    | 'chapterArt'
    | 'trackStuck'
    | 'fallbackRung'
    | 'stuckNoAlternate'
    | 'cardEditFailed';
  fields: LogFields;
}

/**
 * Parsed `key: value` pairs, kept as NARROW types. The Logger serialises with
 * util.inspect, so every value arrives as a string, but a union here makes
 * every arithmetic use a type error — and `npm test` will happily pass those.
 */
interface LogFields {
  from?: number;
  to?: number;
  idx?: number;
  positionMs?: number;
  committedAt?: number;
  ok?: boolean;
  rung?: string;
  code?: string;
}

// Strip ANSI, then classify. Timestamps and level prefixes vary between local
// output and Railway, so nothing depends on a fixed prefix.
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

// Order matters: the first marker found wins, so the MORE SPECIFIC marker must
// come first. 'no alternate upload' lives inside a line that also contains
// '[Music] Track stuck (' — with the broad marker first, a healthy "we looked
// and there was nothing" line is misread as a fresh stuck report, and the
// monitor then reports dead air on a run that recovered correctly.
const RULES: { kind: LogEvent['kind']; marker: string }[] = [
  { kind: 'staleRead', marker: 'Stale position read' },
  { kind: 'jumpHeld', marker: 'Implausible chapter jump' },
  { kind: 'jumpConfirmed', marker: 'Chapter jump confirmed after settle' },
  { kind: 'jumpFromSeek', marker: 'Multi-chapter jump matches a user seek' },
  { kind: 'chapterArt', marker: '[Music] Chapter art' },
  { kind: 'stuckNoAlternate', marker: 'no alternate upload' },
  { kind: 'trackStuck', marker: '[Music] Track stuck (' },
  { kind: 'fallbackRung', marker: '[Music] fallback rung' },
  { kind: 'cardEditFailed', marker: '[Music] Card edit failed' },
];

/** Pull `key: value` pairs out of the util.inspect object the Logger appends. */
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

const field = (text: string, key: string): string | undefined => {
  const m = new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(text);
  if (m) return m[1];
  const n = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(text);
  if (n) return n[1];
  const b = new RegExp(`\\b${key}:\\s*(true|false)`).exec(text);
  return b ? b[1] : undefined;
};

const parse = (raw: string): LogEvent[] => {
  const out: LogEvent[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const text = line.replace(ANSI, '');
    for (const rule of RULES) {
      if (!text.includes(rule.marker)) continue;
      out.push({
        line: i + 1,
        text: text.trim(),
        kind: rule.kind,
        fields: {
          from: num(field(text, 'from')),
          to: num(field(text, 'to')),
          idx: num(field(text, 'idx')),
          ok: field(text, 'ok') === 'true' ? true : field(text, 'ok') === 'false' ? false : undefined,
          rung: field(text, 'rung'),
          code: field(text, 'code'),
          positionMs: num(field(text, 'positionMs')),
          committedAt: num(field(text, 'committedAt')),
        },
      });
      break;
    }
  });
  return out;
};

const STALE_READ_BURST = 5;
const ART_FAILURE_BURST = 3;
const CARD_EDIT_BURST = 5;

export function analyseLog(raw: string): Finding[] {
  const events = parse(raw);
  const findings: Finding[] = [];

  // ---- Rule 1: a held chapter jump that is never resolved freezes the card.
  // armChapterTimer re-arms from chapters[idx+1], so if the settle re-derive
  // never fires the card sits on the wrong song and the wrong cover for the
  // rest of the set. Observed: "Implausible chapter jump" repeating with no
  // "Chapter jump confirmed after settle" anywhere in the log.
  {
    const held = events.filter((e) => e.kind === 'jumpHeld');
    const resolved = new Set<number>();
    for (const e of events) {
      if (e.kind !== 'jumpConfirmed' && e.kind !== 'jumpFromSeek') continue;
      // A confirmation carries from/to; it resolves the hold for that `from`.
      if (e.fields.from !== undefined) resolved.add(e.fields.from);
    }
    const orphaned = held.filter((e) => e.fields.from === undefined || !resolved.has(e.fields.from));
    if (orphaned.length > 0) {
      findings.push({
        rule: 'INV-1 chapter jump never settled',
        severity: 'high',
        message:
          `${orphaned.length} implausible chapter jump(s) were held to confirm and never committed. ` +
          `The settle re-derive is not firing, so the card is frozen on the previous chapter.`,
        lineNumbers: orphaned.map((e) => e.line),
        evidence: orphaned.map((e) => e.text),
      });
    }
  }

  // ---- Rule 2: a burst of refused rewinds means the position reader is wrong,
  // not briefly stale. One or two are the node's post-seek catch-up window and
  // are expected by design; every tick repeating means a persistent fault.
  {
    const stale = events.filter((e) => e.kind === 'staleRead');
    if (stale.length >= STALE_READ_BURST) {
      const byFrom = new Map<number, LogEvent[]>();
      for (const e of stale) {
        const k = e.fields.from ?? -1;
        byFrom.set(k, [...(byFrom.get(k) ?? []), e]);
      }
      for (const [from, group] of byFrom) {
        if (group.length < STALE_READ_BURST) continue;
        findings.push({
          rule: 'INV-2 position reader persistently stale',
          severity: 'high',
          message:
            `${group.length} consecutive refused chapter rewind(s) from chapter ${from} with no ` +
            `chapter change between them. This is not the post-seek catch-up window; the position ` +
            `reader is persistently returning a stale value.`,
          lineNumbers: group.map((e) => e.line),
          evidence: group.slice(0, 3).map((e) => e.text),
        });
      }
    }
  }

  // ---- Rule 3: a backward commit that was NOT explained by a user seek is the
  // original rewind bug, arriving through the forward-jump path. The guard is
  // supposed to make this unreachable, so seeing it means the guard failed.
  {
    for (const e of events) {
      if (e.kind !== 'jumpConfirmed') continue;
      const { from, to } = e.fields;
      if (from === undefined || to === undefined || to >= from) continue;
      findings.push({
        rule: 'INV-3 chapter committed backwards without a seek',
        severity: 'high',
        message:
          `A chapter jump was CONFIRMED after settle while moving backwards (${from} -> ${to}). ` +
          `A confirmed jump is only ever allowed to move forward. The card will visibly snap back.`,
        lineNumbers: [e.line],
        evidence: [e.text],
      });
    }
  }

  // ---- Rule 4: the same chapter's cover failing repeatedly is a catalogue
  // miss, not a cold cache. A held cover is by design, so the symptom is a
  // chapter that changes title but never changes picture.
  {
    const failed = events.filter((e) => e.kind === 'chapterArt' && e.fields.ok === false);
    const byIdx = new Map<number, LogEvent[]>();
    for (const e of failed) {
      const k = e.fields.idx ?? -1;
      byIdx.set(k, [...(byIdx.get(k) ?? []), e]);
    }
    for (const [idx, group] of byIdx) {
      if (group.length < ART_FAILURE_BURST) continue;
      findings.push({
        rule: 'INV-4 chapter artwork never resolves',
        severity: 'medium',
        message:
          `Chapter ${idx}'s artwork failed to resolve ${group.length} times. The card is holding the ` +
          `previous cover. This is a provider title shape the matcher rejects, not a network problem.`,
        lineNumbers: group.map((e) => e.line),
        evidence: group.slice(0, 3).map((e) => e.text),
      });
    }
  }

  // ---- Rule 5: the scariest class. A stuck track with neither a fallback rung
  // nor an explicit "no alternate" means the ladder went quiet: no error, just
  // silence, and the listener waits.
  {
    const stuck = events.filter((e) => e.kind === 'trackStuck');
    for (const s of stuck) {
      const after = events.filter(
        (e) =>
          e.line > s.line &&
          (e.kind === 'fallbackRung' || e.kind === 'stuckNoAlternate') &&
          e.line - s.line <= 40,
      );
      if (after.length > 0) continue;
      findings.push({
        rule: 'INV-5 stuck track produced no fallback activity',
        severity: 'high',
        message:
          `A track was reported stuck but NO fallback rung and no "no alternate upload" line follows it. ` +
          `The fallback ladder is not firing. Expect dead air with no error.`,
        lineNumbers: [s.line],
        evidence: [s.text],
      });
    }
  }

  // ---- Rule 6: card edit churn. A fixed backoff against a throttled card
  // turns a transient 429 into a sustained failure loop.
  {
    const failed = events.filter((e) => e.kind === 'cardEditFailed');
    const byCode = new Map<string, LogEvent[]>();
    for (const e of failed) {
      const k = e.fields.code ?? 'unknown';
      byCode.set(k, [...(byCode.get(k) ?? []), e]);
    }
    for (const [code, group] of byCode) {
      if (group.length < CARD_EDIT_BURST) continue;
      findings.push({
        rule: 'INV-6 card edit failing repeatedly',
        severity: 'medium',
        message:
          `Card edits failed ${group.length} times with code ${code}. Discord is refusing the edit; ` +
          `the card is frozen on whatever it last rendered.`,
        lineNumbers: group.map((e) => e.line),
        evidence: group.slice(0, 3).map((e) => e.text),
      });
    }
  }

  return findings.sort((a, b) => {
    const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule);
  });
}

/** Human-readable report. `ok` is false when any high-severity rule fired. */
export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'No log-invariant violations found.';
  }
  const out: string[] = [];
  for (const f of findings) {
    out.push(`[${f.severity.toUpperCase()}] ${f.rule}`);
    out.push(`  ${f.message}`);
    out.push(`  lines: ${f.lineNumbers.slice(0, 12).join(', ')}${f.lineNumbers.length > 12 ? ' ...' : ''}`);
    for (const e of f.evidence) out.push(`    > ${e}`);
  }
  return out.join('\n');
}

export const hasHighSeverity = (findings: Finding[]): boolean =>
  findings.some((f) => f.severity === 'high');
