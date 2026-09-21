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

describe('playErrorMessage', () => {
  it('explains each failure mode distinctly', () => {
    expect(playErrorMessage('no-nodes')).toMatch(/rate-limited/i);
    expect(playErrorMessage('voice')).toMatch(/voice channel/i);
    expect(playErrorMessage('empty-spotify')).toMatch(/Spotify/i);
    expect(playErrorMessage(undefined)).toMatch(/music node/i);
  });
});
