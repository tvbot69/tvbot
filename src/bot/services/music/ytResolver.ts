import { Logger } from '@domain/logger';
import { fetchDescriptionChapters } from './descriptionChapters';

let pausedUntil = 0;

// Negative cache: ids the resolver 502'd recently. A 502 means yt-dlp
// itself failed for that video, so retrying (e.g. in the fallback pass
// seconds later for the same video id) would just burn another full
// attempt. Skip for 10 minutes. Only 502s are recorded — client-side
// aborts and pauses are NOT misses (the server-side fetch may still be
// warming the cache for the next request).
const misses = new Map<string, number>();
const MISS_TTL_MS = 600_000;

export const resolverMissed = (id: string): boolean => {
  const at = misses.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > MISS_TTL_MS) {
    misses.delete(id);
    return false;
  }
  return true;
};

// Breakage alerting: rolling outcomes feed two rules — 30%+ of the last
// 10+ calls 502'ing (yt-dlp likely broken), or 3+ unreachable pauses in an
// hour (PC asleep / tunnel down). Alerts go to a private Discord webhook
// (RESOLVER_ALERT_WEBHOOK_URL, unset = silent) with a 30-min cooldown per
// rule so an ongoing incident reminds rather than spams. The ladder already
// degrades to SoundCloud, so these are notice-quickly signals, not pages.
const outcomes: Array<{ at: number; miss: boolean }> = [];
const pauseAts: number[] = [];
const ALERT_COOLDOWN_MS = 30 * 60_000;
let lastMissAlertAt = 0;
let lastPauseAlertAt = 0;

function postAlert(text: string): void {
  const url = (process.env.RESOLVER_ALERT_WEBHOOK_URL ?? '').trim();
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => Logger.debug({ err }, '[Music] Resolver alert webhook failed'));
}

function checkMissAlert(now: number): void {
  const recent = outcomes.slice(-10);
  if (recent.length < 10) return;
  const missCount = recent.filter((o) => o.miss).length;
  if (missCount / recent.length < 0.3) return;
  if (now - lastMissAlertAt < ALERT_COOLDOWN_MS) return;
  lastMissAlertAt = now;
  postAlert(
    `⚠️ tvbot resolver: ${missCount}/10 recent calls 502'd — yt-dlp may be broken (nightly update + rollback run at 04:00; check the 502 rate).`,
  );
}

function checkPauseAlert(now: number): void {
  const cutoff = now - 3_600_000;
  let drop = 0;
  while (drop < pauseAts.length && (pauseAts[drop] as number) <= cutoff) drop++;
  if (drop > 0) pauseAts.splice(0, drop);
  if (pauseAts.length < 3) return;
  if (now - lastPauseAlertAt < ALERT_COOLDOWN_MS) return;
  lastPauseAlertAt = now;
  postAlert(
    '⚠️ tvbot resolver unreachable 3+ times in the last hour (2-min pauses each) — check the PC / Funnel tunnel.',
  );
}

function recordOutcome(miss: boolean): void {
  const now = Date.now();
  outcomes.push({ at: now, miss });
  if (outcomes.length > 50) outcomes.splice(0, outcomes.length - 50);
  checkMissAlert(now);
}

export const resolverEnabled = (): boolean =>
  !!process.env.HOME_RESOLVER_URL &&
  !!process.env.HOME_RESOLVER_TOKEN &&
  Date.now() >= pausedUntil;

/**
 * Display URL for the rug's square video-thumb crop (640x640 center crop —
 * kills hqdefault's baked black bars and maxres's wide shape). Pure string
 * mapping: Discord fetches /thumb from the resolver's public Funnel URL
 * itself, so this never touches the network and art lookups stay
 * side-effect-free. null when the resolver is unconfigured/paused or the
 * URL isn't a video thumbnail.
 */
export function squareVideoThumbUrl(url: string | null | undefined): string | null {
  if (!url || !resolverEnabled()) return null;
  const id = url.match(/i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//)?.[1];
  if (!id) return null;
  return `${(process.env.HOME_RESOLVER_URL as string).replace(/\/+$/, '')}/thumb?id=${id}`;
}

export interface VideoChapterDto {
  title: string;
  startMs: number;
}

/**
 * Chapter list for lives/mixes (song titles + start times). Cascade: the
 * official Data API description parse first (fast, no bot checks), then the
 * home resolver's yt-dlp probe for videos whose description carries no
 * timestamps (auto/UGC chapters). Returns null when unusable (API down,
 * bad id) — distinct from `[]`, which means the video genuinely has no
 * chapters. Deliberately side-effect-free: a chapter miss must never trip
 * the audio resolver's pause/miss/alert machinery.
 */
export async function getVideoChapters(id: string): Promise<VideoChapterDto[] | null> {
  if (!/^[\w-]{11}$/.test(id)) return null;
  const now = Date.now();

  const pos = cascadePosCache.get(id);
  if (pos) {
    if (now - pos.at <= POS_TTL_MS) return pos.chapters;
    cascadePosCache.delete(id);
  }
  const emptyAt = cascadeEmptyCache.get(id);
  if (emptyAt !== undefined) {
    if (now - emptyAt <= EMPTY_TTL_MS) return [];
    cascadeEmptyCache.delete(id);
  }
  const negAt = cascadeNegCache.get(id);
  if (negAt !== undefined) {
    if (now - negAt <= NEG_TTL_MS) return null;
    cascadeNegCache.delete(id);
  }

  const pending = cascadeInflight.get(id);
  if (pending) return pending;

  const run = probeVideoChapters(id).finally(() => cascadeInflight.delete(id));
  cascadeInflight.set(id, run);
  return run;
}

// Cascade-level cache so the rug probe (a slower yt-dlp call) never repeats
// within the TTL windows, and "no chapters anywhere" doesn't re-probe home
// on every play. Mirrors descriptionChapters' TTLs and cap.
const POS_TTL_MS = 7 * 24 * 3_600_000;
const EMPTY_TTL_MS = 24 * 3_600_000;
const NEG_TTL_MS = 10 * 60_000;
const CASCADE_CACHE_CAP = 2_000;
interface CascadePosEntry {
  at: number;
  chapters: VideoChapterDto[];
}
const cascadePosCache = new Map<string, CascadePosEntry>();
const cascadeEmptyCache = new Map<string, number>();
const cascadeNegCache = new Map<string, number>();
const cascadeInflight = new Map<string, Promise<VideoChapterDto[] | null>>();

async function probeVideoChapters(id: string): Promise<VideoChapterDto[] | null> {
  const data = await fetchDescriptionChapters(id);
  if (data && data.length > 0) {
    cascadePosCache.set(id, { at: Date.now(), chapters: data });
    evictOldest(cascadePosCache);
    return data;
  }

  const rug = await getRugVideoChapters(id);
  if (rug && rug.length > 0) {
    cascadePosCache.set(id, { at: Date.now(), chapters: rug });
    evictOldest(cascadePosCache);
    return rug;
  }

  // [] = the API answered but carried no timestamps and the rug probe came
  // up empty — a genuinely chapter-less video. null = the API was unusable
  // (down / missing key), so retry sooner.
  if (data !== null) {
    cascadeEmptyCache.set(id, Date.now());
    evictOldest(cascadeEmptyCache);
    return [];
  }
  cascadeNegCache.set(id, Date.now());
  evictOldest(cascadeNegCache);
  return null;
}

const evictOldest = (m: Map<string, unknown>): void => {
  while (m.size > CASCADE_CACHE_CAP) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};

/**
 * Home-resolver chapter rung: the yt-dlp metadata probe (GET /chapters)
 * that catches videos whose chapters live outside the description (auto /
 * UGC chapters). Skipped when the resolver is disabled or paused.
 */
async function getRugVideoChapters(id: string): Promise<VideoChapterDto[] | null> {
  if (!resolverEnabled()) return null;
  const base = process.env.HOME_RESOLVER_URL as string;
  const token = process.env.HOME_RESOLVER_TOKEN as string;
  try {
    const r = await fetch(`${base}/chapters?${new URLSearchParams({ id }).toString()}`, {
      headers: { authorization: token },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { chapters?: unknown };
    if (!Array.isArray(body.chapters)) return null;
    const out: VideoChapterDto[] = [];
    for (const c of body.chapters) {
      const cc = c as { title?: unknown; startMs?: unknown };
      if (typeof cc.title !== 'string' || !cc.title.trim()) continue;
      if (typeof cc.startMs !== 'number' || !Number.isFinite(cc.startMs) || cc.startMs < 0) continue;
      out.push({ title: cc.title.trim(), startMs: Math.round(cc.startMs) });
    }
    out.sort((a, b) => a.startMs - b.startMs);
    return out;
  } catch {
    return null;
  }
}

/**
 * Asks the home PC's yt-dlp resolver to materialize a YouTube video id into
 * a cached audio file. Returns the node's local filesystem path, or null.
 * `meta` (Spotify title/artist when the bot has them) is forwarded so the
 * server can file the track under its real name with baked-in tags;
 * without it the server falls back to YouTube's own metadata.
 * 25s client timeout, then fall through to SoundCloud: live samples resolve
 * in 5-8s, so anything slower is pathological. The server keeps working
 * past the abort (60s kill, per-id dedupe), so an abandoned download still
 * lands in the cache for the next request. 502 = yt-dlp failed for this id
 * (recorded in the negative cache, no pause). Anything else (PC asleep,
 * tunnel down) pauses the resolver for 2 minutes.
 */
export interface ResolverMeta {
  title?: string;
  artist?: string;
  /** Known-good cover (e.g. Spotify album art) for artwork pre-cleaning. */
  artworkUrl?: string;
  /** ISRC for exact-recording-first YouTube search (LavaSrc mirroring). */
  isrc?: string;
  /** Expected audio length in ms — gross-mismatch guard for ISRC hits. */
  durationMs?: number;
}

export async function resolveViaHome(id: string, meta?: ResolverMeta): Promise<string | null> {
  if (!resolverEnabled()) return null;
  if (resolverMissed(id)) {
    Logger.debug({ id }, '[Music] Resolver negative-cache hit — skipping re-attempt');
    return null;
  }
  const params = new URLSearchParams({ id });
  // Length-capped: URLs stay sane, server re-validates anyway.
  if (meta?.title?.trim()) params.set('title', meta.title.trim().slice(0, 200));
  if (meta?.artist?.trim()) params.set('artist', meta.artist.trim().slice(0, 200));
  const base = process.env.HOME_RESOLVER_URL as string;
  const token = process.env.HOME_RESOLVER_TOKEN as string;
  const started = Date.now();
  try {
    const r = await fetch(`${base}/?${params.toString()}`, {
      headers: { authorization: token },
      signal: AbortSignal.timeout(25_000),
    });
    if (r.status === 502) {
      misses.set(id, Date.now());
      Logger.info({ id, resolveMs: Date.now() - started }, '[Music] Resolver miss (502) — cached, falling through');
      recordOutcome(true);
      return null;
    }
    if (!r.ok) throw new Error(`resolver ${r.status}`);
    const body = (await r.json()) as { path?: string; cached?: boolean };
    Logger.info(
      { id, resolveMs: Date.now() - started, cached: body.cached ?? 'unknown' },
      '[Music] Resolver hit',
    );
    recordOutcome(false);
    return body.path ?? null;
  } catch {
    const now = Date.now();
    pausedUntil = now + 120_000;
    pauseAts.push(now);
    checkPauseAlert(now);
    Logger.warn({ id, resolveMs: now - started }, '[Music] Resolver unreachable — pausing 2 min');
    return null;
  }
}
