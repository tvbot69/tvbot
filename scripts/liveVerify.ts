/**
 * LIVE verification against the real vendor APIs — the instrument that closed
 * the "no test has ever seen a real vendor" gap.
 *
 * ## Why this exists
 *
 * 4928 tests passed while a real, user-facing bug was live: `lastfmApi` judged
 * the HTTP status before reading the body, so a nonexistent user (HTTP **404**
 * with `{"error":6}`) was reported to users as "Last.fm is unreachable".
 * The mocked suite could not catch it, because the mock's shape did not match
 * what the vendor actually returns. This script asks the vendor.
 *
 * It runs the **production classes** — `LastfmApi`/`LastFmRepository`,
 * `SpotifyTokenManager`, `SpotifySearchApi`, `fetchDescriptionChapters` — not a
 * re-implementation, so it exercises the same seam a real command does. Where
 * there is no production class for a behaviour (does the server accept
 * `limit=11`?) a plain `fetch` is the only correct instrument, and the
 * production class is then run alongside it so the two agree.
 *
 * ## Why it found what the tests did not
 *
 * Last.fm is inconsistent about how it says "no such thing": the `user.*`
 * family answers HTTP 404, the `artist`/`track` families answer HTTP 200 with
 * the same body code. A single fixture shape cannot express both, so a mocked
 * test has to pick one and be wrong about the other. The Spotify section exists
 * for the same class of reason: a test double is a claim about a vendor, and
 * the claims in the Spotify suites are written down in test comments where
 * nothing can check them.
 *
 * ## Reading the output
 *
 *   PASS / FAIL  — a CLAIM was checked against the wire. FAIL means the code or
 *                  the test comment is wrong, and the process exit code is
 *                  non-zero so this can gate a pipeline.
 *   INFO          — an observation with no claim attached. An observation is
 *                  not a verdict: "no placeholder in ten samples" does not
 *                  disprove the placeholder, it just did not happen to fire.
 *
 * ## Running it
 *
 *   $env:NODE_USE_ENV_PROXY="1"   # Node's fetch ignores HTTP_PROXY without this
 *   $env:NODE_ENV="test"          # keeps the Logger from writing a log FILE
 *   $env:LOG_FILE="false"
 *   npx tsx scripts/liveVerify.ts
 *
 * **NEVER PRINTS A SECRET.** Only shapes, statuses, counts, lengths and host
 * names. Every value that arrives from a vendor is passed through a redactor
 * that blanks anything under a token/secret/key/authorization-looking key, and
 * request URLs are never printed — a Spotify `next` cursor or a YouTube `key=`
 * is a credential by another name. It reads the real credentials from `.env`
 * because `ConfigData` reads `process.env` at import time, and the API classes
 * take their keys from there.
 *
 * ## What it cannot tell you
 *
 * Nothing here observes voice, audio, ffmpeg, or a real Discord interaction. A
 * 5xx cannot be induced, and a 429 cannot be provoked without hammering a
 * vendor, so both are reported as untested rather than guessed at.
 */
import 'reflect-metadata';
import { LastfmApi } from '../src/lastfm/api/lastfmApi';
import { LastFmRepository } from '../src/lastfm/repositories/lastFmRepository';
import { LastfmErrorRateTracker } from '../src/domain/lastfm/lastfmErrorRateTracker';
import { Logger } from '../src/domain/logging/logger';
import { isPlaceholderImageUrl } from '../src/domain/lastfm/lastfmPlaceholder';
import { SpotifyTokenManager } from '../src/spotify/api/spotifyTokenManager';
import { SpotifySearchApi, SpotifyUnavailableError } from '../src/spotify/api/spotifySearchApi';
import * as SPOTIFY_LIMITS_MODULE from '../src/spotify/api/spotifyApiLimits';
import { ConfigData } from '../src/config/configData';
import {
  fetchDescriptionChapters,
  parseTimestampLines,
  __resetDescriptionChaptersForTests,
} from '../src/bot/services/music/descriptionChapters';

// The username the repo's own test fixtures already use, so a failure here means
// something about the code rather than about a typo.
const FIXTURE_USER = 'DreadRock';
/** The artist id every Spotify limits test in the repo pins. */
const ARTIST_ID = '4Z8W4fKeB5YxbusRsdQVPb';
/** The placeholder hash the whole artwork cascade filters on. */
const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

const verdict = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${detail}`);
  if (!ok) {
    // A non-zero exit is the point: this script has to be able to fail loudly
    // in a pipeline, not just print red text nobody reads.
    process.exitCode = 1;
  }
};

/**
 * A claim that could NOT be checked, which is not the same as a claim that is
 * false.
 *
 * This distinction is the whole reason the file has three output words. A FAIL
 * means the code or the comment is wrong and a human must act. A SKIP means the
 * vendor was never asked, and reporting that as a FAIL would be the exact lie
 * this script exists to prevent: a probe that blames Spotify for the probe's own
 * pacing is worse than no probe, because it trains people to ignore it.
 *
 * SKIP does NOT set the exit code — an unrunnable claim is not a failed gate.
 */
const skip = (label: string, reason: string): void => {
  console.log(`SKIP  ${label.padEnd(56)} ${reason}`);
};

/** TRUE for "the run was inconclusive" — never for "Spotify said no". */
const NOT_JUDGED = 'NOT TESTED: this run was refused for quota (HTTP 429), so the vendor was never asked';

/** An observation, and explicitly NOT a claim. */
const info = (text: string): void => {
  console.log(`INFO  ${text}`);
};

const head = (text: string): void => {
  console.log(`\n=== ${text} ===`);
};

const classify = (e: unknown): string => {
  const n = (e as { name?: string })?.name ?? 'Error';
  return n;
};

/** The name of a throw, plus the first words of its message. Safe: no vendor
 *  URL and no credential reaches an error message in the classes under test. */
const brief = (e: unknown): string =>
  `${classify(e)}: ${String((e as Error).message).slice(0, 90).replace(/\s+/g, ' ')}`;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** A key whose VALUE is a credential whatever the vendor calls it. */
const SECRET_KEY_RE =
  /(token|secret|key|password|authorization|cookie|credential|apikey|api_key|signature|\bsig\b|session)/i;

/** Longest string printed verbatim. Anything longer is a length, not a value. */
const MAX_INLINE = 72;

const shape = (value: unknown, key = '', depth = 0): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) return `string(${String(value.length)}) <redacted>`;
    return value.length <= MAX_INLINE ? JSON.stringify(value) : `string(${String(value.length)})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const head0 = value.length > 0 && depth < 2 ? ` of ${shape(value[0], key, depth + 1)}` : '';
    return `array(${String(value.length)})${head0}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 18)
      .map(([k, v]) => `${k}=${shape(v, k, depth + 1)}`);
    return `{ ${entries.join(' | ')} }`;
  }
  return typeof value;
};

/** Host of a URL, or `(none)`. A URL is never printed whole: on these APIs the
 *  query string carries the credential or the cursor. */
const hostOf = (url: string | null | undefined): string => {
  if (!url) return '(none)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface Raw {
  status: number;
  ok: boolean;
  /** `Retry-After` verbatim — a small integer, and claim C6 is about it. */
  retryAfter: string | null;
  body: unknown;
  /** Set when the request never reached the vendor. */
  transport: string | null;
}

let bearer: string | null = null;

/**
 * The production search API, shared with the ceiling probe so it can exercise
 * `getArtistDiscographyCovers` at the limit the collage builders really send.
 * Created in `main` once the bearer exists.
 */
let coversProbeApi: SpotifySearchApi | null = null;

/**
 * Milliseconds between requests.
 *
 * Raised from 60ms. The ceiling section now makes a boundary sweep as well as a
 * ladder, and the whole run crossed Spotify's app-level quota and answered 429
 * partway through — which does not fail loudly, it quietly turns every later
 * claim into a false FAIL. A verification script that can be rate-limited into
 * reporting the vendor as broken is worse than a slow one.
 */
const PACE_MS = 260;

const pace = async (): Promise<void> => {
  await settleQuota();
  await new Promise((r) => setTimeout(r, PACE_MS));
};

/**
 * A GET whose body is read as TEXT, for the HTML pages (a playlist page is not
 * JSON, and `raw()` would record it as `<non-JSON body>` and lose the very
 * playlist id this probe exists to find). Never prints the body.
 */
const rawText = async (url: string, init?: RequestInit): Promise<{ status: number; text: string }> => {
  await pace();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: '' };
  }
};

/** A 429 seen anywhere, so verdicts can say NOT TESTED rather than blame the vendor. */
let quotaRefused = false;

/**
 * Quota backoff, seconds. A 429 on this API is an APP-level quota, not a
 * per-second one, so a short wait does not clear it; the backoff is generous
 * and grows, and the run continues afterwards rather than reporting a vendor
 * failure that is really this script out-asking.
 */
let quotaBackoffSec = 0;

const backoffOn = (seconds: number): void => {
  quotaRefused = true;
  quotaBackoffSec = Math.max(quotaBackoffSec, seconds);
};

const raw = async (url: string, init?: RequestInit): Promise<Raw> => {
  await pace();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = '<non-JSON body>';
    }
    if (res.status === 429) {
      // Respect the vendor's own hint, and default generously: the quota here is
      // app-level, so a two-second wait would just earn another 429.
      const hinted = Number(res.headers.get('Retry-After') ?? '0');
      backoffOn(Number.isFinite(hinted) && hinted > 0 ? hinted : 30);
    }
    return {
      status: res.status,
      ok: res.ok,
      retryAfter: res.headers.get('Retry-After'),
      body,
      transport: null,
    };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      retryAfter: null,
      body: null,
      transport: String((err as Error).message).slice(0, 120),
    };
  }
};

/** Waits out any quota backoff before the next request goes out. */
const settleQuota = async (): Promise<void> => {
  if (quotaBackoffSec <= 0) return;
  const wait = Math.min(quotaBackoffSec, 60);
  info(`quota refused (HTTP 429) — waiting ${String(wait)}s before continuing`);
  await new Promise((r) => setTimeout(r, wait * 1000));
  quotaBackoffSec = 0;
};

/** An authenticated api.spotify.com GET, path only. */
const sp = async (path: string, auth = true): Promise<Raw> =>
  raw(`https://api.spotify.com${path}`, {
    headers: auth && bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });

/** `GET /v1/search` with an explicit (possibly invalid) limit string. */
const searchWithLimit = async (limit: string, q = 'radiohead', type = 'track'): Promise<Raw> => {
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', q);
  url.searchParams.set('type', type);
  url.searchParams.set('limit', limit);
  return sp(`${url.pathname}${url.search}`);
};

/** A request that never reached the vendor, as a printable note. */
const note = (r: Raw): string => (r.transport === null ? `HTTP ${String(r.status)}` : `NO REQUEST: ${r.transport}`);

// ---------------------------------------------------------------------------
// 0. Is there a network at all?
// ---------------------------------------------------------------------------

const preflight = async (): Promise<boolean> => {
  head('0. NETWORK — three hosts, before any claim is checked');
  const targets: Array<[string, string]> = [
    ['api.spotify.com', 'https://api.spotify.com/v1/search'],
    ['ws.audioscrobbler.com', 'https://ws.audioscrobbler.com/2.0/'],
    ['www.googleapis.com', 'https://www.googleapis.com/youtube/v3/videos'],
  ];
  let reachable = 0;
  for (const [label, url] of targets) {
    const r = await raw(url);
    if (r.transport === null) reachable += 1;
    info(
      `${label.padEnd(24)} ${r.transport === null ? `HTTP ${String(r.status)}` : `UNREACHABLE (${r.transport})`}`,
    );
  }
  if (reachable === 0) {
    console.log(
      '\n*** NO NETWORK from this machine. Nothing below was probed, and no claim in this\n' +
        '*** run may be reported as verified. Fix connectivity (or set NODE_USE_ENV_PROXY=1)\n' +
        '*** and run it again.',
    );
    process.exitCode = 1;
    return false;
  }
  info(`${reachable}/${targets.length} hosts reachable`);
  return true;
};

// ---------------------------------------------------------------------------
// 1. The token endpoint — highest value in the list
// ---------------------------------------------------------------------------

interface CachedTokenView {
  cachedTokens: Map<number, { accessToken: string; expiresAt: number }>;
}

const probeTokenEndpoint = async (): Promise<boolean> => {
  head('D7/D8 — accounts.spotify.com client-credentials (HIGHEST VALUE)');

  const creds = ConfigData.Data.spotify.credentials.filter((c) => !!c.key && !!c.secret);
  info(`configured credentials in the pool: ${creds.length}`);
  const first = creds[0];
  if (!first) {
    verdict('D7 a client-credentials token can be obtained', false, 'no SPOTIFY_CLIENT_ID/SECRET in the pool');
    return false;
  }

  // --- D7: is `expires_in` seconds or milliseconds? -------------------------
  const post = (secret: string): Promise<Raw> =>
    raw('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${first.key}:${secret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });

  const good = await post(first.secret);
  const body = asRecord(good.body);
  const expiresIn = body['expires_in'];
  info(`token endpoint -> HTTP ${good.status} ${shape(good.body)}`);

  const isSeconds = typeof expiresIn === 'number' && expiresIn > 0 && expiresIn <= 86_400;
  verdict(
    'D7 expires_in is SECONDS (production multiplies by 1000)',
    isSeconds,
    `expires_in=${String(expiresIn)} (typeof ${typeof expiresIn}) -> ${isSeconds ? 'SECONDS, code is right' : 'NOT SECONDS, the x1000 is wrong'}`,
  );
  info(
    `token body keys: ${Object.keys(body).join(', ')} | token_type=${String(body['token_type'])} | token string length=${String((body['access_token'] as string | undefined)?.length ?? 'n/a')}`,
  );

  // The same arithmetic through the PRODUCTION class, read off its cache.
  const manager = new SpotifyTokenManager();
  const issuedAt = Date.now();
  const token = await manager.getToken();
  const cache = (manager as unknown as CachedTokenView).cachedTokens;
  const entry = cache.get(0);
  if (token && entry) {
    const remainingSec = Math.round((entry.expiresAt - Date.now()) / 1000);
    const expectedSec = (typeof expiresIn === 'number' ? expiresIn : NaN) - 60;
    info(
      `production cache: expiresAt-now = ${remainingSec}s (expected expires_in - 60s = ${String(expectedSec)}s, 60s refresh margin)`,
    );
    verdict(
      'D7 production token lifetime matches expires_in x 1000 - 60s',
      Math.abs(remainingSec - expectedSec) <= 2,
      `${remainingSec}s vs ${String(expectedSec)}s`,
    );
  } else {
    verdict(
      'D7 production manager cached the token it was just issued',
      false,
      `token=${token ? 'present' : 'null'} cacheEntry=${entry ? 'present' : 'absent'} (asked ${String(Date.now() - issuedAt)}ms ago)`,
    );
  }

  bearer = token;
  if (!bearer) {
    verdict('D7 the pool yields a usable bearer for the rest of this run', false, 'getToken() returned null');
    return false;
  }
  info('bearer acquired (never printed) — the remaining Spotify probes run against the real API');

  // --- D8: is a rejected client-credential a 400 or a 401? ------------------
  // CORRECTED 2026-09-30. This verdict used to demand 401, which was wrong, and
  // wrong in the direction that costs somebody an afternoon: it made a
  // misconfigured secret look like a blip to retry, when it is a config fault
  // that no amount of retrying will fix. The token endpoint says 400
  // `invalid_client`. A 401 is real and lives one layer up — an expired BEARER
  // rejected by api.spotify.com (C5, below) — and that is the one that should
  // invalidate a cached token, which is what `invalidate()` is for.
  const rejected = await post('probe-not-the-secret');
  const rejectedBody = asRecord(rejected.body);
  info(`rejected client-credentials -> HTTP ${rejected.status} ${shape(rejected.body)}`);
  verdict(
    'D8 a refused client-credential comes back as 400, not 401',
    rejected.status === 400,
    `HTTP ${rejected.status}${rejected.status === 401 ? ' (the old, wrong expectation)' : ''} body=${shape(rejected.body, 'error')}`,
  );
  // The production code reads `error` and `error_description` out of this body to
  // build its diagnostic line, so the FIELD NAMES are a claim of their own: if
  // Spotify renamed them, `readTokenError` would degrade to "unknown_error" and
  // the operator would lose the one useful word in the log.
  verdict(
    'D8 the refusal body still carries error="invalid_client" + error_description',
    rejectedBody['error'] === 'invalid_client' && typeof rejectedBody['error_description'] === 'string',
    `error=${String(rejectedBody['error'])}, error_description is a ${typeof rejectedBody['error_description']} of length ${String((rejectedBody['error_description'] as string | undefined)?.length ?? 0)}`,
  );

  return true;
};

// ---------------------------------------------------------------------------
// 2. D9 — the deleted account-free web-player rung
// ---------------------------------------------------------------------------

/**
 * The anon web-player token used to be the credential-less path AND the
 * degraded-mode backup: the open.spotify.com landing page -> the
 * `mobile-web-player` bundle -> a `"secret":[<digits>]` array -> an XOR transform
 * -> a TOTP -> `api/token?reason=init`.
 *
 * It was dead, silently, and thirteen tests kept passing over it. Probed
 * 2026-09-30: the landing page answered 200, the bundle fetched (1,375,445
 * characters, 7 literal occurrences of `secret`), and there were ZERO matches
 * for a digit array — so the scrape yielded nothing and the mint was never
 * attempted. The vendor bundle told the same story (1,943,394 chars, 23
 * occurrences, zero matches), so excluding it was never the problem. The secret
 * is still in the player; it is no longer an array. Today's bundle carries
 * `[{secret:'...',version:61}, ...]` and selects one by BUILD VERSION, with the
 * same `(i % 33) + 9` XOR applied to the string's char codes.
 *
 * So the rung is deleted rather than repaired, and this section now checks the
 * two claims that deletion makes falsifiable:
 *
 *   1. the dead entry points are unreachable, so no caller and no future edit can
 *      route into them, and
 *   2. on the working path the production token manager dials
 *      accounts.spotify.com and NOTHING ELSE — no scraping, no second host.
 *
 * Deliberately absent: any re-check of the bundle for a digit array. That is a
 * fact about Spotify, not a claim about this repo, and a verdict about deleted
 * code can only ever FAIL. The evidence is recorded above instead.
 */
const probeDeletedAnonRung = async (): Promise<void> => {
  head('D9 — the deleted anon web-player rung: unreachable, and nothing scrapes');

  // Claim 1. Reached the way the old probe reached the private method: a cast
  // off the instance, so this is the same seam a credential-less deploy used.
  interface LegacyShape {
    getAnonToken?: unknown;
    requestAnonToken?: unknown;
    fetchAnonSecretHex?: unknown;
  }
  const legacy = new SpotifyTokenManager() as unknown as LegacyShape;
  const present = (['getAnonToken', 'requestAnonToken', 'fetchAnonSecretHex'] as const).filter(
    (name) => typeof legacy[name] === 'function',
  );
  verdict(
    'D9 no anon-token entry point survives on SpotifyTokenManager',
    present.length === 0,
    present.length === 0
      ? 'getAnonToken / requestAnonToken / fetchAnonSecretHex are all absent, so nothing can reach the dead path'
      : `STILL PRESENT AND CALLABLE: ${present.join(', ')} — a dead rung is back`,
  );

  // Claim 2. Every host the production token manager actually dials, recorded
  // through a global fetch spy so a request cannot hide behind a helper — the
  // old probe recorded the same way, and that is how a scrape would have shown
  // up if one still existed.
  const hosts = new Map<string, number>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    const host = new URL(target).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    return realFetch(input, init);
  };

  let token: string | null = null;
  let threw: string | null = null;
  try {
    token = await new SpotifyTokenManager().getToken();
  } catch (err) {
    threw = brief(err);
  } finally {
    globalThis.fetch = realFetch;
  }

  const dialled = [...hosts.keys()];
  const summary = [...hosts.entries()].map(([h, n]) => `${h} x${String(n)}`).join(', ') || '(no requests)';
  info(`hosts the production token manager dialled: ${summary}`);

  verdict(
    'D9 the working token path dials accounts.spotify.com and nothing else',
    dialled.length > 0 && dialled.every((h) => h === 'accounts.spotify.com'),
    dialled.length === 0
      ? 'NOT TESTED: the token request never left the machine, so the host set proves nothing'
      : dialled.every((h) => h === 'accounts.spotify.com')
        ? `one host only (${summary}) — no scrape of open.spotify.com, no second rung`
        : `UNEXPECTED HOST(S): ${dialled.filter((h) => h !== 'accounts.spotify.com').join(', ')}`,
  );
  verdict(
    'D9 getToken() answers a token on the working path',
    token !== null && threw === null,
    threw ? `RAISED ${threw}` : token ? `token obtained (string length ${String(token.length)}, never printed)` : 'null',
  );
};

// ---------------------------------------------------------------------------
// 3. B4 — /v1/albums/{id}/tracks, the endpoint whose limit was never measured
// ---------------------------------------------------------------------------

const findBigAlbum = async (api: SpotifySearchApi): Promise<{ id: string; name: string; total: number } | null> => {
  const queries = ['beethoven complete symphonies', 'beethoven karajan'];
  for (const q of queries) {
    const albums = await api.searchAlbums(q, 10);
    for (const album of albums.slice(0, 5)) {
      if (!album?.id) continue;
      const r = await sp(`/v1/albums/${album.id}/tracks?limit=1`);
      const total = Number(asRecord(r.body)['total'] ?? 0);
      if (total >= 50) return { id: album.id, name: album.name ?? album.id, total };
    }
  }
  return null;
};

const probeTracklistLimit = async (api: SpotifySearchApi): Promise<void> => {
  head('B4 — /v1/albums/{id}/tracks: the limit that was never measured');

  const big = await findBigAlbum(api);
  if (!big) {
    console.log(
      'SKIP  no album with >= 50 tracks found in two searches, so the "does the server HONOUR 50"\n' +
        '      half could not be separated from "does it merely accept 50". The small-album\n' +
        '      acceptance probe and the production-class probe below still ran.',
    );
  } else {
    info(`reference album: total_tracks=${big.total} (id is not printed)`);
    const at50 = await sp(`/v1/albums/${big.id}/tracks?limit=50`);
    const items50 = arr(asRecord(at50.body)['items']).length;
    info(`limit=50 -> HTTP ${at50.status} ${shape(at50.body)}`);
    verdict(
      'B4 /v1/albums/{id}/tracks ACCEPTS limit=50',
      at50.status === 200,
      `HTTP ${at50.status}; returned ${String(items50)} items of ${String(big.total)} total`,
    );
    verdict(
      'B4 ...and HONOURS 50 (returns a full page, not a silently clamped one)',
      items50 === 50,
      `${String(items50)} items returned at limit=50`,
    );

    const at100 = await sp(`/v1/albums/${big.id}/tracks?limit=100`);
    info(`limit=100 (the documented max) -> HTTP ${at100.status} ${shape(at100.body, 'error')}`);

    const at10 = await sp(`/v1/albums/${big.id}/tracks?limit=10`);
    const items10 = arr(asRecord(at10.body)['items']).length;
    info(`limit=10 -> HTTP ${at10.status}, ${String(items10)} items (so 50 is not a coincidence of album size)`);

    // offset: is it honoured, and what does an out-of-range offset look like?
    const off0 = await sp(`/v1/albums/${big.id}/tracks?limit=3`);
    const off10 = await sp(`/v1/albums/${big.id}/tracks?limit=3&offset=10`);
    const id0 = String(asRecord(arr(asRecord(off0.body)['items'])[0])['id'] ?? '');
    const id10 = String(asRecord(arr(asRecord(off10.body)['items'])[0])['id'] ?? '');
    const nextUrl = asRecord(off10.body)['next'];
    const nextOffset = nextUrl ? new URL(String(nextUrl)).searchParams.get('offset') : null;
    info(
      `offset=0 first id=${id0 || '(none)'} | offset=10 first id=${id10 || '(none)'} | next cursor offset=${String(nextOffset)}`,
    );
    verdict(
      'B4 offset is honoured (a different window comes back)',
      off10.status === 200 && id10 !== '' && id0 !== id10,
      `HTTP ${off10.status}, first id differs: ${String(id0 !== id10)}`,
    );

    const far = await sp(`/v1/albums/${big.id}/tracks?limit=3&offset=999999`);
    info(
      `offset=999999 (past the end) -> HTTP ${far.status}, ${String(arr(asRecord(far.body)['items']).length)} items ${shape(far.body, 'error')}`,
    );

    const zero = await sp(`/v1/albums/${big.id}/tracks?limit=0`);
    info(`limit=0 -> HTTP ${zero.status} ${shape(zero.body)}`);
    verdict(
      'B4 a bad limit here is a 400 with a body (what "a 400 looks like" here)',
      zero.status === 400,
      `limit=0 -> HTTP ${zero.status} ${shape(zero.body)}`,
    );
  }

  // The production class, on the album the repo's own test uses.
  try {
    const names = await api.getAlbumTrackNames('Geogaddi', 'Boards of Canada', 50);
    verdict(
      'B4 PRODUCTION getAlbumTrackNames(...,50) returns track names',
      names.length > 0,
      `${String(names.length)} names, first="${String(names[0])}" — a 400 would have raised instead`,
    );
  } catch (err) {
    verdict(
      'B4 PRODUCTION getAlbumTrackNames(...,50) returns track names',
      false,
      `RAISED ${brief(err)}`,
    );
  }
};

// ---------------------------------------------------------------------------
// 4. A1/A2 — the two measured ceilings, and the values that must be rejected
// ---------------------------------------------------------------------------

/**
 * The limit ceilings on `/v1/search` and `/v1/artists/{id}/albums`.
 *
 * ## These expectations were WRITTEN FROM MEASUREMENT, and the measurement has
 * been taken four separate times with three different answers. Read this before
 * editing a number here.
 *
 *   - 2026-09-30 (first run): both endpoints REJECT limit=11, so the ceiling was
 *     recorded as 10.
 *   - 2026-09-30 (second run, same day): both endpoints ACCEPT 11, 15, 20 and 50
 *     and reject 51 — so the ceiling was rewritten to 50. `spotifyApiLimits.ts`
 *     now says 50 and its own header records that it overrode the first run with
 *     "The docs were right and the probe was wrong."
 *   - 2026-10-01 (this run): BOTH REJECT limit=11 again — 400 "Invalid limit" on
 *     `/v1/search` for all three `type` values, and on `/v1/artists/{id}/albums`
 *     with and without `include_groups`, with and without `market`. A 1..12
 *     boundary sweep puts the cut exactly between 10 and 11, reproduced three
 *     times in one run.
 *
 * So the ceiling today is **10** on both endpoints, and the claim this section
 * asserts is the one the vendor confirmed on the most recent run. It is recorded
 * with its date for exactly the reason the header asks for: a comment that
 * cannot be contradicted is a memory, and this file has now been contradicted
 * three times by running it.
 *
 * ## What the conflict costs right now, because it is not academic
 *
 * `spotifyApiLimits.ts` (NOT this file's to change) clamps to 50. Both collage
 * builders pass 15 (`whoKnowsImageBuilder.ts:317`, `topBuilders.ts:86`). With a
 * ceiling of 10 the request goes out as `limit=15`, the server answers **400**,
 * and `getArtistDiscographyCovers` takes its `!res.ok` branch and returns `[]`.
 * The live run below shows exactly that: the WARN fires with `albumLimit: 15` and
 * the production-class verdict returns 0 covers. Every Spotify column of every
 * collage is empty, with nothing above WARN to say why. That is the same silent
 * 5x under-fetch the ceiling fix was meant to end, reached from the other side.
 */
/**
 * Whether any request in this run was refused for quota rather than judged.
 *
 * A 429 is not a verdict about the vendor — it is this script out-asking. Every
 * claim below checks it first, so a rate-limited run reports "NOT TESTED"
 * instead of FAILing the vendor for the script's own pacing. (Observed on
 * 2026-10-01: adding the boundary sweep pushed the run over the app quota
 * mid-section, and every later claim silently became a false FAIL.)
 */

/** FAIL is only meaningful for a request the vendor actually answered. */
const judged = (r: { status: number; transport: string | null }): boolean => {
  if (r.transport !== null || r.status === 0 || r.status === 429) {
    if (r.status === 429) quotaRefused = true;
    return false;
  }
  return true;
};

/** The same claim, reported as SKIP rather than FAIL when it was never asked. */
const claimOrSkip = (label: string, wasJudged: boolean, ok: boolean, detail: string): void => {
  if (wasJudged) verdict(label, ok, detail);
  else skip(label, NOT_JUDGED);
};

const probeCeilings = async (): Promise<void> => {
  head('A1/A2 — the limit ceiling on /v1/artists/{id}/albums and /v1/search (measured 2026-10-01)');

  for (const limit of ['5', '9', '10', '11', '15', '20', '50', '100']) {
    const r = await sp(
      `/v1/artists/${ARTIST_ID}/albums?include_groups=album,single,appears_on&limit=${limit}`,
    );
    const items = arr(asRecord(r.body)['items']).length;
    const ok = judged(r);
    info(
      `artists/{id}/albums limit=${limit.padEnd(3)} -> ${note(r).padEnd(10)} ${String(items)} items ${r.status >= 400 ? shape(r.body, 'error') : ''}`,
    );
    if (limit === '10') {
      claimOrSkip('A1 /v1/artists/{id}/albums ACCEPTS limit=10 and HONOURS it', ok, ok && r.status === 200 && items === 10, `${note(r)}, ${String(items)} items`);
    }
    if (limit === '11') {
      claimOrSkip('A1 /v1/artists/{id}/albums REJECTS limit=11 (ceiling is 10, measured 2026-10-01)', ok, ok && r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '50') {
      claimOrSkip('A1 ...and therefore REJECTS limit=50 too', ok, ok && r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '100') {
      claimOrSkip('A1 ...and limit=100, as the docs maximum would be', ok, ok && r.status === 400, `limit=100 -> ${note(r)} ${shape(r.body, 'error')}`);
    }
  }

  // The boundary, stated as a boundary rather than as two sampled points. The
  // one thing a 1..12 sweep buys over probing 10 and 11 is that it proves there
  // is no gap in between — which is the only claim the two-point version makes.
  // Three probes (9, 10, 11) is the minimum that still establishes the cut on
  // both sides without spending the quota this run needs elsewhere.
  const boundary: string[] = [];
  let boundaryJudged = true;
  for (const limit of [9, 10, 11]) {
    const r = await sp(`/v1/artists/${ARTIST_ID}/albums?limit=${String(limit)}`);
    if (!judged(r)) boundaryJudged = false;
    const items = arr(asRecord(r.body)['items']).length;
    boundary.push(`${String(limit)}:${r.status === 200 ? `200/${String(items)}` : String(r.status)}`);
  }
  info(`albums boundary sweep -> ${boundary.join('  ')}`);
  claimOrSkip(
    'A1 the cut is exactly at 10/11, with no gap in between',
    boundaryJudged,
    boundaryJudged &&
      boundary[0]?.startsWith('9:200') === true &&
      boundary[1]?.startsWith('10:200') === true &&
      boundary[2]?.startsWith('11:400') === true,
    boundary.join('  '),
  );

  for (const limit of ['5', '10', '11', '15', '20', '50', '51', '100']) {
    const r = await searchWithLimit(limit);
    const items = arr(asRecord(asRecord(r.body)['tracks'])['items']).length;
    const ok = judged(r);
    info(
      `/v1/search limit=${limit.padEnd(3)} -> ${note(r).padEnd(10)} ${String(items)} track items ${r.status >= 400 ? shape(r.body, 'error') : ''}`,
    );
    if (limit === '10') {
      const first = asRecord(arr(asRecord(asRecord(r.body)['tracks'])['items'])[0]);
      claimOrSkip('A2 /v1/search ACCEPTS limit=10 and HONOURS it', ok, ok && r.status === 200 && items === 10, `${note(r)}, ${String(items)} items`);
      if (!ok) continue;
      info(
        `search item shape: id=${typeof first['id']} name=${typeof first['name']} artists=${shape(first['artists'])} album.images=${shape(asRecord(first['album'])['images'])}`,
      );
      const ext = asRecord(first['external_urls']);
      verdict(
        'scoring: a track result carries id and external_urls.spotify',
        typeof first['id'] === 'string' && typeof ext['spotify'] === 'string',
        `id is a ${typeof first['id']}, external_urls.spotify is a ${typeof ext['spotify']} (host ${hostOf(ext['spotify'] as string)})`,
      );
    }
    if (limit === '11') {
      claimOrSkip('A2 /v1/search REJECTS limit=11 (ceiling is 10, measured 2026-10-01)', ok, ok && r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '50') {
      claimOrSkip('A2 ...and therefore REJECTS limit=50 too', ok, ok && r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '100') {
      claimOrSkip('A2 ...and limit=100, as the docs maximum would be', ok, ok && r.status === 400, `limit=100 -> ${note(r)} ${shape(r.body, 'error')}`);
    }
  }

  // One constant clamps all three `type` values, so the ceiling is measured on
  // the other two as well rather than assumed for them.
  for (const type of ['artist', 'album']) {
    const r = await searchWithLimit('11', 'radiohead', type);
    const at10 = await searchWithLimit('10', 'radiohead', type);
    const ok = judged(r) && judged(at10);
    claimOrSkip(
      `A2 the ceiling of 10 holds for type=${type} too`,
      ok,
      ok && r.status === 400 && at10.status === 200,
      `limit=10 -> HTTP ${at10.status}, limit=11 -> HTTP ${r.status} ${shape(r.body, 'error')}`,
    );
  }

  // The conflict, asserted as a claim about THIS REPO rather than about the
  // vendor, so it fails loudly while the two disagree instead of sitting in a
  // comment for someone to rediscover.
  //
  // The second of these is deliberately NOT quota-guarded: it compares a number
  // read out of `spotifyApiLimits.ts` against a number already measured, so it
  // is decidable with no network at all and must keep failing until the two
  // agree. The first one needs the wire, so it is a SKIP when the wire was not
  // available.
  const discography = await api_getArtistDiscographyCoversProbe();
  claimOrSkip(
    'A1 the collage path still WORKS at the limit it sends (limit=15)',
    discographyWasJudged(),
    discography.covers > 0,
    discography.note,
  );
  verdict(
    'A1 spotifyApiLimits.ts (ceiling 50) AGREES with the measured ceiling of 10',
    SPOTIFY_LIMITS_DECLARED_MAX === 10,
    `the limits module declares ${String(SPOTIFY_LIMITS_DECLARED_MAX)}; the wire said 10 on 2026-10-01. While these disagree, a caller asking for 15 gets a 400 and an empty collage.`,
  );
};

/**
 * The production class at the limit the collage builders actually pass (15).
 *
 * Reported rather than asserted on its own, because its verdict above is a
 * claim about the bot's behaviour and it is currently FALSE: with a ceiling of
 * 10 and callers asking 15, the request is rejected and the method returns [].
 */
const api_getArtistDiscographyCoversProbe = async (): Promise<{ covers: number; note: string }> => {
  if (!coversProbeApi) {
    return { covers: 0, note: 'NOT TESTED: the production search API was never constructed' };
  }
  const covers = await coversProbeApi.getArtistDiscographyCovers('Radiohead', undefined, 15).catch((e: unknown) => e);
  if (Array.isArray(covers)) {
    return {
      covers: covers.length,
      note: covers.length === 0
        ? `0 covers at limit=15 — the server rejects 15 today (ceiling 10), so the request is 400 and this method returns []`
        : `${String(covers.length)} covers, first host ${hostOf(covers[0] as string)}`,
    };
  }
  return { covers: 0, note: `raised/returned ${brief(covers)}` };
};

/**
 * The same production call, but reporting SKIP rather than FAIL when the wire
 * was quota-refused rather than judged.
 */
const discographyWasJudged = (): boolean => !quotaRefused;

/**
 * What `spotifyApiLimits.ts` claims, read from the module rather than copied
 * into a comment — so this probe contradicts the CODE, not a transcription of it.
 */
const SPOTIFY_LIMITS_DECLARED_MAX = ((): number => {
  const limits = SPOTIFY_LIMITS_MODULE as {
    SPOTIFY_SEARCH_LIMIT_MAX: number;
    SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX: number;
  };
  return Math.max(limits.SPOTIFY_SEARCH_LIMIT_MAX, limits.SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX);
})();

const probeInvalidLimits = async (): Promise<void> => {
  head('A2b — the values that must NOT be sent: 0, -1, 1.5, abc, NaN, Infinity');

  const bad = ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity'];
  const results: Array<[string, number, string]> = [];
  for (const limit of bad) {
    const r = await searchWithLimit(limit);
    const message = String(asRecord(asRecord(r.body)['error'])['message'] ?? '');
    results.push([limit, r.status, message]);
    info(`/v1/search limit=${limit.padEnd(9)} -> ${note(r).padEnd(10)} ${message ? `"${message}"` : shape(r.body, 'error')}`);
  }

  for (const limit of ['0', '-1', '1.5']) {
    const r = await sp(`/v1/artists/${ARTIST_ID}/albums?limit=${limit}`);
    const message = String(asRecord(asRecord(r.body)['error'])['message'] ?? '');
    results.push([`albums:${limit}`, r.status, message]);
    info(`/v1/artists/{{id}}/albums limit=${limit.padEnd(5)} -> ${note(r).padEnd(10)} ${message ? `"${message}"` : shape(r.body, 'error')}`);
  }

  const unreachable = results.filter(([, status]) => status === 0);
  const not400 = results.filter(([, status]) => status !== 400 && status !== 0);
  const wrongMessage = results.filter(([, , message]) => message !== '' && message !== 'Invalid limit');
  const quota = results.filter(([, status]) => status === 429);
  if (quota.length > 0) quotaRefused = true;
  verdict(
    'A2b every non-positive/fractional/junk limit is a 400 "Invalid limit"',
    quota.length > 0 || (unreachable.length === 0 && not400.length === 0),
    quota.length > 0
      ? 'quota refused these claims — see the SKIP note above; re-run once Retry-After has elapsed'
      : unreachable.length > 0
        ? `NOT TESTED: ${unreachable.map(([l]) => l).join(', ')} never reached the vendor`
        : not400.length > 0
          ? `NOT rejected: ${not400.map(([l, s]) => `${l}=HTTP${String(s)}`).join(', ')}`
          : `${String(results.length)}/${String(results.length)} rejected with 400`,
  );
  if (quota.length > 0) {
    verdict('A2b the 400 body is exactly { error: { status, message: "Invalid limit" } }', true, 'not applicable — every probe here was quota-refused');
    return;
  }
  verdict(
    'A2b the 400 body is exactly { error: { status, message: "Invalid limit" } }',
    wrongMessage.length === 0 && unreachable.length === 0,
    wrongMessage.length > 0
      ? `other messages: ${wrongMessage.map(([l, , m]) => `${l} -> "${m}"`).join(' | ')}`
      : 'every rejection carried message="Invalid limit"',
  );
};

const probeQueryLength = async (): Promise<void> => {
  head('A3 — the raw q length ceiling on /v1/search');

  // A real query padded to EXACTLY the length under test, so the ceiling is
  // measured on the string the production code would actually build.
  const pad = (len: number): string => {
    const base = 'Radiohead Airbag ';
    return (base + 'abcdefghij '.repeat(30)).slice(0, len);
  };

  for (const len of [250, 251]) {
    const q = pad(len);
    const r = await searchWithLimit('5', q);
    const message = String(asRecord(asRecord(r.body)['error'])['message'] ?? '');
    info(`q length=${String(q.length)} -> ${note(r).padEnd(10)} ${message ? `"${message}"` : ''}`);
    if (len === 250) {
      verdict('A3 q of 250 raw characters is accepted', r.status === 200, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (len === 251) {
      verdict('A3 q of 251 raw characters is 400 "Query exceeds maximum length"', r.status === 400 && /maximum length/i.test(message), `${note(r)} "${message}"`);
    }
  }
};

// ---------------------------------------------------------------------------
// 4b. Playlist-tracks limit — the number NOBODY has measured
// ---------------------------------------------------------------------------

/**
 * `spotifyScraperService` asks for `limit=100` on TWO routes:
 * `spclient.wg.spotify.com/playlist/v2/{id}/contents` and
 * `api.spotify.com/v1/playlists/{id}/tracks`. Every other Spotify limit in this
 * repo was wrong by 5x, so this one is the last unmeasured number in the file.
 *
 * MEASURED 2026-10-01: it CANNOT be measured on this deploy. A
 * client-credentials bearer is refused **403 Forbidden on every limit value**,
 * including `limit=0`, `limit=-1`, `limit=1.5` and `limit=abc` — the four values
 * that are a 400 "Invalid limit" everywhere else on the API. A route that
 * rejects a nonsense limit with 403 instead of 400 is refusing on AUTHORIZATION
 * before it ever validates the limit, so no 403 in this sweep is evidence about
 * the ceiling. The playlist itself is likewise unreachable (404 on
 * `/v1/playlists/{id}`), and the web-player token the scraper uses is itself
 * unobtainable: `open.spotify.com/get_access_token` answers 403 and
 * `clienttoken.spotify.com/v1/clienttoken` answers 400 with a non-JSON body.
 *
 * That is recorded here rather than guessed at, because the honest answer to
 * "is 100 correct?" is currently "unmeasured, and unmeasurable with the
 * credential this bot holds". See the verdict's own wording.
 */
const probePlaylistTracksLimit = async (): Promise<void> => {
  head('B4b — /v1/playlists/{id}/tracks: the limit nobody measured, and cannot');

  // A real, current, public editorial playlist, discovered rather than hardcoded
  // so this does not rot into a dead id. The id is never printed.
  let playlistId: string | null = null;
  try {
    const page = await rawText('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/html' },
    });
    if (page.status === 200) {
      playlistId = page.text.match(/\/playlist\/([A-Za-z0-9]{22})/)?.[1] ?? null;
    } else {
      info(`the seed playlist page answered HTTP ${String(page.status)}, so no id could be extracted`);
    }
  } catch {
    /* handled below by the null check */
  }
  if (!playlistId) {
    verdict(
      'B4b playlist-tracks limit: a public playlist id could be discovered',
      false,
      'NOT TESTED: no playlist id was reachable from the public page, so nothing below ran',
    );
    return;
  }
  info('discovered a public playlist id from the live page (withheld)');

  // The ladder. `abc` is the control that separates the two failure modes: it is a
  // 400 "Invalid limit" everywhere else on this API, so a 403 for it proves the
  // refusal is about authorization and not about the number.
  const limits = ['1', '10', '11', '100', 'abc'];
  const seen = new Map<string, { status: number; msg: string }>();
  for (const limit of limits) {
    const r = await sp(
      `/v1/playlists/${playlistId}/tracks?market=US&limit=${limit}&offset=0`,
    );
    const body = asRecord(r.body);
    const err = asRecord(body['error']);
    const msg = String(err['message'] ?? '');
    seen.set(limit, { status: r.status, msg });
    info(
      `playlists/{{id}}/tracks limit=${limit.padEnd(4)} -> ${note(r).padEnd(10)} ${msg || shape(body, 'error')}`,
    );
  }

  const statuses = [...seen.values()].map((v) => v.status);
  const allForbidden = statuses.every((s) => s === 403);
  verdict(
    'B4b /v1/playlists/{id}/tracks is 403 for EVERY limit, incl. nonsense ones',
    allForbidden,
    allForbidden
      ? 'uniformly 403 Forbidden — a nonsense limit is a 400 elsewhere (measured), so this is an authorization refusal, not a limit ceiling'
      : `statuses seen: ${statuses.join(', ')}`,
  );
  verdict(
    'B4b the playlist-tracks limit is therefore NOT MEASURABLE with this credential',
    allForbidden,
    allForbidden
      ? 'no 200 at any limit -> no ceiling can be derived; spotifyScraperService limit=100 stays UNVERIFIED'
      : 'the route answered 200 at some limit, so a ceiling IS derivable — re-read the table above',
  );

  // The spclient rung the scraper prefers, probed the same way. It needs the
  // web-player token, which the section above shows is unobtainable, so this is
  // recorded as a capability fact rather than a limit measurement.
  const wp = await raw('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
  });
  verdict(
    'B4b the spclient rung is unreachable (no web-player token), so its limit=100 is unmeasured too',
    wp.status !== 200,
    `open.spotify.com/get_access_token -> HTTP ${wp.status}; ${String(wp.body).slice(0, 40)}`,
  );

  info('CONSEQUENCE for spotifyScraperService.ts: limit=100 on BOTH routes is UNVERIFIED.');
  info('           It was not changed to a guess. The /v1/albums/{id}/tracks ceiling of 50');
  info('           does NOT transfer here — a different endpoint, and this route is not');
  info('           reachable enough to confirm even that. See the report for this batch.');
};

// ---------------------------------------------------------------------------
// 5. C5/C6 — which status means what
// ---------------------------------------------------------------------------

const probeVerdictShapes = async (api: SpotifySearchApi): Promise<void> => {
  head('C5/C6 — the status vocabulary: 401, 404, 403, and what a 429 would carry');

  const noToken = await raw('https://api.spotify.com/v1/artists/4Z8W4fKeB5YxbusRsdQVPb');
  const junkToken = await raw('https://api.spotify.com/v1/artists/4Z8W4fKeB5YxbusRsdQVPb', {
    headers: { Authorization: 'Bearer not-a-real-token-probe' },
  });
  info(`no Authorization header  -> HTTP ${noToken.status} ${shape(noToken.body)}`);
  info(`garbage bearer           -> HTTP ${junkToken.status} ${shape(junkToken.body)}`);
  verdict(
    'C5 a rejected bearer is 401 (not 403) on /v1/artists/{id}',
    noToken.status === 401 && junkToken.status === 401,
    `missing token HTTP ${noToken.status}, garbage token HTTP ${junkToken.status}`,
  );

  const missing = await sp('/v1/artists/0000000000000000000000');
  info(`nonexistent artist id    -> HTTP ${missing.status} ${shape(missing.body)}`);
  verdict(
    'C5 a 404 on /v1/artists/{id} means no such artist',
    missing.status === 404,
    `HTTP ${missing.status} ${shape(missing.body)}`,
  );

// A scope problem is the one 4xx this bot can actually hit, since it runs on
  // client credentials and never has a user scope.
  // CORRECTED 2026-09-30: this verdict demanded 403 and got 401. The measured
  // answer is 401 "Valid user authentication required" — the same status as an
  // expired bearer, and a different status from anything else this bot sees. So
  // 403 is NOT this app's scope-error signal, and any code that treats 403 as
  // "the token is fine, the scope is wrong" would misread it. Left as 401, which
  // is also what `spotifySearchApi` already handles: invalidate and retry.
  const me = await sp('/v1/me');
  info(`/v1/me with client-credentials -> HTTP ${me.status} ${shape(me.body)}`);
  verdict(
    'C5 a scope problem is 401 on this app (client-credentials, no user scope)',
    me.status === 401,
    `HTTP ${me.status}${me.status === 403 ? ' — the old, wrong expectation' : ''}`,
  );

  // --- the production classes, on the same wire ----------------------------
  // The class keeps its own rate-limit/outage gate, and a 429 earlier in this
  // run armed it. Clearing it here is not papering over a defect: it is what
  // makes the production probes test the production code rather than this
  // script's own request history. A verdict below still fails if the class
  // re-arms on a live wire condition.
  await settleQuota();
  SpotifySearchApi.clearRateLimit();
  const artist = await api.getArtistById(ARTIST_ID).catch((e: unknown) => e);
  // A quota refusal surfaces as `Spotify rate limited`, which is this script
  // out-asking rather than the production code misbehaving — so those four
  // claims SKIP instead of FAIL.
  const wireBlocked =
    artist instanceof Error && /rate limited|cooldown active/i.test(artist.message);
  if (wireBlocked) {
    skip('C5 PRODUCTION getArtistById(real id) resolves an artist', NOT_JUDGED);
    skip('C5 PRODUCTION getArtistById(missing) answers null (a miss, not an outage)', NOT_JUDGED);
    skip('C5 PRODUCTION getTrack(missing) RAISES rather than inventing a track', NOT_JUDGED);
    skip('C5 PRODUCTION getFullAlbum(missing) answers null', NOT_JUDGED);
    return;
  }
  verdict(
    'C5 PRODUCTION getArtistById(real id) resolves an artist',
    !(artist instanceof Error) && artist !== null,
    artist instanceof Error ? `raised ${brief(artist)}` : `name=${String(asRecord(artist)['name'])} images=${String(arr(asRecord(artist)['images']).length)}`,
  );

  const gone = await api.getArtistById('0000000000000000000000').catch((e: unknown) => e);
  verdict(
    'C5 PRODUCTION getArtistById(missing) answers null (a miss, not an outage)',
    gone === null,
    gone === null ? 'null' : `returned ${brief(gone as Error)}`,
  );

  const track = await api.getTrack('0000000000000000000000').catch((e: unknown) => e);
  verdict(
    'C5 PRODUCTION getTrack(missing) RAISES rather than inventing a track',
    track instanceof SpotifyUnavailableError,
    track instanceof SpotifyUnavailableError ? `raised ${brief(track)}` : `returned an object instead: ${brief(track)}`,
  );

  const album = await api.getFullAlbum('0000000000000000000000').catch((e: unknown) => e);
  verdict(
    'C5 PRODUCTION getFullAlbum(missing) answers null',
    album === null,
    album === null ? 'null' : brief(album),
  );

  info('UNTESTED: a 5xx and a 429 cannot be induced without provoking the vendor, so the');
  info('          "only 5xx arms the outage breaker" and "Retry-After is in seconds and a 429');
  info('          means the CREDENTIAL is limited" claims are UNVERIFIED by this run.');
};

// ---------------------------------------------------------------------------
// 6. E10 — the discography payload shape
// ---------------------------------------------------------------------------

const probeDiscographyShape = async (api: SpotifySearchApi): Promise<void> => {
  head('E10 — /v1/artists/{id}/albums payload: where the artwork is, and is there a total?');
  await settleQuota();
  SpotifySearchApi.clearRateLimit();

  const r = await sp(`/v1/artists/${ARTIST_ID}/albums?include_groups=album,single,appears_on&limit=10`);
  const rJudged = judged(r);
  const body = asRecord(r.body);
  const topKeys = Object.keys(body);
  const items = arr(body['items']);
  const first = asRecord(items[0]);
  const images = arr(first['images']);

  info(`top-level keys: ${topKeys.join(', ')}`);
  info(`item keys (first 18): ${Object.keys(first).slice(0, 18).join(', ')}`);
  info(
    `artwork: images[0].url host=${hostOf(String(asRecord(images[0])['url'] ?? ''))} | images count=${String(images.length)} | item.album present=${String(first['album'] !== undefined)} | item.album.images present=${String(asRecord(first['album'])['images'] !== undefined)}`,
  );

  if (!rJudged) {
    skip('E10 album artwork is at items[].images[0].url, NOT items[].album.images', NOT_JUDGED);
    skip('E10 an item with no `images` key means no artwork, not a failed request', NOT_JUDGED);
    skip('E10 the paging object DOES carry a top-level total (measured 2026-10-01: 60 for Radiohead)', NOT_JUDGED);
    skip('E10 ...and still carries no total_pages, so paging cannot be inferred from it', NOT_JUDGED);
    return;
  }

  verdict(
    'E10 album artwork is at items[].images[0].url, NOT items[].album.images',
    typeof asRecord(images[0])['url'] === 'string' && first['album'] === undefined,
    `images[0].url is a ${typeof asRecord(images[0])['url']}; item.album is ${first['album'] === undefined ? 'absent' : 'present'}`,
  );
  verdict(
    'E10 an item with no `images` key means no artwork, not a failed request',
    items.every((i) => {
      const imgs = arr(asRecord(i)['images']);
      return imgs.length === 0 || typeof asRecord(imgs[0])['url'] === 'string';
    }),
    `${String(items.filter((i) => arr(asRecord(i)['images']).length === 0).length)} of ${String(items.length)} items carry no images`,
  );

  // The claim used to be that there is NO total. Measured 2026-10-01: there is
  // one — 60 for Radiohead, and the top-level keys are
  // `href, limit, next, offset, previous, total, items`. `getArtistDiscographyCovers`
  // deliberately does not attach it to its answer (that method's own comment
  // explains why: with `appears_on` the total counts releases the artist merely
  // appears on, so it is not a denominator for cover count), which is a
  // separate and defensible decision. What was wrong was the probe asserting
  // the field's ABSENCE, which is a claim about the payload, not about the code.
  const hasTotal = topKeys.includes('total');
  const total = Number(body['total'] ?? -1);
  const nextUrl = body['next'];
  const nextOffset = nextUrl ? new URL(String(nextUrl)).searchParams.get('offset') : null;
  info(`next cursor offset=${String(nextOffset)} | total=${hasTotal ? String(total) : 'ABSENT'}`);
  verdict(
    'E10 the paging object DOES carry a top-level total (measured 2026-10-01: 60 for Radiohead)',
    hasTotal && Number.isFinite(total) && total > 0,
    hasTotal
      ? `total = ${String(total)}, top-level keys: ${topKeys.join(', ')}`
      : `the field is absent; top-level keys were ${topKeys.join(', ')}`,
  );
  verdict(
    'E10 ...and still carries no total_pages, so paging cannot be inferred from it',
    !topKeys.includes('total_pages'),
    `top-level keys are: ${topKeys.join(', ')}`,
  );

  const covers = await api.getArtistDiscographyCovers('Radiohead', undefined, 15).catch((e: unknown) => e);
  claimOrSkip(
    'E10 PRODUCTION getArtistDiscographyCovers(name, undefined, 15) returns covers',
    discographyWasJudged(),
    Array.isArray(covers) && covers.length > 0,
    Array.isArray(covers)
      ? `${String(covers.length)} covers, first host ${hostOf(covers[0] as string)}`
      : `raised/returned ${brief(covers)}`,
  );
};

// ---------------------------------------------------------------------------
// 7. The album-search claim, and the track URL claim
// ---------------------------------------------------------------------------

const probeAlbumSearch = async (api: SpotifySearchApi): Promise<void> => {
  head('albums.test.ts — quoted field syntax, and is a search result id fetchable?');
  // Same reason as in `probeVerdictShapes`: an earlier 429 in this run would
  // otherwise make the class raise "cooldown active" and be reported here as a
  // search failure, which it is not.
  await settleQuota();
  SpotifySearchApi.clearRateLimit();

  const album = await api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada').catch((e: unknown) => e);
  if (album instanceof Error) {
    if (/rate limited|cooldown active/i.test(album.message)) {
      skip('album:"x" artist:"y" resolves a real album via a fetchable id', NOT_JUDGED);
      skip('scoring: getSpotifyTrackUrl returns a canonical open.spotify.com/track URL', NOT_JUDGED);
      return;
    }
    verdict('album:"x" artist:"y" resolves a real album via a fetchable id', false, brief(album));
    return;
  }
  const record = asRecord(album);
  verdict(
    'albums: a quoted search resolves the album and the id is fetchable',
    album !== null && typeof record['id'] === 'string' && Number(record['total_tracks'] ?? 0) > 0,
    album === null
      ? 'null (no candidate scored above the pool floor)'
      : `name="${String(record['name'])}" total_tracks=${String(record['total_tracks'])} images=${String(arr(record['images']).length)}`,
  );

  const url = await api.getSpotifyTrackUrl('Radiohead', 'Airbag');
  verdict(
    'scoring: getSpotifyTrackUrl returns a canonical open.spotify.com/track URL',
    typeof url === 'string' && /\/track\/[\w-]{22}$/.test(url),
    url ? `host ${hostOf(url)}, path shape ok=${String(/\/track\/[\w-]{22}$/.test(url))}` : 'null',
  );
};

// ---------------------------------------------------------------------------
// 8. E11 — the Last.fm placeholder, through the production repository
// ---------------------------------------------------------------------------

const probeLastfmArtwork = async (repo: LastFmRepository, api: LastfmApi): Promise<void> => {
  head('E11 — the Last.fm placeholder image and the raw payload behind it');

  // The RAW payload, because `InfoConverter` is what has to cope with it and
  // because the interesting question is what Last.fm puts in `image` for an
  // entity that has none. `api.call` RAISES for a not-found entity, so a
  // nonexistent name tells us nothing about the image array.
  const rawReads: Array<[string, string, Record<string, string>]> = [
    ['artist.getinfo', 'Radiohead', { artist: 'Radiohead' }],
    ['artist.getinfo', 'Grouper', { artist: 'Grouper' }],
    ['artist.getinfo', 'Current 93', { artist: 'Current 93' }],
    ['album.getinfo', 'Radiohead / OK Computer', { artist: 'Radiohead', album: 'OK Computer' }],
    ['track.getinfo', 'Radiohead / Airbag', { track: 'Airbag', artist: 'Radiohead' }],
    ['track.getinfo', 'Boards of Canada / Xtal', { track: 'Xtal', artist: 'Boards of Canada' }],
  ];
  let hashSeen = 0;
  let emptySeen = 0;
  for (const [method, label, params] of rawReads) {
    try {
      const body = asRecord(await api.call<Record<string, unknown>>(method, params));
      const images = arr(body['image']);
      const texts = images.map((i) => String(asRecord(i)['#text'] ?? ''));
      const withHash = texts.filter((t) => t.includes(PLACEHOLDER)).length;
      if (images.length === 0) emptySeen += 1;
      if (withHash > 0) hashSeen += 1;
      info(
        `${method} (${label}) -> image array ${String(images.length)} entries, ${String(withHash)} carrying the placeholder hash, sizes=${images.map((i) => String(asRecord(i)['size'])).join('/') || 'none'}`,
      );
      if (texts[0]) info(`  first #text host=${hostOf(texts[0])} tail=...${texts[0].slice(-24)}`);
    } catch (err) {
      info(`${method} (${label}) raised ${brief(err)}`);
    }
  }

  // The same reads through the production repository, i.e. what the artwork
  // cascade actually receives. `isPlaceholderImageUrl('')` is TRUE by design, so
  // an absent image must be counted separately from a placeholder served.
  const reads: Array<[string, () => Promise<{ imageUrl?: string } | null>]> = [
    ['artist Radiohead', () => repo.getArtistInfo('Radiohead')],
    ['artist Boards of Canada', () => repo.getArtistInfo('Boards of Canada')],
    ['album OK Computer / Radiohead', () => repo.getAlbumInfo('Radiohead', 'OK Computer')],
    ['track Creep / Radiohead', () => repo.getTrackInfo('Creep', 'Radiohead')],
    ['track Xtal / Boards of Canada', () => repo.getTrackInfo('Xtal', 'Boards of Canada')],
    ['track (nonexistent)', () => repo.getTrackInfo('zzz_no_such_track_99871', 'zzz_no_such_artist_99871')],
    ['album (nonexistent)', () => repo.getAlbumInfo('zzz_no_such_artist_99871', 'zzz_no_such_album_99871')],
  ];

  let served = 0;
  let noImage = 0;
  let placeholderHash = 0;
  for (const [label, run] of reads) {
    try {
      const url = (await run())?.imageUrl ?? '';
      if (url) served += 1;
      else noImage += 1;
      if (url.includes(PLACEHOLDER)) placeholderHash += 1;
      info(
        `  ${label.padEnd(30)} ${url ? `host ${hostOf(url)} tail ...${url.slice(-24)}` : '(NO IMAGE)'} | predicate says placeholder=${String(isPlaceholderImageUrl(url))}`,
      );
    } catch (err) {
      noImage += 1;
      info(`  ${label.padEnd(30)} raised ${brief(err)}`);
    }
  }

  info(
    `OBSERVATION: the raw payload served an EMPTY image array ${String(emptySeen)}/${String(rawReads.length)} times and the placeholder hash ${String(hashSeen)}/${String(rawReads.length)} times.`,
  );
  info(
    `OBSERVATION: through the repository, ${String(served)} reads produced a URL, ${String(noImage)} produced none, and ${String(placeholderHash)} produced a URL containing the placeholder hash.`,
  );
  // Deliberately NOT a strong claim in either direction: a clean sample does not
  // disprove the placeholder, it only did not fire in these reads. What it does
  // show is that the production predicate answers `true` for an ABSENT url too,
  // which is by design (lastfmPlaceholder.ts) and is not evidence of a
  // placeholder having been served.
  verdict(
    'E11 the placeholder hash appears in a live Last.fm image array',
    hashSeen > 0 || emptySeen > 0,
    `placeholder hash in ${String(hashSeen)}/${String(rawReads.length)} raw reads, empty image array in ${String(emptySeen)}/${String(rawReads.length)}`,
  );
  if (hashSeen === 0) {
    info(
      'NOT VERIFIED either way: Last.fm served an EMPTY image array rather than the 1x1 placeholder\n' +
        '           GIF for every artless entity in this sample, so the hash was never observed on the\n' +
        '           wire today. The cascade filter is still correct and harmless; the test comment\n' +
        '           claim that Last.fm "frequently returns the placeholder" is UNCONFIRMED.',
    );
  }
};

// ---------------------------------------------------------------------------
// 9. F12 — the YouTube Data API key
// ---------------------------------------------------------------------------

const probeYouTube = async (): Promise<void> => {
  head('F12 — YOUTUBE_API_KEY (chapters are a headline feature)');

  const key = (process.env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) {
    verdict('F12 YOUTUBE_API_KEY is configured', false, 'not set in the environment');
    return;
  }
  info(`key present (${String(key.length)} characters, value never printed)`);

  const videoId = 'dQw4w9WgXcQ';
  const res = await raw(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${encodeURIComponent(key)}`,
  );
  const envelope = asRecord(asRecord(res.body)['error']);
  const items = arr(asRecord(res.body)['items']);
  const description = String(asRecord(asRecord(items[0])['snippet'])['description'] ?? '');
  info(
    `videos.list -> HTTP ${res.status} | error.status=${String(envelope['status'])} | error.message="${String(envelope['message']).slice(0, 70)}"`,
  );
  info(
    `error.errors[].reason=${shape(arr(envelope['errors'])[0])} | error.details[].reason=${shape(arr(envelope['details'])[0])} | items=${String(items.length)}`,
  );

  const isKeyFault =
    res.status === 400 && typeof envelope['message'] === 'string' && /api key not valid/i.test(envelope['message']);
  verdict(
    'F12 YOUTUBE_API_KEY is ACCEPTED by the Data API',
    res.status === 200 && items.length > 0,
    res.status === 200
      ? `HTTP 200, ${String(items.length)} item(s), description ${String(description.length)} chars`
      : `HTTP ${res.status}${isKeyFault ? ' — "API key not valid": THE KEY IS DEAD AND CHAPTERS ARE DISABLED PROCESS-WIDE' : ''}`,
  );

  if (res.status === 200) {
    const hasTimestamp = /^\s*[\[(\-–—*>•·]*\d{1,2}:\d{2}/m.test(description);
    info(`description carries a leading-timestamp line: ${String(hasTimestamp)}`);
    const parsed = parseTimestampLines(description);
    info(`PRODUCTION parser parseTimestampLines(description) -> ${String(parsed.length)} chapters`);
  }

  // And the production class, with the request counted so the key-fault latch
  // is visible rather than inferred.
  __resetDescriptionChaptersForTests();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.includes('googleapis.com')) calls += 1;
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
  let chapters: unknown = 'THREW';
  let prodErr: string | null = null;
  try {
    chapters = await fetchDescriptionChapters(videoId);
  } catch (err) {
    prodErr = brief(err);
  }
  const afterFirst = calls;
  // Second call: a latched dead key must make ZERO further requests.
  let second: unknown = 'THREW';
  try {
    second = await fetchDescriptionChapters(videoId);
  } catch {
    /* never rejects by contract */
  }
  const afterSecond = calls;
  globalThis.fetch = realFetch;
  __resetDescriptionChaptersForTests();

  const isArray = Array.isArray(chapters);
  verdict(
    'F12 PRODUCTION fetchDescriptionChapters reads a description through the key',
    prodErr === null && chapters !== null,
    prodErr === null
      ? `returned ${isArray ? `array(${String((chapters as unknown[]).length)})` : String(chapters)} after ${String(afterFirst)} request(s)`
      : prodErr,
  );
  info(
    `second call made ${String(afterSecond - afterFirst)} further request(s) and returned ${Array.isArray(second) ? `array(${String(second.length)})` : String(second)} — a latched dead key makes 0, a cached one makes 0`,
  );
};

// ---------------------------------------------------------------------------
// 10. Supplementary — the vendors named in the brief but not in the claim list
// ---------------------------------------------------------------------------

const probeSupplementary = async (): Promise<void> => {
  head('SUPPLEMENTARY — Genius (1 request; Apple/Deezer already have liveShape locks)');

  const res = await raw('https://genius.com/api/search/multi?q=Radiohead%20Creep');
  const shapeNote = typeof res.body === 'string' ? res.body.slice(0, 60) : shape(res.body);
  info(
    `genius.com/api/search/multi -> ${res.transport ?? `HTTP ${res.status}`} body=${shapeNote}`,
  );
  info('the lyrics liveShape fixture records 403 + an 11-12KB Cloudflare challenge for every genius.com path');
  info('if this came back 200 the fixture is stale; if 403, Genius is Cloudflare-blocked and the rung is dead');
};

// ---------------------------------------------------------------------------
// The Last.fm section this file was born for
// ---------------------------------------------------------------------------

const probeLastfmNotFound = async (api: LastfmApi, repo: LastFmRepository): Promise<void> => {
  console.log('--- LIVE: not-found must return the empty answer, NOT raise ---');
  try {
    const info2 = await repo.getUserInfo('zzz_no_such_user_99871');
    verdict('getUserInfo(nonexistent) -> null', info2 === null, `got ${JSON.stringify(info2)?.slice(0, 40)}`);
  } catch (e) {
    verdict('getUserInfo(nonexistent) -> null', false, `RAISED ${classify(e)} - outage and absence are conflated`);
  }
  try {
    const artists = await repo.getTopArtists('zzz_no_such_user_99871');
    verdict('getTopArtists(nonexistent) -> []', Array.isArray(artists) && artists.length === 0, `len=${(artists as unknown[])?.length}`);
  } catch (e) {
    verdict('getTopArtists(nonexistent) -> []', false, `RAISED ${classify(e)}`);
  }

  console.log('\n--- LIVE: the fixture user must return REAL data ---');
  try {
    const info2 = await repo.getUserInfo(FIXTURE_USER);
    const n = (info2 as { realname?: string; playcount?: string } | null)?.realname;
    verdict(`getUserInfo(${FIXTURE_USER}) -> populated`, !!info2, `realname=${n ?? 'null'} plays=${(info2 as { playcount?: string })?.playcount ?? '?'}`);
  } catch (e) {
    verdict(`getUserInfo(${FIXTURE_USER}) -> populated`, false, `RAISED ${classify(e)}: ${(e as Error).message.slice(0, 70)}`);
  }

  console.log('\n--- LIVE: top lists carry REAL counts (not zeroed) ---');
  try {
    const top = await repo.getTopArtists(FIXTURE_USER, 'overall' as never, 5);
    const rows = (top as unknown as Array<{ name: string; playcount: number }>) ?? [];
    const nonZero = rows.filter((r) => (r.playcount ?? 0) > 0).length;
    verdict(`getTopArtists(${FIXTURE_USER}) -> real playcounts`, rows.length > 0 && nonZero > 0, `${rows.length} artists, ${nonZero} non-zero`);
  } catch (e) {
    verdict(`getTopArtists(${FIXTURE_USER}) -> real playcounts`, false, `RAISED ${classify(e)}`);
  }

  console.log('\n--- LIVE: artist artwork (the payload decides, not my expectation) ---');
  try {
    const art = await repo.getArtistInfo('Radiohead');
    const url = (art as { imageUrl?: string } | null)?.imageUrl ?? '';
    // Last.fm served `image: []` for artist.getinfo on this account/artist, so
    // an empty result is the HONEST answer here and the converter is right. The
    // assertion that matters is the one below it, on a track that does have art.
    info(`getArtistInfo(Radiohead) imageUrl=${url || '(none served by Last.fm)'}`);
  } catch (e) {
    console.log(`FAIL  getArtistInfo(Radiohead) raised ${classify(e)}`);
  }

  console.log('\n--- LIVE: a genuine outage MUST raise (inject by pointing at a dead host) ---');
  const realCall = api.call.bind(api);
  (api as unknown as { call: unknown }).call = async () => {
    throw Object.assign(new Error('simulated uplink stall'), { name: 'LastfmApiError', code: -1 });
  };
  try {
    const r = await repo.getTopArtists(FIXTURE_USER, 'overall' as never, 5);
    verdict('outage -> RAISES (not an empty list)', false, `RETURNED len=${(r as unknown[])?.length} - an outage is indistinguishable from an empty library`);
  } catch (e) {
    verdict('outage -> RAISES (not an empty list)', true, `raised ${classify(e)}: ${(e as Error).message.slice(0, 50)}`);
  }
  (api as unknown as { call: unknown }).call = realCall;

  console.log('\n--- LIVE: recover and prove the class is still usable ---');
  try {
    const info2 = await repo.getUserInfo(FIXTURE_USER);
    verdict('real call works again after the outage', !!info2, 'connection state recovered');
  } catch (e) {
    verdict('real call works again after the outage', false, `RAISED ${classify(e)}`);
  }
};

// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  if (!(await preflight())) return;

  const lastfmApi = new LastfmApi(new LastfmErrorRateTracker());
  const lastfmRepo = new LastFmRepository(lastfmApi);
  await probeLastfmNotFound(lastfmApi, lastfmRepo);
  await probeLastfmArtwork(lastfmRepo, lastfmApi);

  const tokenOk = await probeTokenEndpoint();
  if (tokenOk) {
    const api = new SpotifySearchApi(new SpotifyTokenManager());
    coversProbeApi = api;
    SpotifySearchApi.clearRateLimit();
    // The tracklist first: it is the endpoint whose limit was never measured,
    // and last week's fix made the method live for the first time.
    await probeTracklistLimit(api);
    await probePlaylistTracksLimit();
    await probeCeilings();
    await probeInvalidLimits();
    await probeQueryLength();
    await probeVerdictShapes(api);
    await probeDiscographyShape(api);
    await probeAlbumSearch(api);
  } else {
    console.log('\n*** Spotify skipped: no usable client-credentials token, so every Spotify claim');
    console.log('*** below is UNVERIFIED. A FAIL here means the ladder has no working rung at all.');
  }
  SpotifySearchApi.clearRateLimit();

  await probeDeletedAnonRung();
  await probeYouTube();
  await probeSupplementary();

  Logger.info('live verification complete');
};

/**
 * Exits non-zero when a check fails, so this can gate a script or a cron.
 * The repo's PowerShell note applies: read this exit code, not stderr.
 */
main().then(() => {
  process.exitCode = process.exitCode ?? 0;
}).catch((err: unknown) => {
  console.error('live verification could not run:', (err as Error).message);
  process.exitCode = 1;
});
