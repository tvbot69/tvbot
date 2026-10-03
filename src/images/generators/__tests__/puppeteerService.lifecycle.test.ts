import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { Logger } from '@domain/logging/logger';

/**
 * `PuppeteerService` — the one Chromium, the render slot, the render cache and
 * the shutdown path. No browser is launched: `launchBrowser` is replaced with a
 * fake, exactly as `puppeteerService.policy.test.ts` does, so this stays in the
 * default unit run and passes with no Chromium installed.
 *
 * What is worth pinning here is the RETRY. One Chromium serves the whole
 * process against a 384MB container, so `screenshotHtml` renders, and on failure
 * throws the browser away and renders exactly once more. Both directions matter:
 * a retry loop turns one crash into a fork bomb, and no retry at all turns a
 * transient wedge into a failed command forever. And the cache is asserted
 * alongside it, because a cache that returns bytes for the wrong size is worse
 * than no cache — the image would silently be the wrong dimensions.
 */

interface FakePage {
  setViewport: (o: unknown) => Promise<void>;
  setRequestInterception: (b: boolean) => Promise<void>;
  on: (event: string, cb: (req: unknown) => void) => void;
  setContent: (html: string, opts?: unknown) => Promise<void>;
  evaluate: (fn: unknown) => Promise<unknown>;
  screenshot: () => Promise<Uint8Array>;
  close: () => Promise<void>;
}

interface Harness {
  svc: PuppeteerService;
  pages: FakePage[];
  launches: number;
  closes: number;
  setContent: (impl: (html: string) => Promise<void>) => void;
  setEvaluate: (impl: () => Promise<unknown>) => void;
  setPageClose: (impl: () => Promise<void>) => void;
}

const makeService = (browserOverrides: Record<string, unknown> = {}): Harness => {
  const pages: FakePage[] = [];
  const state = {
    launches: 0,
    closes: 0,
    contentImpl: async (_html: string): Promise<void> => undefined,
    evaluateImpl: async (): Promise<unknown> => undefined,
    closeImpl: async (): Promise<void> => undefined,
  };

  const svc = new PuppeteerService() as unknown as {
    browser: unknown;
    launching: Promise<unknown> | null;
    launchBrowser: (dir: string | null) => Promise<unknown>;
    screenshotHtml: (html: string, w: number, h: number) => Promise<Buffer>;
    screenshotHtmlWithRainbowSort: (html: string, w: number, h: number) => Promise<Buffer>;
    isHealthy: () => Promise<boolean>;
    close: () => Promise<void>;
    preheatAsync: () => Promise<void>;
  };
  svc.browser = null;
  svc.launching = null;

  svc.launchBrowser = (async () => {
    state.launches += 1;
    return {
      connected: true,
      // `close()` and the process-exit hook both call this. Returning null keeps
      // the test away from a real signal; the force-kill branch is therefore not
      // exercised here.
      process: () => null,
      close: async () => undefined,
      on: () => undefined,
      newPage: async (): Promise<FakePage> => {
        const page: FakePage = {
          setViewport: async () => undefined,
          setRequestInterception: async () => undefined,
          on: () => undefined,
          setContent: async (html: string) => {
            await state.contentImpl(html);
          },
          evaluate: async () => state.evaluateImpl(),
          screenshot: async () => new Uint8Array([1, 2, 3]),
          close: async () => {
            state.closes += 1;
            await state.closeImpl();
          },
        };
        pages.push(page);
        return page;
      },
      ...browserOverrides,
    };
  }) as never;

  return {
    svc: svc as unknown as PuppeteerService,
    pages,
    get launches() {
      return state.launches;
    },
    get closes() {
      return state.closes;
    },
    setContent: (impl) => {
      state.contentImpl = impl;
    },
    setEvaluate: (impl) => {
      state.evaluateImpl = impl;
    },
    setPageClose: (impl) => {
      state.closeImpl = impl;
    },
  };
};

/** Rebuilt per test by the two describes that render; see the note in `beforeEach`. */
let harness!: Harness;

beforeEach(() => {
  // No service is built here. Every `new PuppeteerService()` registers four
  // process listeners (exit, SIGINT, SIGTERM, SIGHUP) and there is no API to
  // remove them, so building one per test that does not need it would push the
  // process past Node's max-listener warning for no benefit. The two describes
  // that render build their own.
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('screenshotHtml — one retry, never a loop', () => {
  beforeEach(() => {
    harness = makeService();
  });

  it('renders once and hands back the screenshot bytes', async () => {
    const buffer = await harness.svc.screenshotHtml('<html>a</html>', 100, 200);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect([...buffer]).toEqual([1, 2, 3]);
    expect(harness.pages).toHaveLength(1);
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  it('discards the browser and renders exactly once more after a failure', async () => {
    let attempts = 0;
    harness.setContent(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Target closed');
    });

    const buffer = await harness.svc.screenshotHtml('<html>a</html>', 100, 200);

    expect([...buffer]).toEqual([1, 2, 3]);
    expect(attempts).toBe(2);
    // A fresh browser, because the old one is assumed to be the thing that broke.
    expect(harness.launches).toBe(2);
    expect(Logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the second failure instead of retrying forever', async () => {
    harness.setContent(async () => {
      throw new Error('Target closed');
    });

    await expect(harness.svc.screenshotHtml('<html>a</html>', 100, 200)).rejects.toThrow(
      /Target closed/,
    );
    expect(harness.pages).toHaveLength(2);
    expect(Logger.warn).toHaveBeenCalledTimes(1);
  });

  it('closes the page even when the render threw, because a leaked page is unreclaimable memory', async () => {
    harness.setContent(async () => {
      throw new Error('boom');
    });

    await expect(harness.svc.screenshotHtml('<html>a</html>', 100, 200)).rejects.toThrow();
    // Both attempts ran and both pages were closed. On a 384MB container with
    // one shared Chromium, an unclosed page is memory that is never reclaimed.
    expect(harness.pages).toHaveLength(2);
    expect(harness.closes).toBe(2);
  });

  it('still produces a PNG when the in-page font/image wait fails', async () => {
    // The degradation lives INSIDE the page (each image has a 4s timeout and an
    // onerror handler), so an evaluate failure means the page context is gone and
    // the screenshot that follows fails too. Asserting the screenshot still
    // happened here pins that the catch does not swallow the render itself.
    harness.setEvaluate(() => Promise.reject(new Error('execution context destroyed')));

    const buffer = await harness.svc.screenshotHtml('<html>a</html>', 100, 200);
    expect([...buffer]).toEqual([1, 2, 3]);
    expect(Logger.debug).toHaveBeenCalled();
  });

  it('logs but does not fail the render when a page refuses to close', async () => {
    harness.setPageClose(() => Promise.reject(new Error('page already closed')));

    const buffer = await harness.svc.screenshotHtml('<html>a</html>', 100, 200);
    expect([...buffer]).toEqual([1, 2, 3]);
    expect(Logger.debug).toHaveBeenCalled();
  });
});

describe('the identical-render cache', () => {
  beforeEach(() => {
    // The cache is per instance and per hour, so each test needs a clean one —
    // a shared service would make the first test's render satisfy the second.
    harness = makeService();
  });

  it('serves the same HTML and size twice without opening a second page', async () => {
    await harness.svc.screenshotHtml('<html>same</html>', 100, 200);
    await harness.svc.screenshotHtml('<html>same</html>', 100, 200);

    expect(harness.pages).toHaveLength(1);
    expect(harness.launches).toBe(1);
  });

  it('keys on the SIZE as well as the HTML, so a resized chart is not served stale pixels', async () => {
    // The dangerous failure is not a miss, it is a HIT with the wrong box: the
    // caller asked for a taller image and gets the previous one, with no error.
    await harness.svc.screenshotHtml('<html>same</html>', 100, 200);
    await harness.svc.screenshotHtml('<html>same</html>', 100, 400);
    await harness.svc.screenshotHtml('<html>same</html>', 300, 200);

    expect(harness.pages).toHaveLength(3);
  });

  it('does not cache a render that threw, so the next caller retries', async () => {
    let attempts = 0;
    harness.setContent(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('transient');
    });

    await expect(harness.svc.screenshotHtml('<html>a</html>', 10, 10)).rejects.toThrow();
    const buffer = await harness.svc.screenshotHtml('<html>a</html>', 10, 10);

    expect([...buffer]).toEqual([1, 2, 3]);
    expect(attempts).toBe(3);
  });

  it('caches the rainbow render under the same rules', async () => {
    await harness.svc.screenshotHtmlWithRainbowSort('<html>same</html>', 100, 200);
    await harness.svc.screenshotHtmlWithRainbowSort('<html>same</html>', 100, 200);

    expect(harness.pages).toHaveLength(1);
  });
});

describe('isHealthy', () => {
  /**
   * `isHealthy()` is public, so the assertions below call the REAL method; only
   * `browser` is private and has to be reached through a cast. The double is a
   * real `PuppeteerService` instance with a stand-in browser on it, so nothing
   * here reimplements the probe.
   */
  type HealthProbe = {
    browser: { connected: boolean; version: () => Promise<string> } | null;
    isHealthy: () => Promise<boolean>;
  };

  const withBrowser = (browser: HealthProbe['browser']): HealthProbe => {
    const svc = new PuppeteerService() as unknown as HealthProbe;
    svc.browser = browser;
    return svc;
  };

  it('is false with no browser at all', async () => {
    const svc = new PuppeteerService();
    await expect(svc.isHealthy()).resolves.toBe(false);
  });

  it('is false when the browser is disconnected, without probing it', async () => {
    const version = vi.fn(async () => 'Chrome/1');
    const svc = withBrowser({ connected: false, version });

    await expect(svc.isHealthy()).resolves.toBe(false);
    expect(version).not.toHaveBeenCalled();
  });

  it('is true when the browser answers with a version string', async () => {
    const svc = withBrowser({ connected: true, version: async () => 'Chrome/130' });

    await expect(svc.isHealthy()).resolves.toBe(true);
  });

  it('is false when the version probe throws', async () => {
    const svc = withBrowser({
      connected: true,
      version: async () => {
        throw new Error('Target closed');
      },
    });

    await expect(svc.isHealthy()).resolves.toBe(false);
  });

  it('gives up on a wedged browser after two seconds', async () => {
    // A health check that hangs is worse than one that says no: the caller is
    // holding a request open while it waits.
    const svc = withBrowser({ connected: true, version: () => new Promise<string>(() => undefined) });

    vi.useFakeTimers();
    const probe = svc.isHealthy();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(probe).resolves.toBe(false);
  });
});

describe('the blocked-request log is capped', () => {
  type Internals = {
    logDeniedRequest: (url: string, reason: string) => void;
    deniedUrls: Set<string>;
    deniedOverflow: number;
  };

  it('logs each distinct blocked URL once', async () => {
    const svc = new PuppeteerService() as unknown as Internals;

    svc.logDeniedRequest('https://blocked.example/a.png', 'not allowlisted');
    svc.logDeniedRequest('https://blocked.example/a.png', 'not allowlisted');

    expect(svc.deniedUrls.size).toBe(1);
    expect(Logger.debug).toHaveBeenCalledTimes(1);
  });

  it('stops logging after twenty distinct URLs and says so exactly once', async () => {
    // One hostile cover URL must not turn a progress loop into a log flood, and
    // the overflow has to be announced or the silence looks like "nothing is
    // being blocked".
    const svc = new PuppeteerService() as unknown as Internals;

    for (let i = 0; i < 40; i += 1) {
      svc.logDeniedRequest(`https://blocked.example/${String(i)}.png`, 'not allowlisted');
    }

    expect(svc.deniedUrls.size).toBe(20);
    expect(svc.deniedOverflow).toBe(20);
    // 20 denials plus the single suppression notice.
    expect(Logger.debug).toHaveBeenCalledTimes(21);
  });
});

describe('close', () => {
  const withBrowser = (svc: PuppeteerService, browser: unknown): void => {
    (svc as unknown as { browser: unknown }).browser = browser;
  };

  const stubBrowser = (pages: () => Promise<unknown[]>) => ({
    connected: true,
    process: () => null,
    close: async () => undefined,
    on: () => undefined,
    pages,
  });

  it('is a no-op with no browser, so a double close cannot throw', async () => {
    const svc = new PuppeteerService();
    await expect(svc.close()).resolves.toBeUndefined();
    await expect(svc.close()).resolves.toBeUndefined();
  });

  it('closes the browser even when the tab sweep fails', async () => {
    const svc = new PuppeteerService();
    withBrowser(
      svc,
      stubBrowser(() => Promise.reject(new Error('detached'))),
    );

    await expect(svc.close()).resolves.toBeUndefined();
    expect(Logger.info).toHaveBeenCalledWith('Puppeteer browser closed');
  });

  it('carries on past a tab that refuses to close', async () => {
    // Shutdown: a tab the browser close is about to take with it is not worth a
    // failed shutdown, so each tab gets its own 800ms race and a swallowed error.
    const stubborn = { close: () => Promise.reject(new Error('still busy')) };
    const svc = new PuppeteerService();
    withBrowser(
      svc,
      stubBrowser(() => Promise.resolve([stubborn, { close: async () => undefined }])),
    );

    await expect(svc.close()).resolves.toBeUndefined();
    expect(Logger.info).toHaveBeenCalledWith('Puppeteer browser closed');
    expect((svc as unknown as { browser: unknown }).browser).toBeNull();
  });
});

describe('preheatAsync', () => {
  it('warns and gives up when the browser cannot launch', async () => {
    // Preheat is best-effort by design — it exists so the FIRST user command does
    // not pay the launch — so a failure must not stop the bot from booting.
    const svc = new PuppeteerService() as unknown as {
      launchBrowser: (dir: string | null) => Promise<unknown>;
      browser: unknown;
      preheatAsync: () => Promise<void>;
    };
    svc.browser = null;
    svc.launchBrowser = async () => {
      throw new Error('Could not find Chrome');
    };

    await expect(svc.preheatAsync()).resolves.toBeUndefined();
    expect(Logger.warn).toHaveBeenCalled();
  });

  it('closes the warmup page when it is done', async () => {
    const h = makeService();
    await h.svc.preheatAsync();

    expect(h.pages).toHaveLength(1);
    expect(h.launches).toBe(1);
  });
});

describe('retry skips when a slot waiter is queued', () => {
  type SlotInternals = {
    acquireRenderSlot: () => Promise<void>;
    releaseRenderSlot: () => void;
    renderWaiters: Array<() => void>;
  };

  beforeEach(() => {
    harness = makeService();
  });

  const waitFor = async (cond: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(label);
      await new Promise((r) => setImmediate(r));
    }
  };

  it('screenshotHtml skips the second attempt when a waiter is queued, releases the slot, waiter proceeds', async () => {
    const internals = harness.svc as unknown as SlotInternals;
    let attempts = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    harness.setContent(async () => {
      attempts += 1;
      if (attempts === 1) {
        await gate;
        throw new Error('Target closed');
      }
    });

    const first = harness.svc.screenshotHtml('<html>skip-a</html>', 100, 200);
    await waitFor(() => attempts === 1, 'first attempt never started');

    // Fill the second slot so the next render queues behind the two slots.
    await internals.acquireRenderSlot();
    const second = harness.svc.screenshotHtml('<html>skip-b</html>', 100, 200);
    await waitFor(() => internals.renderWaiters.length === 1, 'waiter never queued');
    expect(internals.renderWaiters.length).toBe(1);

    releaseGate();

    await expect(first).rejects.toThrow(/Target closed/);
    // Second attempt of the failed render never ran: one page for the failed
    // first attempt plus one for the waiter that proceeded.
    await expect(second).resolves.toBeDefined();
    expect(attempts).toBe(2);
    expect(harness.pages).toHaveLength(2);
    const debugText = vi.mocked(Logger.debug).mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(debugText.toLowerCase()).toContain('waiter');
    expect(debugText).toContain('1');
    expect(internals.renderWaiters.length).toBe(0);

    internals.releaseRenderSlot();
  });

  it('screenshotHtmlWithRainbowSort skips the second attempt when a waiter is queued', async () => {
    const internals = harness.svc as unknown as SlotInternals;
    let attempts = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    harness.setContent(async () => {
      attempts += 1;
      if (attempts === 1) {
        await gate;
        throw new Error('Target closed');
      }
    });

    const first = harness.svc.screenshotHtmlWithRainbowSort('<html>rainbow-skip-a</html>', 100, 200);
    await waitFor(() => attempts === 1, 'first rainbow attempt never started');

    await internals.acquireRenderSlot();
    const second = harness.svc.screenshotHtmlWithRainbowSort('<html>rainbow-skip-b</html>', 100, 200);
    await waitFor(() => internals.renderWaiters.length === 1, 'rainbow waiter never queued');
    expect(internals.renderWaiters.length).toBe(1);

    releaseGate();

    await expect(first).rejects.toThrow(/Target closed/);
    await expect(second).resolves.toBeDefined();
    expect(attempts).toBe(2);
    expect(harness.pages).toHaveLength(2);
    const debugText = vi.mocked(Logger.debug).mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(debugText.toLowerCase()).toContain('waiter');
    expect(debugText).toContain('1');
    expect(internals.renderWaiters.length).toBe(0);

    internals.releaseRenderSlot();
  });

  it('screenshotHtmlWithRainbowSort still retries once when no waiters are queued', async () => {
    let attempts = 0;
    harness.setContent(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Target closed');
    });

    const buffer = await harness.svc.screenshotHtmlWithRainbowSort('<html>rainbow-retry</html>', 100, 200);

    expect([...buffer]).toEqual([1, 2, 3]);
    expect(attempts).toBe(2);
    expect(harness.pages).toHaveLength(2);
    expect(Logger.warn).toHaveBeenCalledTimes(1);
  });
});
