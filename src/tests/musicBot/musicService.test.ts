import { describe, it, expect, vi } from 'vitest';
import { MusicService } from '@bot/services/music/musicService';
import { QueueService } from '@bot/services/music/queueService';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import type { Player } from 'moonlink.js';

describe('MusicService', () => {
  const historyRepo = new MusicHistoryRepository();
  const queueService = new QueueService(historyRepo);

  const mockPlayer = {
    guildId: '123456789',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    volume: 100,
    paused: false,
    playing: true,
    connected: true,
    autoPlay: false,
    loop: 'off',
    ping: 35,
    lastPosition: 15000,
    current: {
      title: 'Bohemian Rhapsody',
      author: 'Queen',
      duration: 354000,
      uri: 'https://youtube.com/watch?v=fJ9rUzIMcZQ',
      identifier: 'fJ9rUzIMcZQ',
      isSeekable: true,
      isStream: false,
    },
    queue: {
      all: [],
      size: 0,
      duration: 0,
      isEmpty: true,
      clear: vi.fn(),
      shuffle: vi.fn(),
      remove: vi.fn(),
      removeRange: vi.fn(),
      add: vi.fn(),
    },
    filters: {
      enabled: ['bassboost'],
      enable: vi.fn(),
      disable: vi.fn(),
      clear: vi.fn(),
      apply: vi.fn().mockResolvedValue(true),
    },
    setVolume: vi.fn(function (this: { volume: number }, vol: number) {
      this.volume = vol;
    }),
    setLoop: vi.fn(function (this: { loop: string }, mode: string) {
      this.loop = mode;
    }),
    setAutoPlay: vi.fn(function (this: { autoPlay: boolean }, val: boolean) {
      this.autoPlay = val;
    }),
    connect: vi.fn().mockResolvedValue(true),
    play: vi.fn().mockResolvedValue(true),
    pause: vi.fn().mockResolvedValue(true),
    resume: vi.fn().mockResolvedValue(true),
    skip: vi.fn().mockResolvedValue(true),
    seek: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as Player;

  const mockMoonlinkManager = {
    getManager: vi.fn().mockReturnValue({
      players: {
        get: vi.fn((guildId: string) => (guildId === '123456789' ? mockPlayer : undefined)),
        create: vi.fn().mockReturnValue(mockPlayer),
      },
      search: vi.fn().mockImplementation(() =>
        Promise.resolve({
          loadType: 'track',
          tracks: [
            {
              title: 'Bohemian Rhapsody',
              author: 'Queen',
              duration: 354000,
              uri: 'https://youtube.com/watch?v=fJ9rUzIMcZQ',
              identifier: 'fJ9rUzIMcZQ',
            },
          ],
        }),
      ),
    }),
    getNodeStats: vi.fn().mockReturnValue([
      {
        identifier: 'Serenetia',
        host: 'lavalinkv4.serenetia.com',
        port: 443,
        connected: true,
        players: 5,
        playingPlayers: 3,
        cpuLoad: 12.5,
        lavalinkLoad: 4.2,
        memoryUsedMb: 256,
        memoryAllocatedMb: 1024,
        uptimeMs: 3600000,
        ping: 25,
      },
    ]),
    hasHealthyNode: vi.fn().mockReturnValue(true),
  } as unknown as MoonlinkManager;

  const mockSpotifyResolver = {
    isSpotifyUrl: vi.fn().mockReturnValue(false),
    resolve: vi.fn(),
    searchTrack: vi.fn().mockResolvedValue(null),
  } as unknown as SpotifyResolver;

  const musicService = new MusicService(
    mockMoonlinkManager,
    mockSpotifyResolver,
    queueService,
  );

  it('gets queue info for an active player', () => {
    const queueInfo = musicService.getQueueInfo('123456789');
    expect(queueInfo).not.toBeNull();
    expect(queueInfo?.guildId).toBe('123456789');
    expect(queueInfo?.current?.title).toBe('Bohemian Rhapsody');
    expect(queueInfo?.volume).toBe(100);
    expect(queueInfo?.isPlaying).toBe(true);
    expect(queueInfo?.activeFilters).toContain('bassboost');
  });

  it('sets and clamps volume correctly between 0 and 150', () => {
    const vol80 = musicService.setVolume('123456789', 80);
    expect(vol80).toBe(80);

    const volCapped = musicService.setVolume('123456789', 200);
    expect(volCapped).toBe(150);

    const volZero = musicService.setVolume('123456789', -10);
    expect(volZero).toBe(0);
  });

  it('toggles 24/7 mode', () => {
    expect(queueService.is247('123456789')).toBe(false);
    const enabled = musicService.toggle247('123456789');
    expect(enabled).toBe(true);
    expect(queueService.is247('123456789')).toBe(true);
  });

  it('toggles autoplay mode', () => {
    const nextState = musicService.toggleAutoplay('123456789');
    expect(nextState).toBe(true);
    expect(mockPlayer.setAutoPlay).toHaveBeenCalledWith(true);
  });

  it('sets loop mode', () => {
    const updated = musicService.setLoop('123456789', 'queue');
    expect(updated).toBe('queue');
    expect(mockPlayer.setLoop).toHaveBeenCalledWith('queue');
  });

  it('fetches node stats', () => {
    const stats = musicService.getNodeStats();
    expect(stats.length).toBe(1);
    expect(stats[0]?.identifier).toBe('Serenetia');
    expect(stats[0]?.connected).toBe(true);
  });

  it('adjusts volume up and down with delta clamping', () => {
    musicService.setVolume('123456789', 100);
    const steppedUp = musicService.adjustVolume('123456789', 10);
    expect(steppedUp).toBe(110);

    const steppedDown = musicService.adjustVolume('123456789', -20);
    expect(steppedDown).toBe(90);
  });

  it('cycles loop mode correctly', () => {
    mockPlayer.loop = 'off';
    const firstCycle = musicService.cycleLoop('123456789');
    expect(firstCycle).toBe('track');

    const secondCycle = musicService.cycleLoop('123456789');
    expect(secondCycle).toBe('queue');

    const thirdCycle = musicService.cycleLoop('123456789');
    expect(thirdCycle).toBe('off');
  });

  it('replays the current track from 0:00', async () => {
    const replayed = await musicService.replay('123456789');
    expect(replayed).toBe(true);
    expect(mockPlayer.seek).toHaveBeenCalledWith(0);
  });

  it('searches for tracks and maps to domain model', async () => {
    const results = await musicService.searchTracks('Queen');
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe('Bohemian Rhapsody');
    expect(results[0]?.author).toBe('Queen');
  });

  it('extrapolates position accurately when track is playing', () => {
    const now = Date.now();
    const playingPlayer = {
      ...mockPlayer,
      playing: true,
      paused: false,
      current: {
        ...mockPlayer.current,
        position: 10000,
        time: now - 5000, // 5 seconds elapsed
        duration: 354000,
      },
      get: vi.fn(),
    } as unknown as Player;

    const pos = queueService.calculatePosition(playingPlayer);
    // Should be 10000 + ~5000 = ~15000
    expect(pos).toBeGreaterThanOrEqual(14900);
    expect(pos).toBeLessThanOrEqual(15200);
  });

  it('does not extrapolate position when track is paused', () => {
    const now = Date.now();
    const pausedPlayer = {
      ...mockPlayer,
      playing: true,
      paused: true,
      current: {
        ...mockPlayer.current,
        position: 10000,
        time: now - 5000,
        duration: 354000,
      },
      get: vi.fn(),
    } as unknown as Player;

    const pos = queueService.calculatePosition(pausedPlayer);
    expect(pos).toBe(10000);
  });

  it('enriches YouTube playback with Spotify track name and artist when found', async () => {
    (mockSpotifyResolver.searchTrack as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
      durationMs: 354000,
      searchQuery: 'Queen - Bohemian Rhapsody',
      artworkUrl: 'https://spotify.com/art.jpg',
      spotifyUri: 'https://open.spotify.com/track/bohemian',
    });

    const res = await musicService.play(
      '123456789',
      'vc-1',
      'tc-1',
      'Queen - Bohemian Rhapsody (Official Video)',
      { id: 'user-1', tag: 'TestUser' },
    );

    expect(res.loadType).toBe('track');
    expect(res.track?.title).toBe('Bohemian Rhapsody');
    expect(res.track?.author).toBe('Queen');
    expect(res.track?.artworkUrl).toBe('https://spotify.com/art.jpg');
    expect(res.track?.source).toBe('youtube');
  });

  it('uses Spotify track name and artist for direct Spotify links', async () => {
    (mockSpotifyResolver.isSpotifyUrl as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (mockSpotifyResolver.resolve as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'track',
      title: 'Blinding Lights',
      totalTracks: 1,
      tracks: [
        {
          name: 'Blinding Lights',
          artist: 'The Weeknd',
          durationMs: 200000,
          searchQuery: 'The Weeknd - Blinding Lights',
          artworkUrl: 'https://spotify.com/blinding.jpg',
          spotifyUri: 'https://open.spotify.com/track/blinding',
        },
      ],
    });

    const res = await musicService.play(
      '123456789',
      'vc-1',
      'tc-1',
      'https://open.spotify.com/track/blinding',
      { id: 'user-1', tag: 'TestUser' },
    );

    expect(res.loadType).toBe('track');
    expect(res.track?.title).toBe('Blinding Lights');
    expect(res.track?.author).toBe('The Weeknd');
    expect(res.track?.artworkUrl).toBe('https://spotify.com/blinding.jpg');
    expect(res.track?.uri).toBe('https://open.spotify.com/track/blinding');
    expect(res.track?.source).toBe('spotify');
  });

  it('does NOT query Spotify or overwrite track metadata when a direct YouTube URL is played', async () => {
    vi.clearAllMocks();
    const res = await musicService.play(
      '123456789',
      'vc-1',
      'tc-1',
      'https://www.youtube.com/watch?v=cxk-1zsy_W8&t=212s',
      { id: 'user-1', tag: 'TestUser' },
    );

    expect(mockSpotifyResolver.searchTrack).not.toHaveBeenCalled();
    expect(res.loadType).toBe('track');
    expect(res.track?.title).toBe('Bohemian Rhapsody');
    expect(res.track?.author).toBe('Queen');
    expect(res.track?.source).toBe('youtube');
  });

  it('rejects an invalid Spotify match and preserves original YouTube metadata', async () => {
    (mockSpotifyResolver.searchTrack as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'Mo City Don',
      artist: 'Z-Ro',
      durationMs: 265213,
      searchQuery: 'Z-Ro - Mo City Don',
      artworkUrl: 'https://spotify.com/zro.jpg',
      spotifyUri: 'https://open.spotify.com/track/zro',
    });

    const res = await musicService.play(
      '123456789',
      'vc-1',
      'tc-1',
      'Playboi Carti Live Set',
      { id: 'user-1', tag: 'TestUser' },
    );

    expect(res.loadType).toBe('track');
    // Keeps the original title and does not adopt "Mo City Don"
    expect(res.track?.title).not.toBe('Mo City Don');
    expect(res.track?.artworkUrl).not.toBe('https://spotify.com/zro.jpg');
  });
});

