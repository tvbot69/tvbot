import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotScrobblingService } from './botScrobblingService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
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
});
