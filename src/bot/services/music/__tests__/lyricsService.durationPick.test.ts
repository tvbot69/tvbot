import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LyricsService } from '@bot/services/music/lyricsService';

/**
 * LRCLIB search must pick the pressing actually playing, not the first row
 * with words in it.
 *
 * Search returns closest-text-match first, which is routinely a cover or a
 * different pressing: same words, different clock. Picking row zero hands the
 * card timings offset by seconds for the whole track — which reads as
 * permanent lyric drift. `selectSynced`'s 15s duration guard only rejects
 * far-apart versions; two pressings 6s apart sail through it with the wrong
 * clock. The fix prefers the duration-closest row when the caller knows the
 * track length.
 */

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lrcAt = (ms: number): string => {
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `[00:${ss}.${cs}]`;
};

const row = (durationSec: number, secondMs: number) => ({
  trackName: 'Airbag',
  artistName: 'Radiohead',
  plainLyrics: 'First\nSecond',
  syncedLyrics: `[00:00.00]First\n${lrcAt(secondMs)}Second`,
  duration: durationSec,
});

const searchWith = (rows: unknown[]) => {
  fetchMock.mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes('/api/get')) return json({}, 404);
    if (url.includes('/api/search')) return json(rows);
    return json({}, 404);
  });
};

describe('fetchLrclibSearch duration-aware pick', () => {
  it('picks the duration-closest row, so the card keeps the right clock', async () => {
    // First row: a 290s pressing with the second line at 10s. Second row:
    // the 284s studio take with it at 5s. Old code took row zero (diff 6s
    // passes the 15s guard) and the card sat 5s late all song.
    searchWith([row(290, 10_000), row(284, 5_000)]);

    const lines = await new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 284_000);

    expect(lines).toEqual([
      { ms: 0, text: 'First' },
      { ms: 5_000, text: 'Second' },
    ]);
  });

  it('a single matching row still resolves exactly as before', async () => {
    // The unchanged direction: no alternative to choose between, same lines.
    searchWith([row(284, 5_000)]);

    const lines = await new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 284_000);

    expect(lines).toEqual([
      { ms: 0, text: 'First' },
      { ms: 5_000, text: 'Second' },
    ]);
  });

  it('a search with only a far-apart version is still null, never wrong lines', async () => {
    // The guard direction: a 3-minute live of a 5-minute studio take shares
    // the title but not the clock — null beats drift.
    searchWith([row(180, 5_000)]);

    await expect(new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 300_000)).resolves.toBeNull();
  });
});
