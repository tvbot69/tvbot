import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LyricsService } from '@bot/services/music/lyricsService';

/**
 * LRCLIB exact-match must not bypass duration disambiguation.
 *
 * The duration-closest search pick means nothing when `/api/get` answers:
 * `getLyrics` returned the exact leg immediately, so a 241s live take playing
 * from a 288s studio transcription drifted for the whole track (or nulled
 * out in `selectSynced` when the pressings were far apart, even though the
 * search leg held the right pressing). Measured live against lrclib.net:
 * `/api/get?track_name=Airbag&artist_name=Radiohead` answers the 288s
 * "OK Computer" row, while the same call with `&duration=240` answers the
 * 241s "Live at the 10 Spot" row — the server disambiguates when asked.
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
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `[${mm}:${ss}.${cs}]`;
};

const row = (durationSec: number, secondMs: number) => ({
  trackName: 'Airbag',
  artistName: 'Radiohead',
  plainLyrics: 'First\nSecond',
  syncedLyrics: `[00:00.00]First\n${lrcAt(secondMs)}Second`,
  duration: durationSec,
});

const getUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

describe('fetchLrclibExact duration disambiguation', () => {
  it('sends the expected duration so the server returns the pressing playing', async () => {
    // The old URL carried only track_name + artist_name, so the server chose
    // the pressing and the card inherited its clock.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(row(288, 10_000));
      return json([], 200);
    });

    await new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 284_000);

    const exactUrl = getUrls().find((u) => u.includes('/api/get'));
    expect(exactUrl).toContain('duration=284');
  });

  it('a far-apart exact falls through to the duration-closest search row', async () => {
    // Playing the 241s live take while exact answers the 288s studio row
    // (47s apart). Old code returned exact and `selectSynced` nulled it —
    // no lyrics at all, despite the search leg holding the 241s pressing.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(row(288, 10_000));
      if (url.includes('/api/search')) return json([row(288, 10_000), row(241, 5_000)]);
      return json({}, 404);
    });

    const lines = await new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 241_000);

    expect(lines).toEqual([
      { ms: 0, text: 'First' },
      { ms: 5_000, text: 'Second' },
    ]);
  });

  it('a duration-matching exact still wins without consulting search', async () => {
    // The unchanged direction: exact IS the pressing playing, so its lines
    // stand even though search holds alternatives.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(row(284, 7_000));
      if (url.includes('/api/search')) return json([row(290, 10_000), row(284, 5_000)]);
      return json({}, 404);
    });

    const lines = await new LyricsService().getSyncedLyrics('Airbag', 'Radiohead', 284_000);

    expect(lines).toEqual([
      { ms: 0, text: 'First' },
      { ms: 7_000, text: 'Second' },
    ]);
    expect(getUrls().some((u) => u.includes('/api/search'))).toBe(false);
  });

  it('callers without a duration send the exact same URL as before', async () => {
    // Plain-lyrics displays never knew the track length; no param, no guard.
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes('/api/get')) return json(row(288, 10_000));
      return json({}, 404);
    });

    await new LyricsService().getLyrics('Airbag', 'Radiohead');

    const exactUrl = getUrls().find((u) => u.includes('/api/get'));
    expect(exactUrl).not.toContain('duration=');
  });
});
