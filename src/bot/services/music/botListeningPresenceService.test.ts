import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityType } from 'discord.js';
import { BotListeningPresenceService } from './botListeningPresenceService';

describe('BotListeningPresenceService', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let mockClient: any;
  let service: BotListeningPresenceService;

  beforeEach(() => {
    broadcast = vi.fn();
    mockClient = { ws: { broadcast } };
    service = new BotListeningPresenceService(mockClient);
  });

  it('sends a Spotify Listening activity with details/state/timestamps on track start', () => {
    service.showTrack({
      guildId: 'g1',
      title: 'Kick',
      artist: 'Future',
      artworkUrl: 'https://example.com/cover.jpg',
      durationMs: 135000,
      positionMs: 62000,
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const packet = broadcast.mock.calls[0]![0] as any;
    expect(packet.op).toBe(3);
    const activity = packet.d.activities[0];
    expect(activity.name).toBe('Spotify');
    expect(activity.type).toBe(ActivityType.Listening);
    expect(activity.details).toBe('Kick');
    expect(activity.state).toBe('Future');
    expect(activity.timestamps.end - activity.timestamps.start).toBe(135000);
    expect(activity.assets.large_image).toBe('https://example.com/cover.jpg');
    expect(service.isShowingMusic()).toBe(true);
  });

  it('freezes the bar when paused (no end timestamp)', () => {
    service.showTrack({
      guildId: 'g1',
      title: 'Kick',
      artist: 'Future',
      durationMs: 135000,
      positionMs: 62000,
      paused: true,
    });

    const activity = (broadcast.mock.calls[0]![0] as any).d.activities[0];
    expect(activity.timestamps?.end).toBeUndefined();
    expect(activity.state).toContain('Future');
  });

  it('only clears presence for the guild that owns it (last-wins safe)', () => {
    service.showTrack({ guildId: 'g1', title: 'A', artist: 'B', durationMs: 1000 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    service.clearIfGuild('g2');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(service.isShowingMusic()).toBe(true);

    service.clearIfGuild('g1');
    expect(broadcast).toHaveBeenCalledTimes(2);
    const activity = (broadcast.mock.calls[1]![0] as any).d.activities[0];
    expect(activity.name).toBe('scrobbles');
    expect(service.isShowingMusic()).toBe(false);
  });

  it('does nothing without a websocket (tests, unlucky boot order)', () => {
    const svc = new BotListeningPresenceService({} as any);
    expect(() =>
      svc.showTrack({ guildId: 'g1', title: 'A', artist: 'B', durationMs: 1000 }),
    ).not.toThrow();
    expect(svc.isShowingMusic()).toBe(false);
  });
});
