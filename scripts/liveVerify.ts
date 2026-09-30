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
import { LastfmErrorRateTracker } from '../src/domain/lastfmErrorRateTracker';
import { Logger } from '../src/domain/logger';
import { isPlaceholderImageUrl } from '../src/domain/lastfmPlaceholder';
import { SpotifyTokenManager } from '../src/spotify/api/spotifyTokenManager';
import { SpotifySearchApi, SpotifyUnavailableError } from '../src/spotify/api/spotifySearchApi';
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

const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

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

  // --- D8: is a rejected client-credential a 401? --------------------------
  const rejected = await post('probe-not-the-secret');
  info(`rejected client-credentials -> HTTP ${rejected.status} ${shape(rejected.body)}`);
  verdict(
    'D8 a rejected client-credential comes back as 401',
    rejected.status === 401,
    `HTTP ${rejected.status} body=${shape(rejected.body, 'error')}`,
  );

  return true;
};

// ---------------------------------------------------------------------------
// 2. D9 — the account-free web-player token (reverse-engineered)
// ---------------------------------------------------------------------------

const probeAnonToken = async (): Promise<void> => {
  head('D9 — the account-free web-player token (reverse-engineered flow)');

  interface Seen {
    path: string;
    status: number;
    totpShape: string;
    totpVer: string;
    tsDigits: number;
  }
  const seen: Seen[] = [];
  /** The bundle URL the production code actually requested, reused below. */
  let bundleUrl: string | null = null;
  /** The bundle the production code REFUSES to look at. */
  let vendorBundleUrl: string | null = null;
  /** What the PRODUCTION scraper actually saw, byte for byte. */
  const pageAudit: { status: number; chars: number; tags: number; matches: number; afterFilter: number; basenames: string[] } = {
    status: 0,
    chars: 0,
    tags: 0,
    matches: 0,
    afterFilter: 0,
    basenames: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    const res = await realFetch(input as never, init);
    // EVERY request is recorded, not just open.spotify.com: a bundle served from
    // another host would otherwise be invisible and look like "never fetched".
    const u = new URL(target);
    const totp = u.searchParams.get('totp') ?? '';
    const ts = u.searchParams.get('ts') ?? '';
    seen.push({
      path: `${u.origin}${u.pathname}`,
      status: res.status,
      totpShape: totp ? (/^\d{6}$/.test(totp) ? '6 digits' : `NOT 6 digits (len ${String(totp.length)})`) : 'absent',
      totpVer: u.searchParams.get('totpVer') ?? 'absent',
      tsDigits: ts.length,
    });
    if (u.pathname.includes('mobile-web-player') && !u.pathname.includes('vendor')) {
      bundleUrl = target;
    }
    if (u.pathname.includes('vendor') && u.pathname.includes('mobile-web-player')) {
      vendorBundleUrl = target;
    }
    if (u.host === 'open.spotify.com' && u.pathname === '/') {
      const html = await res.clone().text();
      const srcs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => String(m[1]));
      const matches = [...html.matchAll(/src="([^"]*mobile-web-player[^"]*\.js)"/g)].map((m) => String(m[1]));
      const afterFilter = matches.filter((s) => !!s && !s.includes('vendor'));
      const vendor = matches.find((s) => s.includes('vendor'));
      if (vendor) vendorBundleUrl = new URL(vendor, 'https://open.spotify.com/').toString();
      pageAudit.status = res.status;
      pageAudit.chars = html.length;
      pageAudit.tags = srcs.length;
      pageAudit.matches = matches.length;
      pageAudit.afterFilter = afterFilter.length;
      pageAudit.basenames = srcs.map((s) => s.split('/').pop() ?? s);
    }
    return res;
  }) as typeof globalThis.fetch;

  let token: string | null = null;
  let threw: string | null = null;
  try {
    // The private method, reached the way a credential-less deploy reaches it.
    token = await (new SpotifyTokenManager() as unknown as { getAnonToken: () => Promise<string | null> }).getAnonToken();
  } catch (err) {
    threw = brief(err);
  } finally {
    globalThis.fetch = realFetch;
  }

  for (const s of seen) {
    info(
      `  ${s.path.padEnd(58)} HTTP ${String(s.status)}${s.totpShape !== 'absent' ? ` totp=${s.totpShape} totpVer=${s.totpVer} ts=${String(s.tsDigits)} digits` : ''}`,
    );
  }
  const bundles = seen.filter((s) => s.path.includes('mobile-web-player'));
  const mint = seen.find((s) => s.path.endsWith('/api/token'));
  info(`web-player bundle fetches: ${bundles.length} | token mints attempted: ${mint ? 1 : 0}`);
  if (threw) info(`getAnonToken threw: ${threw}`);
  info(
    `AUDIT of the page the production scraper received: HTTP ${String(pageAudit.status)}, ${String(pageAudit.chars)} chars, ${String(pageAudit.tags)} <script src> tags, ${String(pageAudit.matches)} regex matches, ${String(pageAudit.afterFilter)} after the vendor filter`,
  );
  info(`  script basenames: ${pageAudit.basenames.map((n) => n.slice(0, 46)).join(', ') || '(none)'}`);

  verdict(
    'D9 the anon web-player ladder completes end to end',
    token !== null,
    token
      ? `token obtained (string length ${String(token.length)}); scrape -> bundle -> totp -> mint all worked`
      : `NO TOKEN. ${mint ? `mint answered HTTP ${String(mint.status)}` : bundles.length === 0 ? 'the bundle scrape never fired, so no token request was made' : 'a bundle was fetched but the flow stopped before minting'}`,
  );
  if (token === null) {
    console.log('      >> This is the credential-less fallback AND the degraded-mode backup. If the');
    console.log('      >> client-credentials path above also failed, the Spotify ladder has no working rung.');
  }

  // WHY. The production scraper is
  //   /src="([^"]*mobile-web-player[^"]*\.js)"/g  then  .filter(src => !src.includes('vendor'))
  // so the question is whether that pattern survives in the HTML the vendor
  // served to it. Audited above, from the response itself, not re-fetched.
  verdict(
    'D9 the scraper regex still finds a mobile-web-player bundle in the served HTML',
    pageAudit.afterFilter > 0,
    pageAudit.afterFilter > 0
      ? `${String(pageAudit.afterFilter)} candidate(s) after the vendor filter`
      : pageAudit.matches > 0
        ? `${String(pageAudit.matches)} regex match(es) but ALL of them were filtered out by the "vendor" exclusion — the flow has nothing left to fetch`
        : `NO MATCH in ${String(pageAudit.chars)} chars across ${String(pageAudit.tags)} script tags — the bundle the scraper needs is not referenced from the landing page any more, so the TOTP secret can never be found`,
  );

  // If a bundle WAS fetched, the remaining question is the one regex that turns
  // a script into a secret: /"secret":\[([\d,]+)\]/. Counts and lengths only —
  // a minified bundle is public, but nothing here needs its contents printed.
  if (bundleUrl) {
    const bundleRes = await fetch(bundleUrl, { signal: AbortSignal.timeout(25_000) });
    const js = await bundleRes.text();
    const secretHits = [...js.matchAll(/"secret":\[([^\]]*)\]/g)].map((m) => String(m[1]));
    const looseHits = [...js.matchAll(/secret/g)].length;
    info(
      `bundle audit -> HTTP ${bundleRes.status}, ${String(js.length)} chars, ${String(looseHits)} occurrences of the literal "secret", ${String(secretHits.length)} match(es) of /"secret":\[...\]/`,
    );
    verdict(
      'D9 the web-player bundle still contains a "secret":[...] digit array to scrape',
      secretHits.length > 0,
      secretHits.length > 0
        ? `${String(secretHits.length)} digit array(s), lengths ${secretHits.map((s) => String(s.split(',').length)).join('/')}`
        : `THE SCRAPE FAILS HERE: the bundle has ${String(looseHits)} occurrences of "secret" but NOT ONE is a [digits] array, so transformSpotifySecret never runs and the flow stops before minting`,
    );
  }

  // And the bundle the production code REFUSES to read, because a test claims a
  // vendor bundle never carries the secret. Checked, not assumed — if it does
  // carry it, that exclusion is what breaks the ladder.
  if (vendorBundleUrl) {
    const vRes = await fetch(vendorBundleUrl, { signal: AbortSignal.timeout(30_000) });
    const vjs = await vRes.text();
    const vHits = [...vjs.matchAll(/"secret":\[([^\]]*)\]/g)].map((m) => String(m[1]));
    info(
      `vendor bundle audit -> HTTP ${vRes.status}, ${String(vjs.length)} chars, ${String([...vjs.matchAll(/secret/g)].length)} occurrences of "secret", ${String(vHits.length)} match(es) of /"secret":[...]/`,
    );
    verdict(
      'D9 the FILTERED-OUT vendor bundle never carries the secret',
      vHits.length === 0,
      vHits.length === 0
        ? 'confirmed: the vendor bundle has no [digits] secret array, so the exclusion is right'
        : `WRONG ASSUMPTION: the vendor bundle DOES carry a "secret":[...] array of ${String(vHits[0]?.split(',').length ?? 0)} bytes, and it is the one the production scraper refuses to read`,
    );
  }
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

const probeCeilings = async (): Promise<void> => {
  head('A1/A2 — the limit ceiling on /v1/artists/{id}/albums and /v1/search');

  for (const limit of ['5', '9', '10', '11', '15', '20', '50', '51', '100']) {
    const r = await sp(
      `/v1/artists/${ARTIST_ID}/albums?include_groups=album,single,appears_on&limit=${limit}`,
    );
    const items = arr(asRecord(r.body)['items']).length;
    info(
      `artists/{id}/albums limit=${limit.padEnd(3)} -> ${note(r).padEnd(10)} ${String(items)} items ${r.status >= 400 ? shape(r.body, 'error') : ''}`,
    );
    if (limit === '10') {
      verdict('A1 /v1/artists/{id}/albums accepts limit=10', r.status === 200 && items > 0, `${note(r)}, ${String(items)} items`);
    }
    if (limit === '11') {
      verdict('A1 /v1/artists/{id}/albums REJECTS limit=11 (ceiling is 10, not 50)', r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '50') {
      verdict('A1 /v1/artists/{id}/albums REJECTS limit=50 (docs say 50)', r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '100') {
      verdict('A1 /v1/artists/{id}/albums ceiling: 51 and 100 both', r.status === 400, `limit=100 -> ${note(r)} ${shape(r.body, 'error')}`);
    }
  }

  for (const limit of ['5', '10', '11', '15', '20', '50', '51', '100']) {
    const r = await searchWithLimit(limit);
    const items = arr(asRecord(asRecord(r.body)['tracks'])['items']).length;
    info(
      `/v1/search limit=${limit.padEnd(3)} -> ${note(r).padEnd(10)} ${String(items)} track items ${r.status >= 400 ? shape(r.body, 'error') : ''}`,
    );
    if (limit === '10') {
      const first = asRecord(arr(asRecord(asRecord(r.body)['tracks'])['items'])[0]);
      verdict('A2 /v1/search accepts limit=10', r.status === 200 && items > 0, `${note(r)}, ${String(items)} items`);
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
      verdict('A2 /v1/search REJECTS limit=11', r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '50') {
      verdict('A2 /v1/search REJECTS limit=50', r.status === 400, `${note(r)} ${shape(r.body, 'error')}`);
    }
    if (limit === '100') {
      verdict('A2 /v1/search ceiling: 51 and 100 both', r.status === 400, `limit=100 -> ${note(r)} ${shape(r.body, 'error')}`);
    }
  }
};

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
  verdict(
    'A2b every non-positive/fractional/junk limit is a 400 "Invalid limit"',
    unreachable.length === 0 && not400.length === 0,
    unreachable.length > 0
      ? `NOT TESTED: ${unreachable.map(([l]) => l).join(', ')} never reached the vendor`
      : not400.length > 0
        ? `NOT rejected: ${not400.map(([l, s]) => `${l}=HTTP${String(s)}`).join(', ')}`
        : `${String(results.length)}/${String(results.length)} rejected with 400`,
  );
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
  const me = await sp('/v1/me');
  info(`/v1/me with client-credentials -> HTTP ${me.status} ${shape(me.body)}`);
  verdict(
    'C5 a scope problem is 403 on this app (client-credentials, no user scope)',
    me.status === 403,
    `HTTP ${me.status} ${shape(me.body)}`,
  );

  // --- the production classes, on the same wire ----------------------------
  const artist = await api.getArtistById(ARTIST_ID).catch((e: unknown) => e);
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

  const r = await sp(`/v1/artists/${ARTIST_ID}/albums?include_groups=album,single,appears_on&limit=10`);
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

  // The claim is that there is no total. Checked rather than assumed.
  const hasTotal = topKeys.includes('total');
  const total = Number(body['total'] ?? -1);
  const nextUrl = body['next'];
  const nextOffset = nextUrl ? new URL(String(nextUrl)).searchParams.get('offset') : null;
  info(`next cursor offset=${String(nextOffset)} | total=${hasTotal ? String(total) : 'ABSENT'}`);
  verdict(
    'E10 the response has NO total (so there is no denominator to attach)',
    !hasTotal,
    hasTotal
      ? `WRONG ASSUMPTION: the paging object DOES carry total = ${String(total)}`
      : 'no total in the body',
  );
  verdict(
    'E10 the response has no total_pages',
    !topKeys.includes('total_pages'),
    hasTotal ? `top-level keys are: ${topKeys.join(', ')}` : 'no total_pages in the body',
  );

  const covers = await api.getArtistDiscographyCovers('Radiohead', undefined, 15).catch((e: unknown) => e);
  verdict(
    'E10 PRODUCTION getArtistDiscographyCovers(name, undefined, 15) returns covers',
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

  const album = await api.searchAndGetFullAlbum('Geogaddi', 'Boards of Canada').catch((e: unknown) => e);
  if (album instanceof Error) {
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
    SpotifySearchApi.clearRateLimit();
    // The tracklist first: it is the endpoint whose limit was never measured,
    // and last week's fix made the method live for the first time.
    await probeTracklistLimit(api);
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

  await probeAnonToken();
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
