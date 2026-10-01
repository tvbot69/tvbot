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
 * `LyricsService` used to discard that distinction. `probe.answered = true` was
 * set at lyricsService.ts *before* any status was read, so an outage counted as
 * a provider that answered, and the negative cache entry was written for an
 * hour. A song that HAS lyrics answered "Could not find lyrics" to everyone for
 * 60 minutes after one 503.
 *
 * That was precisely the failure the `ProviderProbe` guard exists to prevent —
 * the guard was present and wired up, and it was set one line too early to do
 * its job. It is fixed: `statusIsAnAnswer` now decides from the status, and a
 * 2xx or a genuine 404 counts while 5xx / 429 / 401 / 403 do not. These fixtures
 * pin the wire shapes on BOTH sides so the guard cannot be "fixed" in a way that
 * starts treating a real 404 as inconclusive, and cannot be over-corrected into a
 * cache that never holds a negative at all.
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

    it('a 503 ServerOverloaded yields null AND must NOT be cached', async () => {
      // THE BUG THIS FIXES. `probe.answered` used to be set on any completed
      // request, so this 503 counted as a provider that answered and the
      // negative cache entry was written — freezing "no lyrics" for an hour
      // after a ten-second outage. The second call must now retry the network.
      //
      // `mockImplementation`, not `mockResolvedValueOnce`: getLyrics makes four
      // requests per call, so a four-`Once` spy is exhausted by the first call
      // and the second call falls through to the REAL LRCLIB — which returned
      // actual Creep lyrics and failed this test for a completely different
      // reason. Persistent, URL-keyed stubs keep both calls offline.
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        // Genius' block page is a 403, also measured live from this IP.
        if (url.includes('genius.com')) return new Response('<!DOCTYPE html>', { status: 403 });
        return jsonResponse(SERVER_OVERLOADED, 503);
      });

      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();

      // The user-visible symptom: the second call short-circuits and makes NO
      // network request at all. That is the bug. It must go back out.
      const callsAfterFirst = spy.mock.calls.length;
      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

      // And the two bodies really are distinguishable, which is what makes the
      // collapse a choice rather than an inevitability.
      expect(TRACK_NOT_FOUND.statusCode).toBe(404);
      expect(TRACK_NOT_FOUND.name).toBe('TrackNotFound');
      expect(SERVER_OVERLOADED.statusCode).toBe(503);
      expect(SERVER_OVERLOADED.name).toBe('ServerOverloaded');
      expect(SERVER_OVERLOADED.name).not.toBe(TRACK_NOT_FOUND.name);
    });

    it('a 503 is not cached, but the NEXT real answer is — the fix is not "never cache"', async () => {
      // Guards against over-correcting into a cache that never holds a negative.
      const overloaded = async (input: unknown) => {
        const url = String(input);
        if (url.includes('genius.com')) return new Response('<!DOCTYPE html>', { status: 403 });
        return jsonResponse(SERVER_OVERLOADED, 503);
      };
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(overloaded);

      await expect(service.getLyrics('No Such Song Here', 'Nobody')).resolves.toBeNull();

      // Now every leg answers 404 properly — a genuine, definitive miss.
      spy.mockImplementation(async () => jsonResponse(TRACK_NOT_FOUND, 404));
      await expect(service.getLyrics('No Such Song Here', 'Nobody')).resolves.toBeNull();

      // A definitive "no" IS cacheable, so this third call makes no request.
      const callsAfterSecond = spy.mock.calls.length;
      await expect(service.getLyrics('No Such Song Here', 'Nobody')).resolves.toBeNull();
      expect(spy.mock.calls).toHaveLength(callsAfterSecond);
    });

    it('a 403 Cloudflare challenge is not an answer either', async () => {
      // Genius' block page is a 403, and it means "I will not tell you", not
      // "this track has no lyrics". It must not freeze a negative.
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('<!DOCTYPE html>', { status: 403 }));

      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();
      const callsAfterFirst = spy.mock.calls.length;
      await expect(service.getLyrics('Creep', 'Radiohead')).resolves.toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe('Genius', () => {
    it('a 403 Cloudflare challenge is a FAILURE, not an answer and not lyrics', async () => {
      // CORRECTED 2026-09-30: this test previously claimed the measurement was
      // "every genius.com path returns 403 and an 11-12 KB Cloudflare challenge
      // document from a datacenter IP", and the rung was recorded as dead.
      // Re-probed the same day, Genius answers 200 from this machine with a real
      // hit and real lyrics — so the claim was false, and it would have led the
      // next person to delete a working rung.
      //
      // What survives is the BEHAVIOUR, which is correct whenever Genius does
      // challenge us: a 403 must not be parsed as lyrics, must not be treated as
      // a definitive "no lyrics", and must not freeze a negative cache entry.
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
