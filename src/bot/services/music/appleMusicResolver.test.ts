import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppleMusicResolver } from './appleMusicResolver';
import type { AppleMusicTokenScraper } from '@applemusic/apis/appleMusicTokenScraper';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const nullScraper = {
  getToken: vi.fn().mockResolvedValue(null),
  invalidate: vi.fn(),
} as unknown as AppleMusicTokenScraper;

describe('AppleMusicResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resolver = new AppleMusicResolver(nullScraper);

  it('identifies and parses links incl. storefront and ?i=', () => {
    expect(resolver.isAppleMusicUrl('https://music.apple.com/us/song/nevermind/1440783616?i=1440783617')).toBe(true);
    expect(resolver.isAppleMusicUrl('https://music.apple.com/album/nevermind/1440783616')).toBe(true);
    expect(resolver.isAppleMusicUrl('https://music.apple.com/us/playlist/today-s-hits/pl.123')).toBe(true);
    expect(resolver.isAppleMusicUrl('https://open.spotify.com/track/abc')).toBe(false);
    expect(resolver.parseAppleMusicUrl('https://music.apple.com/us/song/nevermind/1440783616?i=1440783617')).toEqual({
      type: 'song',
      id: '1440783616',
      cc: 'us',
      trackId: '1440783617',
    });
    expect(resolver.parseAppleMusicUrl('https://music.apple.com/fr/album/nevermind/1440783616')?.cc).toBe('fr');
  });

  it('resolves a song through the no-auth iTunes fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      expect(String(url)).toContain('itunes.apple.com/lookup');
      return jsonResponse({
        resultCount: 1,
        results: [
          {
            wrapperType: 'track',
            trackName: 'Smells Like Teen Spirit',
            artistName: 'Nirvana',
            trackTimeMillis: 301000,
            trackViewUrl: 'https://music.apple.com/us/song/x/1440783616?i=1440783617',
            artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
          },
        ],
      });
    }) as typeof fetch);

    const res = await resolver.resolve('https://music.apple.com/us/song/nevermind/1440783616?i=1440783617');
    expect(res?.type).toBe('track');
    expect(res?.provider).toBe('apple');
    expect(res?.tracks[0]).toMatchObject({
      name: 'Smells Like Teen Spirit',
      artist: 'Nirvana',
      durationMs: 301000,
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg',
      provider: 'apple',
    });
    expect(res?.tracks[0]?.isrc).toBeUndefined();
  });

  it('resolves an album through the no-auth iTunes fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return jsonResponse({
        resultCount: 3,
        results: [
          { wrapperType: 'collection', collectionName: 'Nevermind', artistName: 'Nirvana', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg' },
          { wrapperType: 'track', trackName: 'Smells Like Teen Spirit', artistName: 'Nirvana', trackTimeMillis: 301000, trackViewUrl: 'https://music.apple.com/x?i=1', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg' },
          { wrapperType: 'track', trackName: 'In Bloom', artistName: 'Nirvana', trackTimeMillis: 254000, trackViewUrl: 'https://music.apple.com/x?i=2', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg' },
        ],
      });
    }) as typeof fetch);

    const res = await resolver.resolve('https://music.apple.com/us/album/nevermind/1440783616');
    expect(res?.type).toBe('album');
    expect(res?.title).toBe('Nevermind');
    expect(res?.tracks).toHaveLength(2);
  });

  it('returns null for playlists when the catalog token is unavailable', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(resolver.resolve('https://music.apple.com/us/playlist/today-s-hits/pl.123')).resolves.toBeNull();
    // No iTunes fallback exists for playlists — zero network calls.
    expect(spy).not.toHaveBeenCalled();
  });

  it('prefers the catalog (ISRC + hi-res art) when a token exists', async () => {
    const tokenScraper = {
      getToken: vi.fn().mockResolvedValue('catalog-token'),
      invalidate: vi.fn(),
    } as unknown as AppleMusicTokenScraper;
    const withToken = new AppleMusicResolver(tokenScraper);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      expect(String(url)).toContain('amp-api.music.apple.com');
      return jsonResponse({
        data: [
          {
            id: '1440783617',
            attributes: {
              name: 'Smells Like Teen Spirit',
              artistName: 'Nirvana',
              durationInMillis: 301000,
              isrc: 'USGF19942500',
              url: 'https://music.apple.com/us/song/x/1440783616?i=1440783617',
              artwork: { url: 'https://is1-ssl.mzstatic.com/image/{w}x{h}bb.jpg', width: 3000, height: 3000 },
            },
          },
        ],
      });
    }) as typeof fetch);

    const res = await withToken.resolve('https://music.apple.com/us/song/nevermind/1440783616?i=1440783617');
    expect(res?.tracks[0]?.isrc).toBe('USGF19942500');
    expect(res?.tracks[0]?.artworkUrl).toBe('https://is1-ssl.mzstatic.com/image/1000x1000bb.jpg');
  });
});
