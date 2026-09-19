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
      track: unknown,
      guildId: string,
      key: string,
    ) => Promise<unknown>;
  };
};

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
      failedTrack,
      'g4',
      'enc-blocked',
    )) as { identifier: string };
    expect(first.identifier).toBe('yt-alt');

    // yt-alt already failed too: second lookup must skip both known ids
    const second = (await handler.findAlternatePlayableTrack(
      { search },
      failedTrack,
      'g4',
      'enc-blocked',
    )) as { identifier: string };
    expect(second.identifier).toBe('sc-alt');
  });
});

describe('resolvePlaylistTrack (Phase 3.2)', () => {
  const svc = new MusicService({} as never, {} as never, {} as never) as unknown as {
    resolvePlaylistTrack: (
      manager: unknown,
      spTrack: { searchQuery: string; name: string; artist: string },
    ) => Promise<{ lavalinkTrack: { identifier: string } } | null>;
  };
  const spTrack = { searchQuery: 'Mond - Esme', name: 'Esme', artist: 'Mond' };

  it('takes the YouTube hit when present', async () => {
    const manager = {
      search: vi.fn(async () => ({ tracks: [{ identifier: 'yt1' }] })),
    };
    const res = await svc.resolvePlaylistTrack(manager, spTrack);
    expect(res?.lavalinkTrack.identifier).toBe('yt1');
    expect(manager.search).toHaveBeenCalledTimes(1);
  });

  it('tries SoundCloud when YouTube misses', async () => {
    const manager = {
      search: vi.fn(async ({ source }: { source: string }) =>
        source === 'youtube' ? { tracks: [] } : { tracks: [{ identifier: 'sc1' }] },
      ),
    };
    const res = await svc.resolvePlaylistTrack(manager, spTrack);
    expect(res?.lavalinkTrack.identifier).toBe('sc1');
  });

  it('returns null when both sources miss', async () => {
    const manager = { search: vi.fn(async () => ({ tracks: [] })) };
    await expect(svc.resolvePlaylistTrack(manager, spTrack)).resolves.toBeNull();
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
