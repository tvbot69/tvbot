import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicService } from './musicService';

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
