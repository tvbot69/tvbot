import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeezerApi } from '@deezer/apis/deezerApi';

/**
 * **Captured from the real Deezer API on 2026-09-30.** Not invented, not
 * paraphrased from docs — copied out of a live `curl` via the probe pattern in
 * `scripts/liveVerify.ts`. Long text values are elided; every key and every type
 * is exactly what the server sent.
 *
 * ## Why these three bodies and not the ones the other Deezer tests use
 *
 * `deezerResolver.test.ts` mocks `/track/123` and `/album/456` — a
 * 1-track and a 1-track album. Neither can express a `next` cursor, and the
 * mocked suite therefore never saw the shape that broke the pager.
 *
 * **Deezer's `next` is an ABSOLUTE URL, not a path.**
 * `deezerApi.collectPages` hands it to `getNullable`, which builds
 * `` `${API_BASE}${path}` ``. That produces
 * `https://api.deezer.comhttps://api.deezer.com/...` — host
 * `api.deezer.comhttps` — which cannot resolve. The real playlist below has
 * 347 tracks; the pager returns its first 100 and stops, with no partial flag,
 * which is the exact failure `deezerApi.ts`'s own comment says it fixed.
 *
 * The `200 + {error:{...}}` body is here for the same reason: Deezer answers
 * an unknown id with **HTTP 200**, not 404, so the `!response.ok` branch in
 * `getNullable` never runs and the `json.error` check is the only thing standing
 * between a miss and a wrong answer.
 *
 * These are shape locks. They do not assert the truncation is correct — the
 * cursor fixture exists so a fix has a regression test to aim at.
 */

const TRACK_SEARCH_HIT = {
  id: 697193953,
  readable: true,
  title: 'Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)',
  title_short: 'Get Lucky',
  title_version: '(Radio Edit - feat. Pharrell Williams and Nile Rodgers)',
  isrc: 'USQX91300809',
  link: 'https://www.deezer.com/track/697193953',
  // measured `number`, not a numeric string — mapTrack does
  // `(json.duration || 0) * 1000`, which would be NaN on a string.
  duration: 248,
  rank: 1000000,
  explicit_lyrics: false,
  explicit_content_lyrics: 0,
  explicit_content_cover: 0,
  // A TIME-LIMITED URL. `hdnea=exp=` is ~907s out, measured three times
  // independently. ~479 827 bytes of audio/mpeg.
  preview:
    'https://cdnt-preview.dzcdn.net/api/1/1/1/b/f/0/1bf80a82992903ff685ba1b7275223f8.mp3' +
    '?hdnea=exp=1790748572~acl=/api/1/1/1/b/f/0/1bf80a82992903ff685ba1b7275223f8.mp3*' +
    '~data=user_id=0,application_id=42~hmac=486387569898704c92ab9897e1381e58c43d1d89233087b22e25cd386c15db86',
  md5_image: 'bc49adb87758e0c8c4e508a9c5cce85d',
  artist: {
    id: 27,
    name: 'Daft Punk',
    link: 'https://www.deezer.com/artist/27',
    picture: 'https://api.deezer.com/artist/27/image',
    picture_small: 'https://e-cdns-images.dzcdn.net/images/artist/27/75x75-000000-80-0-0.jpg',
    picture_medium: 'https://e-cdns-images.dzcdn.net/images/artist/27/250x250-000000-80-0-0.jpg',
    picture_big: 'https://e-cdns-images.dzcdn.net/images/artist/27/500x500-000000-80-0-0.jpg',
    picture_xl: 'https://e-cdns-images.dzcdn.net/images/artist/27/1000x1000-000000-80-0-0.jpg',
    tracklist: 'https://api.deezer.com/artist/27/top?limit=50',
    type: 'artist',
  },
  album: {
    id: 302632,
    title: 'Get Lucky',
    cover: 'https://api.deezer.com/album/302632/image',
    cover_small: 'https://e-cdns-images.dzcdn.net/images/cover/bc49adb87758e0c8c4e508a9c5cce85d/56x56-000000-80-0-0.jpg',
    cover_medium: 'https://e-cdns-images.dzcdn.net/images/cover/bc49adb87758e0c8c4e508a9c5cce85d/250x250-000000-80-0-0.jpg',
    cover_big: 'https://e-cdns-images.dzcdn.net/images/cover/bc49adb87758e0c8c4e508a9c5cce85d/500x500-000000-80-0-0.jpg',
    cover_xl: 'https://cdn-images.dzcdn.net/images/cover/bc49adb87758e0c8c4e508a9c5cce85d/1000x1000-000000-80-0-0.jpg',
    md5_image: 'bc49adb87758e0c8c4e508a9c5cce85d',
    tracklist: 'https://api.deezer.com/album/302632/tracks',
    type: 'album',
  },
  type: 'track',
};

const MISS_BODY = { error: { type: 'DataException', message: 'no data', code: 800 } };

/** Verbatim, from a real 347-track playlist. `data` elided to 2 entries. */
const PLAYLIST_PAGE_1 = {
  data: [TRACK_SEARCH_HIT, { ...TRACK_SEARCH_HIT, id: 697193954, title: 'Lucky' }],
  total: 347,
  next: 'https://api.deezer.com/playlist/914651125/tracks?limit=100&index=100',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('DeezerApi — live wire shapes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the fields mapTrack / mapToLyricsResult depend on', () => {
    it('search/track returns every field the code reads, with the measured types', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse({ data: [TRACK_SEARCH_HIT], total: 75, next: 'https://api.deezer.com/search/track?q=x&limit=1&index=1' }),
      );

      const [hit] = await new DeezerApi().searchTracks('daft punk get lucky', 1);

      expect(hit).toBeDefined();
      // deezerResolver.mapTrack reads exactly these.
      expect(typeof hit?.title).toBe('string');
      expect(typeof hit?.artist?.name).toBe('string');
      // NUMBER, so `(json.duration || 0) * 1000` yields 248000 and not NaN.
      expect(typeof hit?.duration).toBe('number');
      expect((hit?.duration ?? 0) * 1000).toBe(248_000);
      expect(hit?.isrc).toBe('USQX91300809');
      expect(hit?.md5_image).toBe('bc49adb87758e0c8c4e508a9c5cce85d');
      expect(hit?.album?.cover_xl).toMatch(/^https:\/\/cdn-images\.dzcdn\.net\//);
      expect(hit?.link).toMatch(/^https:\/\/www\.deezer\.com\/track\//);
      // previewResolverService.ts:244 reads this one.
      expect(hit?.preview).toMatch(/^https:\/\/cdnt-preview\.dzcdn\.net\//);
    });

    it('the preview URL carries an embedded ~15 minute expiry, which no cache TTL in the repo accounts for', () => {
      // `hdnea=exp=` is an ABSOLUTE unix timestamp, not an offset. Measured live
      // three times in one session: 907s, 907s, 907s. Asserted against the
      // frozen capture instant rather than `Date.now()`, so this records a fact
      // instead of decaying into a tautology (or a false failure) as time passes.
      const CAPTURED_AT = Date.parse('2026-09-30T05:54:25.000Z') / 1000;
      const exp = /exp=(\d+)/.exec(TRACK_SEARCH_HIT.preview);
      expect(exp).not.toBeNull();

      const ttlSeconds = Number(exp?.[1]) - CAPTURED_AT;
      expect(ttlSeconds).toBe(907);
      // The load-bearing claim: minutes, not hours. A 60 minute resolution
      // cache (previewResolverService.ts:120) and a 30 minute registration
      // (voiceMessageService.ts:15) both hand out a dead URL.
      expect(ttlSeconds).toBeLessThan(1800);
      expect(ttlSeconds).toBeLessThan(3600);
    });

    it('an unknown id is HTTP 200 with a body error, so only the json.error check can catch it', async () => {
      // The real answer, verbatim. Deezer does NOT 404 here.
      const res = jsonResponse(MISS_BODY, 200);
      expect(res.ok).toBe(true);

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res);
      await expect(new DeezerApi().getTrack('0')).resolves.toBeNull();

      // And the throwing search leg does not swallow it, so a caller can tell.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ data: [], total: 0 }, 200));
      await expect(new DeezerApi().searchTracks('Radiohead Creep', 3)).resolves.toEqual([]);
    });
  });

  describe('the `next` cursor', () => {
    it('is an ABSOLUTE url, which is what makes collectPages stop after page 1', () => {
      // Locked from the live wire. If Deezer ever switches to a path, the
      // `collectPages` concatenation becomes correct and this fails loudly
      // rather than the truncation staying invisible.
      expect(PLAYLIST_PAGE_1.next).toMatch(/^https:\/\/api\.deezer\.com\//);
      expect(PLAYLIST_PAGE_1.total).toBe(347);
      expect(PLAYLIST_PAGE_1.data).toHaveLength(2);
    });

    it('a playlist past the first page is truncated to that page, with no partial flag', async () => {
      // Two real calls in a row: page 1 succeeds, then the cursor is handed to
      // the same `${API_BASE}${path}` concatenation the pager uses.
      const spy = vi.spyOn(globalThis, 'fetch');
      spy.mockResolvedValueOnce(jsonResponse(PLAYLIST_PAGE_1));
      spy.mockRejectedValueOnce(new TypeError('fetch failed'));

      const tracks = await new DeezerApi().getPlaylistTracks('914651125');

      // The honest statement of today's behaviour. 347 on the wire, 2 back,
      // and `getPlaylistTracks` returns an array — the caller cannot tell.
      expect(tracks).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(2);

      // The URL the pager actually requested, spelled out.
      const requested = String(spy.mock.calls[1]?.[0]);
      expect(requested).toBe('https://api.deezer.comhttps://api.deezer.com/playlist/914651125/tracks?limit=100&index=100');
    });

    it('a playlist that fits on one page is unaffected', async () => {
      // A 4-track album: no cursor, so the pager is correct by accident.
      const page = { data: [TRACK_SEARCH_HIT, TRACK_SEARCH_HIT, TRACK_SEARCH_HIT, TRACK_SEARCH_HIT], total: 4 };
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(page));

      const tracks = await new DeezerApi().getAlbumTracks('302632');

      expect(tracks).toHaveLength(4);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
