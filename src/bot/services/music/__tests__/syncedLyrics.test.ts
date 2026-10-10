import 'reflect-metadata';
import { EDIT_LATENCY_FLOOR_MS } from '@bot/handlers/music/nowPlayingCardPublisher';
import { describe, it, expect } from 'vitest';
import {
  parseLrc,
  selectSynced,
  lyricWindowAt,
  alignSyncedLines,
  lyricEffectiveAt,
  lyricClockFor,
  measureLyricLead,
  nextLyricBoundary,
  LYRIC_SAFETY_LAG_MS,
  LYRIC_LEAD_MAX_MS,
  MAX_LYRIC_ALIGN_SHIFT_MS,
  isLivePerformance,
  LIVE_DURATION_TOLERANCE_MS,
} from '@bot/services/music/syncedLyrics';

const LRC = [
  '[00:00.15] Is this the real life?',
  '[00:07.13] Caught in a landslide',
  '[02:35.66] ',
  '[03:05.97] I see a little silhouetto',
  'not a lyric line',
  '[04:55.03] Ooh',
].join('\n');

describe('parseLrc', () => {
  it('parses timestamps to ms and drops malformed lines', () => {
    const lines = parseLrc(LRC);
    expect(lines.map((l) => l.ms)).toEqual([150, 7130, 155660, 185970, 295030]);
    expect(lines[0]?.text).toBe('Is this the real life?');
  });

  it('keeps empty-text lines as gap markers', () => {
    const lines = parseLrc(LRC);
    expect(lines[2]).toEqual({ ms: 155660, text: '' });
  });

  it('returns empty for missing input', () => {
    expect(parseLrc(undefined)).toEqual([]);
    expect(parseLrc('')).toEqual([]);
  });
});

describe('selectSynced', () => {
  it('accepts matching duration with synced text', () => {
    const lines = selectSynced(
      { syncedLyrics: '[00:01.00] Hello', instrumental: false, durationMs: 200000 },
      195000,
    );
    expect(lines?.length).toBe(1);
  });

  it('rejects instrumentals and missing sync', () => {
    expect(selectSynced({ syncedLyrics: '[00:01.00] x', instrumental: true }, 1000)).toBeNull();
    expect(selectSynced({ instrumental: false }, 1000)).toBeNull();
    expect(selectSynced(null, 1000)).toBeNull();
  });

  it('rejects wrong-version timings beyond tolerance', () => {
    const candidate = { syncedLyrics: '[00:01.00] Hello', instrumental: false, durationMs: 200000 };
    expect(selectSynced(candidate, 200000)).not.toBeNull();
    expect(selectSynced(candidate, 240000)).toBeNull();
  });

  it('allows unknown durations through', () => {
    expect(selectSynced({ syncedLyrics: '[00:01.00] Hello' }, 99999)).not.toBeNull();
  });

  it('a custom tolerance rejects what the default accepts', () => {
    const candidate = { syncedLyrics: '[00:01.00] Hello', instrumental: false, durationMs: 200000 };
    // 8s apart: inside the 15s default, outside a 5s live gate.
    expect(selectSynced(candidate, 208000)).not.toBeNull();
    expect(selectSynced(candidate, 208000, LIVE_DURATION_TOLERANCE_MS)).toBeNull();
    // 3s apart passes both gates.
    expect(selectSynced(candidate, 203000, LIVE_DURATION_TOLERANCE_MS)).not.toBeNull();
  });
});

describe('isLivePerformance', () => {
  it('flags live-tagged titles and albums', () => {
    expect(isLivePerformance('Off-Season - Audiotree Live Version')).toBe(true);
    expect(isLivePerformance('Song', 'Live at Leeds')).toBe(true);
    expect(isLivePerformance('Unplugged in New York')).toBe(true);
  });

  it('leaves studio titles alone', () => {
    expect(isLivePerformance('Geronimo')).toBe(false);
    expect(isLivePerformance('Alive')).toBe(false);
    // An album literally titled Live IS a live record.
    expect(isLivePerformance('Song', 'Live')).toBe(true);
  });
});

describe('lyricWindowAt', () => {
  const lines = parseLrc(LRC);

  it('shows current plus next line mid-song', () => {
    expect(lyricWindowAt(lines, 8000)).toEqual({
      current: 'Caught in a landslide',
      next: 'I see a little silhouetto',
    });
  });

  it('holds the last pair through instrumental gaps', () => {
    expect(lyricWindowAt(lines, 170000)).toEqual({
      current: 'Caught in a landslide',
      next: 'I see a little silhouetto',
    });
  });

  it('shows the upcoming line before the first timestamp', () => {
    expect(lyricWindowAt(lines, 0)).toEqual({ current: null, next: 'Is this the real life?' });
  });

  it('holds the finale after the last line', () => {
    expect(lyricWindowAt(lines, 999999)).toEqual({ current: 'Ooh', next: null });
  });

  it('shifts the window back by the startup offset', () => {
    // Clock reads 10s but audio only started ~3s ago: still on line one.
    expect(lyricWindowAt(lines, 10000, 3000)).toEqual({
      current: 'Is this the real life?',
      next: 'Caught in a landslide',
    });
    // Without the offset the same clock already shows line two.
    expect(lyricWindowAt(lines, 10000)).toEqual({
      current: 'Caught in a landslide',
      next: 'I see a little silhouetto',
    });
  });

  it('clamps the offset lookup at zero', () => {
    expect(lyricWindowAt(lines, 1000, 5000)).toEqual({ current: null, next: 'Is this the real life?' });
  });

  it('returns null without lines', () => {
    expect(lyricWindowAt([], 5000)).toBeNull();
    expect(lyricWindowAt(null, 5000)).toBeNull();
  });
});

describe('alignSyncedLines (per-track arrangement correction)', () => {
  const base = [
    { ms: 15000, text: 'One' },
    { ms: 25000, text: 'Two' },
  ];

  it('shifts forward by the duration delta so YouTube intros stop showing early', () => {
    // LRC pressing 115s, playing audio 123s: 8s extra intro. Without the
    // shift the 15s line shows 8s before it is heard.
    const { lines, shiftMs } = alignSyncedLines(base, 115000, 123000);
    expect(shiftMs).toBe(8000);
    expect(lines.map((l) => l.ms)).toEqual([23000, 33000]);
    // Without the shift the old clock would already sing at 15s.
    expect(lines[0]?.ms).not.toBe(15000);
  });

  it('never shifts backwards: a shorter playing track leaves the clock untouched', () => {
    // Shifting backwards would show lines BEFORE they are sung — the exact
    // "lyrics early" symptom. Doubt holds the clock instead.
    const { lines, shiftMs } = alignSyncedLines(base, 200000, 190000);
    expect(shiftMs).toBe(0);
    expect(lines.map((l) => l.ms)).toEqual([15000, 25000]);
  });

  it('caps the shift so a bad duration cannot teleport the clock', () => {
    const { lines, shiftMs } = alignSyncedLines(base, 100000, 200000);
    expect(shiftMs).toBe(MAX_LYRIC_ALIGN_SHIFT_MS);
    expect(lines[0]?.ms).toBe(15000 + MAX_LYRIC_ALIGN_SHIFT_MS);
    expect(shiftMs).toBeLessThanOrEqual(10000);
  });

  it('returns zero shift when either duration is unknown', () => {
    expect(alignSyncedLines(base, undefined, 123000).shiftMs).toBe(0);
    expect(alignSyncedLines(base, 115000, undefined).shiftMs).toBe(0);
    expect(alignSyncedLines(base, 0, 123000).shiftMs).toBe(0);
    expect(alignSyncedLines([], 115000, 123000).shiftMs).toBe(0);
  });
});

describe('lyricEffectiveAt + nextLyricBoundary (timer/display unity)', () => {
  const lines = [
    { ms: 2000, text: 'One' },
    { ms: 10000, text: 'Two' },
  ];

  it('effective is raw minus the safety lag, clamped at zero', () => {
    expect(lyricEffectiveAt(9200, 1200)).toBe(8000);
    expect(lyricEffectiveAt(500, 1200)).toBe(0);
    // The default is no longer the invented 1200ms: it is the floor under the
    // MEASURED Discord edit round-trip, so an untimed first edit is never
    // held back by a beat that was never observed.
    expect(LYRIC_SAFETY_LAG_MS).toBe(EDIT_LATENCY_FLOOR_MS);
    expect(LYRIC_SAFETY_LAG_MS).toBe(150);
  });

  it('timer and display agree on the next boundary', () => {
// Display and timer both read 9050 (9200 - the 150ms default lag), so the
    // timer arms 950ms out. Arming on raw 9200 gave 800 and fired early.
    const effective = lyricEffectiveAt(9200, LYRIC_SAFETY_LAG_MS);
    expect(nextLyricBoundary(lines, effective)?.ms).toBe(10000);
    expect(10000 - effective).toBe(950);
  });

  it('returns null past the last line (no timer armed)', () => {
    expect(nextLyricBoundary(lines, 20000)).toBeNull();
    expect(nextLyricBoundary([], 0)).toBeNull();
  });
});

describe('measureLyricLead (the node startup lead)', () => {
  it('is the node position minus wall time since track start', () => {
    // Log line: position 69127ms, elapsed 57532ms -> lead 11595ms.
    expect(measureLyricLead(69127, 57532, 0)).toBe(11595);
  });

  it('is a running MAX: a node true-up may raise it, never lower it', () => {
    // First boundary of the same track read 8680ms, then the clock true-upped.
    expect(measureLyricLead(22941, 14261, 0)).toBe(8680);
    expect(measureLyricLead(26866, 15260, 8680)).toBe(11606);
    // A later jittery read must not walk it back down.
    expect(measureLyricLead(27117, 15512, 11606)).toBe(11606);
  });

  it('clamps skew and nonsense at both ends', () => {
    expect(measureLyricLead(5000, 12000, 0)).toBe(0);
    expect(measureLyricLead(200000, 0, 0)).toBe(LYRIC_LEAD_MAX_MS);
  });

  it('ignores a non-finite previous value rather than poisoning the max', () => {
    expect(measureLyricLead(69127, 57532, Number.NaN)).toBe(11595);
  });
});

describe('lyricClockFor', () => {
  it('subtracts the measured lead and the safety lag', () => {
    expect(lyricClockFor(69127, 11595, 1200)).toBe(56332);
  });

  it('never returns a negative clock', () => {
    expect(lyricClockFor(1000, 5000, 500)).toBe(0);
  });

  it('is the one value both the timer and the window derive from', () => {
    // Timer delay and window lookup agree because they share the call.
    const clock = lyricClockFor(26866, 11606, LYRIC_SAFETY_LAG_MS);
    const next = nextLyricBoundary(
      [
        { ms: 13430, text: 'One' },
        { ms: 22740, text: 'Two' },
      ],
      clock,
    );
    expect(next?.ms).toBe(22740);
    // The delay is whatever the shared clock says it is — here 26866 - 11606
    // lead - 150 lag = 15110, so 7630ms until the line. Pinned as arithmetic
    // on the constants, not as a remembered magic number.
    expect(22740 - clock).toBe(22740 - (26866 - 11606 - LYRIC_SAFETY_LAG_MS));
    expect(22740 - clock).toBe(7630);
  });
});

