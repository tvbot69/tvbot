import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { container } from 'tsyringe';
import { ShutdownService } from './shutdownService';
import { TimerService } from './timerService';
import { Client } from 'discord.js';
import { CacheService } from './cacheService';
import { PuppeteerService } from '@images/generators/puppeteerService';

describe('ShutdownService', () => {
  it('orchestrates clean shutdown steps without throwing', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    const mockTimerStop = vi.fn();
    const mockClientDestroy = vi.fn();
    const mockPuppeteerClose = vi.fn().mockResolvedValue(undefined);
    const mockCacheDisconnect = vi.fn().mockResolvedValue(undefined);

    container.registerInstance(TimerService, { stopAsync: mockTimerStop } as any);
    container.registerInstance(Client, { destroy: mockClientDestroy } as any);
    container.registerInstance(PuppeteerService, { close: mockPuppeteerClose } as any);
    container.registerInstance(CacheService, { disconnect: mockCacheDisconnect } as any);

    await ShutdownService.shutdown('TEST_SIG', 0);

    expect(mockTimerStop).toHaveBeenCalled();
    expect(mockClientDestroy).toHaveBeenCalled();
    expect(mockPuppeteerClose).toHaveBeenCalled();
    expect(mockCacheDisconnect).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });
});
