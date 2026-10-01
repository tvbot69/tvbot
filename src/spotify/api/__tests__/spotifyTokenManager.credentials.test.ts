import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `SpotifyTokenManager` — caching, refresh, credential rotation, and what
 * happens when the client-credentials path cannot answer.
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
 *     every token effectively immortal. VERIFIED 2026-09-30 by
 *     `scripts/liveVerify.ts` (D7): `expires_in=3600`, and the production cache
 *     entry reads 3540s of remaining life, i.e. exactly expires_in minus the 60s
 *     margin.
 *   VENDOR ASSUMPTION — a REFUSED credential is **400**, not 401. VERIFIED
 *     2026-09-30 (D8) with a deliberately wrong secret:
 *     `{"error":"invalid_client","error_description":"Invalid client secret"}`.
 *     A 401 is a real and different thing, and it lives one layer up: an expired
 *     BEARER rejected by `api.spotify.com` (C5 verified: a missing header and a
 *     garbage bearer are both 401). That is what `invalidate()` answers to, and
 *     it is observed by `spotifySearchApi` on the resource response — never here,
 *     because this class only ever talks to the token endpoint. The two
 *     statuses used to be conflated in a comment in this file, which made a 400
 *     look like a transient blip; the conflation is now a classified branch with
 *     a test on each side of it.
 *   NOT A VENDOR ASSUMPTION ANY MORE — the account-free web-player token. This
 *     suite used to carry thirteen tests describing it: a `"secret":[<digits>]`
 *     scrape out of the `mobile-web-player` bundle, an XOR transform, a TOTP,
 *     and `open.spotify.com/api/token?reason=init`. It has been dead, silently,
 *     since at least the probe of 2026-09-30 (the bundle is served, carries 7
 *     literal occurrences of `secret`, and has zero matches for a digit array),
 *     and the tests passed anyway. They asserted the SHAPE of a flow, which is a
 *     statement about the code and not about Spotify, so they would have kept
 *     passing if the vendor had deleted the entire web player. The flow is
 *     deleted; see the class docstring in `spotifyTokenManager.ts` for why a
 *     silent rot is worse than no fallback.
 */

type TokenManagerModule = typeof import('@spotify/api/spotifyTokenManager');
type LoggerModule = typeof import('@domain/logging/logger');

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
 *
 * The module is spread into the result alongside `Logger`, so a test that needs
 * to assert that a failure was REPORTED can reach the same spies this function
 * installed, while every other test keeps destructuring just the class.
 */
const load = async (pool: { ids: string; secrets: string }): Promise<TokenManagerModule & LoggerModule> => {
  vi.resetModules();
  for (let i = 2; i <= 5; i += 1) {
    vi.stubEnv(`SPOTIFY_CLIENT_ID_${String(i)}`, '');
    vi.stubEnv(`SPOTIFY_CLIENT_SECRET_${String(i)}`, '');
  }
  vi.stubEnv('SPOTIFY_CLIENT_ID', pool.ids);
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', pool.secrets);

  const mod: TokenManagerModule = await import('@spotify/api/spotifyTokenManager');
  // The whole logger namespace is spread, not just its `Logger` const: the
  // declared return type is the intersection with the module's own type, and
  // `LoggerModule` is every export of that file. Spreading only `Logger` left
  // the intersection unsatisfied.
  const loggerModule: LoggerModule = await import('@domain/logging/logger');
  const { Logger } = loggerModule;
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
  return { ...mod, ...loggerModule };
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

const tokenEndpoint = 'accounts.spotify.com';

/** Every line the logger was handed, flattened to text, for content assertions. */
const loggedText = (spy: FetchMock, argsIndex = 0): string =>
  spy.mock.calls.map((c) => String(c[argsIndex])).join('\n');

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

/**
 * The deleted rung leaves one path, so this is where the interesting behaviour
 * now lives: what a caller gets when that one path cannot answer, and whether
 * the failure was said out loud.
 */
describe('a failed token request', () => {
  /** A token endpoint that always answers the same way. */
  const failingTokenEndpoint = (reply: (call: number) => Response | Error) => {
    let calls = 0;
    const fetchMock = vi.fn(async (..._args: unknown[]): Promise<Response> => {
      calls += 1;
      const out = reply(calls);
      if (out instanceof Error) throw out;
      return out;
    });
    return fetchMock;
  };

  it('answers null and NEVER throws, so the caller can raise "we do not know"', async () => {
    // A throw here surfaces as a command crash, and a throw that is not a
    // `SpotifyUnavailableError` is caught upstream and becomes the `null` the
    // artwork cascade caches as `'none'` — a refusal turned into a fact about
    // the catalogue. The null is turned into
    // `SpotifyUnavailableError('Spotify credentials not configured')` by the
    // search API instead, which is a raised "we do not know".
    const { SpotifyTokenManager } = await load(CREDS.one);
    vi.stubGlobal('fetch', failingTokenEndpoint(() => jsonResponse({}, 500)));
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();
  });

  it('reports a refused credential at ERROR, naming the vendor error code', async () => {
    // MEASURED, not assumed: a bad secret is 400 `invalid_client`, not 401.
    // The log line is the whole diagnosis a reader gets, so it has to carry the
    // status and the vendor's own code rather than a bare "request failed".
    const { SpotifyTokenManager, Logger } = await load(CREDS.one);
    vi.stubGlobal(
      'fetch',
      failingTokenEndpoint(() =>
        jsonResponse({ error: 'invalid_client', error_description: 'Invalid client secret' }, 400),
      ),
    );
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();

    const err = vi.mocked(Logger.error);
    expect(err).toHaveBeenCalledTimes(1);
    const line = loggedText(err);
    expect(line).toContain('400');
    expect(line).toContain('invalid_client');
    expect(line).toContain('credential #1');
  });

  it('redacts the credential if the vendor ever echoes it back in the description', async () => {
    // The repo is public. Today `error_description` is a fixed string, but the
    // moment a vendor echoes the submitted secret, an unredacted log line puts
    // it in a file on disk that is then committed. Checked, not trusted.
    const { SpotifyTokenManager, Logger } = await load(CREDS.one);
    vi.stubGlobal(
      'fetch',
      failingTokenEndpoint(() =>
        jsonResponse(
          { error: 'invalid_client', error_description: 'bad secret: fake-secret-1' },
          400,
        ),
      ),
    );
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();

    const line = loggedText(vi.mocked(Logger.error));
    expect(line).not.toContain('fake-secret-1');
    expect(line).toContain('redacted');
  });

  it('reports a request that never reached Spotify at WARN, without blaming the credential', async () => {
    // A DNS failure, a refused connection or a timeout has no status and says
    // nothing about the credential. It used to produce NO log line at all: the
    // `.catch()` on the request chain went on to try the anon rung and discarded
    // the error. That is the A1 shape — an outage that reads as an empty result.
    const { SpotifyTokenManager, Logger } = await load(CREDS.one);
    vi.stubGlobal('fetch', failingTokenEndpoint(() => new TypeError('fetch failed')));
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();

    const warn = vi.mocked(Logger.warn);
    expect(warn).toHaveBeenCalled();
    expect(loggedText(warn, 1)).toContain('never reached');
  });

  it('never logs a 5xx or a transport failure as a credential fault', async () => {
    // The classification is load-bearing in both directions: a Spotify outage
    // is not a config error, and calling it one sends the operator to edit an
    // env file that is already correct.
    const { SpotifyTokenManager, Logger } = await load(CREDS.one);
    vi.stubGlobal('fetch', failingTokenEndpoint(() => jsonResponse({}, 503)));
    const manager = new SpotifyTokenManager();

    await expect(manager.getToken()).resolves.toBeNull();

    const line = loggedText(vi.mocked(Logger.error));
    expect(line).toContain('transient');
    expect(line).not.toContain('not retried as a blip');
  });

  it('a refused credential is NOT treated as a transient blip, and is not retried for 15 minutes', async () => {
    // The 400/401 correction as executable behaviour. A wrong secret does not
    // become a right one by waiting, so a 30s blip backoff would put every
    // artwork lookup back on the auth endpoint twice a minute for a quarter of
    // an hour. The pool is also NOT touched: `credentialCount` and
    // `rotateCredential()` are asserted, because dropping or rotating on a
    // config fault would halve the pool permanently.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = failingTokenEndpoint(() => jsonResponse({ error: 'invalid_client' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    // Well past the 30s a transient fault would have waited: still nothing.
    vi.setSystemTime(start + 14 * 60_000);
    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    // Past the credential backoff: it does try again, because this is a rate
    // limit on a dead credential and not a decision to stop trying forever.
    vi.setSystemTime(start + 16 * 60_000);
    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);

    expect(manager.credentialCount).toBe(1);
    expect(manager.rotateCredential()).toBe(false);
    vi.useRealTimers();
  });

  it('a 5xx IS treated as a transient blip, and recovers on its own', async () => {
    // The other direction of the same classification. Asserting only the 400
    // case would let a "credential-rejected" regression hide behind a comment.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = failingTokenEndpoint((call) =>
      call === 1 ? jsonResponse({}, 500) : jsonResponse({ access_token: 'RECOVERED', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    expect(await manager.getToken()).toBeNull();
    expect(manager.credentialCount).toBe(1);
    expect(manager.rotateCredential()).toBe(false);

    // Past the 30s transient backoff, and inside the 15m credential one: the
    // distinction between the two branches, measured.
    vi.setSystemTime(start + 31_000);
    expect(await manager.getToken()).toBe('RECOVERED');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
    vi.useRealTimers();
  });

  it('holds the backoff across many concurrent callers during an outage', async () => {
    // With the anon cache gone, this is the only thing standing between a
    // Spotify outage and one auth request per artwork lookup.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = failingTokenEndpoint(() => jsonResponse({}, 500));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    await Promise.all(Array.from({ length: 10 }, () => manager.getToken()));
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    await manager.getToken();
    await manager.getToken();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);
  });

  it('invalidate() clears the failure backoff, so a 401-driven retry actually retries', async () => {
    // The bug this pins: `invalidate()` exists because `spotifySearchApi` saw a
    // 401 on the resource and wants a fresh bearer. If the backoff survived it,
    // that retry would be answered `null` for up to 15 minutes and a recoverable
    // "this bearer expired" would become an outage. The backoff and the cached
    // token are cleared together or the lever does nothing.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = failingTokenEndpoint((call) =>
      call === 1 ? jsonResponse({}, 500) : jsonResponse({ access_token: 'FRESH', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    // Still inside the 30s transient backoff, so nothing would happen without
    // the invalidate.
    vi.setSystemTime(start + 1_000);
    manager.invalidate();
    expect(await manager.getToken()).toBe('FRESH');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);
    vi.useRealTimers();
  });

  it('recovers the credential once the endpoint comes back, unasked', async () => {
    // The backoff must not be a latch. `expires_in` is reset so the token is
    // unambiguously a new one rather than a coincidence of the cache.
    const { SpotifyTokenManager } = await load(CREDS.one);
    const fetchMock = failingTokenEndpoint((call) =>
      call === 1 ? jsonResponse({ error: 'invalid_client' }, 400) : jsonResponse({ access_token: 'BACK', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    expect(await manager.getToken()).toBeNull();
    vi.setSystemTime(start + 20 * 60_000);
    expect(await manager.getToken()).toBe('BACK');
    expect(manager.credentialCount).toBe(1);
    vi.useRealTimers();
  });
});

describe('no credentials configured', () => {
  it('answers null and contacts NO endpoint at all', async () => {
    // Previously this branch scraped a web-player bundle and minted a token.
    // Now it makes no network request whatsoever, which is the honest shape of a
    // pool with nothing in it — and it is a claim that can fail, because the
    // deleted code would have made two calls here.
    const { SpotifyTokenManager } = await load(CREDS.none);
    const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(manager.credentialCount).toBe(0);
    expect(await manager.getToken()).toBeNull();
    expect(await manager.getToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the missing credentials EXACTLY ONCE, and not from getToken()', async () => {
    // This test started life asserting `Logger.warn` was never called here, and
    // failed: `ConfigData` calls `assertValidEnvironment()` at import, which
    // pushes "Spotify credentials missing … will be disabled" through
    // `Logger.warn`. Which is the point — the capability loss IS reported, once,
    // at the one place that owns the configuration.
    //
    // So the claim worth pinning is not "silent" but "reported exactly once, by
    // the boot validator, naming the keys". Two `getToken()` calls must not add a
    // second line: `getToken()` runs once per Spotify lookup, so warning there
    // would turn one boot warning into dozens an hour.
    const { SpotifyTokenManager, Logger } = await load(CREDS.none);
    vi.stubGlobal('fetch', vi.fn(async (..._args: unknown[]) => jsonResponse({}, 200)));
    const manager = new SpotifyTokenManager();

    await manager.getToken();
    await manager.getToken();
    await manager.getToken();

    const warn = vi.mocked(Logger.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = loggedText(warn);
    expect(line).toContain('SPOTIFY_CLIENT_ID');
    expect(line).toContain('SPOTIFY_CLIENT_SECRET');
    expect(line).toContain('Spotify credentials missing');
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

  it('backoff is per-credential, so one dead member does not disable the other', async () => {
    // The pool is the reason a second credential exists. A shared backoff would
    // mean credential #1's bad secret suppresses credential #2, which is
    // working — the exact failure this whole rotation mechanism is there to
    // survive.
    const { SpotifyTokenManager } = await load(CREDS.two);
    // Answered by WHICH credential is authenticating, read off the request that
    // is already on record, so #1 is permanently refused and #2 permanently
    // healthy. A test double that keys on the request is the only way to give a
    // pool two different fates.
    const fetchMock = vi.fn(async (..._args: unknown[]): Promise<Response> =>
      basicCredential(fetchMock, countCalls(fetchMock, tokenEndpoint) - 1) === 'fake-id-1:fake-secret-1'
        ? jsonResponse({ error: 'invalid_client' }, 400)
        : jsonResponse({ access_token: 'HEALTHY', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SpotifyTokenManager();

    expect(await manager.getToken()).toBeNull();
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(1);

    manager.rotateCredential();
    expect(await manager.getToken()).toBe('HEALTHY');
    expect(countCalls(fetchMock, tokenEndpoint)).toBe(2);

    // #1 is still latched: rotating back does not re-hit the auth endpoint.
    manager.rotateCredential();
    expect(await manager.getToken()).toBeNull();
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
