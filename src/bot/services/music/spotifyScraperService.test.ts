import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpotifyScraperService } from './spotifyScraperService';

const htmlPage = (items: unknown[]) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name: 'RAGE',
              owner: { displayName: 'someone' },
              images: [{ url: 'https://img.test/pl.jpg' }],
              trackList: items,
            },
          },
        },
      },
    },
  })}</script><span>3 items</span></body></html>`;

describe('SpotifyScraperService html fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps embed track URIs to spotifyUri for by-ID artwork', async () => {
    const page = htmlPage([
      {
        uri: 'spotify:track:4mF0aVVHtmHQSIdem2Wh0g',
        title: 'GONE 4 A MIN',
        subtitle: 'Yeat',
        duration: 135053,
      },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
      const url = String(input);
      if (url.startsWith('https://open.spotify.com/')) {
        return { ok: true, status: 200, text: async () => page } as Response;
      }
      return { ok: false, status: 403 } as Response;
    }) as any);
    const svc = new SpotifyScraperService();
    const res = await svc.fetchPlaylistPage('73VZK7BqgCVuZr5Z3rv40k', 0, 100);
    expect(res?.tracks[0]?.spotifyUri).toBe('spotify:track:4mF0aVVHtmHQSIdem2Wh0g');
    expect(res?.tracks[0]?.name).toBe('GONE 4 A MIN');
  });

  it('leaves spotifyUri undefined when the embed item has no uri', async () => {
    const page = htmlPage([{ title: 'Mystery', subtitle: 'Nobody', duration: 180000 }]);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
      const url = String(input);
      if (url.startsWith('https://open.spotify.com/')) {
        return { ok: true, status: 200, text: async () => page } as Response;
      }
      return { ok: false, status: 403 } as Response;
    }) as any);
    const svc = new SpotifyScraperService();
    const res = await svc.fetchPlaylistPage('xyz', 0, 100);
    expect(res?.tracks[0]?.spotifyUri).toBeUndefined();
  });
});
