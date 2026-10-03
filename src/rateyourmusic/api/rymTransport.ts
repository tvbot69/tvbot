import { Logger } from '@domain/logging/logger';
import { rymFlaresolverrUrl, rymMaxTimeoutMs, rymRequestDelayMs } from '@config/runtimeEnv';

export interface RymTransportConfig {
  solverUrl: string;
  minDelayMs: number;
  maxTimeoutMs: number;
  maxRetries: number;
}

export interface RymPage {
  html: string;
  status: number;
  userAgent: string;
  url: string;
}

export class RymOriginBlockError extends Error {
  public constructor(url: string, detail?: string) {
    super(
      `rateyourmusic.com returned a ${detail ?? '503 origin block'} for ${url}. ` +
        'Release detail pages are heavily rate-limited; retry later, slow down, or use a residential exit.',
    );
    this.name = 'RymOriginBlockError';
  }
}

export class RymTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RymTransportError';
  }
}

const DEFAULTS = {
  solverUrl: 'http://localhost:8191',
  minDelayMs: 5000,
  maxTimeoutMs: 120000,
  maxRetries: 3,
} satisfies RymTransportConfig;

const OBSERVED_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

interface SolverResponse {
  status: string;
  message?: string;
  solution?: {
    url?: string;
    status?: number;
    response?: string;
    userAgent?: string;
  };
}

export class RymTransport {
  private readonly solverUrl: string;
  private readonly minDelayMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = 0;
  private sessionId: string | null = null;
  private sessionUserAgent = OBSERVED_UA;

  public constructor(config?: Partial<RymTransportConfig>) {
    this.solverUrl = config?.solverUrl ?? rymFlaresolverrUrl() ?? DEFAULTS.solverUrl;
    this.minDelayMs = config?.minDelayMs ?? rymRequestDelayMs() ?? DEFAULTS.minDelayMs;
    this.maxTimeoutMs = config?.maxTimeoutMs ?? rymMaxTimeoutMs() ?? DEFAULTS.maxTimeoutMs;
    this.maxRetries = config?.maxRetries ?? DEFAULTS.maxRetries;
  }

  public async getHtml(path: string): Promise<RymPage> {
    const url = path.startsWith('http') ? path : `https://rateyourmusic.com${path}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      await this.throttle();
      try {
        const page = await this.fetchViaSolver(url);
        if (this.isOriginBlock(page)) {
          throw new RymOriginBlockError(url);
        }
        return page;
      } catch (err) {
        if (err instanceof RymOriginBlockError) {
          throw err;
        }
        if (attempt >= this.maxRetries) {
          throw err instanceof RymTransportError
            ? err
            : new RymTransportError(`RYM fetch failed for ${url}: ${String(err)}`);
        }
        const backoff = 1000 * 2 ** (attempt - 1);
        Logger.debug(`RYM fetch retry ${attempt}/${this.maxRetries} for ${url} in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        this.sessionId = null;
      }
    }
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minDelayMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private isOriginBlock(page: RymPage): boolean {
    return (
      page.status === 503 ||
      (page.html.includes('HTTP ERROR 503') && page.html.includes('is currently unable to handle this request'))
    );
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    const res = await fetch(`${this.solverUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'sessions.create', maxTimeout: this.maxTimeoutMs }),
    });
    const json = (await res.json()) as SolverResponse;
    if (json.status !== 'ok') {
      throw new RymTransportError(`FlareSolverr session create failed: ${json.message ?? json.status}`);
    }
    const id = (json as { session?: string }).session;
    if (!id) {
      throw new RymTransportError('FlareSolverr session create returned no session id');
    }
    this.sessionId = id;
    return id;
  }

  private async fetchViaSolver(url: string): Promise<RymPage> {
    const sessionId = await this.ensureSession();
    const res = await fetch(`${this.solverUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', session: sessionId, url, maxTimeout: this.maxTimeoutMs }),
    });
    const json = (await res.json()) as SolverResponse;
    if (json.status !== 'ok' || !json.solution) {
      this.sessionId = null;
      throw new RymTransportError(`FlareSolverr request failed: ${json.message ?? json.status}`);
    }
    const solution = json.solution;
    if (solution.userAgent) {
      this.sessionUserAgent = solution.userAgent;
    }
    return {
      html: solution.response ?? '',
      status: solution.status ?? 0,
      userAgent: solution.userAgent ?? OBSERVED_UA,
      url: solution.url ?? url,
    };
  }

  public async destroySession(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      await fetch(`${this.solverUrl}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'sessions.destroy', session: this.sessionId }),
      });
    } catch {
      Logger.debug('RYM session destroy failed');
    }
  }

  public getUserAgent(): string {
    return this.sessionUserAgent;
    }
}
