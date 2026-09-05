import { Logger } from '@domain/logger';

export interface ExtractedToken {
  token: string;
  extractedAt: number;
}

const TOKEN_TTL_MS = 12 * 3600 * 1000;

export const extractTokenFromHtml = (html: string): string | null => {
  const jwtMatch = html.match(/(ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  return jwtMatch?.[1] ?? null;
};

export const extractBundleUrls = (html: string): string[] =>
  [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)]
    .map((m) => m[1] ?? '')
    .filter((src) => /index|main|app/i.test(src));

const extractTokenFromJs = (js: string): string | null => {
  const match = js.match(/(ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/);
  if (match && match[1]) {
    return match[1];
  }
  const labeled = js.match(/"token"\s*:\s*"(ey[^"]{40,})"/);
  return labeled?.[1] ?? null;
};

export class AppleMusicTokenScraper {
  private cached: ExtractedToken | null = null;
  private inflight: Promise<string> | null = null;

  public async getToken(): Promise<string | null> {
    if (this.cached && this.cached.extractedAt + TOKEN_TTL_MS > Date.now()) {
      return this.cached.token;
    }
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.scrape()
      .then((token) => {
        if (token) {
          this.cached = { token: token, extractedAt: Date.now() };
        }
        return token ?? '';
      })
      .finally(() => {
        this.inflight = null;
      });

    const result = await this.inflight;
    return result || null;
  }

  private async scrape(): Promise<string | null> {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    };

    try {
      const pageResponse = await fetch('https://music.apple.com/us/browse', { headers: headers });
      if (!pageResponse.ok) {
        Logger.warn(`Apple Music token scrape failed with HTTP ${pageResponse.status}`);
        return null;
      }
      const html = await pageResponse.text();

      const directToken = extractTokenFromHtml(html);
      if (directToken) {
        return directToken;
      }

      for (const bundleUrl of extractBundleUrls(html)) {
        const absolute = new URL(bundleUrl, 'https://music.apple.com').toString();
        try {
          const jsResponse = await fetch(absolute, { headers: headers });
          if (!jsResponse.ok) {
            continue;
          }
          const js = await jsResponse.text();
          const token = extractTokenFromJs(js);
          if (token) {
            return token;
          }
        } catch {
          continue;
        }
      }

      Logger.warn('Apple Music token not found in page or bundles');
      return null;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, 'Apple Music token scrape error');
      return null;
    }
  }

  public invalidate(): void {
    this.cached = null;
  }
}
