import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { Client } from 'discord.js';

describe('VoiceChannelStatusService', () => {
  let mockPut: ReturnType<typeof vi.fn>;
  let mockClient: Client;
  let service: VoiceChannelStatusService;

  beforeEach(() => {
    mockPut = vi.fn().mockResolvedValue({});
    mockClient = {
      rest: {
        put: mockPut,
      },
    } as unknown as Client;
    service = new VoiceChannelStatusService(mockClient);
  });

  it('sets voice channel status to "Artist - Song Title"', async () => {
    const success = await service.setStatus(
      '1234567890',
      'Lame (Official Music Video)',
      'Zaid Khaled',
    );

    expect(success).toBe(true);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith('/channels/1234567890/voice-status', {
      body: { status: 'Zaid Khaled - Lame' },
    });
  });

  it('sets voice channel status to just Song Title if author is omitted', async () => {
    const success = await service.setStatus('987654321', 'Starboy (Official Audio)');

    expect(success).toBe(true);
    expect(mockPut).toHaveBeenCalledWith('/channels/987654321/voice-status', {
      body: { status: 'Starboy' },
    });
  });

  it('avoids duplicate artist prefix if title already begins with artist', async () => {
    const success = await service.setStatus(
      '111222333',
      'Playboi Carti - POP OUT',
      'Playboi Carti',
    );

    expect(success).toBe(true);
    expect(mockPut).toHaveBeenCalledWith('/channels/111222333/voice-status', {
      body: { status: 'Playboi Carti - POP OUT' },
    });
  });

  it('skips redundant API calls if status is already set to the same title', async () => {
    await service.setStatus('1234567890', 'Starboy', 'The Weeknd');
    expect(mockPut).toHaveBeenCalledTimes(1);

    const secondCall = await service.setStatus('1234567890', 'Starboy', 'The Weeknd');
    expect(secondCall).toBe(true);
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('clears voice channel status when clearStatus is called', async () => {
    // First set it so it has an active status recorded
    await service.setStatus('1234567890', 'Starboy', 'The Weeknd');
    expect(mockPut).toHaveBeenCalledTimes(1);

    const clearSuccess = await service.clearStatus('1234567890');
    expect(clearSuccess).toBe(true);
    expect(mockPut).toHaveBeenCalledTimes(2);
    expect(mockPut).toHaveBeenLastCalledWith('/channels/1234567890/voice-status', {
      body: { status: '' },
    });

    // Calling clear again should skip because it is already cleared
    await service.clearStatus('1234567890');
    expect(mockPut).toHaveBeenCalledTimes(2);
  });

  it('handles API errors without throwing', async () => {
    mockPut.mockRejectedValueOnce(new Error('Missing Permissions'));

    const success = await service.setStatus('1234567890', 'Starboy', 'The Weeknd');
    expect(success).toBe(false);
  });

  it('returns false when channelId or title is missing', async () => {
    expect(await service.setStatus('', 'Starboy')).toBe(false);
    expect(await service.setStatus('123', '')).toBe(false);
    expect(await service.clearStatus('')).toBe(false);
  });
});
