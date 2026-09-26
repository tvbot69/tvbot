import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicService } from './musicService';
import { QueueService } from './queueService';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import type { MoonlinkManager } from './moonlinkManager';
import type { SpotifyResolver } from './spotifyResolver';
import type { Player } from 'moonlink.js';

const YT_THUMB = 'https://i.ytimg.com/vi/ytpick00001/hqdefault.jpg';

const makeYtHit = (over: Record<string, unknown> = {}) => ({
  identifier: 'ytpick00001',
  title: 'Midnight Circuit - Neon Skyline (Official Music Video)',
  author: 'Midnight Circuit',
  duration: 213000,
  uri: 'https://www.youtube.com/watch?v=ytpick00001',
  artworkUrl: YT_THUMB,
  isSeekable: true,
  isStream: false,
  ...over,
});

describe('MusicService mirror resolving', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['HOME_RESOLVER_URL', 'HOME_RESOLVER_TOKEN', 'HOME_PLUGIN_RUNG', 'HOME_LADDER_MODE']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  const historyRepo = new MusicHistoryRepository();
  const queueService = new QueueService(historyRepo);

  const buildHarness = (opts?: {
    spotifySearchTracks?: unknown;
    searchImpl?: (args: { query: string; source: string }) => unknown;
  }) => {
    const searchImpl =
      opts?.searchImpl ??
      (() => ({
        tracks: [makeYtHit()],
      }));
    const searchSpy = vi.fn(searchImpl);
    const queueAdd = vi.fn();
    const mockPlayer = {
      guildId: 'g-mirror-1',
      voiceChannelId: 'vc-1',
      textChannelId: 'tc-1',
      node: { identifier: 'test-mirror-node' },
      connected: true,
      playing: false,
      paused: false,
      queue: { size: 0, add: queueAdd },
      play: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockResolvedValue(true),
      setVoiceChannelId: vi.fn(),
      setTextChannelId: vi.fn(),
    } as unknown as Player;
    const mockManager = {
      getManager: vi.fn().mockReturnValue({
        players: { get: vi.fn().mockReturnValue(mockPlayer), create: vi.fn().mockReturnValue(mockPlayer) },
        search: searchSpy,
      }),
      hasHealthyNode: vi.fn().mockReturnValue(true),
    } as unknown as MoonlinkManager;
    const mockSpotifyResolver = {
      isSpotifyUrl: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
      searchTrack: vi.fn().mockResolvedValue(null),
      searchTracks: vi.fn().mockResolvedValue(opts?.spotifySearchTracks ?? []),
    } as unknown as SpotifyResolver;
    const svc = new MusicService(mockManager, mockSpotifyResolver, queueService);
    return { svc, searchSpy, queueAdd, mockPlayer };
  };

  const ladderOnce = (
    svc: MusicService,
    player: Player,
    query: string,
    meta?: { title?: string; artist?: string; artworkUrl?: string; isrc?: string; durationMs?: number },
  ) =>
    (
      svc as unknown as {
        searchTrackWithLadderOnce: (
          player: Player,
          query: string,
          meta?: Record<string, unknown>,
        ) => Promise<{ track: { identifier: string }; rung: string } | { transportError: true } | null>;
      }
    ).searchTrackWithLadderOnce(player, query, meta);

  it('sanitizeOverride drops YouTube-thumbnail art but keeps real covers', () => {
    expect(
      MusicService.sanitizeOverride({ title: 'T', artworkUrl: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg' }),
    ).toEqual({ title: 'T' });
    const good = { title: 'T', artworkUrl: 'https://i.scdn.co/image/abc' };
    expect(MusicService.sanitizeOverride(good)).toBe(good);
    expect(MusicService.sanitizeOverride(undefined)).toBeUndefined();
  });

  it('preCleanArtwork never stamps a YouTube thumbnail passed as trusted art', () => {
    const track: { artworkUrl?: string | null } = { artworkUrl: null };
    MusicService.preCleanArtwork(track, 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg');
    expect(track.artworkUrl).toBeNull();
    MusicService.preCleanArtwork(track, 'https://i.scdn.co/image/abc');
    expect(track.artworkUrl).toBe('https://i.scdn.co/image/abc');
  });

  it('normalizeIsrc strips dashes and rejects garbage', () => {
    expect(MusicService.normalizeIsrc('USRC17607839')).toBe('USRC17607839');
    expect(MusicService.normalizeIsrc('usrc-1760-7839')).toBe('USRC17607839');
    expect(MusicService.normalizeIsrc('bogus')).toBeNull();
    expect(MusicService.normalizeIsrc(undefined)).toBeNull();
  });

  it('searches ISRC-first and skips the fuzzy query on hit', async () => {
    const { svc, searchSpy, mockPlayer } = buildHarness({
      searchImpl: (args) => {
        if (args.query === '"USRC17607839"') {
          return { tracks: [makeYtHit({ identifier: 'isrcvid0001', uri: 'https://www.youtube.com/watch?v=isrcvid0001' })] };
        }
        return { tracks: [makeYtHit({ identifier: 'fuzzyvid001' })] };
      },
    });
    const res = await ladderOnce(svc, mockPlayer, 'Midnight Circuit - Neon Skyline', {
      title: 'Neon Skyline',
      artist: 'Midnight Circuit',
      isrc: 'USRC17607839',
      durationMs: 213000,
    });
    expect(res && 'track' in res ? res.track.identifier : null).toBe('isrcvid0001');
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({ query: '"USRC17607839"', source: 'youtube' });
  });

  it('falls back to the title search when the ISRC hit duration-mismatches', async () => {
    const { svc, searchSpy, mockPlayer } = buildHarness({
      searchImpl: (args) => {
        if (args.query === '"USRC17607839"') {
          return { tracks: [makeYtHit({ identifier: 'isrcvid0001', duration: 600000 })] };
        }
        return { tracks: [makeYtHit({ identifier: 'fuzzyvid001' })] };
      },
    });
    const res = await ladderOnce(svc, mockPlayer, 'Midnight Circuit - Neon Skyline', {
      title: 'Neon Skyline',
      artist: 'Midnight Circuit',
      isrc: 'USRC17607839',
      durationMs: 213000,
    });
    expect(res && 'track' in res ? res.track.identifier : null).toBe('fuzzyvid001');
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it('runs a single fuzzy search when no ISRC is known', async () => {
    const { svc, searchSpy, mockPlayer } = buildHarness();
    const res = await ladderOnce(svc, mockPlayer, 'Midnight Circuit - Neon Skyline', {
      title: 'Neon Skyline',
      artist: 'Midnight Circuit',
    });
    expect(res && 'track' in res ? res.track.identifier : null).toBe('ytpick00001');
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({ query: 'Midnight Circuit - Neon Skyline' });
  });

  it('upgrades +search picker hits with Spotify names and covers (no URI hijack)', async () => {
    const { svc } = buildHarness({
      spotifySearchTracks: [
        {
          name: 'Neon Skyline',
          artist: 'Midnight Circuit',
          durationMs: 213000,
          searchQuery: 'Midnight Circuit - Neon Skyline',
          artworkUrl: 'https://i.scdn.co/image/upgraded',
          spotifyUri: 'https://open.spotify.com/track/xyz',
          provider: 'spotify',
        },
      ],
    });
    const results = await svc.searchTracks('midnight circuit neon skyline', 'youtube', false);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Neon Skyline');
    expect(results[0]?.author).toBe('Midnight Circuit');
    expect(results[0]?.artworkUrl).toBe('https://i.scdn.co/image/upgraded');
    // The pick still plays the chosen YouTube upload — only display metadata upgrades.
    expect(results[0]?.uri).toBe('https://www.youtube.com/watch?v=ytpick00001');
    expect(results[0]?.source).toBe('youtube');
  });

  it('never hands out a picker YouTube thumb when Spotify has no valid match', async () => {
    const { svc } = buildHarness({
      spotifySearchTracks: [
        {
          name: 'Completely Different Song',
          artist: 'Someone Else',
          durationMs: 120000,
          searchQuery: 'x',
          artworkUrl: 'https://i.scdn.co/image/nope',
          provider: 'spotify',
        },
      ],
    });
    const results = await svc.searchTracks('midnight circuit neon skyline', 'youtube', false);
    // No mismatched Spotify cover AND no video frame either: the pick
    // resolves its real art through the backfill cascade once it plays.
    expect(results[0]?.artworkUrl).toBeUndefined();
  });

  it('playMirror resolves a Deezer track ISRC-first with the deezer badge', async () => {
    const { svc, searchSpy, queueAdd } = buildHarness({
      searchImpl: (args) => {
        if (args.query === '"USRC17607839"') {
          return { tracks: [makeYtHit({ identifier: 'isrcvid0001', uri: 'https://www.youtube.com/watch?v=isrcvid0001' })] };
        }
        return { tracks: [makeYtHit({ identifier: 'fuzzyvid001' })] };
      },
    });
    const playMirror = (
      svc as unknown as {
        playMirror: (
          player: Player,
          resolution: {
            type: string;
            title: string;
            tracks: Array<Record<string, unknown>>;
            totalTracks: number;
            provider: string;
          },
          sourceUrl: string,
          requester: { id: string },
        ) => Promise<{ loadType: string; track?: { source?: string; artworkUrl?: string } }>;
      }
    ).playMirror.bind(svc);
    const player = (svc as unknown as { getPlayer: (g: string) => Player }).getPlayer('g-mirror-1') as Player;
    // getPlayer needs a registered player — our mock returns one for any guild.
    expect(player).toBeDefined();
    const res = await playMirror(
      player,
      {
        type: 'track',
        title: 'Neon Skyline',
        tracks: [
          {
            name: 'Neon Skyline',
            artist: 'Midnight Circuit',
            durationMs: 213000,
            searchQuery: 'Midnight Circuit - Neon Skyline',
            artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/dz.jpg',
            sourceUrl: 'https://www.deezer.com/track/123',
            isrc: 'USRC17607839',
            provider: 'deezer',
          },
        ],
        totalTracks: 1,
        provider: 'deezer',
      },
      'https://www.deezer.com/track/123',
      { id: 'u1' },
    );
    expect(res.loadType).toBe('track');
    expect(res.track?.source).toBe('deezer');
    expect(res.track?.artworkUrl).toBe('https://cdn-images.dzcdn.net/images/cover/dz.jpg');
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({ query: '"USRC17607839"' });
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('playMirror reports mirror_playlist for Deezer collections', async () => {
    const { svc } = buildHarness();
    const playMirror = (
      svc as unknown as {
        playMirror: (
          player: Player,
          resolution: {
            type: string;
            title: string;
            tracks: Array<Record<string, unknown>>;
            totalTracks: number;
            provider: string;
          },
          sourceUrl: string,
          requester: { id: string },
        ) => Promise<{ loadType: string }>;
      }
    ).playMirror.bind(svc);
    const player = (svc as unknown as { getPlayer: (g: string) => Player }).getPlayer('g-mirror-1') as Player;
    const mirrorTrack = {
      name: 'Neon Skyline',
      artist: 'Midnight Circuit',
      durationMs: 213000,
      searchQuery: 'Midnight Circuit - Neon Skyline',
      provider: 'deezer',
    };
    const res = await playMirror(
      player,
      { type: 'playlist', title: 'DZ Mix', tracks: [mirrorTrack, { ...mirrorTrack, name: 'Second' }], totalTracks: 2, provider: 'deezer' },
      'https://www.deezer.com/playlist/1',
      { id: 'u1' },
    );
    expect(res.loadType).toBe('mirror_playlist');
    // Let the fire-and-forget JIT top-up settle while mocks are still live —
    // otherwise it rejects after teardown and pollutes the run.
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('MusicService preClean statics (existing behavior guard)', () => {
  it('keeps stamping a known-good cover', () => {
    const track: { artworkUrl?: string | null } = { artworkUrl: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg' };
    MusicService.preCleanArtwork(track, 'https://i.scdn.co/image/abc');
    expect(track.artworkUrl).toBe('https://i.scdn.co/image/abc');
  });
});
