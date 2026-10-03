import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreviewResolverService } from '@bot/services/audio/previewResolverService';
import type { AppleMusicSearchApi } from '@applemusic/api/appleMusicSearchApi';
import type { DeezerApi } from '@deezer/api/deezerApi';
import type { CacheService } from '@bot/services/system/cacheService';

/**
 * Why this file exists
 *
 * The cache TTL was a flat `3600` for every provider. Measured live, that is
 * right for Apple and Spotify and badly wrong for Deezer: a Deezer preview URL
 * carries a signed token that expires in **~907 seconds**, so three quarters of
 * the cache window handed out a URL that 404s on fetch. The user-visible
 * symptom is a preview button that does nothing, with no explanation — and the
 * rung is never re-queried, because the entry is still "valid".
 *
 * NOTE ON THE THREE PREREQS. `previewResolverService.ts` is the least-covered
 * service in the repo (7.65% of lines), so this file deliberately does NOT try to
 * cover the scoring logic — it pins the cache-decision contract, which is the
 * thing that was wrong. The full scoring path is a separate job.
 */

const APPLE_HIT = {
  trackName: 'Creep',
  artistName: 'Radiohead',
  collectionName: 'Pablo Honey',
  trackTimeMillis: 239_000,
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a',
  trackViewUrl: 'https://music.apple.com/us/album/creep/123',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/100x100bb.jpg',
};

const DEEZER_HIT = {
  id: 496,
  title: 'Creep',
  duration: 239,
  link: 'https://www.deezer.com/track/496',
  preview: 'https://cdns-preview.dzcdn.net/helper.php?hash=abc',
  artist: { name: 'Radiohead' },
  album: { title: 'Pablo Honey', cover_xl: 'https://cdn.example/xl.jpg' },
};

const cacheWith = () => {
  // The rest parameter is load-bearing, not decoration. A zero-arg `vi.fn`
  // infers a `[]` call tuple, so `calls[0][2]` is a COMPILE error (TS2493) that
  // `npm test` never reports — this is the zero-arg-mock tuple trap that has
  // bitten this repo four separate times. `npm test` passes; `tsc` does not.
  const set = vi.fn(async (..._args: unknown[]) => undefined);
  const get = vi.fn(async (..._args: unknown[]) => null);
  return { cache: { set, get } as unknown as CacheService, set, get };
};

describe('PreviewResolverService — the cache TTL follows the rung that produced the URL', () => {
  const build = (over: {
    apple?: unknown[] | null;
    deezer?: unknown[];
  }): { svc: PreviewResolverService; set: ReturnType<typeof cacheWith>['set'] } => {
    const { cache, set } = cacheWith();
    const appleApi = {
      searchSongs: vi.fn(async () => over.apple ?? []),
    } as unknown as AppleMusicSearchApi;
    const deezerApi = {
      searchTracks: vi.fn(async () => over.deezer ?? []),
    } as unknown as DeezerApi;
    return { svc: new PreviewResolverService(appleApi, deezerApi, cache), set };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an APPLE preview keeps the long TTL — those URLs do not expire', async () => {
    const { svc, set } = build({ apple: [APPLE_HIT] });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('apple');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[2]).toBe(3600);
  });

  it('a DEEZER preview is cached for well under its ~907s token lifetime', async () => {
    // THE BUG THIS FIXES. 3600 was 4x the real expiry.
    const { svc, set } = build({ apple: null, deezer: [DEEZER_HIT] });

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('deezer');
    expect(set).toHaveBeenCalledTimes(1);
    const ttl = set.mock.calls[0]?.[2] as number;
    expect(ttl).toBe(600);
    // The number itself is the point: a TTL at or above the measured 907s
    // expiry serves dead URLs, and this fails if someone tunes it back up.
    expect(ttl).toBeLessThan(907);
  });

  it('a SPOTIFY preview keeps the long TTL', async () => {
    const { cache, set } = cacheWith();
    const scraper = {
      getTrackPreview: vi.fn(async () => ({
        trackName: 'Creep',
        artistName: 'Radiohead',
        previewUrl: 'https://p.scdn.co/mp3-preview/xyz',
        spotifyUrl: 'https://open.spotify.com/track/xyz',
      })),
    };
    const svc = new PreviewResolverService(
      { searchSongs: vi.fn(async () => []) } as unknown as AppleMusicSearchApi,
      { searchTracks: vi.fn(async () => []) } as unknown as DeezerApi,
      cache,
      scraper as never,
    );

    const result = await svc.resolve('Radiohead', 'Creep');

    expect(result?.source).toBe('spotify');
    expect(set.mock.calls[0]?.[2]).toBe(3600);
  });

  it('a miss writes preview:miss inconclusive 90s (art:track INCONCLUSIVE_TTL gate)', async () => {
    // Formerly nothing cached, so every miss re-ran scraper HTML plus Apple
    // plus Deezer. Now mirrors art:track inconclusive backoff.
    const { svc, set } = build({ apple: [], deezer: [] });

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toBe('preview:miss:radiohead|creep');
    expect(set.mock.calls[0]?.[1]).toBe('inconclusive');
    expect(set.mock.calls[0]?.[2]).toBe(90);
  });

  it('a miss hits cache: second resolve returns null without re-running providers', async () => {
    const store = new Map<string, unknown>();
    const get = vi.fn(async (...args: unknown[]) => store.get(args[0] as string) ?? null);
    const set = vi.fn(async (...args: unknown[]) => {
      store.set(args[0] as string, args[1]);
    });
    const cache = { get, set } as unknown as CacheService;
    const searchSongs = vi.fn(async () => []);
    const searchTracks = vi.fn(async () => []);
    const svc = new PreviewResolverService(
      { searchSongs } as unknown as AppleMusicSearchApi,
      { searchTracks } as unknown as DeezerApi,
      cache,
    );

    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
    expect(searchSongs).toHaveBeenCalledTimes(1);
    expect(searchTracks).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);

    searchSongs.mockClear();
    searchTracks.mockClear();
    await expect(svc.resolve('Radiohead', 'Creep')).resolves.toBeNull();
    expect(searchSongs).not.toHaveBeenCalled();
    expect(searchTracks).not.toHaveBeenCalled();
  });
});
