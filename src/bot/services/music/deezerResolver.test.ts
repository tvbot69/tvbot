import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeezerResolver } from './deezerResolver';
import { DeezerApi } from '@deezer/apis/deezerApi';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DeezerResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resolver = new DeezerResolver(new DeezerApi());

  it('identifies canonical and share URLs', () => {
    expect(resolver.isDeezerUrl('https://www.deezer.com/track/123')).toBe(true);
    expect(resolver.isDeezerUrl('https://deezer.com/fr/album/456')).toBe(true);
    expect(resolver.isDeezerUrl('https://deezer.com/playlist/789')).toBe(true);
    expect(resolver.isDeezerUrl('https://deezer.page.link/abcXYZ')).toBe(true);
    expect(resolver.isDeezerUrl('https://link.deezer.com/s/xyz')).toBe(true);
    expect(resolver.isDeezerUrl('https://open.spotify.com/track/abc')).toBe(false);
    expect(resolver.isDeezerUrl('not a url')).toBe(false);
  });

  it('parses canonical URLs incl. country prefixes', () => {
    expect(resolver.parseDeezerUrl('https://www.deezer.com/track/123')).toEqual({ type: 'track', id: '123' });
    expect(resolver.parseDeezerUrl('https://deezer.com/fr/album/456')).toEqual({ type: 'album', id: '456' });
    expect(resolver.parseDeezerUrl('https://deezer.com/playlist/789')).toEqual({ type: 'playlist', id: '789' });
    expect(resolver.parseDeezerUrl('https://open.spotify.com/track/abc')).toBeNull();
  });

  it('resolves a track with ISRC, cover and provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      expect(String(url)).toContain('/track/123');
      return jsonResponse({
        id: 123,
        title: 'Neon Skyline',
        link: 'https://www.deezer.com/track/123',
        duration: 213,
        preview: 'https://cdns-preview.dzcdn.net/preview.mp3',
        isrc: 'USRC17607839',
        artist: { id: 7, name: 'Midnight Circuit' },
        album: { id: 9, title: 'Neon Skyline', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/xl.jpg' },
      });
    }) as typeof fetch);

    const res = await resolver.resolve('https://www.deezer.com/track/123');
    expect(res?.type).toBe('track');
    expect(res?.provider).toBe('deezer');
    expect(res?.tracks[0]).toMatchObject({
      name: 'Neon Skyline',
      artist: 'Midnight Circuit',
      durationMs: 213000,
      searchQuery: 'Midnight Circuit - Neon Skyline',
      artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/xl.jpg',
      sourceUrl: 'https://www.deezer.com/track/123',
      isrc: 'USRC17607839',
      provider: 'deezer',
    });
  });

  it('falls back to the md5 cover template when cover_xl is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return jsonResponse({
        id: 124,
        title: 'Bare',
        duration: 180,
        isrc: 'USRC17607840',
        md5_image: 'abc123md5',
        artist: { id: 7, name: 'Midnight Circuit' },
        album: { id: 9, title: 'Bare' },
      });
    }) as typeof fetch);

    const res = await resolver.resolve('https://www.deezer.com/track/124');
    expect(res?.tracks[0]?.artworkUrl).toBe(
      'https://cdn-images.dzcdn.net/images/cover/abc123md5/1000x1000-000000-80-0-0.jpg',
    );
  });

  it('resolves an album from header + track list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/album/456/tracks')) {
        return jsonResponse({
          data: [
            { id: 1, title: 'First', duration: 200, isrc: 'USRC10000001', artist: { id: 7, name: 'Band' }, album: { id: 456, title: 'LP' } },
            { id: 2, title: 'Second', duration: 210, isrc: 'USRC10000002', artist: { id: 7, name: 'Band' }, album: { id: 456, title: 'LP' } },
          ],
        });
      }
      return jsonResponse({ id: 456, title: 'LP', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/lp.jpg', artist: { name: 'Band' } });
    }) as typeof fetch);

    const res = await resolver.resolve('https://www.deezer.com/album/456');
    expect(res?.type).toBe('album');
    expect(res?.tracks).toHaveLength(2);
    expect(res?.tracks[0]?.artworkUrl).toBe('https://cdn-images.dzcdn.net/images/cover/lp.jpg');
    expect(res?.tracks[0]?.isrc).toBe('USRC10000001');
  });

  it('resolves share links via ?dest= redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('deezer.page.link')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://deezer.page.link/?link=https://www.deezer.com/track/555&dest=https://www.deezer.com/track/555' },
        });
      }
      return jsonResponse({
        id: 555,
        title: 'Shared',
        duration: 190,
        artist: { id: 7, name: 'Band' },
        album: { id: 1, title: 'Shared', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/s.jpg' },
      });
    }) as typeof fetch);

    expect(await resolver.resolveShareUrl('https://deezer.page.link/abc')).toBe('https://www.deezer.com/track/555');
    const res = await resolver.resolve('https://deezer.page.link/abc');
    expect(res?.tracks[0]?.name).toBe('Shared');
  });

  it('returns null for unknown IDs instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return jsonResponse({ error: { type: 'DataException', message: 'no data' } });
    }) as typeof fetch);

    await expect(resolver.resolve('https://www.deezer.com/track/0')).resolves.toBeNull();
  });
});
