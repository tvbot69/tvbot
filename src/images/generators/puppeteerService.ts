import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import path from 'path';
import { Logger } from '@domain/logger';

export class PuppeteerService {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly userDataDir: string | null;
  private ProcessListenersRegistered = false;

  constructor() {
    // No persistent profile in dev — .puppeteer lock causes 40 chrome leak on tsx watch restarts
    const isProd = process.env.ENVIRONMENT === 'production' || process.env.NODE_ENV === 'production';
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
      const page = await browser.newPage();
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
    return puppeteer.launch({
      headless: true,
      ...(dir ? { userDataDir: dir } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        ...(dir ? ['--disk-cache-size=104857600'] as string[] : []),
      ],
    });
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
          const fallbackDir = path.join(this.userDataDir, `worker-${process.pid}-${Date.now()}`);
          try { mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
          Logger.info('Puppeteer browser fallback to worker profile');
          const browser = await this.launchBrowser(fallbackDir);
          this.browser = browser;
          browser.on('disconnected', () => { if (this.browser === browser) this.browser = null; });
          return browser;
        }
        this.browser = null;
        throw err;
      }
    })().finally(() => {
      this.launching = null;
    });

    return this.launching;
  }

  public async screenshotHtml(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    try {
      return await this.renderHtmlOnce(html, width, height);
    } catch (err) {
      Logger.warn({ err }, 'Puppeteer render error; reinitializing browser and retrying...');
      this.browser = null;
      return await this.renderHtmlOnce(html, width, height);
    }
  }

  private async renderHtmlOnce(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
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
    try {
      return await this.renderRainbowOnce(html, width, height);
    } catch (err) {
      Logger.warn({ err }, 'Puppeteer rainbow render error; reinitializing browser and retrying...');
      this.browser = null;
      return await this.renderRainbowOnce(html, width, height);
    }
  }

  private async renderRainbowOnce(
    html: string,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
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
      if (typeof (window as unknown as { processAllCellThemes?: () => void }).processAllCellThemes === 'function') {
        (window as unknown as { processAllCellThemes: () => void }).processAllCellThemes();
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

