import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicService } from './musicService';
import { QueueService } from './queueService';

// Faithful Moonlink queue semantics: removeRange is INCLUSIVE on both ends,
// skip() shifts the front and pushes the old current into history.
const track = (id: string) => ({ identifier: id, title: id, encoded: `enc-${id}` });

const makePlayer = (currentId: string | null, queueIds: string[], previousIds: string[] = []) => {
  const player: any = {
    current: currentId ? track(currentId) : null,
    previous: previousIds.map(track),
    queue: {
      tracks: queueIds.map(track),
      get size() {
        return this.tracks.length;
      },
      removeRange(start: number, end: number) {
        this.tracks.splice(start, end - start + 1);
        return true;
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
    const { svc, player, titles } = makeCombined(['a', 'b'], 2);
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
