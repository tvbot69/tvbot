import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlaylistChunkManager } from '@bot/services/music/playlistChunkManager';
import { MusicService, MAX_QUEUE_TRACKS } from '@bot/services/music/musicService';
import type { ChunkTrackResolver } from '@bot/services/music/playlistChunkManager';
import type { Track } from 'moonlink.js';

/** Moonlink's event callbacks; the chunk manager only ever registers on these. */
type EventHandler = (...args: unknown[]) => Promise<void>;

const makeChunk = (opts?: {
  resolver?: ChunkTrackResolver;
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
  const handlers = new Map<string, EventHandler>();
  const search = vi.fn(
    opts?.searchImpl ??
      (async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, title: 'raw', author: 'raw' }] })),
  );
  const manager = {
    search,
    players: { get: (id: string) => (id === 'g-chunk' ? player : undefined) },
    on: vi.fn((ev: string, cb: EventHandler) => {
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
  if (opts?.resolver) chunk.setTrackResolver(opts.resolver);
  chunk.bindEvents();
  chunk.register('g-chunk', 'pl1', 'P', 102, 100, 'u1', 'tc1');
  return { chunk, player, added, handlers, search };
};

describe('PlaylistChunkManager ladder resolution', () => {
  it('resolves tails through the injected ladder with rung-aware labels', async () => {
    const resolver = vi.fn<ChunkTrackResolver>(
      async (_player, sp) => ({
        lavalinkTrack: { identifier: `r-${sp.name}` } as Track,
        rung: sp.name === 'C1' ? 'resolver' : 'plugin',
      }),
    );
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
    const resolver = vi.fn<ChunkTrackResolver>(async (_player, sp) =>
      sp.name === 'C1' ? { lavalinkTrack: { identifier: 'r1' } as Track, rung: 'soundcloud' } : null,
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
    resolver?: ChunkTrackResolver;
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
    const handlers = new Map<string, EventHandler>();
    const manager = {
      players: { get: (id: string) => (id === 'g-drain' ? player : undefined) },
      on: vi.fn((ev: string, cb: EventHandler) => {
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
        (async () => ({ lavalinkTrack: { identifier: 'r-d1' } as Track, rung: 'soundcloud' }))) as never,
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
    const { chunk, added, play } = makeDrainChunk({
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
    const handlers = new Map<string, EventHandler>();
    const manager = {
      players: { get: (id: string) => (id === 'g-drain' ? player : undefined) },
      on: vi.fn((ev: string, cb: EventHandler) => {
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
    chunk.setTrackResolver(
      (async () => ({ lavalinkTrack: { identifier: 'r-x' } as Track, rung: 'soundcloud' })) as never,
    );
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

  it('tells the channel when a mid-playlist fetch comes back empty', async () => {
    // The silent truncation. The scraper returning nothing partway through a
    // 200-track playlist deletes the chunk and the queue simply stops growing,
    // so the user's remaining tracks vanish with no notice at all — the two
    // sibling stops (queue cap, both sites) both talk to the channel and this
    // one did not. The message is asserted VERBATIM rather than by substring:
    // it is the third of a set of three that are supposed to read as one
    // behaviour, and only an exact string can notice if it drifts.
    const notices: Array<{ guildId: string; message: string }> = [];
    const { chunk, player, added, handlers } = makeDrainChunk({
      fetchPage: async () => ({ tracks: [], nextOffset: 300, total: 200 }),
    });
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    await handlers.get('trackStart')!(player as never);

    expect(added).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.guildId).toBe('g-drain');
    expect(notices[0]!.message).toBe('⚠️ Spotify returned no more tracks — stopped loading **Playlist P**.');
    expect(chunk.getState('g-drain')).toBeUndefined();
  });

  it('a null page is noticed too, not just an empty track list', async () => {
    // `!page || page.tracks.length === 0` is one branch, and the null case is
    // the one that actually happens when a fetch throws inside the scraper and
    // is swallowed. Covering only the empty-list half would leave the reachable
    // shape unreported.
    const notices: Array<{ guildId: string; message: string }> = [];
    const { chunk, player, added, handlers } = makeDrainChunk({ fetchPage: async () => null });
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    await handlers.get('trackStart')!(player as never);

    expect(added).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('Spotify returned no more tracks');
    expect(chunk.getState('g-drain')).toBeUndefined();
  });

  it('a completed playlist is NOT told about, so the notice stays meaningful', async () => {
    // The other direction. The stop that has genuinely finished must not fire
    // the same notice, or "stopped loading" stops meaning "you lost tracks".
    const notices: Array<{ guildId: string; message: string }> = [];
    const { chunk, player, added, handlers } = makeDrainChunk();
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));

    await handlers.get('trackStart')!(player as never);

    expect(added).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });
});

describe('PlaylistChunkManager unknown-total cap', () => {
  const makeProbeChunk = (opts: {
    total: number;
    nextOffset: number;
    totalKnown?: boolean;
    page: unknown;
    resolver?: ChunkTrackResolver;
    guildId?: string;
  }) => {
    const guildId = opts.guildId ?? 'g-probe';
    const added: unknown[] = [];
    const player = {
      guildId,
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
    const handlers = new Map<string, EventHandler>();
    const manager = {
      search: vi.fn(async () => ({ tracks: [{ identifier: 'yt1', duration: 180000, title: 'raw', author: 'raw' }] })),
      players: { get: (id: string) => (id === guildId ? player : undefined) },
      on: vi.fn((ev: string, cb: EventHandler) => {
        handlers.set(ev, cb);
      }),
    };
    const scraper = { fetchPlaylistPage: vi.fn(async () => opts.page) };
    const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
    chunk.setTrackResolver(
      (opts.resolver ?? (async () => ({ lavalinkTrack: { identifier: 'r-probe' } as Track, rung: 'soundcloud' }))) as never,
    );
    chunk.bindEvents();
    const notices: Array<{ guildId: string; message: string }> = [];
    chunk.setUnavailableNotifier((g, m) => notices.push({ guildId: g, message: m }));
    chunk.register(guildId, 'pl-big', 'Big Playlist', opts.total, opts.nextOffset, 'u1', 'tc1', opts.totalKnown ?? true);
    return { chunk, player, added, handlers, scraper, notices, guildId };
  };

  it('register with unknown total schedules nothing and tells the channel', async () => {
    // Shard-as-floor: total 100, offset 100, totalKnown false. The initial
    // 0-100 page was the single probe — no offset>0 fetch may be scheduled.
    const { chunk, player, handlers, scraper, notices, guildId } = makeProbeChunk({
      total: 100,
      nextOffset: 100,
      totalKnown: false,
      page: { tracks: [{ name: 'X', artist: 'A', durationMs: 1000 }], nextOffset: null, total: 100, totalKnown: false },
    });
    expect(chunk.getState(guildId)).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('does not report the full playlist size');
    expect(notices[0]!.message).toContain('Big Playlist');
    await handlers.get('trackStart')!(player as never);
    expect(scraper.fetchPlaylistPage).not.toHaveBeenCalled();
  });

  it('a known register still schedules, so the cap above is not vacuous', async () => {
    const { chunk, guildId, notices } = makeProbeChunk({
      total: 347,
      nextOffset: 100,
      totalKnown: true,
      page: { tracks: [], nextOffset: null, total: 347, totalKnown: true },
    });
    expect(chunk.getState(guildId)).toBeDefined();
    expect(notices).toHaveLength(0);
  });

  it('an unknown page caps at one probe and never chains a second fetch', async () => {
    // Real count at register (347) but the scraper page admits it never knew
    // the size. One probe appends, then deletes — the low-queue chain must not
    // fire a second offset>0 fetch that would burn ladder searches.
    const { chunk, player, added, handlers, scraper, notices, guildId } = makeProbeChunk({
      total: 347,
      nextOffset: 100,
      totalKnown: true,
      page: {
        tracks: [
          { name: 'U1', artist: 'A', durationMs: 1000 },
          { name: 'U2', artist: 'A', durationMs: 1000 },
        ],
        nextOffset: 200,
        total: 100,
        totalKnown: false,
      },
    });
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(2);
    expect(scraper.fetchPlaylistPage).toHaveBeenCalledTimes(1);
    expect(scraper.fetchPlaylistPage).toHaveBeenCalledWith('pl-big', 100, 100);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('does not report the full playlist size');
    expect(chunk.getState(guildId)).toBeUndefined();
    await handlers.get('trackEnd')!(player as never);
    expect(scraper.fetchPlaylistPage).toHaveBeenCalledTimes(1);
  });

  it('a same-offset page caps instead of looping forever', async () => {
    // Embed returns the same shard for any offset: nextOffset comes back 100
    // when we asked 100. Without the no-progress guard this re-requests 100
    // forever (same/dupe/empty) while burning ladder searches.
    const { chunk, player, added, handlers, scraper, notices, guildId } = makeProbeChunk({
      total: 347,
      nextOffset: 100,
      totalKnown: true,
      page: {
        tracks: [{ name: 'S1', artist: 'A', durationMs: 1000 }],
        nextOffset: 100,
        total: 347,
        totalKnown: true,
      },
    });
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(1);
    expect(scraper.fetchPlaylistPage).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('does not report the full playlist size');
    expect(chunk.getState(guildId)).toBeUndefined();
  });
});

describe('PlaylistChunkManager fetch throw notice', () => {
  it('tells the channel when the chunk fetch throws, keeping state for retry', async () => {
    const added: unknown[] = [];
    const player = {
      guildId: 'g-throw',
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
    const handlers = new Map<string, EventHandler>();
    const manager = {
      players: { get: (id: string) => (id === 'g-throw' ? player : undefined) },
      on: vi.fn((ev: string, cb: EventHandler) => {
        handlers.set(ev, cb);
      }),
    };
    const scraper = {
      fetchPlaylistPage: vi.fn(async () => {
        throw new Error('ladder down');
      }),
    };
    const chunk = new PlaylistChunkManager({ getManager: () => manager } as never, scraper as never);
    chunk.setTrackResolver((async () => ({ lavalinkTrack: { identifier: 'r-t' } as Track, rung: 'soundcloud' })) as never);
    chunk.bindEvents();
    chunk.register('g-throw', 'pl1', 'Throw Playlist', 347, 100, 'u1', 'tc1');
    const notices: Array<{ guildId: string; message: string }> = [];
    chunk.setUnavailableNotifier((guildId, message) => notices.push({ guildId, message }));
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.guildId).toBe('g-throw');
    expect(notices[0]!.message).toContain('Throw Playlist');
    // Known-total throw keeps the chunk so the drain/backoff retry can still
    // land it — deleting here would turn one blip into a truncated playlist.
    expect(chunk.getState('g-throw')).toBeDefined();
    expect(chunk.getState('g-throw')?.isFetching).toBe(false);
  });
});

describe('PlaylistChunkManager requester shape', () => {
  it('stamps resolver tracks with an object requester, not a string', async () => {
    const resolver = vi.fn<ChunkTrackResolver>(
      async () => ({ lavalinkTrack: { identifier: 'r-req' } as Track, rung: 'soundcloud' }),
    );
    const { player, added, handlers } = makeChunk({ resolver });
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(2);
    for (const t of added as Array<Record<string, unknown>>) {
      expect(t.requester).toEqual({ id: 'u1' });
      expect(typeof t.requester).not.toBe('string');
    }
  });

  it('stamps fallback tracks with an object requester, not a string', async () => {
    const { player, added, handlers } = makeChunk();
    await handlers.get('trackStart')!(player as never);
    expect(added).toHaveLength(2);
    for (const t of added as Array<Record<string, unknown>>) {
      expect(t.requester).toEqual({ id: 'u1' });
      expect(typeof t.requester).not.toBe('string');
    }
  });
});
