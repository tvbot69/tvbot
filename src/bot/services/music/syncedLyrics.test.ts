import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { parseLrc, selectSynced, lyricWindowAt } from './syncedLyrics';

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
