import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { QueueService } from './queueService';
import { BotScrobblingService } from './botScrobblingService';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';

const makeRepo = (settings: Array<{ guildId: string; stay247: boolean; volume: number; loopMode: string; autoplay: boolean; filters: string[] }> = [], optIns: string[] = []) => {
  const saved: Array<{ guildId: string; partial: unknown }> = [];
  return {
    repo: {
      getAllSettings: vi.fn(async () =>
        settings.map((s) => ({ ...s })),
      ),
      saveSettings: vi.fn(async (guildId: string, partial: unknown) => {
        saved.push({ guildId, partial });
      }),
      getOptedInDiscordIds: vi.fn(async () => [...optIns]),
      setOptIn: vi.fn(async () => undefined),
    },
    saved,
  };
};

describe('durable music settings (Phase 3.3)', () => {
  it('restores 247 and prefs from the database at boot', async () => {
    const { repo } = makeRepo([
      { guildId: 'g1', stay247: true, volume: 80, loopMode: 'queue', autoplay: true, filters: ['nightcore'] },
    ]);
    const queue = new QueueService({} as MusicHistoryRepository, repo as never);

    expect(queue.is247('g1')).toBe(false);
    await queue.loadPersistedState();

    expect(queue.is247('g1')).toBe(true);
    expect(queue.getSettings('g1')).toMatchObject({ volume: 80, loopMode: 'queue', autoplay: true, filters: ['nightcore'] });
    expect(queue.getSettings('unknown')).toMatchObject({ volume: 100, loopMode: 'off' });
  });

  it('writes 247 toggles through to the database', async () => {
    const { repo, saved } = makeRepo();
    const queue = new QueueService({} as MusicHistoryRepository, repo as never);

    queue.set247('g2', true);
    expect(queue.is247('g2')).toBe(true);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ guildId: 'g2', partial: { stay247: true } });

    queue.set247('g2', false);
    expect(queue.is247('g2')).toBe(false);
  });

  it('restores scrobbling opt-ins and persists toggles', async () => {
    const { repo } = makeRepo([], ['u1']);
    const service = new BotScrobblingService({} as never, {} as never, repo as never);

    expect(service.isUserOptedIn('u1')).toBe(false);
    await service.loadOptIns();
    expect(service.isUserOptedIn('u1')).toBe(true);

    service.toggleUserOptIn('u2', true);
    expect(service.isUserOptedIn('u2')).toBe(true);
    await vi.waitFor(() =>
      expect(repo.setOptIn).toHaveBeenCalledWith('u2', true),
    );
  });
});
