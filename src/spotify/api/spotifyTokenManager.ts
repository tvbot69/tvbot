import { createHmac } from 'node:crypto';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const ANON_TOKEN_ENDPOINT = 'https://open.spotify.com/api/token';
const WEB_PLAYER_PAGE = 'https://open.spotify.com/';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REFRESH_MARGIN_MS = 60000;
const SECRET_CACHE_MS = 24 * 3600 * 1000;

/**
 * Derives the anon-token TOTP secret from the `secret` int array scraped out
 * of the web-player bundle (LavaSrc SpotifyTokenTracker): each byte XORed
 * with ((index % 33) + 9), decimal-concatenated, UTF-8 hex-encoded.
 */
export function transformSpotifySecret(secret: number[]): string {
  const decimal = secret.map((b, i) => String((b ^ ((i % 33) + 9)) & 0xff)).join('');
  return Buffer.from(decimal, 'utf8').toString('hex');
}

/** RFC-6238 TOTP (SHA-1, 30s step, 6 digits) over the hex secret. */
export function generateSpotifyTotp(hexSecret: string, nowMs: number): string {
  const key = Buffer.from(hexSecret, 'hex');
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const code =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

let cachedSecretHex: { hex: string; at: number } | null = null;

export class SpotifyTokenManager {
  private activeIndex: number = 0;
  private readonly cachedTokens = new Map<number, CachedToken>();
  private readonly inflightRequests = new Map<number, Promise<string | null>>();
  private anonToken: CachedToken | null = null;
  private anonInflight: Promise<string | null> | null = null;

  private getCredentials(): Array<{ key: string; secret: string }> {
    const config = ConfigData.Data.spotify;
    if (config.credentials && config.credentials.length > 0) {
      return config.credentials.filter((c) => !!c.key && !!c.secret);
    }
    if (config.key && config.secret) {
      return [{ key: config.key, secret: config.secret }];
    }
    return [];
  }

  public get credentialCount(): number {
    return this.getCredentials().length;
  }

  public rotateCredential(): boolean {
    const creds = this.getCredentials();
    if (creds.length <= 1) {
      return false;
    }
    const prev = this.activeIndex;
    this.activeIndex = (this.activeIndex + 1) % creds.length;
    Logger.info(
      `[Spotify] Switched from credential #${prev + 1} to credential #${this.activeIndex + 1} (${creds[this.activeIndex]?.key.slice(0, 6)}...).`,
    );
    return true;
  }

  public async getToken(): Promise<string | null> {
    const creds = this.getCredentials();
    if (creds.length === 0) {
      // No client credentials configured — the anon web-player token is the
      // only path (previously this returned null and killed all Spotify).
      return this.getAnonToken();
    }

    const currentCred = creds[this.activeIndex] ?? creds[0]!;
    const cached = this.cachedTokens.get(this.activeIndex);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }

    const inflight = this.inflightRequests.get(this.activeIndex);
    if (inflight) {
      return inflight;
    }

    // Credential failure no longer throws up the stack (which surfaced as a
    // command crash) — it degrades to the anon token, then to null.
    const req = this.requestToken(currentCred.key, currentCred.secret, this.activeIndex)
      .then((token): string | null => token)
      .catch(() => this.getAnonToken())
      .finally(() => {
        this.inflightRequests.delete(this.activeIndex);
      });

    this.inflightRequests.set(this.activeIndex, req);
    return req;
  }

  private async requestToken(clientId: string, clientSecret: string, index: number): Promise<string> {
    const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      Logger.error(`Spotify token request failed with HTTP ${response.status} for credential #${index + 1}`);
      throw new Error(`Spotify token request failed (${response.status})`);
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    const tokenObj: CachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - REFRESH_MARGIN_MS,
    };
    this.cachedTokens.set(index, tokenObj);
    return tokenObj.accessToken;
  }

  public invalidate(): void {
    this.cachedTokens.delete(this.activeIndex);
    this.anonToken = null;
  }

  /**
   * Anonymous web-player token (LavaSrc SpotifyTokenTracker flow): the TOTP
   * secret is scraped from the `mobile-web-player` bundle once a day, then
   * `api/token?reason=init&productType=web-player` mints an account-free
   * bearer good for public catalog endpoints. Credential-less fallback AND
   * degraded-mode backup when client credentials fail.
   */
  private async getAnonToken(): Promise<string | null> {
    if (this.anonToken && this.anonToken.expiresAt > Date.now()) {
      return this.anonToken.accessToken;
    }
    if (!this.anonInflight) {
      this.anonInflight = this.requestAnonToken().finally(() => {
        this.anonInflight = null;
      });
    }
    return this.anonInflight;
  }

  private async requestAnonToken(): Promise<string | null> {
    const hex = await this.fetchAnonSecretHex();
    if (!hex) return null;
    const now = Date.now();
    const totp = generateSpotifyTotp(hex, now);
    const endpoint = `${ANON_TOKEN_ENDPOINT}?reason=init&productType=web-player&totp=${totp}&totpVer=7&ts=${now}`;
    try {
      const res = await fetchWithTimeout(endpoint, undefined, 10000);
      if (!res.ok) {
        Logger.warn({ status: res.status }, '[Spotify] Anon token request failed');
        return null;
      }
      const data = (await res.json()) as {
        accessToken?: string;
        accessTokenExpirationTimestampMs?: number;
        error?: unknown;
      };
      if (!data.accessToken || data.error) return null;
      this.anonToken = {
        accessToken: data.accessToken,
        expiresAt: (data.accessTokenExpirationTimestampMs ?? now + 3600000) - REFRESH_MARGIN_MS,
      };
      Logger.info('[Spotify] Anon web-player token acquired (credential fallback)');
      return data.accessToken;
    } catch (err) {
      Logger.debug({ err }, '[Spotify] Anon token fetch exception');
      return null;
    }
  }

  private async fetchAnonSecretHex(): Promise<string | null> {
    if (cachedSecretHex && Date.now() - cachedSecretHex.at < SECRET_CACHE_MS) {
      return cachedSecretHex.hex;
    }
    try {
      const page = await fetchWithTimeout(WEB_PLAYER_PAGE, { headers: { 'User-Agent': WEB_UA } }, 10000);
      if (!page.ok) return null;
      const html = await page.text();
      const scripts = [...html.matchAll(/src="([^"]*mobile-web-player[^"]*\.js)"/g)]
        .map((m) => m[1])
        .filter((src): src is string => !!src && !src.includes('vendor'));
      for (const src of scripts) {
        try {
          const jsUrl = new URL(src, WEB_PLAYER_PAGE).toString();
          const jsRes = await fetchWithTimeout(jsUrl, undefined, 15000);
          if (!jsRes.ok) continue;
          const js = await jsRes.text();
          const secretMatch = js.match(/"secret":\[([\d,]+)\]/);
          const nums = secretMatch?.[1]?.split(',').map(Number).filter((n) => Number.isFinite(n));
          if (!nums || nums.length === 0) continue;
          const hex = transformSpotifySecret(nums);
          cachedSecretHex = { hex, at: Date.now() };
          return hex;
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
