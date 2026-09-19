import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const REFRESH_MARGIN_MS = 60000;

export class SpotifyTokenManager {
  private activeIndex: number = 0;
  private readonly cachedTokens = new Map<number, CachedToken>();
  private readonly inflightRequests = new Map<number, Promise<string>>();

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
      return null;
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

    const req = this.requestToken(currentCred.key, currentCred.secret, this.activeIndex)
      .then((token) => token)
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
  }
}
