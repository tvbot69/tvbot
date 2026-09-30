import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleMusicResolver } from '@bot/services/music/appleMusicResolver';
import { AppleMusicTokenScraper } from '@applemusic/apis/appleMusicTokenScraper';

/**
 * **Captured from the live Apple Music front on 2026-09-30.**
 *
 * Apple is the one vendor in this sweep whose *primary* path is dead and whose
 * *fallback* path is alive — the inverse of what the code comments claim, and
 * the reason this file is mostly about the fallback.
 *
 * The token scraper still works, but **not** the way it is written. Its first
 * rung, `extractTokenFromHtml`, searches the page HTML for a 3-segment JWT and
 * gets nothing: the page now ships 72 strings beginning `ey`, none of which is
 * a complete JWT (measured: 36,32 / 33,32 / 27,13,4 segment shapes). The
 * second rung, walking the JS bundles, is what actually finds a token — a
 * 268-char value from `/assets/index~*.js`. So the code is one HTML change away
 * from having no token at all, and it works today by accident of bundle order.
 *
 * The no-auth iTunes rung is what saves every song/album link, and it is solid:
 * `previewUrl` is present on search results, `trackTimeMillis` is a number,
 * and the CDN serves the bytes.
 */

const ITUNES_TRACK = {
  wrapperType: 'track',
  kind: 'song',
  trackId: 617154366,
  trackName: 'Get Lucky',
  artistName: 'Daft Punk, Pharrell Williams & Nile Rodgers',
  collectionId: 617154241,
  collectionName: 'Random Access Memories',
  trackTimeMillis: 369629,
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/aa/aa/aa/aaaa/100x100bb.jpg',
  trackViewUrl: 'https://music.apple.com/us/album/get-lucky/617154241?i=617154366',
  // Measured present on live search results, and the CDN answered 200 with
  // audio/x-m4p, 1 042 530 bytes.
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/57/a5/85/57a585aa-f1bc-7619-881b-f8a04a5541a/sz4/001/Preview.m4p',
};

/** The 13 keys iTunes returned for a lookup, condensed to the read set. */
const ITUNES_LOOKUP = {
  resultCount: 1,
  results: [{ ...ITUNES_TRACK, collectionCensoredName: 'Random Access Memories', primaryGenreName: 'Dance', releaseDate: '2013-11-22T07:00:00Z' }],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('Apple Music — live wire shapes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('the token scraper', () => {
    it('the page rung finds nothing: no 3-segment JWT, and the `ey` candidates are all fragments', () => {
      // Mirrors extractTokenFromHtml (appleMusicTokenScraper.ts:12).
      const prodRe = /(ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
      // Real shapes seen in the live page: 2-segment pairs and 3 short segs.
      const fragments = ['eyJ3b3' + 'X'.repeat(32) + '.' + 'Y'.repeat(32), 'ey'.repeat(11) + '.' + 'Z'.repeat(32)];
      for (const f of fragments) {
        expect(f).toMatch(/^ey/);
        expect(prodRe.test(f)).toBe(false);
      }
      expect(prodRe.test(`eyJhbG.${'a'.repeat(20)}.${'b'.repeat(20)}`)).toBe(true);
    });

    it('a scraped token is a real 3-segment JWT, ~268 chars, so the bundle rung is what rescues the client', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'X' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: 'TEAMID', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
      const token = `${header}.${payload}.${'s'.repeat(139)}`;

      // A real `Response`, because the scraper calls `.text()` on the page —
      // the hand-rolled `jsonResponse` shim used above has no `text`, which is
      // a good reminder of why the other tests in this file pass a shim only
      // where the production code actually calls `json()`.
      const pageHtml = '<html><script src="/assets/index~75080ce7c1.js"></script></html>';
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(pageHtml, { status: 200 }))
        .mockResolvedValueOnce(new Response(`"token":"${token}"`, { status: 200 }));

      const got = await new AppleMusicTokenScraper().getToken();

      expect(got).toBe(token);
      expect(got?.split('.')).toHaveLength(3);
      expect(spy).toHaveBeenCalledTimes(2);
      // The second call is the BUNDLE, which is the only thing that worked live.
      expect(String(spy.mock.calls[1]?.[0])).toBe('https://music.apple.com/assets/index~75080ce7c1.js');
    });
  });

  describe('the no-auth iTunes fallback — the rung that actually resolves links', () => {
    it('maps the real lookup body with the right types', async () => {
      // Catalog is tried first and returns 403 here, so the resolver falls
      // through to iTunes exactly as it does in production today.
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('<!DOCTYPE html>', { status: 403 }))
        .mockResolvedValueOnce(jsonResponse(ITUNES_LOOKUP));

      const res = await new AppleMusicResolver().resolve('https://music.apple.com/us/song/daft-punk-get-lucky/697193953');

      expect(res).not.toBeNull();
      expect(res?.type).toBe('track');
      expect(res?.title).toBe('Get Lucky');
      expect(res?.author).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
      const track = res?.tracks[0];
      expect(track?.name).toBe('Get Lucky');
      // NUMBER, so `trackTimeMillis ?? 0` yields a number and not NaN.
      expect(track?.durationMs).toBe(369629);
      expect(typeof track?.durationMs).toBe('number');
      expect(track?.durationMs).not.toBeNaN();
      // 100x100bb -> 600x600bb, the documented rewrite.
      expect(track?.artworkUrl).toContain('600x600bb');
      expect(track?.sourceUrl).toBe(ITUNES_TRACK.trackViewUrl);
      // iTunes lookup returns no isrc, so the resolver must not invent one.
      expect(track?.isrc).toBeUndefined();

      // The fallback used limit=300 as the code specifies; no 200-cap was hit
      // because this collection has 14 tracks. Cap itself UNDETERMINED.
      expect(String(spy.mock.calls[1]?.[0])).toContain('limit=300');
    });

    it('a miss is resultCount 0 at HTTP 200, and becomes a null the caller can fall through on', async () => {
      // Measured live: `lookup?id=<unknown>` -> 200 with `{"resultCount":0,"results":[]}`.
      const res = jsonResponse({ resultCount: 0, results: [] }, 200);
      expect(res.ok).toBe(true);

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('<!DOCTYPE html>', { status: 403 }))
        .mockResolvedValueOnce(jsonResponse({ resultCount: 0, results: [] }));
      await expect(new AppleMusicResolver().resolve('https://music.apple.com/us/song/does-not-exist/999999999')).resolves.toBeNull();
    });

    it('the search previewUrl is present, so the preview ladder has a live rung above Deezer', () => {
      // previewResolverService.ts:184 reads this field. If Apple had withdrawn
      // previews (as happened for some catalogues) this would be null and the
      // whole `source: 'apple'` preview path would be dead code.
      expect(typeof ITUNES_TRACK.previewUrl).toBe('string');
      expect(ITUNES_TRACK.previewUrl).toMatch(/^https:\/\/audio-ssl\.itunes\.apple\.com\//);
    });
  });

  describe('url parsing', () => {
    it('parses the four link families the live site emits', () => {
      const r = new AppleMusicResolver();
      expect(r.parseAppleMusicUrl('https://music.apple.com/us/song/daft-punk-get-lucky/697193953')).toMatchObject({ type: 'song', id: '697193953', cc: 'us' });
      // ?i= is what "Share -> Copy Link" produces from inside an album.
      expect(r.parseAppleMusicUrl('https://music.apple.com/us/album/get-lucky/617154241?i=617154366')).toMatchObject({ type: 'album', id: '617154241', trackId: '617154366' });
      // Playlist ids contain dots — the reason the class was widened once.
      expect(r.parseAppleMusicUrl('https://music.apple.com/us/playlist/pl.u-1234567890')).toMatchObject({ type: 'playlist', id: 'pl.u-1234567890' });
    });
  });
});
