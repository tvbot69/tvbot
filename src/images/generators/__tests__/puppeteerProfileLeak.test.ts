import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { PuppeteerService } from '@images/generators/puppeteerService';

/**
 * Regression test for the profile leak this machine accumulated.
 *
 * Measured on 2026-09-27: 186 orphaned `worker-<pid>-<timestamp>` directories
 * totalling 1.36 GB in `.puppeteer` — one per tsx-watch restart that hit the
 * profile lock, none of them ever removed.
 *
 * The defect was not "the lock". It was that the fallback directory's lifetime
 * was the process's rather than the browser's, and its name embedded a
 * timestamp, so nothing could ever be reused or reclaimed.
 */

/**
 * Chromium's real message when the profile is already held. The production
 * fallback keys off 'already running' and 'userDataDir'; the 186 leaked
 * directories are proof that branch genuinely executes, so the test uses a
 * message that really satisfies it rather than a shorthand that would silently
 * skip the fallback path.
 */
const LOCK_ERROR =
  'Failed to launch the browser process! Opening in existing browser session. ' +
  'A Chrome instance is already running with this userDataDir';

const root = path.join(tmpdir(), `tvbot-pptr-${process.pid}`);
const primaryDir = path.join(root, 'primary');

type SvcInternals = {
  userDataDir: string | null;
  fallbackProfileDir: string | null;
  browser: unknown;
  launchBrowser: (dir: string | null) => Promise<unknown>;
  ensureBrowser: () => Promise<unknown>;
};

const makeService = (userDataDir: string | null) => {
  const svc = new PuppeteerService() as unknown as SvcInternals;
  svc.userDataDir = userDataDir;
  svc.browser = null;

  const launched: (string | null)[] = [];
  let disconnect: (() => void) | null = null;

  svc.launchBrowser = vi.fn(async (dir: string | null) => {
    launched.push(dir);
    // A profile lock PERSISTS: the primary directory stays unavailable for the
    // life of the other Chrome. Modelling it as a one-shot failure would hide
    // the reuse behaviour entirely.
    if (dir === userDataDir) throw new Error(LOCK_ERROR);
    if (dir) mkdirSync(dir, { recursive: true });
    return {
      connected: true,
      // `kill()` is wired to process 'exit' and calls `browser.process()` and
      // `browser.close()`. Without both, that handler throws at process exit and
      // vitest reports it as an unhandled error attributed to whichever test
      // happened to be running - which is exactly the confusing failure this
      // double must not create.
      process: () => null,
      close: async () => undefined,
      on: (evt: string, cb: () => void) => {
        if (evt === 'disconnected') disconnect = cb;
      },
    };
  }) as never;

  return { svc, launched, fireDisconnect: () => disconnect?.() };
};

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(primaryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('PuppeteerService fallback profile lifecycle', () => {
  it('reuses ONE fallback directory instead of adding one per launch', async () => {
    const { svc, launched } = makeService(primaryDir);

    await svc.ensureBrowser();
    const first = svc.fallbackProfileDir;
    expect(first).toBeTruthy();

    // The disconnect + relaunch cycle a dev restart produces.
    svc.browser = null;
    await svc.ensureBrowser();

    expect(svc.fallbackProfileDir).toBe(first);
    // Every attempt logs the locked primary too, so compare the FALLBACK paths:
    // the old code minted a fresh timestamped path per launch, this must not.
    const fallbacks = new Set(launched.filter((d) => d !== primaryDir));
    expect(fallbacks.size).toBe(1);
    expect([...fallbacks][0]).toBe(first);
  });

  it('removes the fallback profile when its browser disconnects', async () => {
    const { svc, fireDisconnect } = makeService(primaryDir);

    await svc.ensureBrowser();
    const dir = svc.fallbackProfileDir as string;
    writeFileSync(path.join(dir, 'Cookies'), 'x');
    expect(existsSync(dir)).toBe(true);

    fireDisconnect();

    expect(svc.fallbackProfileDir).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('never deletes the primary profile directory', async () => {
    const { svc, fireDisconnect } = makeService(primaryDir);
    await svc.ensureBrowser();
    expect(svc.fallbackProfileDir).not.toBe(primaryDir);

    fireDisconnect();
    // Only the fallback is disposable; the real profile must survive.
    expect(existsSync(primaryDir)).toBe(true);
  });

  it('relaunches against a fallback when the primary profile is locked', async () => {
    const { svc, launched } = makeService(primaryDir);
    await svc.ensureBrowser();
    expect(launched[0]).toBe(primaryDir);
    expect(launched[1]).toBe(svc.fallbackProfileDir);
  });

  it('surfaces the lock error in dev rather than degrading silently', async () => {
    // Dev runs ephemeral, so there is nothing to fall back to.
    const { svc, launched } = makeService(null);

    await expect(svc.ensureBrowser()).rejects.toThrow(/already running/);
    expect(launched).toHaveLength(1);
    expect(svc.fallbackProfileDir).toBeNull();
  });
});
