import { container } from 'tsyringe';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { LastfmApiError } from '@domain/models/lastfmError';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { createLastfmSignature } from './lastfmSignature';

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;

const isTransientStatus = (status: number): boolean =>
  status === 500 || status === 502 || status === 503 || status === 504 || status === 429;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Token bucket rate limiter:
 * Ensures requests to Last.fm never exceed 5 requests/second,
 * smoothing burst loads from background updates and multi-user commands.
 */
class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private tokens: number;
  private lastRefill: number;
  private readonly waitQueue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(capacity = 5, tokensPerSecond = 5) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerMs = tokensPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  public async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.waitQueue.length === 0) {
      this.tokens -= 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.timer) return;
    const intervalMs = Math.max(50, Math.ceil(1000 / this.capacity));
    this.timer = setInterval(() => {
      this.refill();
      while (this.waitQueue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const next = this.waitQueue.shift();
        if (next) next();
      }
      if (this.waitQueue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, intervalMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }
}

export class LastfmApi {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly errorTracker: LastfmErrorRateTracker;
  private readonly rateLimiter: TokenBucketRateLimiter;

  constructor() {
    this.apiKey = ConfigData.Data.lastFm.publicKey;
    this.apiSecret = ConfigData.Data.lastFm.privateKey;
    this.errorTracker = container.resolve(LastfmErrorRateTracker);
    this.rateLimiter = new TokenBucketRateLimiter(5, 5);
  }

  private async fetchWithRetry(url: string, init: RequestInit, method: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.rateLimiter.acquire();
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await fetch(url, { ...init, signal });
        if (!response.ok && isTransientStatus(response.status) && attempt < MAX_RETRIES - 1) {
          const delay = Math.min(300 * Math.pow(2, attempt) + Math.random() * 100, 2000);
          Logger.warn(`Last.fm returned HTTP ${response.status} for ${method}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(delay);
          continue;
        }
        return response;
      } catch (err: unknown) {
        lastError = err;
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const errorMessage = err instanceof Error ? err.message : 'network error';
        if (attempt < MAX_RETRIES - 1) {
          const delay = Math.min(300 * Math.pow(2, attempt) + Math.random() * 100, 2000);
          Logger.warn(`Last.fm request failed (${isTimeout ? 'timeout' : errorMessage}) for ${method}, retrying in ${Math.round(delay)}ms...`);
          await sleep(delay);
          continue;
        }
      }
    }
    Logger.error({ err: lastError }, `Last.fm request failed after ${MAX_RETRIES} attempts for method ${method}`);
    throw new LastfmApiError(-1, 'Network error or timeout while contacting Last.fm');
  }

  public async call<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(LASTFM_API_URL);
    url.searchParams.set('method', method);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchWithRetry(url.toString(), { method: 'GET' }, method);

    if (!response.ok) {
      throw new LastfmApiError(response.status, `Last.fm returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    if ('error' in json && typeof json.error === 'number') {
      const message =
        typeof json.message === 'string' ? json.message : 'Unknown Last.fm error';
      const lfmError = new LastfmApiError(json.error, message);
      this.errorTracker.trackError(lfmError);
      throw lfmError;
    }

    this.errorTracker.trackSuccess();
    return json as T;
  }

  public async callSigned<T>(
    method: string,
    params: Record<string, string> = {},
    httpMethod: 'GET' | 'POST' = 'POST',
  ): Promise<T> {
    const signedParams: Record<string, string> = {
      method: method,
      api_key: this.apiKey,
      ...params,
    };
    signedParams.api_sig = createLastfmSignature(signedParams, this.apiSecret);

    const query = new URLSearchParams(signedParams);
    query.set('format', 'json');

    const requestInit: RequestInit =
      httpMethod === 'POST'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: query.toString(),
          }
        : { method: 'GET' };
    const requestUrl =
      httpMethod === 'POST' ? LASTFM_API_URL : `${LASTFM_API_URL}?${query.toString()}`;

    const response = await this.fetchWithRetry(requestUrl, requestInit, method);

    if (!response.ok) {
      throw new LastfmApiError(response.status, `Last.fm returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    if ('error' in json && typeof json.error === 'number') {
      const message =
        typeof json.message === 'string' ? json.message : 'Unknown Last.fm error';
      const lfmError = new LastfmApiError(json.error, message);
      this.errorTracker.trackError(lfmError);
      throw lfmError;
    }

    this.errorTracker.trackSuccess();
    return json as T;
  }
}
