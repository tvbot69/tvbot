import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { IUserRepository, User } from '@domain/interfaces/ports/iuserRepository';
import type { Client } from 'discord.js';

describe('BotScrobblingService', () => {
  let service: BotScrobblingService;
  let mockLastfmRepo: Partial<ILastfmRepository>;
  let mockUserRepo: Partial<IUserRepository>;

  beforeEach(() => {
    mockLastfmRepo = {
      scrobbleTrack: vi.fn().mockResolvedValue(true),
    };

    mockUserRepo = {
      getUserByDiscordUserId: vi.fn(),
    };

    service = new BotScrobblingService(
      mockLastfmRepo as ILastfmRepository,
      mockUserRepo as IUserRepository,
    );
  });

  it('toggles opt-in state correctly', () => {
    expect(service.isUserOptedIn('123')).toBe(false);

    const enabled = service.toggleUserOptIn('123');
    expect(enabled).toBe(true);
    expect(service.isUserOptedIn('123')).toBe(true);

    const disabled = service.toggleUserOptIn('123', false);
    expect(disabled).toBe(false);
    expect(service.isUserOptedIn('123')).toBe(false);
  });

  it('records playing track in voice', () => {
    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now(),
    });

    const current = service.getNowPlaying('g1');
    expect(current).toBeDefined();
    expect(current?.title).toBe('Karma Police');
    expect(current?.artist).toBe('Radiohead');
  });

  it('scrobbles to opted-in listeners when track finishes threshold', async () => {
    service.toggleUserOptIn('u1', true);
    service.toggleUserOptIn('u2', false); // Not opted in

    vi.mocked(mockUserRepo.getUserByDiscordUserId!).mockImplementation(async (id: string) => {
      if (id === 'u1') {
        return {
          userId: 1,
          discordUserId: 'u1',
          userNameLastFm: 'user1_lfm',
          sessionKey: 'valid_session_key',
        } as User;
      }
      return null;
    });

    const startedAt = Date.now() - 150000; // 150s ago (> 50% of 260s)
    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt,
    });

    const mockMembers = new Map();
    mockMembers.set('u1', { user: { bot: false } });
    mockMembers.set('u2', { user: { bot: false } });
    mockMembers.set('bot_id', { user: { bot: true } });

    const mockClient = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({
            isVoiceBased: () => true,
            members: mockMembers,
          }),
        },
      },
    } as unknown as Client;

    const count = await service.handleTrackEnd(mockClient, 'g1', 'vc1');

    expect(count).toBe(1);
    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledWith(
      'Radiohead',
      'Karma Police',
      Math.floor(startedAt / 1000),
      'valid_session_key',
    );
  });

  it('refuses a track that ends before the 30s floor, with no repo call', async () => {
    service.toggleUserOptIn('u1', true);
    vi.mocked(mockUserRepo.getUserByDiscordUserId!).mockResolvedValue({
      userId: 1,
      discordUserId: 'u1',
      userNameLastFm: 'user1_lfm',
      sessionKey: 'valid_session_key',
    } as User);

    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now() - 10000,
    });

    const mockClient = {
      channels: { cache: { get: vi.fn().mockReturnValue({ isVoiceBased: () => true, members: new Map([['u1', { user: { bot: false } }]]) }) } },
    } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(0);
    expect(mockLastfmRepo.scrobbleTrack).not.toHaveBeenCalled();
    expect(mockUserRepo.getUserByDiscordUserId).not.toHaveBeenCalled();
  });

  it('refuses a track past 30s but before 50%, with no repo call', async () => {
    service.toggleUserOptIn('u1', true);
    vi.mocked(mockUserRepo.getUserByDiscordUserId!).mockResolvedValue({
      userId: 1,
      discordUserId: 'u1',
      userNameLastFm: 'user1_lfm',
      sessionKey: 'valid_session_key',
    } as User);

    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now() - 60000,
    });

    const mockClient = {
      channels: { cache: { get: vi.fn().mockReturnValue({ isVoiceBased: () => true, members: new Map([['u1', { user: { bot: false } }]]) }) } },
    } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(0);
    expect(mockLastfmRepo.scrobbleTrack).not.toHaveBeenCalled();
    expect(mockUserRepo.getUserByDiscordUserId).not.toHaveBeenCalled();
  });

  it('a missing channel returns 0 without reading members', async () => {
    service.toggleUserOptIn('u1', true);
    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now() - 150000,
    });

    const get = vi.fn().mockReturnValue(undefined);
    const mockClient = { channels: { cache: { get } } } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(0);
    expect(get).toHaveBeenCalledWith('vc1');
    expect(mockLastfmRepo.scrobbleTrack).not.toHaveBeenCalled();
    expect(mockUserRepo.getUserByDiscordUserId).not.toHaveBeenCalled();
  });

  it('an empty voice channel returns 0 without any repo call', async () => {
    service.toggleUserOptIn('u1', true);
    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now() - 150000,
    });

    const mockClient = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({
            isVoiceBased: () => true,
            members: new Map([['bot_id', { user: { bot: true } }]]),
          }),
        },
      },
    } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(0);
    expect(mockLastfmRepo.scrobbleTrack).not.toHaveBeenCalled();
    expect(mockUserRepo.getUserByDiscordUserId).not.toHaveBeenCalled();
  });

  it('a per-user throw does not stop the next listener from scrobbling', async () => {
    service.toggleUserOptIn('u1', true);
    service.toggleUserOptIn('u2', true);

    vi.mocked(mockUserRepo.getUserByDiscordUserId!).mockImplementation(async (id: string) => {
      if (id === 'u1') throw new Error('db down for one user');
      return { userId: 2, discordUserId: 'u2', userNameLastFm: 'user2_lfm', sessionKey: 'key2' } as User;
    });

    const startedAt = Date.now() - 150000;
    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt,
    });

    const mockClient = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({
            isVoiceBased: () => true,
            members: new Map([['u1', { user: { bot: false } }], ['u2', { user: { bot: false } }]]),
          }),
        },
      },
    } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(1);
    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledTimes(1);
    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledWith('Radiohead', 'Karma Police', Math.floor(startedAt / 1000), 'key2');
  });

  it('a per-user scrobble rejection does not stop the next listener', async () => {
    service.toggleUserOptIn('u1', true);
    service.toggleUserOptIn('u2', true);

    vi.mocked(mockUserRepo.getUserByDiscordUserId!).mockImplementation(async (id: string) =>
      ({ userId: id === 'u1' ? 1 : 2, discordUserId: id, userNameLastFm: `${id}_lfm`, sessionKey: `${id}-key` }) as User,
    );
    vi.mocked(mockLastfmRepo.scrobbleTrack!).mockImplementation(async (_a: string, _t: string, _ts: number, key: string) => {
      if (key === 'u1-key') throw new Error('vendor down for one user');
      return true;
    });

    service.recordTrackStart({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      title: 'Karma Police',
      artist: 'Radiohead',
      durationMs: 260000,
      startedAt: Date.now() - 150000,
    });

    const mockClient = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({
            isVoiceBased: () => true,
            members: new Map([['u1', { user: { bot: false } }], ['u2', { user: { bot: false } }]]),
          }),
        },
      },
    } as unknown as Client;

    await expect(service.handleTrackEnd(mockClient, 'g1', 'vc1')).resolves.toBe(1);
    expect(mockLastfmRepo.scrobbleTrack).toHaveBeenCalledTimes(2);
  });
});
