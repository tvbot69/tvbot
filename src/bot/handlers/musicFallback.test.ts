import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicHandler } from './musicHandler';
import { MusicService, playErrorMessage } from '@bot/services/music/musicService';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';

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

describe('seek-stall recovery (re-seek once before fallback)', () => {
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

  const seekPlayer = (): any => {
    const data = new Map<string, unknown>([
      ['lastUserSeekAt', Date.now() - 5000],
      ['lastUserSeekPos', 1500000],
    ]);
    return {
      guildId: 'g-seek',
      current: { identifier: 'v1', encoded: 'enc-v1', uri: 'u1', title: 'Hour Set', author: 'DJ', duration: 3600000 },
      queue: { unshift: vi.fn(), size: 1, isEmpty: false },
      skip: vi.fn(async () => true),
      play: vi.fn(async () => true),
      seek: vi.fn(async () => true),
      playing: true,
      paused: false,
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => void data.set(k, v),
    } as never;
  };

  const stuckTrack = () => ({
    identifier: 'v1',
    encoded: 'enc-v1',
    uri: 'u1',
    title: 'Hour Set',
    author: 'DJ',
    duration: 3600000,
  });

  it('re-issues the user seek once instead of burning fallback budget', async () => {
    const { handlers, manager } = captureHandlers();
    const onStuck = handlers.get('trackStuck')!;
    const player = seekPlayer();
    const search = manager.search as ReturnType<typeof vi.fn>;

    await onStuck(player, stuckTrack(), 10000);

    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(1500000);
    expect(search).not.toHaveBeenCalled();
    expect(player.get('seekStallRetried')).toBe(true);
  });

  it('falls through to normal fallback when it stalls again', async () => {
    const { handlers, manager } = captureHandlers();
    const onStuck = handlers.get('trackStuck')!;
    const player = seekPlayer();
    const search = manager.search as ReturnType<typeof vi.fn>;

    await onStuck(player, stuckTrack(), 10000);
    expect(search).not.toHaveBeenCalled();
    await onStuck(player, stuckTrack(), 10000);
    expect(search.mock.calls.length).toBeGreaterThan(0);
  });

  it('ignores stale seeks outside the window', async () => {
    const { handlers, manager } = captureHandlers();
    const onStuck = handlers.get('trackStuck')!;
    const player = seekPlayer();
    player.set('lastUserSeekAt', Date.now() - 120000);
    const search = manager.search as ReturnType<typeof vi.fn>;

    await onStuck(player, stuckTrack(), 10000);

    expect(player.seek).not.toHaveBeenCalled();
    expect(search.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('preview-cut detection (short finishes feed the breaker)', () => {  const captureHandlers = () => {
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
  const withEnv = async (rung: string | undefined, ladderMode?: string) => {
    const savedUrl = process.env.HOME_RESOLVER_URL;
    const savedToken = process.env.HOME_RESOLVER_TOKEN;
    const savedRung = process.env.HOME_PLUGIN_RUNG;
    const savedMode = process.env.HOME_LADDER_MODE;
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    if (rung === undefined) delete process.env.HOME_PLUGIN_RUNG;
    else process.env.HOME_PLUGIN_RUNG = rung;
    if (ladderMode === undefined) delete process.env.HOME_LADDER_MODE;
    else process.env.HOME_LADDER_MODE = ladderMode;
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
      if (savedMode === undefined) delete process.env.HOME_LADDER_MODE;
      else process.env.HOME_LADDER_MODE = savedMode;
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

  it('forces plugin-first order with HOME_LADDER_MODE=plugin-first-test', async () => {
    // Trial rung wins even when HOME_PLUGIN_RUNG is off/unset.
    expect(await withEnv(undefined, 'plugin-first-test')).toEqual([
      'plugin',
      'resolver',
      'soundcloud',
    ]);
    expect(await withEnv('off', 'plugin-first-test')).toEqual([
      'plugin',
      'resolver',
      'soundcloud',
    ]);
  });

  it('ignores any other HOME_LADDER_MODE value', async () => {
    expect(await withEnv(undefined, 'resolver-first')).toEqual(['resolver', 'soundcloud']);
  });

  it('still skips the plugin rung on outage errors when trial puts it first', async () => {
    const savedMode = process.env.HOME_LADDER_MODE;
    const savedUrl = process.env.HOME_RESOLVER_URL;
    const savedToken = process.env.HOME_RESOLVER_TOKEN;
    process.env.HOME_LADDER_MODE = 'plugin-first-test';
    process.env.HOME_RESOLVER_URL = 'http://127.0.0.1:2335';
    process.env.HOME_RESOLVER_TOKEN = 'tok';
    try {
      const { healthFor, ladderFor, YoutubeHealth } = await import(
        '@bot/services/music/youtubeHealth'
      );
      healthFor('Home').recordSuccess();
      const full = ladderFor({ node: { identifier: 'Home' } });
      expect(full).toEqual(['plugin', 'resolver', 'soundcloud']);
      // Same filter as findAlternatePlayableTrack: a plugin outage failure
      // falls through to resolver in the same call, no second track start.
      const outage = { message: 'This video requires login.' };
      const rungs = full.filter((r) => !(YoutubeHealth.isOutage(outage) && r === 'plugin'));
      expect(rungs).toEqual(['resolver', 'soundcloud']);
    } finally {
      if (savedMode === undefined) delete process.env.HOME_LADDER_MODE;
      else process.env.HOME_LADDER_MODE = savedMode;
      if (savedUrl === undefined) delete process.env.HOME_RESOLVER_URL;
      else process.env.HOME_RESOLVER_URL = savedUrl;
      if (savedToken === undefined) delete process.env.HOME_RESOLVER_TOKEN;
      else process.env.HOME_RESOLVER_TOKEN = savedToken;
      const { healthFor } = await import('@bot/services/music/youtubeHealth');
      healthFor('Home').recordSuccess();
    }
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

  const makeJit = (
    searchImpl?: (args: { query: string; source: string }) => Promise<unknown>,
    artImpl?: (title: string, artist: string) => Promise<string | null>,
  ) => {
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
      undefined,
      { getTrackCoverUrl: artImpl ?? (async () => null) } as never,
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

  it('warms artwork for upcoming entries beyond the eager fill', async () => {
    const artImpl = vi.fn(async (title: string) => 'https://img.test/w.jpg');
    const { svc } = makeJit(undefined, artImpl);
    // Artless entries: the realistic gap case (API tracks with art need nothing).
    const bare = Array.from({ length: 6 }, (_, i) => ({
      spTrack: { ...sp(i), artworkUrl: undefined },
      requester: { id: 'u1' },
      spotifyUrl: 'spotify:playlist:p',
      override: undefined,
    }));
    svc.pendingSpotify.set('g-jit', bare as never);
    await svc.topUpPending('g-jit');
    // 2 resolve-time backfills + 2 warmed ahead; Title4+ untouched.
    const called = artImpl.mock.calls.map((c) => c[0]).sort();
    expect(called).toEqual(['Title0', 'Title1', 'Title2', 'Title3']);
  });

  it('skips warmup while Spotify is rate-limited', async () => {
    const artImpl = vi.fn(async (title: string) => 'https://img.test/w.jpg');
    const { svc } = makeJit(undefined, artImpl);
    const bare = Array.from({ length: 6 }, (_, i) => ({
      spTrack: { ...sp(i), artworkUrl: undefined },
      requester: { id: 'u1' },
      spotifyUrl: 'spotify:playlist:p',
      override: undefined,
    }));
    svc.pendingSpotify.set('g-jit', bare as never);
    vi.spyOn(SpotifySearchApi, 'isRateLimited').mockReturnValue(true);
    try {
      await svc.topUpPending('g-jit');
      // Only the 2 resolve-time backfills; warmup stayed quiet.
      const limited = artImpl.mock.calls.map((c) => c[0]).sort();
      expect(limited).toEqual(['Title0', 'Title1']);
    } finally {
      vi.restoreAllMocks();
      SpotifySearchApi.clearRateLimit();
    }
  });
});

describe('resolve artwork backfill', () => {
  const player = { node: { identifier: 'test-node' } };
  const spTrack = { searchQuery: 'Mond - Esme', name: 'Esme', artist: 'Mond' };

  const makeArtSvc = (
    artImpl?: () => Promise<string | null>,
    searchImpl?: (args: { query: string; source: string }) => Promise<unknown>,
    byIdImpl?: () => Promise<string | null>,
    artistImpl?: (...args: never[]) => Promise<string | null>,
  ) => {
    const search = vi.fn(
      searchImpl ??
        (async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, title: 'Vid Title', author: 'Vid Artist' }] })),
    );
    const manager = { search, on: vi.fn(), players: { get: () => undefined } };
    const getTrackCoverUrl = vi.fn(artImpl ?? (async () => 'https://img.test/backfilled.jpg'));
    const getTrackCoverBySpotifyId = vi.fn(byIdImpl ?? (async () => null));
    const getArtistImageUrl = vi.fn(artistImpl ?? (async () => null));
    const svc = new MusicService(
      { getManager: () => manager } as never,
      new SpotifyResolver({} as never, {} as never),
      {} as never,
      undefined,
      { getTrackCoverUrl, getTrackCoverBySpotifyId, getArtistImageUrl } as never,
    ) as unknown as {
      resolvePlaylistTrack: (
        player: unknown,
        spTrack: unknown,
      ) => Promise<{ lavalinkTrack: { artworkUrl?: string } } | null>;
      maybeBackfillArt: (
        track: unknown,
        knownArt: string | undefined,
        title: string,
        artist: string,
        timeoutMs: number,
        spotifyUri?: string,
      ) => Promise<void>;
    };
    return { svc, getTrackCoverUrl, getTrackCoverBySpotifyId, getArtistImageUrl };
  };

  it('backfills missing art via ArtworkService with clean Spotify meta', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc();
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(getTrackCoverUrl).toHaveBeenCalledWith('Esme', 'Mond');
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/backfilled.jpg');
  });

  it('stamps Spotify art at resolve time and skips the lookup', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc();
    const res = await svc.resolvePlaylistTrack(player, { ...spTrack, artworkUrl: 'https://img.test/sp.jpg' });
    expect(getTrackCoverUrl).not.toHaveBeenCalled();
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/sp.jpg');
  });

  it('skips the lookup when the raw track already has art', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc(
      undefined,
      async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, artworkUrl: 'https://img.test/yt.jpg' }] }),
    );
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(getTrackCoverUrl).not.toHaveBeenCalled();
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/yt.jpg');
  });

  it('falls back to the artist picture when no track cover exists', async () => {
    const { svc, getTrackCoverUrl, getArtistImageUrl } = makeArtSvc(
      async () => null,
      undefined,
      undefined,
      async () => 'https://img.test/artist.jpg',
    );
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(getTrackCoverUrl).toHaveBeenCalledWith('Esme', 'Mond');
    expect(getArtistImageUrl).toHaveBeenCalledWith('Mond', 'Esme');
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/artist.jpg');
  });

  it('finds the performer in the video title when the uploader differs', async () => {
    const { svc, getArtistImageUrl } = makeArtSvc(
      async () => null,
      undefined,
      undefined,
      async (artist: string) => (artist === 'EsDeeKid' ? 'https://img.test/esdeekid.jpg' : null),
    );
    const liveTrack = {
      searchQuery: 'gloss - EsDeeKid live',
      name: 'EsDeeKid - Live at Silver Spring, MD [FULL SET | 9/13/26]',
      artist: 'gloss',
    };
    const res = await svc.resolvePlaylistTrack(player, liveTrack);
    expect(getArtistImageUrl).toHaveBeenCalledWith('EsDeeKid', liveTrack.name);
    expect(getArtistImageUrl).not.toHaveBeenCalledWith('gloss', expect.anything());
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/esdeekid.jpg');
  });

  it('gives up after the background timeout when providers hang', async () => {
    vi.useFakeTimers();
    try {
      const { svc, getTrackCoverUrl } = makeArtSvc(() => new Promise<null>(() => undefined));
      const pending = svc.resolvePlaylistTrack(player, spTrack);
      await vi.advanceTimersByTimeAsync(10100);
      const res = await pending;
      expect(res?.lavalinkTrack.artworkUrl).toBeUndefined();
      expect(getTrackCoverUrl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves fine with no artwork service wired', async () => {
    const search = vi.fn(async () => ({ tracks: [{ identifier: 'yt1', duration: 180000 }] }));
    const manager = { search, on: vi.fn(), players: { get: () => undefined } };
    const svc = new MusicService(
      { getManager: () => manager } as never,
      {} as never,
      {} as never,
    ) as unknown as {
      resolvePlaylistTrack: (
        player: unknown,
        spTrack: unknown,
      ) => Promise<{ lavalinkTrack: { artworkUrl?: string } } | null>;
    };
    const res = await svc.resolvePlaylistTrack(player, spTrack);
    expect(res?.lavalinkTrack.artworkUrl).toBeUndefined();
  });

  it('prefers exact by-ID art over the name cascade', async () => {
    const { svc, getTrackCoverUrl, getTrackCoverBySpotifyId } = makeArtSvc(
      async () => 'https://img.test/cascade.jpg',
      undefined,
      async () => 'https://img.test/exact.jpg',
    );
    const res = await svc.resolvePlaylistTrack(player, {
      ...spTrack,
      spotifyUri: 'spotify:track:4mF0aVVHtmHQSIdem2Wh0g',
    });
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/exact.jpg');
    expect(getTrackCoverBySpotifyId).toHaveBeenCalledWith('4mF0aVVHtmHQSIdem2Wh0g');
    expect(getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('falls back to the name cascade when by-ID misses', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc(
      async () => 'https://img.test/cascade.jpg',
      undefined,
      async () => null,
    );
    const res = await svc.resolvePlaylistTrack(player, {
      ...spTrack,
      spotifyUri: 'spotify:track:4mF0aVVHtmHQSIdem2Wh0g',
    });
    expect(res?.lavalinkTrack.artworkUrl).toBe('https://img.test/cascade.jpg');
    expect(getTrackCoverUrl).toHaveBeenCalledWith('Esme', 'Mond');
  });

  it('late-attaches art that arrives after the timeout', async () => {
    const { svc } = makeArtSvc(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return 'https://img.test/late.jpg';
    });
    const track = { title: 'Esme', author: 'Mond' } as unknown as {
      title: string;
      author: string;
      artworkUrl?: string;
    };
    await svc.maybeBackfillArt(track, undefined, 'Esme', 'Mond', 50);
    expect(track.artworkUrl).toBeUndefined();
    await new Promise((r) => setTimeout(r, 250));
    expect(track.artworkUrl).toBe('https://img.test/late.jpg');
  });

  it('late attach never overwrites art set meanwhile', async () => {
    const { svc } = makeArtSvc(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return 'https://img.test/late.jpg';
    });
    const track = { title: 'Esme', author: 'Mond' } as unknown as {
      title: string;
      author: string;
      artworkUrl?: string;
    };
    const pending = svc.maybeBackfillArt(track, undefined, 'Esme', 'Mond', 50);
    await pending;
    track.artworkUrl = 'https://img.test/first.jpg';
    await new Promise((r) => setTimeout(r, 250));
    expect(track.artworkUrl).toBe('https://img.test/first.jpg');
  });

  it('uses the video thumbnail and skips the cascade for long-form content', async () => {
    const { svc, getTrackCoverUrl, getArtistImageUrl } = makeArtSvc();
    const track = {
      title: 'DJ Set - Live at Home [FULL SET]',
      author: 'some-channel',
      duration: 3600000,
      _videoThumb: 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg',
    } as unknown as { title: string; author: string; duration: number; artworkUrl?: string };
    await svc.maybeBackfillArt(track, undefined, 'DJ Set', 'DJ', 6000);
    expect(track.artworkUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg');
    expect(getTrackCoverUrl).not.toHaveBeenCalled();
    expect(getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('falls through to the cascade for long-form content with no thumbnail', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc();
    const track = {
      title: 'DJ Set - Live at Home [FULL SET]',
      author: 'some-channel',
      duration: 3600000,
    } as unknown as { title: string; author: string; duration: number; artworkUrl?: string };
    await svc.maybeBackfillArt(track, undefined, 'DJ Set', 'DJ', 6000);
    expect(getTrackCoverUrl).toHaveBeenCalledWith('DJ Set', 'DJ');
  });

  it('runs the cascade for normal-length tracks without art', async () => {
    const { svc, getTrackCoverUrl } = makeArtSvc();
    const track = {
      title: 'Esme',
      author: 'Mond',
      duration: 180000,
      _videoThumb: 'https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg',
    } as unknown as { title: string; author: string; duration: number; artworkUrl?: string };
    await svc.maybeBackfillArt(track, undefined, 'Esme', 'Mond', 6000);
    expect(getTrackCoverUrl).toHaveBeenCalledWith('Esme', 'Mond');
    expect(track.artworkUrl).toBe('https://img.test/backfilled.jpg');
  });

  it('backfills the playlist first track (playSpotify path)', async () => {
    const search = vi.fn(async () => ({
      tracks: [{ identifier: 'yt1', duration: 135000, title: 'Vid', author: 'Art' }],
    }));
    const queued: unknown[] = [];
    const player = {
      guildId: 'g-first',
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
      },
      play: vi.fn(async () => true),
    };
    const manager = { search, on: vi.fn(), players: { get: () => undefined } };
    const getTrackCoverUrl = vi.fn(async () => 'https://img.test/first.jpg');
    const spotifyResolver = {
      resolve: async () => ({
        type: 'playlist',
        title: 'P',
        tracks: [
          { searchQuery: 'Yeat - GONE 4 A MIN', name: 'GONE 4 A MIN', artist: 'Yeat', durationMs: 135000 },
          { searchQuery: 'A - B', name: 'B', artist: 'A', durationMs: 180000 },
        ],
        totalTracks: 2,
      }),
    };
    const svc = new MusicService(
      { getManager: () => manager } as never,
      spotifyResolver as never,
      {} as never,
      undefined,
      { getTrackCoverUrl } as never,
    ) as unknown as {
      playSpotify: (player: unknown, url: string, requester: unknown) => Promise<unknown>;
    };
    await svc.playSpotify(player, 'https://open.spotify.com/playlist/xyz', { id: 'u1' });
    expect(getTrackCoverUrl).toHaveBeenCalledWith('GONE 4 A MIN', 'Yeat');
    expect((queued[0] as { artworkUrl?: string }).artworkUrl).toBe('https://img.test/first.jpg');
  });
});

describe('chapter art retry + prefetch', () => {
  const SHOW = [
    { title: 'Rottweiler', startMs: 0 },
    { title: '4 Raws', startMs: 150000 },
    { title: 'Century', startMs: 355000 },
  ];

  const makeHandler = (artImpl: (song: string) => Promise<string | null>) => {
    const getTrackCoverUrl = vi.fn(artImpl);
    const client = { on: vi.fn(), channels: { cache: new Map() } };
    const manager = { on: vi.fn(), players: { get: () => undefined } };
    const handler = new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { getTrackCoverUrl } as never,
    ) as unknown as {
      chapterCardFor: (player: unknown, pos: number) => { title: string; artworkUrl?: string | null } | null;
    };
    return { handler, getTrackCoverUrl };
  };

  const mockPlayer = (store: Record<string, unknown>) => ({
    guildId: 'g-ch',
    current: { title: 'EsDeeKid - Live at Silver Spring' },
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => void (store[k] = v),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a missed cover after 30s, not before', async () => {
    const { handler, getTrackCoverUrl } = makeHandler(async () => null);
    const store: Record<string, unknown> = {
      chapters: SHOW,
      chapterIdx: 0,
      chapterCard: { title: 'Rottweiler', artworkUrl: null },
      chapterArtRetry: { idx: 0, at: Date.now() },
    };
    const player = mockPlayer(store);

    handler.chapterCardFor(player, 60000);
    expect(getTrackCoverUrl).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31000);
    handler.chapterCardFor(player, 61000);
    await vi.advanceTimersByTimeAsync(0);
    expect(getTrackCoverUrl).toHaveBeenCalledWith('Rottweiler', 'EsDeeKid');
  });

  it('publishes the title at once and prefetches upcoming covers', async () => {
    const { handler, getTrackCoverUrl } = makeHandler(async () => null);
    const store: Record<string, unknown> = { chapters: SHOW, chapterIdx: -2 };
    const player = mockPlayer(store);

    const card = handler.chapterCardFor(player, 200000);
    expect(card?.title).toBe('4 Raws');
    await vi.advanceTimersByTimeAsync(0);
    const songs = getTrackCoverUrl.mock.calls.map((c) => c[0]);
    expect(songs).toContain('4 Raws');
    expect(songs).toContain('Century');
  });
});
