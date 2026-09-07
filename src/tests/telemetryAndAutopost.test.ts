import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@domain/logger';
import { TelemetryService } from '@bot/services/telemetryService';
import { NowPlayingInteractions } from '@bot/interactions/nowPlayingInteractions';
import { AutopostService, type AutopostConfig } from '@bot/services/autopostService';
import type { ButtonInteraction, TextChannel, Client } from 'discord.js';

describe('Phase 3: Logging & Telemetry System', () => {
  it('creates scoped loggers with context and traceId', () => {
    const contextual = Logger.withContext({
      traceId: 'req-abc-123',
      userId: 'user-456',
      commandName: 'fm',
      guildId: 'guild-789',
    });

    expect(contextual).toBeDefined();
    expect(typeof contextual.info).toBe('function');
    expect(typeof contextual.error).toBe('function');
    expect(typeof contextual.warn).toBe('function');
  });

  it('tracks command invocations, failure rates, and percentiles', () => {
    const telemetry = new TelemetryService();

    // Record 100 executions with predictable latencies
    for (let i = 1; i <= 100; i++) {
      telemetry.recordCommandExecution('fm', i * 10, i % 10 !== 0); // 10% error rate
    }

    const commandStats = telemetry.getCommandMetric('fm');
    expect(commandStats).toBeDefined();
    expect(commandStats?.executions).toBe(100);
    expect(commandStats?.failures).toBe(10);
    expect(commandStats?.minDurationMs).toBe(10);
    expect(commandStats?.maxDurationMs).toBe(1000);
    
    const p50 = telemetry.calculatePercentile(commandStats!.recentLatencies, 50);
    const p95 = telemetry.calculatePercentile(commandStats!.recentLatencies, 95);
    const p99 = telemetry.calculatePercentile(commandStats!.recentLatencies, 99);
    expect(p50).toBeGreaterThanOrEqual(490);
    expect(p95).toBeGreaterThanOrEqual(940);
    expect(p99).toBeGreaterThanOrEqual(980);
  });

  it('tracks external API metrics across providers', () => {
    const telemetry = new TelemetryService();

    telemetry.recordApiCall('lastfm', '/2.0/?method=user.getRecentTracks', 120, 200);
    telemetry.recordApiCall('lastfm', '/2.0/?method=track.getInfo', 180, 200);
    telemetry.recordApiCall('lastfm', '/2.0/?method=artist.getInfo', 500, 500, 'Last.fm down');
    telemetry.recordApiCall('spotify', '/v1/search', 60, 200);

    const metrics = telemetry.getHealthMetrics();
    expect(metrics.externalApis['lastfm']).toBeDefined();
    expect(metrics.externalApis['lastfm']?.totalCalls).toBe(3);
    expect(metrics.externalApis['lastfm']?.errorCalls).toBe(1);
    expect(metrics.externalApis['spotify']?.totalCalls).toBe(1);
    expect(metrics.externalApis['spotify']?.errorCalls).toBe(0);
    expect(metrics.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryUsageMb.heapUsed).toBeGreaterThan(0);
  });
});

describe('Phase 4: Interactive Component Button Handlers', () => {
  let mockLastfmRepo: any;
  let mockUserRepo: any;
  let mockTrackService: any;
  let mockLyricsService: any;
  let interactions: NowPlayingInteractions;

  beforeEach(() => {
    mockLastfmRepo = {
      scrobbleTrack: vi.fn().mockResolvedValue(true),
      loveTrack: vi.fn().mockResolvedValue(true),
      unloveTrack: vi.fn().mockResolvedValue(true),
    };
    mockUserRepo = {
      getUserByDiscordUserId: vi.fn().mockResolvedValue({
        userId: 1,
        discordUserId: 'user-123',
        userNameLastFm: 'MusicLover',
        sessionKey: 'valid-session-key',
      }),
    };
    mockTrackService = {
      getScrobbleReference: vi.fn().mockImplementation((token: string) => {
        if (token === 'valid-ref') {
          return { artist: 'Radiohead', track: 'Creep' };
        }
        return null;
      }),
    };
    mockLyricsService = {
      getLyrics: vi.fn().mockResolvedValue({
        title: 'Creep',
        artist: 'Radiohead',
        plainLyrics: 'When you were here before...',
        source: 'lrclib',
      }),
    };

    interactions = new NowPlayingInteractions(
      mockUserRepo,
      mockLastfmRepo,
      mockTrackService,
      mockLyricsService,
    );
  });

  it('scrobbles track using referenced music cache token', async () => {
    const mockInteraction = {
      customId: 'scrobble-ref:valid-ref:user-123',
      user: { id: 'user-123' },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await interactions.handleScrobble(mockInteraction);

    expect(mockTrackService.getScrobbleReference).toHaveBeenCalledWith('valid-ref');
    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledWith(
      'Radiohead',
      'Creep',
      expect.any(Number),
      'valid-session-key',
    );
    expect(mockInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it('scrobbles track using encoded token payload', async () => {
    const mockInteraction = {
      customId: `scrobble-now:${encodeURIComponent('Coldplay')}:${encodeURIComponent('Yellow')}:user-123`,
      user: { id: 'user-123' },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await interactions.handleScrobble(mockInteraction);

    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledWith(
      'Coldplay',
      'Yellow',
      expect.any(Number),
      'valid-session-key',
    );
    expect(mockInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it('handles 1-click love and unlove buttons', async () => {
    const loveInteraction = {
      customId: `love-track:${encodeURIComponent('Daft Punk')}:${encodeURIComponent('Get Lucky')}`,
      user: { id: 'user-123' },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await interactions.handleLove(loveInteraction);
    expect(mockLastfmRepo.loveTrack).toHaveBeenCalledWith('Daft Punk', 'Get Lucky', 'valid-session-key');
    expect(loveInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('❤️ Loved') }),
    );

    const unloveInteraction = {
      customId: `unlove-track:${encodeURIComponent('Daft Punk')}:${encodeURIComponent('Get Lucky')}`,
      user: { id: 'user-123' },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await interactions.handleLove(unloveInteraction);
    expect(mockLastfmRepo.unloveTrack).toHaveBeenCalledWith('Daft Punk', 'Get Lucky', 'valid-session-key');
    expect(unloveInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('💔 Unloved') }),
    );
  });

  it('handles lyrics preview button', async () => {
    const lyricsInteraction = {
      customId: `track-lyrics:${encodeURIComponent('Radiohead')}:${encodeURIComponent('Creep')}:fm`,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await interactions.handleLyrics(lyricsInteraction);
    expect(lyricsInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(mockLyricsService.getLyrics).toHaveBeenCalledWith('Creep', 'Radiohead');
    expect(lyricsInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
  });

  it('resolves NowPlayingInteractions from container cleanly', async () => {
    const { container } = await import('tsyringe');
    const { UserRepository } = await import('@persistence/repositories/userRepository');
    const { LastFmRepository } = await import('@lastfm/repositories/lastFmRepository');
    const { TrackService } = await import('@bot/services/trackService');
    const { LyricsService } = await import('@bot/services/music/lyricsService');

    container.registerInstance(UserRepository, mockUserRepo as any);
    container.registerInstance('IUserRepository', mockUserRepo as any);
    container.registerInstance(LastFmRepository, mockLastfmRepo as any);
    container.registerInstance('ILastfmRepository', mockLastfmRepo as any);
    container.registerInstance(TrackService, mockTrackService as any);
    container.registerInstance(LyricsService, mockLyricsService as any);

    const resolved = container.resolve(NowPlayingInteractions);
    expect(resolved).toBeDefined();
    expect(typeof resolved.handleScrobble).toBe('function');
    expect(typeof resolved.handleLove).toBe('function');
    expect(typeof resolved.handleLyrics).toBe('function');
  });
});

describe('Phase 5: Background Indexer & Autopost Worker Engine', () => {
  let autopostService: AutopostService;
  let mockArtistsService: any;
  let mockAlbumService: any;
  let mockTrackService: any;
  let mockCrownService: any;
  let mockTelemetryService: any;

  beforeEach(() => {
    mockArtistsService = {};
    mockAlbumService = {};
    mockTrackService = {};
    mockCrownService = {
      getGuildLeaderboard: vi.fn().mockResolvedValue({
        entries: [
          {
            userId: 1,
            discordUserId: 'user-123',
            userNameLastFm: 'CrownKing',
            displayName: 'CrownKing',
            crownCount: 42,
          },
        ],
        totalActiveCrowns: 42,
      }),
    };
    mockTelemetryService = {
      recordCommandExecution: vi.fn(),
    };

    autopostService = new AutopostService(
      mockArtistsService,
      mockAlbumService,
      mockTrackService,
      mockCrownService,
      mockTelemetryService,
    );
  });

  it('manages autopost configurations per guild', () => {
    const config: AutopostConfig = {
      id: 'ap-1',
      guildId: 'guild-100',
      channelId: 'channel-200',
      schedule: 'Weekly',
      contentType: 'TopArtists',
      enabled: true,
    };

    autopostService.setAutopost(config);
    expect(autopostService.getAutopostsForGuild('guild-100')).toHaveLength(1);
    expect(autopostService.getAutopostsForGuild('guild-100')[0]?.id).toBe('ap-1');

    const removed = autopostService.removeAutopost('ap-1');
    expect(removed).toBe(true);
    expect(autopostService.getAutopostsForGuild('guild-100')).toHaveLength(0);
  });

  it('executes scheduled server crowns autoposts when due', async () => {
    const config: AutopostConfig = {
      id: 'ap-crowns',
      guildId: 'guild-100',
      channelId: 'channel-200',
      schedule: 'Daily',
      contentType: 'ServerCrowns',
      enabled: true,
      lastPosted: new Date(Date.now() - 25 * 3600 * 1000), // 25 hours ago, due!
    };

    autopostService.setAutopost(config);

    const mockSend = vi.fn().mockResolvedValue({});
    const mockChannel = {
      isTextBased: () => true,
      send: mockSend,
      guild: { name: 'Radiohead Server', iconURL: () => null },
      name: 'music-recap',
    };

    const mockClient = {
      channels: {
        fetch: vi.fn().mockResolvedValue(mockChannel),
      },
    } as unknown as Client;

    const result = await autopostService.runScheduledAutoposts(mockClient);

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockSend).toHaveBeenCalled();
    expect(mockTelemetryService.recordCommandExecution).toHaveBeenCalledWith(
      'autopost:servercrowns',
      expect.any(Number),
      true,
    );

    // Running again immediately should not post since it is not due
    const result2 = await autopostService.runScheduledAutoposts(mockClient);
    expect(result2.executed).toBe(0);
  });
});
