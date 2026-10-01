import { ConfigData } from '@config/configData';
import { Logger } from '@domain/logger';
import { fetchWithTimeout } from '@domain/fetchWithTimeout';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * The two classes of token failure, and the only reason they are separated.
 *
 * `accounts.spotify.com/api/token` splits cleanly: a 4xx says the credential
 * itself is unacceptable, and a 429/5xx says the service is having a moment.
 * Only one of those can fix itself inside a request, so only one of them earns
 * a short retry.
 */
type TokenFailure = 'credential-rejected' | 'transient';

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const REFRESH_MARGIN_MS = 60000;

/**
 * How long a reported failure is remembered before the credential is retried.
 *
 * This exists because the anon rung that used to sit behind this one is gone
 * (see the class docstring). Before that, a token-endpoint 500 was answered
 * half the time from the anon token's cache, so a sustained outage cost one
 * auth request per two lookups. With a single path left it would cost one auth
 * request per lookup, and every artwork miss is a lookup.
 */
const TRANSIENT_BACKOFF_MS = 30_000;

/**
 * A wrong secret does not become a right one by waiting, so it gets a backoff
 * long enough that the auth endpoint is not hammered for fifteen minutes on a
 * misconfiguration — and long enough that the operator has a window in which the
 * fix lands without a restart. It is not permanent: this is a rate limit on a
 * dead credential, not a decision to stop trying.
 */
const CREDENTIAL_BACKOFF_MS = 15 * 60_000;

/**
 * The vendor's own account of why a credential was refused.
 *
 * Read from the BODY rather than inferred from the status, because the status
 * alone is a worse answer than the vendor gives. MEASURED 2026-09-30 with a
 * deliberately wrong secret: HTTP **400** with
 * `{"error":"invalid_client","error_description":"Invalid client secret"}` — not
 * 401. The old comment here claimed 401, and it was wrong in the direction that
 * matters: it made a 400 look like a transient blip.
 *
 * `sensitive` is the submitted values. The description is a fixed vendor string
 * today, but this repo is public and a future vendor that echoes the submitted
 * secret would put it in a log file. So it is checked, not trusted, and this
 * repo has a rule about printing secrets that outranks a tidy message.
 */
async function readTokenError(response: Response, sensitive: readonly string[]): Promise<string> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return '(no JSON body)';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return '(non-object body)';
  }
  const body = parsed as { error?: unknown; error_description?: unknown };
  const code = typeof body.error === 'string' ? body.error : 'unknown_error';
  let description = typeof body.error_description === 'string' ? body.error_description : '';
  for (const value of sensitive) {
    if (value.length >= 4 && description.includes(value)) {
      description = '<redacted: the vendor echoed a submitted credential>';
      break;
    }
  }
  return description ? `${code}: ${description.slice(0, 80)}` : code;
}

/**
 * A wrong credential is a config fault; everything else is the service's mood.
 *
 * MEASURED: 400 `invalid_client` for a bad secret. 401 and 403 are grouped
 * with it on the reading that a token endpoint answering "your Basic auth is
 * not acceptable" is describing the credential and nothing else — that is a
 * judgement, NOT a probe, and it is written down here so the next reader knows
 * which of the three is evidence.
 *
 * A 429 is rate limiting and a 5xx is an outage. A 404 would mean the endpoint
 * moved, which is also not the credential's fault — so it stays transient and
 * the error line says so rather than blaming the pool.
 */
function classifyTokenFailure(status: number): TokenFailure {
  if (status === 400 || status === 401 || status === 403) return 'credential-rejected';
  return 'transient';
}

/**
 * Client-credentials tokens, with per-credential caching, rotation and failure
 * reporting. This is the ONLY way this bot authenticates to Spotify.
 *
 * ## The anon web-player token was deleted, not kept as a fallback
 *
 * This class used to fall back to a reverse-engineered account-free token: the
 * `open.spotify.com` landing page → the `mobile-web-player` JS bundle → a
 * `"secret":[<digits>]` array → `transformSpotifySecret` (XOR with
 * `(i % 33) + 9`) → an RFC-6238 TOTP → `open.spotify.com/api/token?reason=init`.
 * It was the credential-less path AND the degraded-mode backup.
 *
 * It has been dead, silently, and stayed dead while thirteen tests went on
 * passing. Probed live 2026-09-30: the landing page answers 200 and the bundle
 * fetches fine (1,375,445 characters, 7 literal occurrences of `secret`), but
 * there are **zero** matches for `"secret":[<digits>]` — so the scrape yields
 * nothing and the mint is never attempted. The vendor bundle is the same
 * (1,943,394 characters, 23 occurrences, zero matches), so excluding it was
 * never the problem. The secret is still in the player, but it is no longer an
 * array: today's bundle carries `[{secret:'…',version:61}, …]` and picks one by
 * build version.
 *
 * Deleting it is the honest reading of the repo's own rules, and the reason is
 * the *history* rather than the current state:
 *   - §3.8 delete scrapped approaches completely, no flags, no legacy rungs.
 *   - §2.1 A2: no dead feature presents itself as working. This one presented
 *     itself as a second line of defence while providing none, which is worse
 *     than having no fallback, because the code reads as resilient.
 *   - The failure mode was total silence. The scrape returning nothing logged one
 *     DEBUG line, so the one symptom of a dead rung was "Spotify quietly stopped
 *     answering" and nothing else.
 *   - Repairing it would mean tracking a version constant that is internal,
 *     undocumented and rotates with Spotify's build. It has already changed
 *     representation once — from the digit array to a version-picked string —
 *     and that change produced no signal whatsoever. That is the whole argument
 *     against betting the rung on it a second time.
 *   - The only configuration it served is credentials being absent, which
 *     `envValidator` already reports at boot, as a WARN, through the same
 *     `ConfigData` import that builds the pool this class reads.
 *
 * `getToken()` therefore has one path. A token it cannot obtain is reported (at
 * ERROR for a refused request, WARN for one that never arrived) and answered
 * with `null` — which `spotifySearchApi` turns into a raised
 * `SpotifyUnavailableError`, i.e. "we do not know", not "this album has no
 * tracks". `getToken()` must never throw for that reason: a throw that is not a
 * `SpotifyUnavailableError` is caught upstream and becomes the `null` that the
 * artwork cascade caches as `'none'`.
 */
export class SpotifyTokenManager {
  private activeIndex: number = 0;
  private readonly cachedTokens = new Map<number, CachedToken>();
  private readonly inflightRequests = new Map<number, Promise<string | null>>();
  private readonly failureBackoff = new Map<number, { reason: TokenFailure; until: number }>();

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
      // Already reported: `ConfigData` calls `assertValidEnvironment()` at
      // import, which pushes "Spotify credentials missing … will be disabled"
      // through `Logger.warn`. Re-warning here would duplicate a boot line on a
      // path that runs once per Spotify lookup. What this method owes the caller
      // is the honest answer — null, meaning no token — and no network traffic
      // pretending otherwise.
      return null;
    }

    // Capture the index. `rotateCredential()` runs on every 429, so by the
    // time this request settles `this.activeIndex` may point at a DIFFERENT
    // credential: the old `finally` then deleted the NEW index's inflight
    // entry (wiping its dedupe guard, so two token requests raced) and leaked
    // its own entry forever.
    const index = this.activeIndex;
    const cred = creds[index] ?? creds[0]!;
    const cached = this.cachedTokens.get(index);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }

    // A failure already reported for THIS credential. Checked before the
    // inflight map so a burst of concurrent callers during an outage costs one
    // round trip, not one each.
    const backoff = this.failureBackoff.get(index);
    if (backoff && backoff.until > Date.now()) {
      return null;
    }

    const inflight = this.inflightRequests.get(index);
    if (inflight) {
      return inflight;
    }

    // `requestToken` reports its own failures and answers null rather than
    // throwing, so there is no `.catch()` here to hide one. That `.catch()` is
    // exactly how a DNS blip used to produce no log line at all.
    const req = this.requestToken(cred.key, cred.secret, index).finally(() => {
      this.inflightRequests.delete(index);
    });

    this.inflightRequests.set(index, req);
    return req;
  }

  private async requestToken(clientId: string, clientSecret: string, index: number): Promise<string | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      });
    } catch (err) {
      // A DNS failure, a refused connection or a timeout never reached Spotify,
      // so there is no status to report and nothing about the credential can be
      // concluded. That is the definition of a transient fault and it gets the
      // short backoff.
      this.rememberFailure(index, 'transient');
      Logger.warn({ err }, `[Spotify] Token request for credential #${index + 1} never reached accounts.spotify.com`);
      return null;
    }

    if (!response.ok) {
      const detail = await readTokenError(response, [clientId, clientSecret]);
      const reason = classifyTokenFailure(response.status);
      this.rememberFailure(index, reason);
      Logger.error(
        `[Spotify] Token request failed with HTTP ${response.status} for credential #${index + 1} (${detail})` +
          (reason === 'credential-rejected'
            ? ' — the credential was refused, not throttled. This is a config fault, so it is not retried as a blip.'
            : ' — treated as a transient fault; the credential is kept and retried.'),
      );
      return null;
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.failureBackoff.delete(index);
    const tokenObj: CachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - REFRESH_MARGIN_MS,
    };
    this.cachedTokens.set(index, tokenObj);
    return tokenObj.accessToken;
  }

  private rememberFailure(index: number, reason: TokenFailure): void {
    this.failureBackoff.set(index, {
      reason,
      until: Date.now() + (reason === 'credential-rejected' ? CREDENTIAL_BACKOFF_MS : TRANSIENT_BACKOFF_MS),
    });
  }

  public invalidate(): void {
    const index = this.activeIndex;
    this.cachedTokens.delete(index);
    // The backoff goes too, or the retry that a 401-driven `invalidate()` exists
    // to trigger would be swallowed by the backoff and answer null — turning a
    // recoverable "this bearer expired" into a 30-second or 15-minute outage.
    this.failureBackoff.delete(index);
  }
}
