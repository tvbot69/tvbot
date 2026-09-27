import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MusicService } from './musicService';

/**
 * Characterization tests for the invariants that the god-file split must not
 * break. These behaviours are all *identity-sensitive*: they depend on the
 * pending queue being a single live object graph rather than copies, and on
 * the service keeping a reference to the same Map that callers can reach.
 *
 * Nothing here asserts a return value for its own sake — every test fails only
 * if a refactor changes how the pending store is shared or mutated.
 */

const track = (id: string) => ({ identifier: id, title: id, encoded: `enc-${id}` });

const makePlayer = (currentId: string | null, queueIds: string[] = []) => {
  const player: any = {
    current: currentId ? track(currentId) : null,
    previous: [] as unknown[],
    queue: {
      tracks: queueIds.map(track),
      get all() {
        return this.tracks;
      },
      get size() {
        return this.tracks.length;
      },
      get isEmpty() {
        return this.tracks.length === 0;
      },
      shuffle: vi.fn(function (this: any) {
        for (let i = this.tracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
        }
        return true;
      }),
      clear: vi.fn(function (this: any) {
        this.tracks.length = 0;
        return true;
      }),
      removeRange(start: number, end: number) {
        this.tracks.splice(start, end - start + 1);
        return true;
      },
      remove(index: number) {
        return this.tracks.splice(index, 1)[0];
      },
      insert(index: number, t: { identifier: string; title: string; encoded: string }) {
        this.tracks.splice(index, 0, t);
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

const makeService = (player: any, queueService: any = {}) =>
  new MusicService(
    { getManager: () => ({ players: { get: () => player } }) } as never,
    {} as never,
    queueService as never,
  );

/** The test-visible view of the pending store, matching how callers reach it. */
type PendingView = { pendingSpotify: Map<string, unknown[]> };

const pendingOf = (svc: unknown) => (svc as PendingView).pendingSpotify;

const entry = (name: string) => ({
  spTrack: { id: `sp-${name}`, name, artists: [{ name: 'Artist' }] },
  requester: { id: 'u1', username: 'user' },
  spotifyUrl: `https://open.spotify.com/track/${name}`,
});

describe('pending queue store identity (refactor guard)', () => {
  it('exposes a stable pending Map that callers can read and write', () => {
    const svc = makeService(makePlayer('now'));
    const pending = pendingOf(svc);
    expect(pending).toBeInstanceOf(Map);
    // Identity must be stable across reads — a getter that rebuilt the Map
    // would make every write a no-op.
    expect(pendingOf(svc)).toBe(pending);
    pending.set('g1', [entry('a'), entry('b')]);
    expect(pendingOf(svc).get('g1')).toHaveLength(2);
  });

  it('shuffle reorders the live pending array in place, not a copy', () => {
    const player = makePlayer('now', ['a', 'b']);
    const svc = makeService(player);
    const pending = pendingOf(svc);
    const seeded = [entry('a'), entry('b'), entry('c'), entry('d')];
    pending.set('g1', seeded);

    // The exact array instance seeded by the caller is the one that must be
    // reordered; a defensive copy would leave `seeded` untouched and silently
    // turn shuffle into a no-op for the pending tail.
    expect(svc.shuffle('g1')).toBe(true);
    expect(pending.get('g1')).toBe(seeded);
    expect(seeded.map((e) => (e as { spTrack: { name: string } }).spTrack.name).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('shuffle leaves a pending tail of 0 or 1 entries alone', () => {
    const svc = makeService(makePlayer('now', ['a']));
    const pending = pendingOf(svc);
    const single = [entry('only')];
    pending.set('g1', single);
    expect(svc.shuffle('g1')).toBe(true);
    expect(pending.get('g1')).toBe(single);
    expect(single).toHaveLength(1);
  });

  /**
   * KNOWN GAP, pinned deliberately. `getQueueInfo` merges pending entries into
   * the visible queue (and its own comment says shuffle/remove/move must act on
   * what the user can see), but `shuffle` guards on the *resolved* queue being
   * empty. So when a playlist is still entirely pending — current track playing,
   * nothing resolved yet, tail all pending — the user sees a full queue, hits
   * shuffle, and gets `false` (reported as "nothing to shuffle") while the
   * pending tail is left in order.
   *
   * This is pre-existing behaviour, NOT introduced by the split. It is pinned
   * here so a refactor cannot change it by accident, and so the fix is a
   * deliberate, separately-reviewed change rather than a side effect.
   */
  it('KNOWN GAP: shuffle refuses when only pending entries exist', () => {
    const svc = makeService(makePlayer('now', []));
    const pending = pendingOf(svc);
    const seeded = [entry('p1'), entry('p2'), entry('p3')];
    pending.set('g1', seeded);

    expect(svc.shuffle('g1')).toBe(false);
    expect(seeded.map((e) => (e as { spTrack: { name: string } }).spTrack.name)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('remove() past the resolved queue splices the live pending array', () => {
    const player = makePlayer('now', ['a']);
    const svc = makeService(player);
    const pending = pendingOf(svc);
    const seeded = [entry('p1'), entry('p2'), entry('p3')];
    pending.set('g1', seeded);

    // index 2 is past the single resolved track, so it addresses pending[1].
    svc.remove('g1', 2);
    expect(pending.get('g1')).toBe(seeded);
    expect(seeded.map((e) => (e as { spTrack: { name: string } }).spTrack.name)).toEqual(['p1', 'p3']);
  });

  it('clear() drops the guild pending entry entirely', () => {
    const player = makePlayer('now', ['a', 'b']);
    const svc = makeService(player);
    const pending = pendingOf(svc);
    pending.set('g1', [entry('p1')]);
    pending.set('g2', [entry('p2')]);

    expect(svc.clear('g1')).toBe(true);
    expect(pending.has('g1')).toBe(false);
    // Other guilds must be untouched — the store is keyed per guild.
    expect(pending.has('g2')).toBe(true);
  });

  it('clear() with no live player still drops that guild pending entry', () => {
    const svc = makeService(null);
    const pending = pendingOf(svc);
    pending.set('g1', [entry('p1')]);
    expect(svc.clear('g1')).toBe(false);
    expect(pending.has('g1')).toBe(false);
  });
});
