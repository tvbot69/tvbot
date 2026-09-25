import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SpotifyTokenManager,
  transformSpotifySecret,
  generateSpotifyTotp,
} from './spotifyTokenManager';

describe('Spotify anon-token crypto (LavaSrc flow)', () => {
  it('transforms the scraped secret with the XOR schedule', () => {
    // Hand-computed: 0^9=9 -> '9' -> hex '39'.
    expect(transformSpotifySecret([0])).toBe('39');
    // 0^9=9, 1^10=11 -> '911' -> hex '393131'.
    expect(transformSpotifySecret([0, 1])).toBe('393131');
    expect(transformSpotifySecret([0])).toBe(transformSpotifySecret([0]));
  });

  it('generates RFC-6238 SHA-1 TOTPs (verified test vectors)', () => {
    // RFC 4226/6238 reference key: ASCII '12345678901234567890'.
    const hex = '3132333435363738393031323334353637383930';
    // T=59s -> counter 1 -> HOTP-1 = 287082.
    expect(generateSpotifyTotp(hex, 59000)).toBe('287082');
    // RFC 6238 SHA-1, T=1111111109 -> 081804.
    expect(generateSpotifyTotp(hex, 1111111109000)).toBe('081804');
    // Six digits, zero-padded shape.
    expect(generateSpotifyTotp(hex, 59000)).toMatch(/^\d{6}$/);
  });
});

describe('SpotifyTokenManager credential fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the anon web-player token when credentials fail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('accounts.spotify.com')) {
        return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 });
      }
      if (u.includes('/api/token?reason=init')) {
        expect(u).toMatch(/totp=\d{6}&totpVer=7&ts=\d+/);
        return new Response(
          JSON.stringify({ accessToken: 'anon-xyz', accessTokenExpirationTimestampMs: Date.now() + 3600000 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('mobile-web-player')) {
        return new Response('var bundle={"secret":[12,34,56,78]};', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        });
      }
      // Web-player landing page carrying the bundle reference.
      return new Response('<html><head><script src="/mobile-web-player.abc123.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch);

    const manager = new SpotifyTokenManager();
    const token = await manager.getToken();
    expect(token).toBe('anon-xyz');
    // Second call serves the cached anon token — no new token request.
    const tokenCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/token?reason=init'));
    await manager.getToken();
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/token?reason=init'))).toHaveLength(
      tokenCalls.length,
    );
  });
});
