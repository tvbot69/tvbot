import { describe, it, expect } from 'vitest';
import { analyseLog, formatFindings, hasHighSeverity } from '@bot/diagnostics/logInvariants';

/**
 * The log lines below are the REAL shapes captured during the 2026-09-27
 * incidents, not invented fixtures. Each test pairs a log that should be
 * flagged with the near-miss that must NOT be, because the whole value of this
 * monitor is telling a real fault apart from normal degradation.
 *
 * Several of these patterns are deliberately benign: a single refused rewind
 * during a seek's catch-up window is expected by design, and a monitor that
 * cries wolf on it would be switched off within a day.
 */

const staleRead = (from: number, to = 0, pos = 15_206) =>
  `07:12:03 DEBUG [Music] Stale position read - refused chapter rewind { guildId: '1', from: ${from}, to: ${to}, positionMs: ${pos}, committedAt: 3000000 }`;

const jumpHeld = (from: number, to: number) =>
  `07:12:03 INFO [Music] Implausible chapter jump - holding current chapter to confirm { guildId: '1', from: ${from}, to: ${to} }`;

const jumpConfirmed = (from: number, to: number) =>
  `07:12:20 INFO [Music] Chapter jump confirmed after settle - committing { guildId: '1', from: ${from}, to: ${to} }`;

const jumpFromSeek = (from: number, to: number) =>
  `07:12:03 INFO [Music] Multi-chapter jump matches a user seek - committing immediately { guildId: '1', from: ${from}, to: ${to} }`;

const chapterArtFail = (idx: number) =>
  `07:12:03 DEBUG [Music] Chapter art { guildId: '1', idx: ${idx}, ok: false, artMs: 8000 }`;

const trackStuck = (title = 'Some Song') =>
  `07:20:00 WARN [Music] Track stuck (300000ms) - looking for an alternate upload for "${title}"...`;

const fallbackRung = (rung: string, ok = false) =>
  `07:20:05 INFO [Music] fallback rung { guildId: '1', node: 'n1', rung: '${rung}', ok: ${ok}, track: 'Some Song' }`;

describe('log-invariant monitor', () => {
  it('flags a held chapter jump that is never settled', () => {
    const log = [jumpHeld(8, 14), jumpHeld(8, 14), jumpHeld(8, 14)].join('\n');
    const f = analyseLog(log);
    expect(f.map((x) => x.rule)).toContain('INV-1 chapter jump never settled');
    expect(hasHighSeverity(f)).toBe(true);
  });

  it('does NOT flag a held jump that is later confirmed', () => {
    const log = [jumpHeld(8, 14), jumpConfirmed(8, 14)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain('INV-1 chapter jump never settled');
  });

  it('does NOT flag a held jump resolved by a user seek', () => {
    const log = [jumpHeld(8, 14), jumpFromSeek(8, 14)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain('INV-1 chapter jump never settled');
  });

  it('flags a burst of refused rewinds as a persistently stale reader', () => {
    // The exact shape from the incident: 14 identical lines climbing.
    const log = Array.from({ length: 14 }, (_, i) => staleRead(15, 0, 15_206 + i * 231)).join('\n');
    const f = analyseLog(log);
    expect(f.map((x) => x.rule)).toContain('INV-2 position reader persistently stale');
  });

  it('does NOT flag a single refused rewind (the post-seek catch-up window)', () => {
    const log = [staleRead(15, 0), jumpFromSeek(0, 15)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain(
      'INV-2 position reader persistently stale',
    );
  });

  it('flags a chapter committed BACKWARDS as the rewind bug returning', () => {
    const log = [jumpConfirmed(15, 0)].join('\n');
    const f = analyseLog(log);
    expect(f.map((x) => x.rule)).toContain('INV-3 chapter committed backwards without a seek');
  });

  it('does NOT flag a forward confirmation', () => {
    const log = [jumpConfirmed(8, 14)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain(
      'INV-3 chapter committed backwards without a seek',
    );
  });

  it('flags one chapter whose artwork never resolves', () => {
    const log = Array.from({ length: 5 }, () => chapterArtFail(18)).join('\n');
    const f = analyseLog(log);
    const hit = f.find((x) => x.rule === 'INV-4 chapter artwork never resolves');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('Chapter 18');
  });

  it('does NOT flag artwork spread across different chapters', () => {
    const log = [chapterArtFail(1), chapterArtFail(2), chapterArtFail(3)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain('INV-4 chapter artwork never resolves');
  });

  it('flags a stuck track with no fallback activity as the dead-air class', () => {
    const log = [trackStuck(), '07:20:30 DEBUG something unrelated'].join('\n');
    const f = analyseLog(log);
    expect(f.map((x) => x.rule)).toContain('INV-5 stuck track produced no fallback activity');
  });

  it('does NOT flag a stuck track that walked the ladder', () => {
    const log = [trackStuck(), fallbackRung('plugin'), fallbackRung('soundcloud', true)].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain(
      'INV-5 stuck track produced no fallback activity',
    );
  });

  it('does NOT flag a stuck track that explicitly reported no alternate', () => {
    const log = [trackStuck(), `07:20:05 WARN [Music] Track stuck (300000ms) - no alternate upload, leaving Moonlink recovery to handle it.`].join('\n');
    expect(analyseLog(log).map((x) => x.rule)).not.toContain(
      'INV-5 stuck track produced no fallback activity',
    );
  });

  it('flags sustained card-edit failure with the same code', () => {
    const log = Array.from(
      { length: 6 },
      () => `07:30:00 WARN [Music] Card edit failed { guildId: '1', code: 50035, status: 429 }`,
    ).join('\n');
    const f = analyseLog(log);
    expect(f.map((x) => x.rule)).toContain('INV-6 card edit failing repeatedly');
  });

  it('strips ANSI colour codes, as captured from a real terminal', () => {
    const coloured = `\x1b[33m${trackStuck()}\x1b[39m`;
    const f = analyseLog(coloured);
    expect(f.map((x) => x.rule)).toContain('INV-5 stuck track produced no fallback activity');
  });

  it('reports a clean log as clean and formats readably', () => {
    const clean = [jumpHeld(8, 14), jumpConfirmed(8, 14), chapterArtFail(18), fallbackRung('plugin')].join('\n');
    const f = analyseLog(clean);
    expect(f.filter((x) => x.severity === 'high')).toHaveLength(0);
    expect(formatFindings(f)).toBeTruthy();
  });
});
