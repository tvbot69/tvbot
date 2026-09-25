import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlaylistChunkManager } from './playlistChunkManager';
import { MusicService, MAX_QUEUE_TRACKS } from './musicService';

const makeChunk = (opts?: {
  resolver?: (player: unknown, spTrack: any) => Promise<any>;
  searchImpl?: (args: { query: string; source: string }) => Promise<unknown>;
}) => {
  const added: unknown[] = [];
  const player = {
    guildId: 'g-chunk',
    queue: {
      add: (t: unknown) => {
        added.push(t);
      },
      get size() {
        return added.length;
      },
    },
  };
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const search = vi.fn(
    opts?.searchImpl ??
      (async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, title: 'raw', author: 'raw' }] })),
  );
  const manager = {
    search,
    players: { get: (id: string) => (id === 'g-chunk' ? player : undefined) },
    on: vi.fn((ev: string, cb: (...args: any[]) => Promise<void>) => {
      handlers.set(ev, cb);
    }),
  };
  const scraper = {
    fetchPlaylistPage: vi.fn(async () => ({
      tracks: [
        { name: 'C1', artist: 'A1', durationMs: 180000 },
        {
          name: 'C2',
          artist: 'A2',
          durationMs: 180000,
          artworkUrl: 'https://img.test/c2.jpg',
          spotifyUri: 'spotify:track:xyzxyzxyz12',
        },
      ],
      nextOffset: null,
      total: 102,
    })),
  };
  const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
  if (opts?.resolver) chunk.setTrackResolver(opts.resolver as never);
  chunk.bindEvents();
  chunk.register('g-chunk', 'pl1', 'P', 102, 100, 'u1', 'tc1');
  return { chunk, player, added, handlers, search };
};

describe('PlaylistChunkManager ladder resolution', () => {
  it('resolves tails through the injected ladder with rung-aware labels', async () => {
    const resolver = vi.fn(async (_player: unknown, sp: any) => ({
      lavalinkTrack: { identifier: `r-${sp.name}` },
      rung: sp.name === 'C1' ? 'resolver' : 'plugin',
    }));
    const { player, added, handlers, search } = makeChunk({ resolver });
    await handlers.get('trackStart')!(player as never);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g-chunk' }),
      expect.objectContaining({ searchQuery: 'A1 - C1', name: 'C1', artist: 'A1' }),
    );
    expect(search).not.toHaveBeenCalled();
    const [first, second] = added as Array<Record<string, unknown>>;
    expect(first?.title).toBe('C1');
    expect(first?.sourceName).toBe('local');
    expect(second?.title).toBe('C2');
    expect(second?.sourceName).toBe('spotify');
    expect(second?.artworkUrl).toBe('https://img.test/c2.jpg');
    expect(second?.uri).toBe('https://open.spotify.com/track/xyzxyzxyz12');
  });

  it('falls back to raw YouTube search without a resolver', async () => {
    const { player, added, handlers, search } = makeChunk();
    await handlers.get('trackStart')!(player as never);
    expect(search).toHaveBeenCalledTimes(2);
    expect(added).toHaveLength(2);
    const [first] = added as Array<Record<string, unknown>>;
    expect(first?.sourceName).toBe('spotify');
  });

  it('skips entries the ladder cannot resolve', async () => {
    const resolver = vi.fn(async (_player: unknown, sp: any) =>
      sp.name === 'C1' ? { lavalinkTrack: { identifier: 'r1' }, rung: 'soundcloud' } : null,
    );
    const { player, added, handlers } = makeChunk({ resolver });
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(1);
    expect((added[0] as Record<string, unknown>).sourceName).toBe('spotify');
  });
});

describe('MusicService chunk wiring', () => {
  it('injects the ladder resolver into the chunk manager', () => {
    const setTrackResolver = vi.fn();
    const manager = { search: vi.fn(), players: { get: () => undefined }, on: vi.fn() };
    new MusicService(
      { getManager: () => manager } as never,
      {} as never,
      {} as never,
      { bindEvents: vi.fn(), setTrackResolver } as never,
    );
    expect(setTrackResolver).toHaveBeenCalledTimes(1);
    expect(typeof setTrackResolver.mock.calls[0]?.[0]).toBe('function');
  });

  it('disarms playlist chunks on clear() even without a live player', () => {
    const clearChunk = vi.fn();
    const manager = { search: vi.fn(), players: { get: () => undefined }, on: vi.fn() };
    const svc = new MusicService(
      { getManager: () => manager } as never,
      {} as never,
      {} as never,
      { bindEvents: vi.fn(), setTrackResolver: vi.fn(), clear: clearChunk } as never,
    );
    expect(svc.clear('g1')).toBe(false);
    expect(clearChunk).toHaveBeenCalledWith('g1');
  });
});

describe('PlaylistChunkManager queueEnd drain & integrity', () => {
  const makeDrainChunk = (opts?: {
    fetchPage?: () => Promise<unknown>;
    resolver?: (player: unknown, sp: any) => Promise<any>;
  }) => {
    const added: unknown[] = [];
    const play = vi.fn(async () => true);
    const player = {
      guildId: 'g-drain',
      playing: false,
      paused: false,
      play,
      queue: {
        add: (t: unknown) => {
          added.push(t);
        },
        get size() {
          return added.length;
        },
      },
    };
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      players: { get: (id: string) => (id === 'g-drain' ? player : undefined) },
      on: vi.fn((ev: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(ev, cb);
      }),
    };
    const scraper = {
      fetchPlaylistPage: vi.fn(
        opts?.fetchPage ??
          (async () => ({ tracks: [{ name: 'D1', artist: 'B1', durationMs: 1000 }], nextOffset: null, total: 200 })),
      ),
    };
    const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
    chunk.setTrackResolver(
      (opts?.resolver ??
        (async () => ({ lavalinkTrack: { identifier: 'r-d1' }, rung: 'soundcloud' }))) as never,
    );
    chunk.bindEvents();
    chunk.register('g-drain', 'pl1', 'Playlist P', 200, 100, 'u1', 'tc1');
    return { chunk, player, added, play, handlers, scraper };
  };

  it('drains the next chunk on queueEnd and resumes playback', async () => {
    const { chunk, player, added, play, handlers } = makeDrainChunk();
    await handlers.get('queueEnd')!(player as never);
    expect(added).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(chunk.getState('g-drain')).toBeUndefined();
  });

  it('retries a failed chunk fetch with backoff during the drain', async () => {
    let attempts = 0;
    const { chunk, player, added, play } = makeDrainChunk({
      fetchPage: async () => {
        attempts++;
        if (attempts === 1) throw new Error('scraper down');
        return { tracks: [{ name: 'D1', artist: 'B1', durationMs: 1000 }], nextOffset: null, total: 200 };
      },
    });
    await (chunk as unknown as {
      drainOnQueueEnd: (guildId: string, timing: unknown) => Promise<void>;
    }).drainOnQueueEnd('g-drain', {
      maxFetchAttempts: 3,
      retryDelayMs: 5,
      inFlightPollMs: 5,
      overallDeadlineMs: 5000,
    });
    expect(attempts).toBe(2);
    expect(added).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(chunk.getState('g-drain')).toBeUndefined();
  });

  it('aborts an in-flight chunk when a new playlist is registered mid-fetch', async () => {
    let resolvePage!: (v: unknown) => void;
    const added: unknown[] = [];
    const player = {
      guildId: 'g-drain',
      playing: false,
      paused: false,
      play: vi.fn(async () => true),
      queue: {
        add: (t: unknown) => {
          added.push(t);
        },
        get size() {
          return added.length;
        },
      },
    };
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const manager = {
      players: { get: (id: string) => (id === 'g-drain' ? player : undefined) },
      on: vi.fn((ev: string, cb: (...args: any[]) => Promise<void>) => {
        handlers.set(ev, cb);
      }),
    };
    const scraper = {
      fetchPlaylistPage: vi.fn(
        () => new Promise((resolve) => {
          resolvePage = resolve;
        }),
      ),
    };
    const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
    chunk.setTrackResolver((async () => ({ lavalinkTrack: { identifier: 'r-x' }, rung: 'soundcloud' })) as never);
    chunk.bindEvents();
    chunk.register('g-drain', 'pl-old', 'Old', 200, 100, 'u1', 'tc1');
    const pending = handlers.get('trackEnd')!(player as never);
    chunk.register('g-drain', 'pl-new', 'New', 500, 100, 'u1', 'tc1');
    resolvePage({ tracks: [{ name: 'OLD1', artist: 'A', durationMs: 1000 }], nextOffset: 200, total: 200 });
    await pending;
    expect(added).toHaveLength(0);
    const fresh = chunk.getState('g-drain');
    expect(fresh?.playlistId).toBe('pl-new');
    expect(fresh?.nextOffset).toBe(100);
  });

  it('counts unresolvable tracks and notifies when the playlist completes', async () => {
    const notices: Array<{ guildId: string; message: string }> = [];
    const { chunk, player, added, handlers } = makeDrainChunk({
      resolver: async () => null,
      fetchPage: async () => ({
        tracks: [
          { name: 'D1', artist: 'B1', durationMs: 1000 },
          { name: 'D2', artist: 'B2', durationMs: 1000 },
        ],
        nextOffset: null,
        total: 200,
      }),
    });
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.guildId).toBe('g-drain');
    expect(notices[0]!.message).toContain('2 tracks');
    expect(notices[0]!.message).toContain('Playlist P');
    expect(chunk.getState('g-drain')).toBeUndefined();
  });

  it('stops chunk loading and notifies when the queue reaches the sanity cap', async () => {
    const notices: Array<{ guildId: string; message: string }> = [];
    const added: unknown[] = [];
    const player = {
      guildId: 'g-drain',
      playing: false,
      paused: false,
      queue: {
        add: (t: unknown) => {
          added.push(t);
        },
        get size() {
          return MAX_QUEUE_TRACKS;
        },
      },
    };
    const manager = {
      players: { get: (id: string) => (id === 'g-drain' ? player : undefined) },
      on: vi.fn(),
    };
    const scraper = { fetchPlaylistPage: vi.fn() };
    const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
    chunk.setTrackResolver((async () => ({ lavalinkTrack: { identifier: 'r-c' }, rung: 'soundcloud' })) as never);
    chunk.bindEvents();
    chunk.register('g-drain', 'pl1', 'Playlist P', 200, 100, 'u1', 'tc1');
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));
    // Direct fetchNext call: the trackEnd/trackStart hooks never fire at cap
    // (their <20 watermark gates them), but bulk enqueues elsewhere can fill
    // the queue — fetchNext must refuse to add on top.
    await (chunk as unknown as { fetchNext: (guildId: string) => Promise<void> }).fetchNext('g-drain');
    expect(scraper.fetchPlaylistPage).not.toHaveBeenCalled();
    expect(added).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('cap');
    expect(chunk.getState('g-drain')).toBeUndefined();
  });
});
