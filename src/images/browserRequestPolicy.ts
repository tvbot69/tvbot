import { safeUrl } from './html';

/**
 * Plan item 5.1: what the render browser is allowed to fetch.
 *
 * Chart HTML is built from Last.fm/Spotify/Deezer/Apple metadata, so every
 * `<img src>` and `@font-face src` in it is a URL a third party chose. That URL
 * is fetched by a Chromium started with `--no-sandbox`, running as the bot
 * process, inside the Railway container. Before this policy the browser would
 * fetch anything: `file:///app/.env`, `http://` in the clear, and above all
 * `http(s)://169.254.169.254/latest/meta-data/`, which on a cloud host is a
 * live credential-issuing endpoint.
 *
 * `--disable-web-security` is gone from the launch args for the same reason. It
 * turned off the same-origin, mixed-content and CORS checks, and nothing in the
 * render path needs it. Verified rather than argued, because a cross-origin
 * `@font-face` IS CORS-gated and this was the one plausible reason to keep the
 * flag: the only remote asset in any page is the receipt font, fm.bot answers
 * with `access-control-allow-origin: *`, and a Chromium launched without the
 * flag reports the face as `loaded`.
 *
 * Defence in depth, not a live fix. `escapeHtml` and `safeUrl` in `./html` are
 * already correct and already tested, so the untrusted input is neutralised
 * before it reaches a URL. This layer exists for the case where that earlier
 * guard is bypassed or regressed.
 */

/**
 * The only hosts a render may contact: the artwork CDNs of the cascade in
 * `artworkService` (Spotify -> Deezer -> Apple -> Last.fm), Discord's own CDN
 * for embedded avatars, and fmbot's site, which `pages/receipt.html` fetches
 * its receipt font from. Anything else is aborted.
 *
 * Entries are registrable domains matched on DOT boundaries, never with a plain
 * `endsWith` - `evilscdn.co` ends with `scdn.co` and is attacker-registrable.
 */
export const IMAGE_CDN_HOST_ALLOWLIST: readonly string[] = [
  'scdn.co', // Spotify images (i.scdn.co, p.scdn.co, ...)
  'dzcdn.net', // Deezer images
  'deezer.com', // Deezer API-served covers
  'mzstatic.com', // Apple Music artwork
  'lastfm.freetls.fastly.net', // Last.fm artwork
  'lastfm-img.freetls.fastly.net', // Last.fm's second image shard, seen in the wild
  'discordapp.com', // Discord CDN (avatars, icons)
  'discordapp.net', // Discord media CDN (attachments)
  'fm.bot', // the receipt font, fetched at render time by pages/receipt.html
];

export type BrowserRequestVerdict =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * `url(data:font/woff2;base64,...)` is the ONLY way the cards get their
 * typography: every `@font-face` in `pages/fonts.css` is an inline base64
 * woff2, and Chromium does route `data:` through request interception -
 * measured, not assumed, with a probe that rendered the real fonts.css and saw
 * both the png and the woff2 arrive as `request` events. Denying them costs no
 * error and no failed assertion, just every chart silently falling back to a
 * system face, so this branch is load-bearing.
 *
 * `safeUrl` deliberately does not cover it, because a font is not an image and
 * its content is never rendered as one.
 */
const INLINE_FONT_DATA_URL = /^data:font\/(?:woff2?|ttf|otf)[;,]/i;

const SVG_DATA_URL = /^data:image\/svg\+xml/i;

/**
 * Ranges a render must never reach, checked BEFORE the allowlist and
 * independently of it, so that adding a bare IP to the allowlist later cannot
 * quietly reopen any of them.
 *
 * 169.254.0.0/16 is the one that matters: 169.254.169.254 is the cloud
 * instance-metadata service, and on Railway a render that can read it can read
 * the deployment's credentials.
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<{ name: string; cidr: string }> = [
  { name: 'this-network', cidr: '0.0.0.0/8' },
  { name: 'rfc1918 10/8', cidr: '10.0.0.0/8' },
  { name: 'cgnat', cidr: '100.64.0.0/10' },
  { name: 'loopback', cidr: '127.0.0.0/8' },
  { name: 'link-local (cloud metadata)', cidr: '169.254.0.0/16' },
  { name: 'rfc1918 172.16/12', cidr: '172.16.0.0/12' },
  { name: 'rfc1918 192.168/16', cidr: '192.168.0.0/16' },
];

/**
 * Expand an IPv6 literal to its eight hextets, or return null if it is not one.
 * Only zero-compression is expanded, which is the only form that hides a
 * loopback behind a different spelling - `::1` and `0:0:0:0:0:0:0:1` are the
 * same address and must produce the same verdict.
 */
const expandIpv6 = (host: string): string[] | null => {
  if (!host.includes(':')) return null;
  const pieces = host.split('::');
  if (pieces.length > 2) return null;
  const head = pieces[0] === undefined ? [] : pieces[0].split(':').filter((g) => g !== '');
  const compressed = pieces.length === 2;
  const tailRaw = pieces[1] ?? '';
  const tail = tailRaw === '' ? [] : tailRaw.split(':');
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (!compressed && missing !== 0) return null;
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  return groups.length === 8 ? groups : null;
};

/** Strip the shapes `URL.hostname` adds: IPv6 brackets, the FQDN root dot, and an IPv4-mapped prefix. */
const normaliseHost = (raw: string): string => {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  return host;
};

const parseDottedQuad = (host: string): number[] | null => {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
};

const inCidr = (octets: number[], cidr: string): boolean => {
  const [base, bitsRaw] = cidr.split('/') as [string, string];
  const baseOctets = parseDottedQuad(base);
  if (!baseOctets) return false;
  const bits = Number(bitsRaw);
  let remaining = bits;
  for (let i = 0; i < 4; i++) {
    if (remaining <= 0) return true;
    const width = Math.min(8, remaining);
    const mask = (0xff << (8 - width)) & 0xff;
    if ((octets[i]! & mask) !== (baseOctets[i]! & mask)) return false;
    remaining -= width;
  }
  return true;
};

const deny = (reason: string): BrowserRequestVerdict => ({ allow: false, reason });

/**
 * True for loopback, RFC1918, link-local and CGNAT literals, in both IPv4 and
 * IPv6 spelling. A hostname is only rejected for the two loopback names; every
 * other name is the allowlist's business.
 */
export const isPrivateOrLoopbackHost = (rawHost: string): boolean => {
  const host = normaliseHost(rawHost);
  if (host === '') return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const octets = parseDottedQuad(host);
  if (octets) {
    return PRIVATE_IPV4_RANGES.some((range) => inCidr(octets, range.cidr));
  }

  const hextets = expandIpv6(host);
  if (hextets) {
    // ::1 and :: are the v6 loopback and unspecified addresses.
    if (hextets.every((h) => h === '0')) return true;
    if (hextets.slice(0, 7).every((h) => h === '0') && hextets[7] === '1') return true;
    // fc00::/7 unique-local and fe80::/10 link-local are the v6 equivalents of
    // RFC1918 and 169.254/16; on some clouds the metadata service answers on
    // fe80::a9fe:a9fe rather than 169.254.169.254.
    const first = hextets[0] as string;
    if (/^f[cd][0-9a-f]{2}$/.test(first)) return true;
    if (/^fe[89ab][0-9a-f]$/.test(first)) return true;
  }

  return false;
};

/** Exact host, or a true subdomain of one. Never a bare suffix match. */
export const isAllowlistedImageHost = (rawHost: string): boolean => {
  const host = normaliseHost(rawHost);
  return IMAGE_CDN_HOST_ALLOWLIST.some((entry) => host === entry || host.endsWith(`.${entry}`));
};

/**
 * The whole policy, as a pure function of the request URL. Kept free of
 * Puppeteer, of state and of logging so it can be tested exhaustively without
 * launching a browser - the denial that matters (169.254.169.254) must not
 * depend on Chromium being installed to have a test around it.
 */
export const decideBrowserRequest = (url: string): BrowserRequestVerdict => {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return deny('empty url');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny('unparseable url');
  }

  const protocol = parsed.protocol.toLowerCase();

  // No network consequence: the page's own base document and any object URL the
  // page made in memory. `setContent` renders on about:blank, so this is the
  // navigation itself, not a bypass.
  if (protocol === 'about:' || protocol === 'blob:') {
    return { allow: true };
  }

  if (protocol === 'data:') {
    // `safeUrl` is the single authority on data: image payloads - it already
    // rejects svg and text/html, and re-deriving that rule here is exactly the
    // drift AGENTS.md warns about. Delegating keeps the two in step.
    if (safeUrl(url)) return { allow: true };
    if (INLINE_FONT_DATA_URL.test(url)) return { allow: true };
    if (SVG_DATA_URL.test(url)) return deny('data:image/svg+xml can carry script');
    return deny('data: payload is not an allowlisted image type');
  }

  if (protocol !== 'https:') {
    // http: is mixed content and MITM-able; file: reads the container
    // filesystem; anything else is a scheme this render has no use for.
    return deny(`scheme ${protocol} is not allowed`);
  }

  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return deny(`host ${parsed.hostname} is loopback, private or link-local`);
  }

  if (!isAllowlistedImageHost(parsed.hostname)) {
    return deny(`host ${parsed.hostname} is not an allowlisted image CDN`);
  }

  return { allow: true };
};

/**
 * The subset of Puppeteer's `HTTPRequest` this policy uses. Structural on
 * purpose: the tests drive it with a plain object, and `Page` satisfies it.
 */
export interface InterceptableRequest {
  url(): string;
  continue(options?: unknown, priority?: unknown): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export type DenyLogger = (url: string, reason: string) => void;

/**
 * The subset of Puppeteer's `Page` this policy uses. Structural on purpose:
 * the tests drive it with a plain object, and `Page` satisfies it.
 */
export interface InterceptablePage {
  setRequestInterception(enable: boolean): Promise<void>;
  on(event: 'request', handler: (request: unknown) => void): void;
}

export const handleBrowserRequest = async (
  request: InterceptableRequest,
  onDeny?: DenyLogger,
): Promise<void> => {
  const url = request.url();
  const verdict = decideBrowserRequest(url);
  if (verdict.allow) {
    await request.continue();
    return;
  }
  onDeny?.(url, verdict.reason);
  // `failed` rather than `aborted`: a blocked subresource is a normal
  // outcome, and the page's own onerror handlers are what recover from it.
  await request.abort('failed');
};

/**
 * Arm interception on a page. Must be awaited BEFORE any navigation: a handler
 * registered afterwards never sees the requests that navigation triggers.
 */
export const installBrowserRequestPolicy = async (
  page: InterceptablePage,
  onDeny?: DenyLogger,
): Promise<void> => {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void handleBrowserRequest(request as InterceptableRequest, onDeny);
  });
};
