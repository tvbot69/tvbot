import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import puppeteer from 'puppeteer';
import { PuppeteerService } from '@images/generators/puppeteerService';

// Mocked so launch-args assertions read the real options object without
// launching Chromium. Same pattern as puppeteerService.policy.test.ts.
vi.mock('puppeteer', () => ({
  default: { launch: vi.fn(async () => ({})) },
}));

/**
 * Native budget: one Chromium serves the process under a 384MB heap cap.
 * A silent bump of any of these turns one failed render into an OOM.
 */
describe('PuppeteerService native budget', () => {
  type Statics = {
    MAX_CONCURRENT_RENDERS: number;
    RENDER_CACHE_MAX: number;
    RENDER_SLOT_TIMEOUT_MS: number;
  };

  const statics = PuppeteerService as unknown as Statics;

  it('caps concurrent renders at 2', () => {
    expect(statics.MAX_CONCURRENT_RENDERS).toBe(2);
  });

  it('caps the render cache at 20 entries', () => {
    expect(statics.RENDER_CACHE_MAX).toBe(20);
  });

  it('caps the slot wait at 30s', () => {
    expect(statics.RENDER_SLOT_TIMEOUT_MS).toBe(30000);
  });

  it('caps the Chromium heap at 128MB via js-flags', async () => {
    vi.mocked(puppeteer.launch).mockClear();
    const svc = new PuppeteerService() as unknown as {
      launchBrowser: (dir: string | null) => Promise<unknown>;
    };
    await svc.launchBrowser(null);

    expect(vi.mocked(puppeteer.launch)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(puppeteer.launch).mock.calls[0]?.[0]?.args as string[];
    expect(args.join(' ')).toContain('max-old-space-size=128');
  });
});
