import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicService } from '@bot/services/music/musicService';
import { QueueService } from '@bot/services/music/queueService';

// Faithful Moonlink queue semantics: removeRange is INCLUSIVE on both ends,
// skip() shifts the front and pushes the old current into history.
const track = (id: string) => ({ identifier: id, title: id, encoded: `enc-${id}` });

const makePlayer = (currentId: string | null, queueIds: string[], previousIds: string[] = []) => {
  const player: any = {
    current: currentId ? track(currentId) : null,
    previous: previousIds.map(track),
    queue: {
      tracks: queueIds.map(track),
      // Moonlink exposes the live list as `all`; production code (queueService,
      // identity-based rollback) reads it, so the double must model it.
      get all() {
        return this.tracks;
      },
      get size() {
        return this.tracks.length;
      },
      removeRange(start: number, end: number) {
        this.tracks.splice(start, end - start + 1);
        return true;
      },
      remove(index: number) {
        return this.tracks.splice(index, 1)[0];
      },
      unshift(t: { identifier: string; title: string; encoded: string }) {
        this.tracks.unshift(t);
      },
      shift() {
        return this.tracks.shift();
      },
    },
    skip: vi.fn(async function (this: any) {
      const next = this.queue.shift();
      if (!next) return false;
      if (this.current) this.previous.push(this.current);
      this.current = next;
      return true;
    }),
  };
  return player;
};

const makeService = (player: any) =>
  new MusicService(
    { getManager: () => ({ players: { get: () => player } }) } as never,
    {} as never,
    {} as never,
  );

const ids = (player: any): string[] => player.queue.tracks.map((t: any) => t.identifier);

describe('MusicService queue ops (Phase 3.3)', () => {
  it('skip(2) skips current + next, landing on queue #2 like skipto 2', async () => {
    const player = makePlayer('now', ['a', 'b', 'c']);
    const ok = await makeService(player).skip('g', 2);
    expect(ok).toBe(true);
    expect(player.current.identifier).toBe('b');
    expect(ids(player)).toEqual(['c']);
  });

  it('skip() past the end of the queue refuses instead of mis-skipping', async () => {
    const player = makePlayer('now', ['a', 'b']);
    const ok = await makeService(player).skip('g', 99);
    expect(ok).toBe(false);
    expect(ids(player)).toEqual(['a', 'b']);
  });

  it('skipto(3) plays the 3rd queued track', async () => {
    const player = makePlayer('now', ['a', 'b', 'c']);
    const ok = await makeService(player).skipto('g', 3);
    expect(ok).toBe(true);
    expect(player.current.identifier).toBe('c');
  });

  it('previous() toggles without duplicating the queue', async () => {
    // State after A finished and B started: current=B, history=[A], queue=[C]
    const player = makePlayer('B', ['C'], ['A']);
    const svc = makeService(player);

    await svc.previous('g');
    expect(player.current.identifier).toBe('A');
    expect(ids(player)).toEqual(['C']);

    await svc.previous('g');
    expect(player.current.identifier).toBe('B');
    expect(ids(player)).toEqual(['C']);
  });

  it('previous() with empty history is a no-op', async () => {
    const player = makePlayer('B', ['C'], []);
    const ok = await makeService(player).previous('g');
    expect(ok).toBe(false);
    expect(player.current.identifier).toBe('B');
    expect(ids(player)).toEqual(['C']);
  });
});

describe('MusicService combined queue (resolved + pending)', () => {
  const spEntry = (i: number) => ({
    spTrack: {
      searchQuery: `Artist${i} - Title${i}`,
      name: `Title${i}`,
      artist: `Artist${i}`,
      durationMs: 180000 + i,
      artworkUrl: `https://img.test/${i}.jpg`,
      spotifyUri: `spotify:track:${i}`,
    },
    requester: { id: 'u1' },
    spotifyUrl: 'spotify:playlist:p',
    override: undefined,
  });

  const makeCombined = (
    queueIds: string[],
    pendingN: number,
    searchImpl?: (args: { query: string; source: string }) => Promise<unknown>,
  ) => {
    type MockQt = { identifier: string; title: string; encoded: string; duration?: number };
    const search = vi.fn(
      searchImpl ??
        (async () => ({ tracks: [{ identifier: 'yt-hit', duration: 180000, title: 'raw', author: 'raw' }] })),
    );
    const tracks: MockQt[] = queueIds.map(track);
    const player: any = {
      guildId: 'g',
      current: null,
      node: { identifier: 'test-node' },
      playing: false,
      paused: false,
      queue: {
        tracks,
        get size() {
          return this.tracks.length;
        },
        get isEmpty() {
          return this.tracks.length === 0;
        },
        remove(i: number) {
          return this.tracks.splice(i, 1)[0];
        },
        removeRange(s: number, e: number) {
          this.tracks.splice(s, e - s + 1);
          return true;
        },
        insert(i: number, t: MockQt) {
          this.tracks.splice(i, 0, t);
        },
        add(t: MockQt) {
          this.tracks.push(t);
        },
        unshift(t: MockQt) {
          this.tracks.unshift(t);
        },
        clear() {
          this.tracks.length = 0;
        },
        move(i: number, j: number) {
          const t = this.tracks.splice(i, 1)[0]!;
          this.tracks.splice(j, 0, t);
          return true;
        },
        get all() {
          return this.tracks;
        },
        get duration() {
          return this.tracks.reduce((a: number, t: any) => a + (t.duration || 0), 0);
        },
      },
      skip: vi.fn(async function (this: any) {
        const next = this.queue.tracks.shift();
        if (!next) return false;
        if (this.current) this.previous.push(this.current);
        this.current = next;
        return true;
      }),
      play: vi.fn(async () => true),
      previous: [] as unknown[],
    };
    const manager = { search, players: { get: () => player }, on: vi.fn() };
    const svc = new MusicService(
      { getManager: () => manager } as never,
      {} as never,
      new QueueService({} as never),
    ) as unknown as {
      getQueueInfo: (guildId: string) => {
        tracks: Array<{ title: string }>;
        totalTracks: number;
        totalDuration: number;
        remainingDuration: number;
      } | null;
      remove: (guildId: string, index: number) => { title: string } | null;
      move: (guildId: string, from: number, to: number) => Promise<boolean>;
      skip: (guildId: string, amount?: number) => Promise<boolean>;
      skipto: (guildId: string, position: number) => Promise<boolean>;
      pendingSpotify: Map<string, unknown[]>;
    };
    if (pendingN > 0) {
      svc.pendingSpotify.set(
        'g',
        Array.from({ length: pendingN }, (_, i) => spEntry(i)),
      );
    }
    const titles = () => player.queue.tracks.map((t: any) => t.title ?? t.identifier);
    return { svc, player, titles };
  };

  it('getQueueInfo merges pending with counts and durations', () => {
    const { svc } = makeCombined(['a', 'b'], 2);
    const info = svc.getQueueInfo('g')!;
    expect(info.tracks.map((t) => t.title)).toEqual(['a', 'b', 'Title0', 'Title1']);
    expect(info.totalTracks).toBe(4);
    expect(info.totalDuration).toBe(360001);
    expect(info.remainingDuration).toBe(360001);
  });

  it('remove() drops pending entries beyond the resolved queue', () => {
    const { svc, titles } = makeCombined(['a', 'b'], 2);
    const removed = svc.remove('g', 3);
    expect(removed?.title).toBe('Title1');
    expect(titles()).toEqual(['a', 'b']);
    expect(svc.pendingSpotify.get('g')).toHaveLength(1);
    expect(svc.remove('g', 9)).toBeNull();
  });

  it('move() reorders within pending like Moonlink move', async () => {
    const { svc, titles } = makeCombined(['a', 'b'], 3);
    expect(await svc.move('g', 3, 5)).toBe(true);
    expect(titles()).toEqual(['a', 'b']);
    const pending = svc.pendingSpotify.get('g')!.map((e: any) => e.spTrack.name);
    expect(pending).toEqual(['Title1', 'Title2', 'Title0']);
  });

  it('move() downgrades resolved tracks to pending', async () => {
    const { svc, titles } = makeCombined(['a', 'b'], 2);
    expect(await svc.move('g', 1, 4)).toBe(true);
    expect(titles()).toEqual(['b']);
    const pending = svc.pendingSpotify.get('g')!.map((e: any) => e.spTrack.name);
    expect(pending).toEqual(['Title0', 'Title1', 'a']);
  });

  it('move() resolves pending tracks moved into the queue', async () => {
    const { svc, titles } = makeCombined(['a', 'b'], 2);
    expect(await svc.move('g', 4, 1)).toBe(true);
    expect(titles()).toEqual(['Title1', 'a', 'b']);
    expect(svc.pendingSpotify.get('g')).toHaveLength(1);
  });

  it('move() refuses misses and out-of-range with nothing mutated', async () => {
    const missSvc = makeCombined(['a'], 1, async () => ({ tracks: [] }));
    expect(await missSvc.svc.move('g', 2, 1)).toBe(false);
    expect(missSvc.titles()).toEqual(['a']);
    expect(missSvc.svc.pendingSpotify.get('g')).toHaveLength(1);

    const { svc, titles } = makeCombined(['a'], 1);
    expect(await svc.move('g', 1, 9)).toBe(false);
    expect(await svc.move('g', 0, 1)).toBe(false);
    expect(titles()).toEqual(['a']);
    expect(svc.pendingSpotify.get('g')).toHaveLength(1);
  });

  it('skipto() into pending resolves the target and drops ahead', async () => {
    const { svc, player, titles } = makeCombined(['a', 'b'], 2);
    expect(await svc.skipto('g', 4)).toBe(true);
    expect(player.current.identifier).toBe('yt-hit');
    expect(titles()).toEqual([]);
    expect(svc.pendingSpotify.has('g')).toBe(false);
  });

  it('skip() past resolved entries jumps into pending', async () => {
    const { svc, player } = makeCombined(['a'], 1);
    expect(await svc.skip('g', 2)).toBe(true);
    expect(player.current.identifier).toBe('yt-hit');
  });
});

describe('MusicService player lifecycle safety', () => {
  const makeLifecycle = (opts: { destroyed?: boolean; connected?: boolean } = {}) => {
    const data = new Map<string, unknown>();
    const player: any = {
      guildId: 'g-life',
      destroyed: opts.destroyed ?? false,
      connected: opts.connected ?? false,
      playing: false,
      paused: false,
      voiceChannelId: 'vc-real',
      textChannelId: 'tc-real',
      current: null,
      previous: [],
      node: { identifier: 'Home' },
      queue: {
        tracks: [] as unknown[],
        get all() {
          return this.tracks;
        },
        get size() {
          return this.tracks.length;
        },
        add(t: unknown) {
          this.tracks.push(t);
        },
        remove(i: number) {
          return this.tracks.splice(i, 1)[0];
        },
        unshift(t: unknown) {
          this.tracks.unshift(t);
        },
        clear() {
          this.tracks.length = 0;
        },
      },
      connect: vi.fn(async () => undefined),
      play: vi.fn(async () => true),
      destroy: vi.fn(async () => undefined),
      setVoiceChannelId: vi.fn(function (this: any, id: string) {
        this.voiceChannelId = id;
      }),
      setTextChannelId: vi.fn(function (this: any, id: string) {
        this.textChannelId = id;
      }),
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => void data.set(k, v),
    };
    const players = new Map<string, unknown>([['g-life', player]]);
    const svc = new MusicService(
      {
        getManager: () => ({
          players: {
            get: (g: string) => players.get(g),
            create: vi.fn(() => player),
            delete: (g: string) => players.delete(g),
          },
        }),
        hasHealthyNode: () => true,
        isNodeCoolingDown: () => false,
      } as never,
      {} as never,
      { getSettings: () => ({ autoplay: false, volume: 100, loopMode: 'off', filters: [] }) } as never,
    );
    return { svc, player, players };
  };

  it('never hands out a destroyed player (it would be reconnected with nothing tracking it)', () => {
    const { svc } = makeLifecycle({ destroyed: true });
    expect(svc.getPlayer('g-life')).toBeUndefined();
  });

  it('refuses to enqueue onto a destroyed player', async () => {
    const { svc, player } = makeLifecycle({ destroyed: true });
    const res = await (svc as unknown as {
      enqueueLavalinkTracks: (
        p: unknown,
        t: unknown[],
        r: unknown,
        o: undefined,
        s: string,
      ) => Promise<{ loadType: string; totalTracksAdded: number }>;
    }).enqueueLavalinkTracks(player, [track('a')], { id: 'u1' } as never, undefined, 'youtube');
    expect(res.loadType).toBe('error');
    expect(res.totalTracksAdded).toBe(0);
    expect(player.queue.size).toBe(0);
  });

  it('does not retarget the voice channel of a LIVE session (it never moves the connection)', async () => {
    const { svc, player } = makeLifecycle({ connected: true });
    await svc.getOrCreatePlayer('g-life', 'vc-someone-else', 'tc-new');
    // Retargeting here used to make the empty-channel timer watch the
    // CALLER's channel while audio kept playing in the real one.
    expect(player.voiceChannelId).toBe('vc-real');
    // The card channel is a local pointer, so retargeting it is safe.
    expect(player.textChannelId).toBe('tc-new');
  });

  it('rejects a play into a full queue instead of reporting success', async () => {
    const { svc, player } = makeLifecycle();
    player.queue.tracks = Array.from({ length: 5000 }, (_, i) => track(`t${i}`));
    const res = await (svc as unknown as {
      enqueueLavalinkTracks: (
        p: unknown,
        t: unknown[],
        r: unknown,
        o: undefined,
        s: string,
      ) => Promise<{ loadType: string; errorReason?: string; totalTracksAdded: number }>;
    }).enqueueLavalinkTracks(player, [track('new')], { id: 'u1' } as never, undefined, 'youtube');
    expect(res.loadType).toBe('error');
    expect(res.errorReason).toBe('queue-full');
    expect(res.totalTracksAdded).toBe(0);
  });
});

describe('MusicService.seek', () => {
  const seekPlayer = (seekImpl: (ms: number) => Promise<unknown>) => {
    const data = new Map<string, unknown>();
    return {
      current: { identifier: 't1', title: 'Long Show', duration: 3821000 } as {
        identifier: string;
        title: string;
        duration: number;
        position?: number;
        time?: number;
      },
      seek: vi.fn(seekImpl),
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => void data.set(k, v),
      data,
    };
  };
  const seekSvc = (player: unknown) =>
    new MusicService(
      { getManager: () => ({ players: { get: () => player } }) } as never,
      {} as never,
      {} as never,
    );

  it('records seek markers before awaiting the slow REST round-trip', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const player = seekPlayer(() => gate);
    const svc = seekSvc(player);
    const pending = svc.seek('g', 650, 5000);
    // Markers are set synchronously at call time, not after REST resolves.
    await Promise.resolve();
    expect(player.data.get('lastUserSeekAt')).toBeGreaterThan(0);
    expect(player.data.get('lastUserSeekPos')).toBe(650000);
    release();
    // Returns the position actually applied, so callers report the truth.
    await expect(pending).resolves.toBe(650000);
    expect(player.current.position).toBe(650000);
  });

  it('never hangs the command when REST stalls (timeout still resolves)', async () => {
    const player = seekPlayer(() => new Promise(() => undefined));
    const svc = seekSvc(player);
    await expect(svc.seek('g', 650, 50)).resolves.toBe(650000);
    expect(player.data.get('lastUserSeekPos')).toBe(650000);
    expect(player.seek).toHaveBeenCalledWith(650000);
  });

  it('refuses without a player or current track', async () => {
    const svc = seekSvc(null);
    await expect(svc.seek('g', 10)).resolves.toBeNull();
  });

  it('refuses a live stream instead of silently jumping to 0', async () => {
    // duration is 0 on a stream, so the old clamp (min against duration || 0)
    // turned every seek into a jump to the start and still said "seeked".
    const player = seekPlayer(async () => undefined);
    player.current.duration = 0;
    const svc = seekSvc(player);
    await expect(svc.seek('g', 650, 50)).resolves.toBeNull();
    expect(player.seek).not.toHaveBeenCalled();
  });

  it('clamps to the track end and reports the clamped position', async () => {
    const player = seekPlayer(async () => undefined);
    player.current.duration = 60_000;
    const svc = seekSvc(player);
    await expect(svc.seek('g', 9999, 50)).resolves.toBe(60_000);
    expect(player.seek).toHaveBeenCalledWith(60_000);
  });

  it('does not stamp the position onto a DIFFERENT track after a stalled REST', async () => {
    const player = seekPlayer(() => new Promise(() => undefined));
    const svc = seekSvc(player);
    const pending = svc.seek('g', 650, 50);
    // Track ends and the next one starts while our REST call hangs.
    player.current = { identifier: 't2', title: 'Next Song', duration: 200000 } as never;
    await expect(pending).resolves.toBe(650000);
    expect((player.current as unknown as { position?: number }).position).toBeUndefined();
  });
});
