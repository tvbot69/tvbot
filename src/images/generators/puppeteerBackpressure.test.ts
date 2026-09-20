import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PuppeteerService } from './puppeteerService';

describe('PuppeteerService backpressure (Phase 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a third render behind the two slots instead of launching a third page', async () => {
    const svc = new PuppeteerService() as unknown as {
      acquireRenderSlot: () => Promise<void>;
      releaseRenderSlot: () => void;
    };
    const order: string[] = [];

    await svc.acquireRenderSlot();
    await svc.acquireRenderSlot();
    let thirdResolved = false;
    const third = svc.acquireRenderSlot().then(() => {
      thirdResolved = true;
      order.push('third');
    });
    // Still queued — not resolved synchronously
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    svc.releaseRenderSlot();
    await third;
    expect(thirdResolved).toBe(true);
    expect(order).toEqual(['third']);
    svc.releaseRenderSlot();
  });

  it('caches identical renders and evicts oldest past the cap', async () => {
    const svc = new PuppeteerService() as unknown as {
      renderCacheKey: (html: string, w: number, h: number) => string;
      getCachedRender: (key: string) => Buffer | null;
      putCachedRender: (key: string, buf: Buffer) => void;
      renderCache: Map<string, { buf: Buffer; exp: number }>;
    };
    const key = svc.renderCacheKey('<html>a</html>', 100, 100);
    expect(svc.getCachedRender(key)).toBeNull();

    const buf = Buffer.from('png-bytes');
    svc.putCachedRender(key, buf);
    expect(svc.getCachedRender(key)).toBe(buf);

    for (let i = 0; i < 25; i++) {
      svc.putCachedRender(`k${i}`, Buffer.from(`b${i}`));
    }
    expect(svc.renderCache.size).toBeLessThanOrEqual(20);
  });
});
