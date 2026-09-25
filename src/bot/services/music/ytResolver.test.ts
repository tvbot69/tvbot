import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveViaHome, resolverEnabled, resolverMissed, squareVideoThumbUrl } from './ytResolver';

const SAVED_URL = process.env.HOME_RESOLVER_URL;
const SAVED_TOKEN = process.env.HOME_RESOLVER_TOKEN;

const setEnv = (url?: string, token?: string) => {
  if (url === undefined) delete process.env.HOME_RESOLVER_URL;
  else process.env.HOME_RESOLVER_URL = url;
  if (token === undefined) delete process.env.HOME_RESOLVER_TOKEN;
  else process.env.HOME_RESOLVER_TOKEN = token;
};

describe('ytResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setEnv('http://127.0.0.1:2335', 'tok');
  });

  it('stays disabled without configuration and never fetches', async () => {
    setEnv(undefined, undefined);
    expect(resolverEnabled()).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(resolveViaHome('abc123def45')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('returns the path on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'C:\\ytres\\cache\\hit1234abc.webm', cached: true }),
    } as Response);
    await expect(resolveViaHome('hit1234abc')).resolves.toBe('C:\\ytres\\cache\\hit1234abc.webm');
    expect(resolverMissed('hit1234abc')).toBe(false);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('treats 502 as a per-video miss without pausing, cached for 10 min', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as Response);
    await expect(resolveViaHome('miss1234abc')).resolves.toBeNull();
    expect(resolverMissed('miss1234abc')).toBe(true);
    // Second attempt for the same id never hits the network.
    await expect(resolveViaHome('miss1234abc')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(resolverEnabled()).toBe(true);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('forwards metadata as capped query params', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'C:\\c\\meta1234abc.webm', cached: false }),
    } as Response);
    await resolveViaHome('meta1234abc', {
      title: 'Around the World',
      artist: 'Daft Punk',
    });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('title=Around+the+World');
    expect(url).toContain('artist=Daft+Punk');
    expect(url).not.toContain('artwork=');

    await resolveViaHome('meta2234abc', { title: 'x'.repeat(300) });
    const capped = new URL(String(fetchSpy.mock.calls[1]?.[0])).searchParams.get('title');
    expect(capped?.length).toBe(200);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('pauses for 2 minutes when the resolver is unreachable (no miss recorded)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(resolveViaHome('down1234abc')).resolves.toBeNull();
    expect(resolverEnabled()).toBe(false);
    expect(resolverMissed('down1234abc')).toBe(false);
    await expect(resolveViaHome('down1234abc')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    setEnv(SAVED_URL, SAVED_TOKEN);
  });
});

describe('chapter cascade (data first, rug fallback)', () => {
  const SAVED_KEY = process.env.YOUTUBE_API_KEY;
  let mod: typeof import('./ytResolver');

  beforeEach(async () => {
    // Fresh module state: pausedUntil/cascade caches from earlier tests
    // must not leak into the routing under test here.
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    process.env.YOUTUBE_API_KEY = 'test-key';
    mod = await import('./ytResolver');
  });

  afterEach(() => {
    if (SAVED_KEY === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = SAVED_KEY;
  });

  it('returns description chapters without probing the home resolver', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      expect(String(input)).toContain('googleapis.com');
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ snippet: { description: '0:00 - Intro\n1:30 - Song' } }] }),
      } as Response;
    });
    await expect(mod.getVideoChapters('data0video1')).resolves.toEqual([
      { title: 'Intro', startMs: 0 },
      { title: 'Song', startMs: 90_000 },
    ]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/chapters'))).toBe(false);
  });

  it('falls back to the home resolver when the description has no timestamps', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ snippet: { description: 'Doors at 17:00. Stream starts soon.' } }] }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chapters: [
            { title: 'Auto Chapter', startMs: 5000 },
            { title: '  Part 2 ', startMs: 0 },
          ],
        }),
      } as Response;
    });
    await expect(mod.getVideoChapters('rug0video00')).resolves.toEqual([
      { title: 'Part 2', startMs: 0 },
      { title: 'Auto Chapter', startMs: 5000 },
    ]);
    expect(spy.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/chapters?id=rug0video00'))).toBe(true);
  });

  it('caches the cascade result so the rug probe does not repeat', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ snippet: { description: 'No timestamps here.' } }] }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ chapters: [{ title: 'A', startMs: 0 }, { title: 'B', startMs: 1_000 }] }),
      } as Response;
    });
    await expect(mod.getVideoChapters('cache0video')).resolves.toEqual([
      { title: 'A', startMs: 0 },
      { title: 'B', startMs: 1_000 },
    ]);
    const callsAfterFirst = spy.mock.calls.length;
    await expect(mod.getVideoChapters('cache0video')).resolves.toEqual([
      { title: 'A', startMs: 0 },
      { title: 'B', startMs: 1_000 },
    ]);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('resolves to null after both legs fail', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(mod.getVideoChapters('both0down00')).resolves.toBeNull();
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('googleapis.com'))).toBe(true);
    expect(urls.some((u) => u.includes('/chapters'))).toBe(true);
  });
});

describe('resolver breakage alerts', () => {
  const WEBHOOK = 'https://discord.test/api/webhooks/alerts';
  let mod: typeof import('./ytResolver');
  let posts: string[];
  let route: (id: string) => Promise<Response>;
  let nowMs: number;

  const advance = (ms: number) => {
    nowMs += ms;
    vi.setSystemTime(nowMs);
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    nowMs = new Date('2026-09-21T15:00:00Z').getTime();
    vi.setSystemTime(nowMs);
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    process.env.RESOLVER_ALERT_WEBHOOK_URL = WEBHOOK;
    posts = [];
    route = async (id: string) =>
      ({ ok: true, status: 200, json: async () => ({ path: `C:\\c\\${id}.webm`, cached: true }) }) as Response;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init: any) => {
      if (String(input) === WEBHOOK) {
        try {
          posts.push(JSON.parse(String(init?.body))?.content ?? '');
        } catch {
          posts.push('');
        }
        return { ok: true, status: 204 } as Response;
      }
      const id = new URL(String(input)).searchParams.get('id') ?? '';
      return route(id);
    }) as any);
    mod = await import('./ytResolver');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.RESOLVER_ALERT_WEBHOOK_URL;
  });

  it('stays silent on healthy traffic', async () => {
    for (let i = 0; i < 10; i++) await mod.resolveViaHome(`okAlert${i}`);
    expect(posts).toHaveLength(0);
  });

  it('alerts when 30%+ of the last 10 calls 502', async () => {
    let n = 0;
    route = async (id: string) => {
      n++;
      return n <= 10
        ? ({ ok: true, status: 200, json: async () => ({ path: `C:\\c\\${id}.webm`, cached: true }) }) as Response
        : ({ ok: false, status: 502 }) as Response;
    };
    for (let i = 0; i < 10; i++) await mod.resolveViaHome(`hitAlert${i}`);
    expect(posts).toHaveLength(0);
    for (let i = 0; i < 4; i++) await mod.resolveViaHome(`missAlert${i}`);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/recent calls 502/);
  });

  it('reminds at most every 30 minutes while the condition persists', async () => {
    route = async () => ({ ok: false, status: 502 }) as Response;
    for (let i = 0; i < 10; i++) await mod.resolveViaHome(`coolA${i}`);
    expect(posts).toHaveLength(1);
    for (let i = 0; i < 4; i++) await mod.resolveViaHome(`coolB${i}`);
    expect(posts).toHaveLength(1);
    advance(31 * 60_000);
    await mod.resolveViaHome('coolC0');
    expect(posts).toHaveLength(2);
  });

  it('alerts after 3 unreachable pauses in an hour', async () => {
    route = async () => {
      throw new Error('down');
    };
    await mod.resolveViaHome('pauseA0');
    expect(posts).toHaveLength(0);
    advance(3 * 60_000);
    await mod.resolveViaHome('pauseB0');
    expect(posts).toHaveLength(0);
    advance(3 * 60_000);
    await mod.resolveViaHome('pauseC0');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/unreachable 3\+ times/);
  });
});

describe('squareVideoThumbUrl', () => {
  afterEach(() => {
    setEnv(SAVED_URL, SAVED_TOKEN);
  });

  it('maps any ytimg variant to the resolver thumb crop', async () => {
    setEnv('http://127.0.0.1:2335/', 'tok');
    // Fresh module: earlier unreachable-pause tests leave the shared
    // instance inside a 2-minute pause (resolverEnabled() false).
    vi.resetModules();
    const { squareVideoThumbUrl: fresh } = await import('./ytResolver');
    expect(fresh('https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg')).toBe(
      'http://127.0.0.1:2335/thumb?id=abcdefghijk',
    );
    expect(fresh('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')).toBe(
      'http://127.0.0.1:2335/thumb?id=abcdefghijk',
    );
    expect(fresh('https://i.ytimg.com/vi_webp/abcdefghijk/mqdefault.webp')).toBe(
      'http://127.0.0.1:2335/thumb?id=abcdefghijk',
    );
  });

  it('passes non-video art and unconfigured resolvers through as null', () => {
    expect(squareVideoThumbUrl('https://i.scdn.co/image/ab67616d0000b273')).toBeNull();
    expect(squareVideoThumbUrl(null)).toBeNull();
    setEnv(undefined, undefined);
    expect(squareVideoThumbUrl('https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg')).toBeNull();
  });
});
