import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicHandler } from './musicHandler';
import { MusicService, playErrorMessage } from '@bot/services/music/musicService';

const makeHandler = () => {
  const manager = { on: vi.fn(), players: { get: () => undefined } };
  const client = { on: vi.fn(), channels: { cache: new Map() } };
  const handler = new MusicHandler(
    client as never,
    { getManager: () => manager } as never,
    { getQueueInfo: () => null, is247: () => false } as never,
  );
  return handler as unknown as {
    checkFallbackBudget: (guildId: string, key: string) => boolean;
    recordFallbackAttempt: (guildId: string, key: string, id?: string) => void;
    clearFallbackState: (guildId: string) => void;
    findAlternatePlayableTrack: (
      manager: unknown,
      player: unknown,
      track: unknown,
      guildId: string,
      key: string,
      err?: unknown,
    ) => Promise<unknown>;
  };
};

const mockPlayer = (nodeId = 'test-node') => ({ node: { identifier: nodeId } });

const failedTrack = {
  identifier: 'yt-blocked',
  title: 'Esme (Official Video)',
  author: 'Mond',
  duration: 174000,
  uri: 'https://youtube.com/watch?v=blocked',
  encoded: 'enc-blocked',
};

describe('MusicHandler fallback budgets (Phase 3.2)', () => {
  it('caps retries per track and per guild window', () => {
    const handler = makeHandler();
    expect(handler.checkFallbackBudget('g1', 'track-a')).toBe(true);

    handler.recordFallbackAttempt('g1', 'track-a', 'alt-1');
    handler.recordFallbackAttempt('g1', 'track-a', 'alt-2');
    handler.recordFallbackAttempt('g1', 'track-a', 'alt-3');
    expect(handler.checkFallbackBudget('g1', 'track-a')).toBe(false);
    // Other tracks in the same guild still get their chances
    expect(handler.checkFallbackBudget('g1', 'track-b')).toBe(true);
  });

  it('stops the whole guild after 5 fallbacks in 60s', () => {
    const handler = makeHandler();
    for (let i = 0; i < 5; i++) {
      expect(handler.checkFallbackBudget('g2', `track-${i}`)).toBe(true);
      handler.recordFallbackAttempt('g2', `track-${i}`, `alt-${i}`);
    }
    expect(handler.checkFallbackBudget('g2', 'track-5')).toBe(false);
  });

  it('resets budgets when the queue ends', () => {
    const handler = makeHandler();
    handler.recordFallbackAttempt('g3', 'track-a', 'alt-1');
    handler.recordFallbackAttempt('g3', 'track-a', 'alt-2');
    handler.recordFallbackAttempt('g3', 'track-a', 'alt-3');
    expect(handler.checkFallbackBudget('g3', 'track-a')).toBe(false);
    handler.clearFallbackState('g3');
    expect(handler.checkFallbackBudget('g3', 'track-a')).toBe(true);
  });

  it('never returns an already-tried upload (no fallback loops)', async () => {
    const handler = makeHandler();
    const search = vi.fn(async ({ source }: { source: string }) => {
      if (source === 'youtube') {
        return {
          tracks: [
            { identifier: 'yt-blocked', duration: 174000 },
            { identifier: 'yt-alt', duration: 174000 },
          ],
        };
      }
      return { tracks: [{ identifier: 'sc-alt', duration: 174000 }] };
    });

    const first = (await handler.findAlternatePlayableTrack(
      { search },
      mockPlayer(),
      failedTrack,
      'g4',
      'enc-blocked',
    )) as { identifier: string };
    expect(first.identifier).toBe('yt-alt');

    // yt-alt already failed too: second lookup must skip both known ids
    const second = (await handler.findAlternatePlayableTrack(
      { search },
      mockPlayer(),
      failedTrack,
      'g4',
      'enc-blocked',
    )) as { identifier: string };
    expect(second.identifier).toBe('sc-alt');
  });
});

describe('resolvePlaylistTrack (ladder)', () => {
  const makeSvc = (searchImpl: (args: { query: string; source: string }) => Promise<unknown>) => {
    const search = vi.fn(searchImpl);
    const svc = new MusicService(
      { getManager: () => ({ search }) } as never,
      {} as never,
      {} as never,
    ) as unknown as {
      resolvePlaylistTrack: (
        player: unknown,
        spTrack: { searchQuery: string; name: string; artist: string },
      ) => Promise<{ lavalinkTrack: { identifier: string }; rung: string } | null>;
    };
    return { svc, search };
  };
  const spTrack = { searchQuery: 'Mond - Esme', name: 'Esme', artist: 'Mond' };
  const player = { node: { identifier: 'test-node' } };

  it('takes the YouTube hit when present', async () => {
    const { svc, search } = makeSvc(async () => ({ tracks: [{ identifier: 'yt1' }] }));
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(res?.lavalinkTrack.identifier).toBe('yt1');
    expect(res?.rung).toBe('plugin');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('tries SoundCloud when YouTube misses', async () => {
    const { svc } = makeSvc(async ({ source }: { query: string; source: string }) =>
      source === 'youtube' ? { tracks: [] } : { tracks: [{ identifier: 'sc1' }] },
    );
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(res?.lavalinkTrack.identifier).toBe('sc1');
    expect(res?.rung).toBe('soundcloud');
  });

  it('returns null when both sources miss', async () => {
    const { svc } = makeSvc(async () => ({ tracks: [] }));
    await expect(svc.resolvePlaylistTrack(player, spTrack)).resolves.toBeNull();
  });
});

describe('null-track events (late failures after advancement)', () => {
  const captureHandlers = () => {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      on: vi.fn((event: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(event, cb);
      }),
      players: { get: () => undefined },
    };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false } as never,
    );
    return handlers;
  };

  const deadPlayer = () =>
    ({
      guildId: 'g9',
      current: null,
      queue: { unshift: vi.fn(), size: 0, isEmpty: true },
      skip: vi.fn(async () => true),
      playing: false,
      paused: false,
    }) as never;

  it('trackException with null track does not throw and does not search', async () => {
    const handlers = captureHandlers();
    const onException = handlers.get('trackException');
    expect(onException).toBeDefined();
    await expect(onException!(deadPlayer(), null, { message: 'late failure' })).resolves.toBeUndefined();
  });

  it('trackStuck with null track does not throw', async () => {
    const handlers = captureHandlers();
    const onStuck = handlers.get('trackStuck');
    expect(onStuck).toBeDefined();
    await expect(onStuck!(deadPlayer(), null, 10000)).resolves.toBeUndefined();
  });
});

describe('song-identity circuit breaker', () => {
  const captureHandlers = () => {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      on: vi.fn((event: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(event, cb);
      }),
      players: { get: () => undefined },
      search: vi.fn(async () => ({ tracks: [{ identifier: 'alt-1', duration: 174000 }] })),
    };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false } as never,
    );
    return { handlers, manager };
  };

  const livePlayer = (): any => {
    const data = new Map<string, unknown>();
    return {
      guildId: 'g-song',
      current: { identifier: 'v1', encoded: 'enc-v1', uri: 'u1', title: 'Stormi Daniels', author: 'Rich Amiri', duration: 200000 },
      queue: { unshift: vi.fn(), size: 1, isEmpty: false },
      skip: vi.fn(async () => true),
      play: vi.fn(async () => true),
      playing: false,
      paused: false,
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => void data.set(k, v),
    } as never;
  };

  it('abandons the same song after repeated failures without new searches', async () => {
    const { handlers, manager } = captureHandlers();
    const onException = handlers.get('trackException')!;
    const search = manager.search as ReturnType<typeof vi.fn>;

    // Failures 1-2: fallback attempted (2 searches each: youtube + soundcloud)
    await onException(livePlayer(), { ...livePlayer().current }, { message: 'blocked' });
    await onException(livePlayer(), { ...livePlayer().current }, { message: 'blocked' });
    const searchesAfterTwo = search.mock.calls.length;
    expect(searchesAfterTwo).toBeGreaterThan(0);

    // Failure 3: song exhausted — skip with zero new searches
    await onException(livePlayer(), { ...livePlayer().current }, { message: 'blocked' });
    expect(search.mock.calls.length).toBe(searchesAfterTwo);
  });
});

describe('preview-cut detection (short finishes feed the breaker)', () => {
  const captureHandlers = () => {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      on: vi.fn((event: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(event, cb);
      }),
      players: { get: () => undefined },
    };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const handler = new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false } as never,
    ) as unknown as {
      songFailureCounts: Map<string, { count: number; firstAt: number }>;
    };
    return { handlers, handler };
  };

  const previewTrack = {
    identifier: 'sc-preview',
    encoded: 'enc-preview',
    title: 'Hit Song',
    author: 'Major Artist',
    duration: 200000,
    sourceName: 'soundcloud',
  };

  const finishedPlayer = (startedAgoMs: number) => {
    const data = new Map<string, unknown>([['trackStartedAt', Date.now() - startedAgoMs]]);
    return {
      guildId: 'g-preview',
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => void data.set(k, v),
    };
  };

  it('counts a 30s finish of a 200s track toward abandonment', async () => {
    const { handlers, handler } = captureHandlers();
    const onEnd = handlers.get('trackEnd')!;
    await onEnd(finishedPlayer(30000), previewTrack, 'finished');
    expect(handler.songFailureCounts.size).toBe(1);
  });

  it('ignores full-length finishes and non-finish reasons', async () => {
    const { handlers, handler } = captureHandlers();
    const onEnd = handlers.get('trackEnd')!;
    await onEnd(finishedPlayer(200000), previewTrack, 'finished');
    await onEnd(finishedPlayer(30000), previewTrack, 'stopped');
    expect(handler.songFailureCounts.size).toBe(0);
  });
});

describe('clientFailuresText', () => {
  const fn = (MusicHandler as unknown as {
    clientFailuresText: (reason: unknown) => string;
  }).clientFailuresText;

  it('compacts per-client failures onto one line', () => {
    const reason =
      'All clients failed.\r\nClient [ANDROID_VR] failed: This video requires login.\r\nClient [WEB] failed: No supported audio streams available.';
    expect(fn(reason)).toBe(
      'ANDROID_VR: This video requires login | WEB: No supported audio streams available',
    );
  });

  it('falls back to truncated text without client lines', () => {
    expect(fn('plain failure')).toBe('plain failure');
    expect(fn(undefined)).toBe('');
  });
});

describe('resolver rung exclusion for local tracks', () => {
  it('never calls tryResolver for a failed local track even on Home with resolver on', async () => {
    const savedUrl = process.env.HOME_RESOLVER_URL;
    const savedToken = process.env.HOME_RESOLVER_TOKEN;
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    try {
      const { healthFor, ladderFor } = await import('@bot/services/music/youtubeHealth');
      healthFor('Home').recordSuccess();
      const homePlayer = { node: { identifier: 'Home' } };
      // Sanity: the resolver rung would exist for a YouTube failure here.
      expect(ladderFor(homePlayer)).toContain('resolver');

      const manager = { on: vi.fn(), players: { get: () => undefined } };
      const client = { on: vi.fn(), channels: { cache: new Map() } };
      const handler = new MusicHandler(
        client as never,
        { getManager: () => manager } as never,
        { getQueueInfo: () => null, is247: () => false } as never,
      ) as unknown as {
        findAlternatePlayableTrack: (
          manager: unknown,
          player: unknown,
          track: unknown,
          guildId: string,
          key: string,
          err?: unknown,
        ) => Promise<unknown>;
        tryResolver: (player: unknown, track: unknown) => Promise<unknown>;
      };
      const resolverSpy = vi.spyOn(handler, 'tryResolver');
      const search = vi.fn(async ({ source }: { source: string }) =>
        source === 'soundcloud'
          ? { tracks: [{ identifier: 'sc-local-alt', duration: 174000 }] }
          : { tracks: [] },
      );
      const localTrack = { ...failedTrack, sourceName: 'local', identifier: 'local-cache-id' };
      const res = (await handler.findAlternatePlayableTrack(
        { search },
        homePlayer,
        localTrack,
        'g-local',
        'enc-local',
      )) as { identifier: string };
      expect(resolverSpy).not.toHaveBeenCalled();
      expect(res.identifier).toBe('sc-local-alt');
    } finally {
      if (savedUrl === undefined) delete process.env.HOME_RESOLVER_URL;
      else process.env.HOME_RESOLVER_URL = savedUrl;
      if (savedToken === undefined) delete process.env.HOME_RESOLVER_TOKEN;
      else process.env.HOME_RESOLVER_TOKEN = savedToken;
    }
  });
});

describe('HOME_PLUGIN_RUNG flag', () => {
  const withEnv = async (rung: string | undefined) => {
    const savedUrl = process.env.HOME_RESOLVER_URL;
    const savedToken = process.env.HOME_RESOLVER_TOKEN;
    const savedRung = process.env.HOME_PLUGIN_RUNG;
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    if (rung === undefined) delete process.env.HOME_PLUGIN_RUNG;
    else process.env.HOME_PLUGIN_RUNG = rung;
    try {
      const { healthFor, ladderFor } = await import('@bot/services/music/youtubeHealth');
      healthFor('Home').recordSuccess();
      return ladderFor({ node: { identifier: 'Home' } });
    } finally {
      if (savedUrl === undefined) delete process.env.HOME_RESOLVER_URL;
      else process.env.HOME_RESOLVER_URL = savedUrl;
      if (savedToken === undefined) delete process.env.HOME_RESOLVER_TOKEN;
      else process.env.HOME_RESOLVER_TOKEN = savedToken;
      if (savedRung === undefined) delete process.env.HOME_PLUGIN_RUNG;
      else process.env.HOME_PLUGIN_RUNG = savedRung;
      const { healthFor } = await import('@bot/services/music/youtubeHealth');
      healthFor('Home').recordSuccess();
    }
  };

  it('drops the plugin rung on Home by default', async () => {
    expect(await withEnv(undefined)).toEqual(['resolver', 'soundcloud']);
  });

  it('restores the plugin rung with HOME_PLUGIN_RUNG=on', async () => {
    expect(await withEnv('on')).toEqual(['resolver', 'plugin', 'soundcloud']);
  });

  it('never gates public nodes', async () => {
    const { healthFor, ladderFor } = await import('@bot/services/music/youtubeHealth');
    healthFor('MilloHost').recordSuccess();
    expect(ladderFor({ node: { identifier: 'MilloHost' } })).toEqual(['plugin', 'soundcloud']);
  });
});

describe('okTimer lifecycle', () => {
  it('clears stale okTimers on playerDestroy', async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      on: vi.fn((event: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(event, cb);
      }),
      players: { get: () => undefined },
    };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const handler = new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false } as never,
    ) as unknown as { okTimers: Map<string, NodeJS.Timeout> };
    const timer = setTimeout(() => undefined, 15000);
    handler.okTimers.set('g-destroy', timer);
    const onDestroy = handlers.get('playerDestroy')!;
    expect(onDestroy).toBeDefined();
    await onDestroy({ guildId: 'g-destroy', get: () => undefined } as never);
    expect(handler.okTimers.has('g-destroy')).toBe(false);
  });
});

describe('playErrorMessage', () => {
  it('explains each failure mode distinctly', () => {
    expect(playErrorMessage('no-nodes')).toMatch(/rate-limited/i);
    expect(playErrorMessage('voice')).toMatch(/voice channel/i);
    expect(playErrorMessage('empty-spotify')).toMatch(/Spotify/i);
    expect(playErrorMessage(undefined)).toMatch(/music node/i);
  });
});

describe('resolver duration gate (wrong-song guard)', () => {
  const savedEnv = () => {
    const savedUrl = process.env.HOME_RESOLVER_URL;
    const savedToken = process.env.HOME_RESOLVER_TOKEN;
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    return () => {
      if (savedUrl === undefined) delete process.env.HOME_RESOLVER_URL;
      else process.env.HOME_RESOLVER_URL = savedUrl;
      if (savedToken === undefined) delete process.env.HOME_RESOLVER_TOKEN;
      else process.env.HOME_RESOLVER_TOKEN = savedToken;
    };
  };

  const mockFetchPath = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'C:\\c\\x.webm', cached: false }),
    } as Response);

  const homePlayer = (fileLengthMs: number) =>
    ({
      guildId: 'g-dur',
      node: {
        identifier: 'Home',
        rest: {
          loadTracks: async () => ({
            loadType: 'track',
            data: {
              encoded: 'enc-x',
              info: {
                title: 'raw',
                author: 'raw',
                length: fileLengthMs,
                uri: 'u',
                artworkUrl: undefined,
                isStream: false,
              },
            },
          }),
        },
      },
    }) as never;

  const failedTrack = {
    identifier: 'dQw4w9WgXcQ',
    sourceName: 'youtube',
    title: 'Hit Song',
    author: 'Major Artist',
    duration: 174000,
    uri: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    requester: { id: 'u1', tag: 'tester' },
    artworkUrl: 'https://img.test/c.jpg',
  };

  const makeHandlerWithResolver = () => {
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    return new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      { getQueueInfo: () => null, is247: () => false } as never,
    ) as unknown as {
      tryResolver: (player: unknown, track: unknown) => Promise<unknown>;
    };
  };

  it('refuses a duration-mismatched resolver file on the fallback path', async () => {
    const restore = savedEnv();
    try {
      const fetchSpy = mockFetchPath();
      const handler = makeHandlerWithResolver();
      await expect(handler.tryResolver(homePlayer(600000), failedTrack)).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  });

  it('accepts a matching resolver file with adopted metadata', async () => {
    const restore = savedEnv();
    try {
      mockFetchPath();
      const handler = makeHandlerWithResolver();
      const res = (await handler.tryResolver(homePlayer(174000), failedTrack)) as {
        title: string;
        author: string;
      };
      expect(res.title).toBe('Hit Song');
      expect(res.author).toBe('Major Artist');
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  });

  it('refuses a duration-mismatched resolver file on the new-play path', async () => {
    const restore = savedEnv();
    try {
      mockFetchPath();
      const svc = new MusicService(
        { getManager: () => ({}) } as never,
        {} as never,
        {} as never,
      ) as unknown as {
        tryResolverTrack: (player: unknown, track: unknown) => Promise<unknown>;
      };
      const ytTrack = {
        identifier: 'dQw4w9WgXcQ',
        duration: 174000,
        requester: { id: 'u1', tag: 'tester' },
      };
      await expect(svc.tryResolverTrack(homePlayer(600000), ytTrack)).resolves.toBeNull();
      const res = (await svc.tryResolverTrack(homePlayer(174000), ytTrack)) as {
        duration: number;
      };
      expect(res.duration).toBe(174000);
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  });
});

describe('JIT pending Spotify entries', () => {
  const sp = (i: number) => ({
    searchQuery: `Artist${i} - Title${i}`,
    name: `Title${i}`,
    artist: `Artist${i}`,
    durationMs: 180000 + i,
    artworkUrl: `https://img.test/${i}.jpg`,
    spotifyUri: `spotify:track:${i}`,
  });

  const makeJit = (searchImpl?: (args: { query: string; source: string }) => Promise<unknown>) => {
    const search = vi.fn(
      searchImpl ??
        (async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, title: 'raw', author: 'raw' }] })),
    );
    const queued: unknown[] = [];
    const player = {
      guildId: 'g-jit',
      node: { identifier: 'test-node' },
      playing: false,
      paused: false,
      queue: {
        add: (t: unknown) => {
          queued.push(t);
        },
        get size() {
          return queued.length;
        },
        isEmpty: false,
        clear: vi.fn(() => {
          queued.length = 0;
        }),
        shuffle: vi.fn(),
      },
      play: vi.fn(async () => true),
      destroy: vi.fn(async () => true),
    };
    const players = new Map([['g-jit', player]]);
    const handlers = new Map<string, (...args: never[]) => void>();
    const manager = {
      search,
      players: { get: (id: string) => players.get(id) },
      on: vi.fn((ev: string, cb: (...args: never[]) => void) => {
        handlers.set(ev, cb);
      }),
    };
    const svc = new MusicService(
      { getManager: () => manager } as never,
      {} as never,
      { set247: () => undefined } as never,
    ) as unknown as {
      topUpPending: (guildId: string) => Promise<void>;
      pendingSpotify: Map<string, Array<{ spTrack: unknown }>>;
      mapPendingEntry: (e: unknown) => { title: string; author: string; duration: number; source: string };
      stop: (guildId: string) => Promise<void>;
      clear: (guildId: string) => boolean;
      shuffle: (guildId: string) => boolean;
    };
    return { svc, player, queued, handlers, search };
  };

  const seed = (svc: { pendingSpotify: Map<string, Array<{ spTrack: unknown }>> }, n: number) => {
    const entries = Array.from({ length: n }, (_, i) => ({
      spTrack: sp(i),
      requester: { id: 'u1' },
      spotifyUrl: 'spotify:playlist:p',
      override: undefined,
    }));
    svc.pendingSpotify.set('g-jit', entries as never);
  };

  it('binds advance triggers on construction', () => {
    const { handlers } = makeJit();
    expect(handlers.has('trackStart')).toBe(true);
    expect(handlers.has('trackEnd')).toBe(true);
    expect(handlers.has('queueEnd')).toBe(true);
    expect(handlers.has('playerDestroy')).toBe(true);
  });

  it('resolves 2 ahead in order with adopted metadata', async () => {
    const { svc, queued, search } = makeJit();
    seed(svc, 5);
    await svc.topUpPending('g-jit');
    expect(queued).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect((queued[0] as { title: string }).title).toBe('Title0');
    expect((queued[1] as { title: string }).title).toBe('Title1');
    expect(svc.pendingSpotify.get('g-jit')).toHaveLength(3);
  });

  it('refills as playback advances and drains pending', async () => {
    const { svc, queued } = makeJit();
    seed(svc, 3);
    await svc.topUpPending('g-jit');
    expect(queued).toHaveLength(2);
    queued.shift();
    await svc.topUpPending('g-jit');
    expect(queued).toHaveLength(2);
    expect((queued[1] as { title: string }).title).toBe('Title2');
    expect(svc.pendingSpotify.has('g-jit')).toBe(false);
  });

  it('skips unresolvable entries without stalling', async () => {
    const { svc, queued } = makeJit(async ({ query }: { query: string; source: string }) =>
      query.includes('Title1') ? { tracks: [] } : { tracks: [{ identifier: 'yt1', duration: 180000 }] },
    );
    seed(svc, 3);
    await svc.topUpPending('g-jit');
    expect(queued).toHaveLength(2);
    expect((queued[0] as { title: string }).title).toBe('Title0');
    expect((queued[1] as { title: string }).title).toBe('Title2');
    expect(svc.pendingSpotify.has('g-jit')).toBe(false);
  });

  it('stop and clear drop pending entries', async () => {
    const { svc } = makeJit();
    seed(svc, 3);
    expect(svc.clear('g-jit')).toBe(true);
    expect(svc.pendingSpotify.has('g-jit')).toBe(false);
    seed(svc, 3);
    await svc.stop('g-jit');
    expect(svc.pendingSpotify.has('g-jit')).toBe(false);
  });

  it('shuffle randomizes pending order without losing entries', async () => {
    const { svc } = makeJit();
    seed(svc, 5);
    expect(svc.shuffle('g-jit')).toBe(true);
    const pending = svc.pendingSpotify.get('g-jit') ?? [];
    expect(pending).toHaveLength(5);
    const names = pending.map((e) => (e.spTrack as { name: string }).name).sort();
    expect(names).toEqual(['Title0', 'Title1', 'Title2', 'Title3', 'Title4']);
  });

  it('maps pending entries to truthful display tracks', () => {
    const { svc } = makeJit();
    const track = svc.mapPendingEntry({
      spTrack: sp(0),
      requester: { id: 'u1' },
      spotifyUrl: 'spotify:playlist:p',
      override: undefined,
    });
    expect(track.title).toBe('Title0');
    expect(track.author).toBe('Artist0');
    expect(track.duration).toBe(180000);
    expect(track.source).toBe('spotify');
  });
});
