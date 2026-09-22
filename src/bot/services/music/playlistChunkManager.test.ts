import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlaylistChunkManager } from './playlistChunkManager';
import { MusicService } from './musicService';

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
});
