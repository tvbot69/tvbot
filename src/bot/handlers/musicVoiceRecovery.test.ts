import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MusicHandler } from './musicHandler';

describe('MusicHandler voice recovery (Phase 3.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeSetup = () => {
    const player = {
      guildId: 'g1',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      playing: true,
      paused: false,
      current: { identifier: 't1', title: 'Esme', author: 'Mond', duration: 174000, isStream: false },
      queue: { isEmpty: true, size: 0 },
      data: new Map<string, unknown>(),
      get(key: string) {
        return this.data.get(key);
      },
      set(key: string, value: unknown) {
        this.data.set(key, value);
      },
      setVoiceChannelId(id: string) {
        this.voiceChannelId = id;
      },
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      restart: vi.fn(async () => true),
      resume: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      seek: vi.fn(async () => undefined),
    };
    const voiceHandlers: Record<string, (...args: never[]) => void> = {};
    const client = {
      on: vi.fn((event: string, cb: (...args: never[]) => void) => {
        voiceHandlers[event] = cb;
      }),
      user: { id: 'bot1' },
      channels: { cache: new Map(), fetch: vi.fn() },
    };
    const manager = {
      on: vi.fn(),
      players: { get: vi.fn(() => player) },
    };
    const guildChannels = new Map<string, unknown>();
    const guild = { id: 'g1', channels: { cache: guildChannels } };

    const handler = new MusicHandler(
      client as never,
      { getManager: () => manager } as never,
      {
        getQueueInfo: () => null,
        is247: () => false,
        set247: vi.fn(),
        calculatePosition: vi.fn(() => 90000),
      } as never,
    );
    void handler;
    const voiceUpdate = voiceHandlers['voiceStateUpdate'] as (
      oldState: unknown,
      newState: unknown,
    ) => void;
    return { player, voiceUpdate, guild };
  };

  const oldState = (channelId: string | null, guild: unknown) =>
    ({ id: 'bot1', guild, channelId }) as never;
  const newState = (channelId: string | null, guild: unknown) =>
    ({ id: 'bot1', guild, channelId }) as never;

  it('keeps the queue on kick and resumes on rejoin within grace', async () => {
    const { player, voiceUpdate, guild } = makeSetup();

    voiceUpdate(oldState('vc1', guild), newState(null, guild));
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();

    voiceUpdate(oldState(null, guild), newState('vc2', guild));
    await vi.runAllTimersAsync();
    expect(player.connect).toHaveBeenCalledTimes(1);
    // restart() is never used on rejoin: Moonlink v5 sends a channelId-less
    // voice payload there that Lavalink 4.2.2 rejects (400). resume() only
    // unpauses (no voice payload, never 400s), then we seek back to the
    // position saved at kick time instead of replaying from zero.
    expect(player.restart).not.toHaveBeenCalled();
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(90000);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('destroys the player when grace expires without rejoin', async () => {
    const { player, voiceUpdate, guild } = makeSetup();

    voiceUpdate(oldState('vc1', guild), newState(null, guild));
    expect(player.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(180001);
    expect(player.destroy).toHaveBeenCalledTimes(1);
  });
});
