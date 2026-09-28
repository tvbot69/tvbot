import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import { Logger } from '@domain/logger';
import { isProduction, puppeteerExecutablePath } from '@config/runtimeEnv';
import { installBrowserRequestPolicy, type DenyLogger, type InterceptablePage } from '../browserRequestPolicy';

export class PuppeteerService {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly userDataDir: string | null;
  private ProcessListenersRegistered = false;

  /**
   * The fallback profile in use, so it can be deleted when the browser that
   * owns it goes away. See `launchFallbackBrowser`.
   */
  private fallbackProfileDir: string | null = null;

  // Render backpressure: one Chromium serves the whole process. Unbounded
  // concurrent screenshots OOM the 384MB container; extras wait or fail fast
  // (callers fall back to embeds).
  private activeRenders = 0;
  private readonly renderWaiters: Array<() => void> = [];
  private static readonly MAX_CONCURRENT_RENDERS = 2;
  private static readonly RENDER_SLOT_TIMEOUT_MS = 30000;

  // Identical-render dedup (button mashing, autopost retries): sha256 of the
  // exact bytes, 1h TTL, 20-entry LRU. In-process by design — PNGs are too
  // large to mirror into Redis on every render.
  private readonly renderCache = new Map<string, { buf: Buffer; exp: number }>();
  private static readonly RENDER_CACHE_TTL_MS = 3600000;
  private static readonly RENDER_CACHE_MAX = 20;

  /**
   * Distinct URLs the request policy has blocked, so one hostile cover URL
   * cannot turn a 5s progress loop into a log flood. Capped; the overflow
   * counter is reported once.
   */
  private readonly deniedUrls = new Set<string>();
  private deniedOverflow = 0;
  private static readonly MAX_LOGGED_DENIALS = 20;

  constructor() {
    // No persistent profile in dev — .puppeteer lock causes 40 chrome leak on tsx watch restarts
    const isProd = isProduction();
    if (isProd) {
      this.userDataDir = path.resolve(process.cwd(), '.puppeteer');
      try { mkdirSync(this.userDataDir, { recursive: true }); } catch { /* ignore */ }
    } else {
      this.userDataDir = null;
    }
    this.registerProcessCleanup();
  }

  public async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.connected) {
      return false;
    }
    try {
      const version = await Promise.race([
        this.browser.version(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Browser ping timeout')), 2000)),
      ]);
      return typeof version === 'string' && version.length > 0;
    } catch {
      return false;
    }
  }

  private registerProcessCleanup(): void {
    if (this.ProcessListenersRegistered) return;
    this.ProcessListenersRegistered = true;
    const kill = () => {
      try {
        const proc: ChildProcess | null = this.browser?.process() ?? null;
        if (proc?.pid) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      if (this.browser) {
        void this.browser.close().catch(() => undefined);
        this.browser = null;
      }
    };
    process.once('exit', kill);
    process.once('SIGINT', () => { kill(); process.removeListener('exit', kill); });
    process.once('SIGTERM', () => { kill(); process.removeListener('exit', kill); });
    process.once('SIGHUP', () => { kill(); });
  }

  public async preheatAsync(): Promise<void> {
    try {
      const browser = await this.ensureBrowser();
      const page = await this.preparePage(browser);
      try {
        await page.setViewport({ width: 300, height: 300, deviceScaleFactor: 1 });
        await page.setContent(
          `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #000; color: #fff; }
          </style></head><body><span>Warmup</span></body></html>`,
          { waitUntil: 'domcontentloaded', timeout: 5000 },
        );
        await page.evaluate(async () => {
          if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
          }
        }).catch(() => undefined);
        Logger.info('Puppeteer browser preheated and ready');
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to preheat Puppeteer browser on startup');
    }
  }

  private async launchBrowser(dir: string | null): Promise<Browser> {
    const isProd = isProduction();
    const execPath = puppeteerExecutablePath();

    return puppeteer.launch({
      headless: true,
      ...(execPath ? { executablePath: execPath } : {}),
      ...(dir ? { userDataDir: dir } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // `--disable-web-security` used to sit here and is gone. Removing it is
        // not free of doubt: a cross-origin `@font-face` IS CORS-gated, and
        // pages/receipt.html loads its font from fm.bot, so this flag may have
        // been the only reason that font ever rendered. Probed on 2026-09-28 —
        // fm.bot returns `access-control-allow-origin: *`, and a Chromium
        // launched without the flag reports the face as `loaded`. Nothing else
        // in any page is a remote asset, so the flag bought nothing else.
        '--font-render-hinting=none',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--js-flags="--max-old-space-size=128"',
        ...(isProd ? ['--no-zygote', '--single-process'] : []),
        ...(dir ? ['--disk-cache-size=33554432'] as string[] : []),
      ],
    });
  }

  /**
   * A blocked subresource is an expected-but-notable outcome, not an error: the
   * page's own onerror handlers already fall back to a placeholder. DEBUG, not
   * WARN, because it happens on ordinary catalogue misses, and because WARN on
   * every miss is exactly the noise that hides a real failure.
   */
  private readonly logDeniedRequest: DenyLogger = (url, reason) => {
    if (this.deniedUrls.has(url)) return;
    if (this.deniedUrls.size >= PuppeteerService.MAX_LOGGED_DENIALS) {
      this.deniedOverflow++;
      if (this.deniedOverflow === 1) {
        Logger.debug(
          `Puppeteer request policy: further blocked URLs suppressed after ${PuppeteerService.MAX_LOGGED_DENIALS} distinct entries`,
        );
      }
      return;
    }
    this.deniedUrls.add(url);
    Logger.debug(`Puppeteer request policy blocked ${url} — ${reason}`);
  };

  /**
   * Arm request interception before anything navigates. Every page this service
   * creates goes through here; `preheatAsync` included, because a page without
   * the policy is a page that can reach the metadata endpoint.
   */
  private async preparePage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    // Puppeteer's `Page` overloads are not structurally assignable to the
    // two methods the policy uses; the cast is to that narrow interface, not to
    // `any`, so a change on either side still fails the build.
    await installBrowserRequestPolicy(page as unknown as InterceptablePage, this.logDeniedRequest);
    return page;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }
    if (this.launching) {
      return this.launching;
    }

    this.launching = (async () => {
      try {
        const browser = await this.launchBrowser(this.userDataDir);
        Logger.info(`Puppeteer browser initialized ${this.userDataDir ? '(persistent profile)' : '(ephemeral dev)'}`);
        this.browser = browser;
        browser.on('disconnected', () => {
          Logger.warn('Puppeteer browser disconnected; will reinitialize on next call');
          if (this.browser === browser) {
            this.browser = null;
          }
        });
        return browser;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already running') || msg.includes('userDataDir')) {
          if (!this.userDataDir) throw err; // ephemeral should never hit lock — rethrow
          return this.launchFallbackBrowser();
        }
        this.browser = null;
        throw err;
      }
    })().finally(() => {
      this.launching = null;
    });

    return this.launching;
  }

  /**
   * The main profile is locked by another Chrome, so launch against a private
   * one.
   *
   * This used to name the directory `worker-${pid}-${Date.now()}` and never
   * remove it. On a dev machine that accumulated 186 orphaned profiles and
   * 1.36 GB, because every tsx-watch restart hit the lock, created a fresh
   * timestamped directory, and left it behind. The existing comment blamed
   * "the .puppeteer lock", which described the trigger rather than the defect.
   *
   * Two changes, both about making the directory's lifetime match the browser's
   * lifetime rather than the process's:
   *   - one path per process, so a restart reuses the previous directory
   *     instead of adding a new one on every launch
   *   - removed when the browser that owns it disconnects, or on process exit
   *
   * Only the fallback is ever deleted. The primary `userDataDir` holds the real
   * profile and must survive.
   */
  private async launchFallbackBrowser(): Promise<Browser> {
    const dir = this.fallbackProfileDir ?? path.join(this.userDataDir as string, `worker-${process.pid}`);
    this.fallbackProfileDir = dir;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* a pre-existing directory is exactly what we want to reuse */
    }

    Logger.info('Puppeteer browser fallback to worker profile');
    const browser = await this.launchBrowser(dir);
    this.browser = browser;
    const discard = () => {
      if (this.browser === browser) this.browser = null;
      this.discardFallbackProfile();
    };
    browser.on('disconnected', discard);
    process.once('exit', this.discardFallbackProfile);
    return browser;
  }

  private discardFallbackProfile(): void {
    const dir = this.fallbackProfileDir;
    this.fallbackProfileDir = null;
    if (!dir) return;
    process.removeListener('exit', this.discardFallbackProfile);
    try {
      rmSync(dir, { recursive: true, force: true });
      Logger.debug(`Removed Puppeteer fallback profile ${dir}`);
    } catch (err: unknown) {
      // Never throw from cleanup: a locked file here must not take down a
      // screenshot or the exit path.
      Logger.debug(
        `Could not remove Puppeteer fallback profile ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private renderCacheKey(html: string, width: number, height: number): string {
    return createHash('sha256').update(`${width}x${height}:`).update(html).digest('hex');
  }

  private getCachedRender(key: string): Buffer | null {
    const entry = this.renderCache.get(key);
    if (!entry) return null;
    if (entry.exp <= Date.now()) {
      this.renderCache.delete(key);
      return null;
    }
    return entry.buf;
  }

  private putCachedRender(key: string, buf: Buffer): void {
    if (this.renderCache.size >= PuppeteerService.RENDER_CACHE_MAX) {
      const oldest = this.renderCache.keys().next().value;
      if (oldest !== undefined) this.renderCache.delete(oldest);
    }
    this.renderCache.set(key, { buf, exp: Date.now() + PuppeteerService.RENDER_CACHE_TTL_MS });
  }

  private async acquireRenderSlot(): Promise<void> {
    if (this.activeRenders < PuppeteerService.MAX_CONCURRENT_RENDERS) {
      this.activeRenders++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.renderWaiters.indexOf(release);
        if (idx >= 0) this.renderWaiters.splice(idx, 1);
        reject(new Error('Render queue timed out (too many concurrent charts)'));
      }, PuppeteerService.RENDER_SLOT_TIMEOUT_MS);
      const release = () => {
        clearTimeout(timer);
        this.activeRenders++;
        resolve();
      };
      this.renderWaiters.push(release);
    });
  }

  private releaseRenderSlot(): void {
    this.activeRenders = Math.max(0, this.activeRenders - 1);
    const next = this.renderWaiters.shift();
    if (next) next();
  }

  public async screenshotHtml(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const key = this.renderCacheKey(html, width, height);
    const cached = this.getCachedRender(key);
    if (cached) return cached;
    await this.acquireRenderSlot();
    try {
      try {
        const buf = await this.renderHtmlOnce(html, width, height);
        this.putCachedRender(key, buf);
        return buf;
      } catch (err) {
        Logger.warn({ err }, 'Puppeteer render error; reinitializing browser and retrying...');
        this.browser = null;
        const buf = await this.renderHtmlOnce(html, width, height);
        this.putCachedRender(key, buf);
        return buf;
      }
    } finally {
      this.releaseRenderSlot();
    }
  }

  private async renderHtmlOnce(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const browser = await this.ensureBrowser();
    const page = await this.preparePage(browser);
    try {
      await page.setViewport({ width: width, height: height, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 25000 });

      await this.waitForFontsAndImages(page);

      const rendered = await page.screenshot({
        type: 'png',
        omitBackground: false,
      });
      return Buffer.from(rendered);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  public async screenshotHtmlWithRainbowSort(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const key = this.renderCacheKey(html, width, height);
    const cached = this.getCachedRender(key);
    if (cached) return cached;
    await this.acquireRenderSlot();
    try {
      try {
        const buf = await this.renderRainbowOnce(html, width, height);
        this.putCachedRender(key, buf);
        return buf;
      } catch (err) {
        Logger.warn({ err }, 'Puppeteer rainbow render error; reinitializing browser and retrying...');
        this.browser = null;
        const buf = await this.renderRainbowOnce(html, width, height);
        this.putCachedRender(key, buf);
        return buf;
      }
    } finally {
      this.releaseRenderSlot();
    }
  }

  private async renderRainbowOnce(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const browser = await this.ensureBrowser();
    const page = await this.preparePage(browser);
    try {
      await page.setViewport({ width: width, height: height, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 35000 });

      await this.waitForFontsAndImages(page);

      const sortScript = `
        () => {
          const grid = document.querySelector('.grid');
          if (!grid) { return; }
          const cells = Array.from(grid.querySelectorAll('.cell'));
          const hues = cells.map((cell, i) => {
            const img = cell.querySelector('img');
            if (!img || !img.complete) { return { index: i, hue: 999 }; }
            try {
              const canvas = document.createElement('canvas');
              canvas.width = 8; canvas.height = 8;
              const ctx = canvas.getContext('2d');
              if (!ctx) { return { index: i, hue: 999 }; }
              ctx.drawImage(img, 0, 0, 8, 8);
              const data = ctx.getImageData(0, 0, 8, 8).data;
              let r = 0, g = 0, b = 0;
              for (let p = 0; p < data.length; p += 4) {
                r += data[p]; g += data[p+1]; b += data[p+2];
              }
              const count = data.length / 4;
              r /= count; g /= count; b /= count;
              const max = Math.max(r, g, b), min = Math.min(r, g, b);
              const delta = max - min;
              let hue = 0;
              if (delta !== 0) {
                if (max === r) hue = ((g - b) / delta) % 6;
                else if (max === g) hue = (b - r) / delta + 2;
                else hue = (r - g) / delta + 4;
                hue *= 60;
                if (hue < 0) hue += 360;
              }
              const sat = max === 0 ? 0 : delta / max;
              return { index: i, hue: sat < 0.12 ? hue + 360 : hue };
            } catch (e) {
              return { index: i, hue: 999 };
            }
          });
          hues.sort((a, b) => a.hue - b.hue);
          for (const entry of hues) {
            grid.appendChild(cells[entry.index]);
          }
        }
      `;
      await page.evaluate(sortScript);

      const rendered = await page.screenshot({
        type: 'png',
        omitBackground: false,
      });
      return Buffer.from(rendered);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async waitForFontsAndImages(page: Page): Promise<void> {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      const images = Array.from(document.querySelectorAll('img'));
      await Promise.all(
        images.map(
          (img) =>
            new Promise((resolve) => {
              if (img.complete) return resolve(true);
              const timer = setTimeout(() => resolve(true), 4000);
              img.onload = () => {
                clearTimeout(timer);
                resolve(true);
              };
              img.onerror = () => {
                clearTimeout(timer);
                resolve(true);
              };
            }),
        ),
      );
      const w = window as { processAllCellThemes?: () => void };
      if (typeof w.processAllCellThemes === 'function') {
        w.processAllCellThemes();
      }
    }).catch(() => undefined);
  }

  public async close(): Promise<void> {
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = null;
    const timeout = (ms: number, label: string) => new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms));
    try {
      // Close tabs with 2s cap — prevents hang on disconnected browser
      try {
        const pages = (await Promise.race([browser.pages().catch(() => [] as Page[]), timeout(1500, 'pages')]).catch(() => [] as Page[])) as Page[];
        for (const p of pages) await Promise.race([p.close().catch(() => undefined), timeout(800, 'pageClose')]).catch(() => undefined);
      } catch { /* ignore */ }
      // Close browser with 3s cap
      await Promise.race([browser.close().catch(() => undefined), timeout(3000, 'browserClose')]).catch(() => undefined);
      // Force-kill if still alive
      try {
        const proc: ChildProcess | null = browser.process() ?? null;
        if (proc?.pid) {
          try { process.kill(proc.pid, 0); proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      } catch { /* ignore */ }
      Logger.info('Puppeteer browser closed');
    } catch (err) {
      Logger.warn({ err }, 'Failed to close Puppeteer browser cleanly');
      try { browser.process()?.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

