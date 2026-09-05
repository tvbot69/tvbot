import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const REFRESH_MARGIN_MS = 60000;

export class SpotifyTokenManager {
  private cachedToken: CachedToken | null = null;
  private inflightRequest: Promise<string> | null = null;

  public async getToken(): Promise<string | null> {
    const config = ConfigData.Data.spotify;
    if (!config.key || !config.secret) {
      return null;
    }

    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.accessToken;
    }
    if (this.inflightRequest) {
      return this.inflightRequest;
    }

    this.inflightRequest = this.requestToken(config.key, config.secret)
      .then((token) => token)
      .finally(() => {
        this.inflightRequest = null;
      });

    return this.inflightRequest;
  }

  private async requestToken(clientId: string, clientSecret: string): Promise<string> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      Logger.error(`Spotify token request failed with HTTP ${response.status}`);
      throw new Error(`Spotify token request failed (${response.status})`);
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - REFRESH_MARGIN_MS,
    };
    return this.cachedToken.accessToken;
  }

  public invalidate(): void {
    this.cachedToken = null;
  }
}
