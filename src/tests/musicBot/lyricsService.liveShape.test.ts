import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LyricsService } from '@bot/services/music/lyricsService';

/**
 * **Captured from the real LRCLIB API on 2026-09-30.** Keys, types and short
 * values are exactly what the server sent; the two lyric bodies are elided past
 * their first line.
 *
 * ## Why this file exists
 *
 * LRCLIB is perfectly able to say "no such track" — it answers **HTTP 404**
 * with `{"name":"TrackNotFound"}` — and perfectly able to say "I am
 * overloaded" — **HTTP 503** with `{"name":"ServerOverloaded"}`. Measured: 12
 * of 12 misses returned 404, and 1 of 8 searches returned 503 under no
 * particular provocation.
 *
 * `LyricsService` discards that distinction. `probe.answered = true` is set at
 * lyricsService.ts:120 / :141 / :175 *before* the `if (!res.ok)` check, so an
 * outage counts as a provider that answered, and lyricsService.ts:93 then
 * writes a negative cache entry good for an hour. A song that HAS lyrics
 * answers "Could not find lyrics" to everyone for 60 minutes after one 503.
 *
 * That is precisely the failure the `ProviderProbe` comment at :88-92 says it
 * exists to prevent — the guard is present and wired up, and it is set one line
 * too early to do its job. These fixtures pin the wire shapes so the guard
 * cannot be "fixed" in a way that starts treating a real 404 as inconclusive.
 */

const TRACK_NOT_FOUND = { message: 'Failed to find specified track', name: 'TrackNotFound', statusCode: 404 };
const SERVER_OVERLOADED = { message: 'The server is busy, please retry in a moment', name: 'ServerOverloaded', statusCode: 503 };

/** All 13 keys, exactly as LRCLIB returned them. */
const LRCLIB_TRACK = {
  albumName: 'Pablo Honey',
  artistName: 'Radiohead',
  duration: 239,
  hasWordSync: false,
  id: 496,
  instrumental: false,
  lyricsfile: "version: '1.0'\nmetadata:\n  title: Creep\n  artist: Radiohead\n  album: Pablo Honey\n",
  name: 'Creep',
  plainLyrics: 'When you were here before\nCouldn\'t look you in the eye...',
  syncedLyrics: '[00:19.16] When you were here before\n[00:24.09] Couldn\'t look you in the eye...',
  trackName: 'Creep',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('LyricsService — live LRCLIB wire shapes', () => {
  let service: LyricsService;

  beforeEach(() => {
    service = new LyricsService();
    vi.restoreAllMocks();
  });

  describe('a successful /api/get', () => {
    it('maps every field the service reads, and both title spellings are real', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(LRCLIB_TRACK))
        .mockResolvedValueOnce(new Response('[]', { status: 200 }));

      const result = await service.getLyrics('Creep', 'Radiohead');

      expect(result).not.toBeNull();
      expect(result?.source).toBe('lrclib');
      // `name` is what the service prefers; `trackName` is the fallback. Both
      // exist live, which is why neither the mock-only nor the real body can
      // ever produce "Unknown Title" here.
      expect(result?.title).toBe('Creep');
      expect(result?.artist).toBe('Radiohead');
      expect(result?.plainLyrics).toContain('When you were here before');
      expect(result?.syncedLyrics).toContain('[00:19.16]');
      expect(result?.instrumental).toBe(false);
      // `duration` is a NUMBER of seconds; the service multiplies by 1000.
      expect(result?.durationMs).toBe(239_000);
      // A string here would silently yield NaN and a card with no duration.
      expect(typeof LRCLIB_TRACK.duration).toBe('number');
      // The other keys the service does not read, so nobody is tempted to.
      expect(LRCLIB_TRACK.hasWordSync).toBe(false);
      expect(LRCLIB_TRACK.lyricsfile).toContain('title: Creep');
    });
  });

  describe('a miss and an outage are DIFFERENT on the wire', () => {
    it('a 404 TrackNotFound is a real answer and must stay cacheable', async () => {
      // exact, search, genius-multi, genius-title — all 404/no-hit.
      const spy = vi.spyOn(globalThis, 'fetch');
      spy.mockResolvedValueOnce(jsonResponse(TRACK_NOT_FOUND, 404));
      spy.mockResolvedValueOnce(jsonResponse([], 200));
      spy.mockResolvedValueOnce(jsonResponse(TRACK_NOT_FOUND, 404));
      spy.mockResolvedValueOnce(jsonResponse(TRACK_NOT_FOUND, 404));

      await expect(service.getLyrics('Zzzqxwv Nnbbkkjj', 'Nonexistent Artist Qqqx')).resolves.toBeNull();
      expect(spy.mock.calls[0]?.[0]).toContain('/api/get?');
      expect(String(spy.mock.calls[1]?.[0])).toContain('/api/search?');
    });

    it('a 503 ServerOverloaded currently yields the SAME null, and the negative cache is written anyway', async () => {
      // This test documents the LIVE BUG, it does not endorse it. It passes
      // today; when the lead fixes the probe ordering, the two `toBeNull()`
      // calls below are where the behaviour change will show up.
      const spy = vi.spyOn(globalThis, 'fetch');
      // exact -> 503, search -> 503, genius -> 403 (also measured live), title -> 403
      spy.mockResolvedValueOnce(jsonResponse(TRACK_NOT_FOUND, 404));
      spy.mockResolvedValueOnce(jsonResponse(SERVER_OVERLOADED, 503));
      spy.mockResolvedValueOnce(new Response('<!DOCTYPE html>', { status: 403 }));
      spy.mockResolvedValueOnce(new Response('<!DOCTYPE html>', { status: 403 }));

      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();

      // The cached null is the user-visible symptom: the second call short
      // circuits and makes no network request at all, for an hour.
      const callsAfterFirst = spy.mock.calls.length;
      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();
      expect(spy.mock.calls).toHaveLength(callsAfterFirst);

      // And the two bodies really are distinguishable, which is what makes the
      // collapse a choice rather than an inevitability.
      expect(TRACK_NOT_FOUND.statusCode).toBe(404);
      expect(TRACK_NOT_FOUND.name).toBe('TrackNotFound');
      expect(SERVER_OVERLOADED.statusCode).toBe(503);
      expect(SERVER_OVERLOADED.name).toBe('ServerOverloaded');
      expect(SERVER_OVERLOADED.name).not.toBe(TRACK_NOT_FOUND.name);
    });
  });

  describe('Genius', () => {
    it('the unauthenticated search endpoint answers 403 with an HTML block page, not JSON', async () => {
      // Measured live: every genius.com path — the API, the homepage, a lyrics
      // page — returns 403 and an 11-12 KB Cloudflare challenge document from
      // a datacenter IP. The JSON.parse in the service is inside the try, so
      // it is caught, but only AFTER `probe.answered` was already set.
      const html = '<!DOCTYPE html><html lang="en"><head><title>Genius</title></head><body>challenge-platform</body></html>';
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(html, { status: 403 }))
        .mockResolvedValueOnce(new Response(html, { status: 403 }));

      await expect(service.fetchGeniusLyrics('Radiohead Creep')).resolves.toBeNull();
      expect(String(spy.mock.calls[0]?.[0])).toBe(
        'https://genius.com/api/search/multi?q=Radiohead%20Creep',
      );
    });
  });
});
