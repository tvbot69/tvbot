import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { container } from 'tsyringe';
import { ShutdownService } from '@bot/services/system/shutdownService';
import { TimerService } from '@bot/services/lastfm/timerService';
import { Client } from 'discord.js';
import { CacheService } from '@bot/services/system/cacheService';
import { PuppeteerService } from '@images/generators/puppeteerService';

describe('ShutdownService', () => {
  it('orchestrates clean shutdown steps without throwing', async () => {
    // `process.exit` is typed `(code?) => never`; the stub returns normally,
    // which is the whole point — the assertions below need execution to continue.
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const mockTimerStop = vi.fn();
    const mockClientDestroy = vi.fn();
    const mockPuppeteerClose = vi.fn().mockResolvedValue(undefined);
    const mockCacheDisconnect = vi.fn().mockResolvedValue(undefined);

    container.registerInstance(TimerService, { stopAsync: mockTimerStop } as unknown as TimerService);
    container.registerInstance(Client, { destroy: mockClientDestroy } as unknown as Client);
    container.registerInstance(PuppeteerService, {
      close: mockPuppeteerClose,
    } as unknown as PuppeteerService);
    container.registerInstance(CacheService, {
      disconnect: mockCacheDisconnect,
    } as unknown as CacheService);

    await ShutdownService.shutdown('TEST_SIG', 0);

    expect(mockTimerStop).toHaveBeenCalled();
    expect(mockClientDestroy).toHaveBeenCalled();
    expect(mockPuppeteerClose).toHaveBeenCalled();
    expect(mockCacheDisconnect).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });
});
