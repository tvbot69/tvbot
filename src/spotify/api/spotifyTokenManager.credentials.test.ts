import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `SpotifyTokenManager` — caching, refresh, credential rotation and the
 * credential-less fallback.
 *
 * The module is loaded dynamically on purpose. `ConfigData.Data` is a LAZY,
 * MEMOISED getter, so the credential pool is fixed the first time anything reads
 * it and there is no way to exercise "two credentials" and "no credentials" in
 * one module instance. `vi.resetModules()` gives each test a fresh one, and
 * `vi.stubEnv` supplies the pool. Nothing here is real: the ids and secrets are
 * obvious fakes and no test contacts Spotify.
 *
 * A test double is a claim about a vendor, so the claims are written down:
 *   VENDOR ASSUMPTION — `POST https://accounts.spotify.com/api/token` with
 *     `grant_type=client_credentials` and HTTP Basic auth returns
 *     `{ access_token, expires_in }`, where `expires_in` is SECONDS. The manager
 *     multiplies it by 1000, so a vendor that returned milliseconds would make
 *     every token effectively immortal. Not verified here.
 *   VENDOR ASSUMPTION — the client-credentials token is REJECTED (401) once it
 *     expires, which is what makes `invalidate()` the right response to a 401
 *     and a wasted round trip for any other status.
 *   VENDOR ASSUMPTION (fallback path) — the account-free web-player token is
 *     minted by scraping a `secret` array out of the `mobile-web-player` bundle
 *     and calling `open.spotify.com/api/token?reason=init` with a TOTP. This is
 *     a reverse-engineered flow (LavaSrc's), so it is the single most likely
 *     thing here to break silently: the only symptom would be "Spotify quietly
 *     stopped answering" and one DEBUG line.
 */

type TokenManagerModule = typeof import('./spotifyTokenManager');

const CREDS = {
  one: { ids: 'fake-id-1', secrets: 'fake-secret-1' },
  two: { ids: 'fake-id-1,fake-id-2', secrets: 'fake-secret-1,fake-secret-2' },
  none: { ids: '', secrets: '' },
};

/**
 * Fresh module registry + a chosen credential pool + silenced logging.
 *
 * The logger spies have to be re-created here rather than in a `beforeEach`,
 * because `vi.resetModules()` produces a fresh `@domain/logger` instance and a
 * spy on the previous one would never be called.
 */
const load = async (pool: { ids: string; secrets: string }) => {
  vi.resetModules();
  for (let i = 2; i <= 5; i += 1) {
    vi.stubEnv(`SPOTIFY_CLIENT_ID_${String(i)}`, '');
    vi.stubEnv(`SPOTIFY_CLIENT_SECRET_${String(i)}`, '');
  }
  vi.stubEnv('SPOTIFY_CLIENT_ID', pool.ids);
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', pool.secrets);

  const mod: TokenManagerModule = await import('./spotifyTokenManager');
  const { Logger } = await import('@domain/logger');
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  return mod;
};

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

/** Only the call log is read, so the structural shape is all that is needed. */
type FetchMock = { mock: { calls: unknown[][] } };

/** Which credential a given token request authenticated as, read from the header. */
const basicCredential = (fetchMock: FetchMock, index: number): string => {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? '';
  return Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8');
};

const countCalls = (fetchMock: FetchMock, needle: string): number =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(needle)).length;

/** The scraper and the token endpoint are both on `open.spotify.com`, so the
 *  landing page has to be matched exactly rather than by substring. */
const countExact = (fetchMock: FetchMock, url: string): number =>
  fetchMock.mock.calls.filter((c) => String(c[0]) === url).length;

const tokenEndpoint = 'accounts.spotify.com';
const anonTokenEndpoint = 'api/token?reason=init';
const playerBundle = 'mobile-web-player';
const landingPageUrl = 'https://open.spotify.com/';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the client-credentials path', () => {
  it('requests the token once and serves the cache for the rest of its life', async () => {
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK-A', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('TOK-A');
    expect(await manager.getToken()).toBe('TOK-A');
    expect(await manager.getToken()).toBe('TOK-A');

    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);
    expect(basicCredential(fetchMock, 0)).toBe('fake-id-1:fake-secret-1');
  });

  it('does NOT cache a token whose whole lifetime is inside the 60s refresh margin', async () => {
    // The margin exists so a token is never handed out moments before it dies.
    // A vendor (or a misconfigured client) that returns a short `expires_in`
    // therefore means the cache is permanently empty, and every call re-auths.
    // Asserting the re-auth rather than the cache keeps that visible.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'SHORT', expires_in: 30 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('SHORT');
    expect(await manager.getToken()).toBe('SHORT');

    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
  });

  it('re-requests only after the cached token has actually expired, margin included', async () => {
    const { SpotifyTokenManager } = await load(CREDS.one);
    let issued = 0;
    const fetchMock = vi.fn(async (..._args: unknown[]) => {
      issued += 1;
      return jsonResponse({ access_token: `TOK-${String(issued)}`, expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    // Only Date is faked, so nothing in the request path is waiting on a timer.
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    expect(await manager.getToken()).toBe('TOK-1');
    // One second short of the nominal one-hour lifetime: the cached token is
    // still handed out, because the 60s refresh margin has not elapsed yet.
    vi.setSystemTime(start + 3_500_000);
    expect(await manager.getToken()).toBe('TOK-1');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    // Past expires_in minus the margin: a fresh token, not one about to expire.
    vi.setSystemTime(start + 3_600_000);
    expect(await manager.getToken()).toBe('TOK-2');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
    vi.useRealTimers();
  });

  it('collapses two concurrent calls into ONE token request', async () => {
    // `rotateCredential()` runs on every 429, so the index the request was
    // issued under can be stale by the time it settles. The inflight map is what
    // stops two lookups racing — and what used to leak an entry forever when the
    // index moved underneath it.
    const { SpotifyTokenManager } = await load(CREDS.one);
    let release: ((value: Response) => void) | null = null;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (..._args: unknown[]) => gate);
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    const first = manager.getToken();
    const second = manager.getToken();
    release!(jsonResponse({ access_token: 'ONCE', expires_in: 3600 }));

    expect(await first).toBe('ONCE');
    expect(await second).toBe('ONCE');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);
  });

  it('invalidate() drops the cached token so the next call re-authenticates', async () => {
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    manager.invalidate();
    await manager.getToken();

    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
  });

  it('never contacts the token endpoint twice for a cached token, even across many call sites', async () => {
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    await manager.getToken();

    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);
  });
});

describe('a failed token request degrades without burning the credential', () => {
  /**
   * The anon fallback needs four endpoints answered. One router keeps the shape
   * visible: the web-player page, the bundle inside it, the anon token mint, and
   * the client-credentials token.
   */
  const withAnonFallback = (tokenStatus: number | 'reject') => {
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(tokenEndpoint)) {
        if (tokenStatus === 'reject') throw new TypeError('fetch failed');
        return jsonResponse({ error: 'invalid_client' }, tokenStatus);
      }
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({
          accessToken: 'ANON-TOKEN',
          accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
        });
      }
      if (url.includes(playerBundle)) {
        return new Response('var a={"secret":[12,34,56,78]};', {
          status: 200,
          headers: { 'content-type': 'application/javascript' },
        });
      }
      return new Response('<html><head><script src="/mobile-web-player.abc123.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    return fetchMock;
  };

  it('falls back to the anon token on a token-endpoint 500, and keeps the credential', async () => {
    // 500, not 401: a Spotify outage is not a credential problem. If the failure
    // rotated or discarded credential #1, one blip would permanently halve the
    // pool and every later request would use a credential that had never been
    // tried.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = withAnonFallback(500);
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('ANON-TOKEN');
    // Second call: the credential is retried (nothing was cached for it), and
    // the anon token is served from cache without re-scraping.
    expect(await manager.getToken()).toBe('ANON-TOKEN');

    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
    expect(manager.credentialCount).toBe(1);
    expect(manager.rotateCredential()).toBe(false);
  });

  it('falls back on a transport failure too, because a DNS blip is not a bad credential', async () => {
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = withAnonFallback('reject');
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('ANON-TOKEN');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);
    expect(manager.credentialCount).toBe(1);
  });

  it('answers null — never throws — when both paths are dead', async () => {
    // A throw here used to surface as a command crash. The null is turned into
    // `SpotifyUnavailableError('credentials not configured')` by the search API,
    // which is a raised "we do not know" rather than a claim about the
    // catalogue.
    const { SpotifyTokenManager } = await load(CREDS.one);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes(tokenEndpoint)) return jsonResponse({}, 500);
        if (url.includes(anonTokenEndpoint)) return jsonResponse({}, 503);
        if (url.includes(playerBundle)) return new Response('var a={};', { status: 404 });
        return new Response('<html></html>', { status: 200 });
      }),
    );
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();
  });
});

describe('credential rotation', () => {
  it('refuses to rotate when there is only one credential', async () => {
    // Returning true here would hand the caller a retry against the SAME
    // credential after a 429, which is a guaranteed second 429.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const manager = new SpotifyTokenManager();

    expect(manager.credentialCount).toBe(1);
    expect(manager.rotateCredential()).toBe(false);
    expect(manager.rotateCredential()).toBe(false);
  });

  it('reports zero credentials when none are configured', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const manager = new SpotifyTokenManager();

    expect(manager.credentialCount).toBe(0);
    expect(manager.rotateCredential()).toBe(false);
  });

  it('rotates through the pool in order and wraps back to the first', async () => {
    // Asserted through the Basic header rather than through a return value:
    // `rotateCredential()` returning true only says an index moved, not that it
    // moved to the credential we think it did.
    const { SpotifyTokenManager } = await load(CREDS.two);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();
    expect(manager.credentialCount).toBe(2);

    expect(manager.rotateCredential()).toBe(true);
    await manager.getToken();
    expect(basicCredential(fetchMock, 0)).toBe('fake-id-2:fake-secret-2');

    // Second rotation over a two-credential pool must land back on the first.
    expect(manager.rotateCredential()).toBe(true);
    await manager.getToken();
    expect(basicCredential(fetchMock, 1)).toBe('fake-id-1:fake-secret-1');
  });

  it('authenticates as the NEW credential after a rotation, not the old one', async () => {
    // The ordering claim: rotation is not a no-op that re-labels an index, the
    // Basic header really changes, which is the only thing that makes a 429
    // recoverable.
    const { SpotifyTokenManager } = await load(CREDS.two);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    expect(basicCredential(fetchMock, 0)).toBe('fake-id-1:fake-secret-1');

    expect(manager.rotateCredential()).toBe(true);
    await manager.getToken();
    expect(basicCredential(fetchMock, 1)).toBe('fake-id-2:fake-secret-2');
  });

  it('caches a token per credential, so rotating back does not re-authenticate', async () => {
    const { SpotifyTokenManager } = await load(CREDS.two);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    manager.rotateCredential();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);

    // Back to credential #1, whose token is still cached.
    manager.rotateCredential();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
  });

  it('invalidate() clears only the ACTIVE credential, so a 401 on one does not cost the other', async () => {
    // The bug this pins: a one-entry cache keyed by "the current credential"
    // would re-authenticate the whole pool every time either member 401s, which
    // on a rate-limited pool is how you get a thundering herd at the auth
    // endpoint.
    const { SpotifyTokenManager } = await load(CREDS.two);
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ access_token: 'TOK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    manager.rotateCredential();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);

    // A 401 on credential #2: only #2's cache entry goes.
    manager.invalidate();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(3);
    expect(basicCredential(fetchMock, 2)).toBe('fake-id-2:fake-secret-2');

    // Credential #1 is untouched, so rotating back costs nothing.
    manager.rotateCredential();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(3);
  });
});

describe('the account-free web-player fallback', () => {
  const anonScraper = (opts: { pageStatus?: number; pageHtml?: string; bundleStatus?: number } = {}) => {
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({
          accessToken: 'ANON',
          accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
        });
      }
      if (url.includes(playerBundle)) {
        return new Response('var a={"secret":[12,34,56,78]};', {
          status: opts.bundleStatus ?? 200,
          headers: { 'content-type': 'application/javascript' },
        });
      }
      return new Response(
        opts.pageHtml ?? '<html><head><script src="/mobile-web-player.abc.js"></script></head></html>',
        { status: opts.pageStatus ?? 200, headers: { 'content-type': 'text/html' } },
      );
    });
    return fetchMock;
  };

  it('never contacts the client-credentials endpoint when nothing is configured', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('ANON');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(0);
    expect(countCalls(fetchMock, anonTokenEndpoint)).toBe(1);
  });

  it('mints the token with a 6-digit TOTP and the documented query shape', async () => {
    // This is a reverse-engineered endpoint. The exact shape is a claim about
    // Spotify that nothing here verifies, and the first symptom of it drifting
    // is that every anon token request starts failing with one DEBUG line.
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();

    const url = String(fetchMock.mock.calls.find((c) => String(c[0]).includes(anonTokenEndpoint))?.[0]);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://open.spotify.com/api/token');
    expect(parsed.searchParams.get('reason')).toBe('init');
    expect(parsed.searchParams.get('productType')).toBe('web-player');
    expect(parsed.searchParams.get('totp')).toMatch(/^\d{6}$/);
    expect(parsed.searchParams.get('totpVer')).toBe('7');
    expect(Number(parsed.searchParams.get('ts'))).toBeGreaterThan(0);
  });

  it('caches the anon token, so a second lookup makes no second mint request', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    await manager.getToken();

    expect(countCalls(fetchMock, anonTokenEndpoint)).toBe(1);
  });

  it('scrapes the TOTP secret from the web-player bundle exactly once', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    manager.invalidate();
    await manager.getToken();

    // invalidate() drops the token, not the secret, so the page is not re-fetched.
    expect(countExact(fetchMock, landingPageUrl)).toBe(1);
    expect(countCalls(fetchMock, anonTokenEndpoint)).toBe(2);
  });

  it('re-scrapes the secret after the 24h cache expires', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    // Only Date is faked, so the module's own 10s/15s AbortSignal timeouts stay
    // real and the test cannot deadlock on a fake timer.
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    await manager.getToken();
    expect(countExact(fetchMock, landingPageUrl)).toBe(1);

    vi.setSystemTime(start + 25 * 3_600_000);
    await manager.getToken();
    expect(countExact(fetchMock, landingPageUrl)).toBe(2);
    vi.useRealTimers();
  });

  it('ignores a vendor bundle with no secret in it, and keeps looking', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({
          accessToken: 'ANON',
          accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
        });
      }
      if (url.includes('mobile-web-player.first.js')) {
        return new Response('var a={};', { status: 200 });
      }
      if (url.includes(playerBundle)) {
        return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      }
      return new Response(
        '<html><head><script src="/mobile-web-player.first.js"></script>' +
          '<script src="/mobile-web-player.second.js"></script></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('ANON');
    expect(countCalls(fetchMock, 'mobile-web-player.first.js')).toBe(1);
    expect(countCalls(fetchMock, 'mobile-web-player.second.js')).toBe(1);
  });

  it('skips a bundle that 404s and tries the next one', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({
          accessToken: 'ANON',
          accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
        });
      }
      if (url.includes('mobile-web-player.first.js')) return new Response('', { status: 404 });
      if (url.includes(playerBundle)) return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      return new Response(
        '<html><head><script src="/mobile-web-player.first.js"></script>' +
          '<script src="/mobile-web-player.second.js"></script></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBe('ANON');
  });

  it('skips a vendor bundle, which never carries the secret', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({
          accessToken: 'ANON',
          accessTokenExpirationTimestampMs: Date.now() + 3_600_000,
        });
      }
      if (url.includes(playerBundle)) return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      return new Response('<html><head><script src="/vendor-mobile-web-player.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    // Filtered before it is ever requested, so the answer is null rather than a
    // token derived from the wrong array.
    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, 'vendor-mobile-web-player.js')).toBe(0);
  });

  it('answers null when the web-player page itself cannot be read', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = anonScraper({ pageStatus: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBeNull();
  });

  it('answers null when the anon token endpoint rejects the TOTP', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) return jsonResponse({}, 403);
      if (url.includes(playerBundle)) return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      return new Response('<html><head><script src="/mobile-web-player.abc.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBeNull();
  });

  it('answers null when the anon response carries an error alongside a token', async () => {
    // A partial payload is not a token. Accepting `accessToken` here would send
    // a value the vendor simultaneously reported as invalid.
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) {
        return jsonResponse({ accessToken: 'SUSPECT', error: { code: 401 } });
      }
      if (url.includes(playerBundle)) return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      return new Response('<html><head><script src="/mobile-web-player.abc.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBeNull();
  });

  it('answers null when the anon response has no token at all', async () => {
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (...args: unknown[]): Promise<Response> => {
      const url = String(args[0]);
      if (url.includes(anonTokenEndpoint)) return jsonResponse({ nope: true });
      if (url.includes(playerBundle)) return new Response('var a={"secret":[12,34,56,78]};', { status: 200 });
      return new Response('<html><head><script src="/mobile-web-player.abc.js"></script></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBeNull();
  });
});
