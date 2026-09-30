import { Logger } from '@domain/logger';
import { youtubeDataApiKey } from '@config/musicEnv';
import type { VideoChapterDto } from './ytResolver';

const FETCH_TIMEOUT_MS = 8_000;
const POS_TTL_MS = 7 * 24 * 3_600_000;
const EMPTY_TTL_MS = 24 * 3_600_000;
const NEG_TTL_MS = 10 * 60_000;
const CACHE_CAP = 2_000;

/**
 * How long a DEAD CREDENTIAL suppresses the probe for every video, and
 * therefore how often the WARN below can repeat.
 *
 * The three states this module used to collapse are now distinct, and only one
 * of them belongs in `negCache`:
 *
 *   1. The credential cannot work at all (unset, or rejected by Google). Not a
 *      property of any video, so a per-video 10-minute negative entry is the
 *      wrong instrument: it re-probes a dead key every 10 minutes forever, and
 *      every re-probe costs a real API call. Latched process-wide instead, and
 *      the WARN is emitted on the transition, not on every video.
 *   2. The video cannot answer (deleted, private, a 5xx, a timeout, an
 *      exhausted quota). Property of the video, so the 10-minute negative
 *      cache is right, and DEBUG is right: it recurs on a known video and the
 *      caller already degrades.
 *   3. The description answered and carried no timestamps -> `[]`.
 *
 * One hour is the trade: a fixed key is picked up within the hour, and a
 * broken one costs one WARN per hour instead of one per ten minutes per video
 * played. Chapters are decoration, so a slow recovery of a decoration is a far
 * smaller harm than a permanently disabled feature that is invisible in
 * Railway - which is what the 10-minute cycle produced.
 */
const KEY_FAULT_TTL_MS = 60 * 60_000;
let keyFault: { at: number; reason: string } | null = null;

// Description timestamps are uploader-authored and stable; YouTube allows
// description edits, hence the shorter empty TTL. Shard-local memory: the
// probe is one ~4KB API call, cheap to repeat per shard.
interface PosEntry {
  at: number;
  chapters: VideoChapterDto[];
}
const posCache = new Map<string, PosEntry>();
const negCache = new Map<string, number>();
const inflight = new Map<string, Promise<VideoChapterDto[] | null>>();

// Lines like "0:00 - Rottweiler", "1:02:03 Song", "(0:00) Intro",
// "[0:00] Intro", "- 0:00 Intro". The timestamp must open the line (after
// bullets/brackets) so prose like "doors at 17:00" never matches.
const TIMESTAMP_LINE = /^[\s>•·\-–—*(\[]*(\d{1,2}:\d{2}(?::\d{2})?)[.)\]]*\s*[-–—:|]?\s*(\S.*)?$/;

// Title-first variant ("INTRO - 00:00"), the dominant style in live/DJ set
// descriptions. Timestamp must END the line behind a dash/pipe separator, so
// prose like "doors open at 17:00" or "Premiere: 21:00" (colon) never matches.
// Greedy title keeps full names on "A - B - 1:00".
const TRAILING_TIMESTAMP_LINE = /^(\S.{0,199})\s*[-–—|]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[.)\]]*\s*$/;

/**
 * Chapters closer together than this are the same boundary listed twice (a
 * "Tracklist" plus a "Chapters" block is common in live-set descriptions).
 * Below the threshold, the LAST duplicate used to win — so a real first song
 * could be masked by a stray "Intro" at 0:00 for its whole duration.
 */
const MIN_CHAPTER_GAP_MS = 1_000;

export const parseTimestampLines = (description: string): VideoChapterDto[] => {
  const out: VideoChapterDto[] = [];
  for (const line of description.split('\n')) {
    const leading = TIMESTAMP_LINE.exec(line);
    const trailing = leading ? null : TRAILING_TIMESTAMP_LINE.exec(line);
    const m = leading ?? trailing;
    if (!m) continue;
    const raw = String(leading ? m[1] : m[2]);
    const parts = raw.split(':').map(Number);
    const seconds =
      parts.length === 3
        ? (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number)
        : (parts[0] as number) * 60 + (parts[1] as number);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const title = String((leading ? m[2] : m[1]) ?? '').trim().slice(0, 200) || `Chapter ${out.length + 1}`;
    out.push({ title, startMs: seconds * 1000 });
  }
  out.sort((a, b) => a.startMs - b.startMs);

  // Collapse same-instant duplicates. The surviving entry is the one with the
  // most song-like title: generic container titles ("Intro", "Outro", a bare
  // number) lose to a real song name, so a stray generic line can never mask
  // the actual track at that timestamp.
  const deduped: VideoChapterDto[] = [];
  for (const chapter of out) {
    const previous = deduped[deduped.length - 1];
    if (previous && chapter.startMs - previous.startMs < MIN_CHAPTER_GAP_MS) {
      if (isWeakerTitle(chapter.title) && !isWeakerTitle(previous.title)) continue;
      deduped[deduped.length - 1] = chapter;
      continue;
    }
    deduped.push(chapter);
  }
  return deduped;
};

/** A title with no letters is an index number, not a song. */
const isWeakerTitle = (title: string): boolean =>
  !/[a-z0-9]/i.test(title.replace(/[^\p{L}\p{N}]+/gu, '')) ||
  /^(?:intro|outro|interlude|intermission|credits|applause|commentary|talk|chat|announcement)(?:\s*\d+)?$/i.test(
    title.trim(),
  );

/**
 * Chapter list parsed from the video's YouTube description timestamps
 * (official Data API, one ~4KB videos.list call — no bot checks, works
 * from any IP). Returns null when unusable (API error, video gone, or the
 * API key is dead) — distinct from `[]`, which means the description
 * simply carries no timestamp lines (desc edits can add them later, hence
 * the 24h empty cache). Deliberately side-effect-free.
 *
 * NEVER REJECTS. Chapters are decoration (AGENTS.md §3.6): this promise is
 * awaited from the chapter cascade inside playback, so a rejection here
 * becomes an unhandled rejection in a track-start chain. `probe` holds the
 * only try/catch and every branch in it returns a value.
 */
export async function fetchDescriptionChapters(id: string): Promise<VideoChapterDto[] | null> {
  if (!/^[\w-]{11}$/.test(id)) return null;
  const key = youtubeDataApiKey();
  if (!key) {
    disableChapters('YOUTUBE_API_KEY is not set');
    return null;
  }
  // A credential that Google already rejected gets no second request until the
  // latch expires. Deliberately checked AFTER the key is read, so a key that
  // was fixed in the environment is used again the moment the latch lapses.
  const now = Date.now();
  if (keyFault && now - keyFault.at <= KEY_FAULT_TTL_MS) return null;

  const hit = posCache.get(id);
  if (hit) {
    const ttl = hit.chapters.length > 0 ? POS_TTL_MS : EMPTY_TTL_MS;
    if (now - hit.at <= ttl) return hit.chapters;
    posCache.delete(id);
  }

  const negAt = negCache.get(id);
  if (negAt !== undefined) {
    if (now - negAt <= NEG_TTL_MS) return null;
    negCache.delete(id);
  }

  const pending = inflight.get(id);
  if (pending) return pending;

  const run = probe(id, key).finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

/**
 * Latch the credential as dead and say so ONCE, at WARN.
 *
 * WARN, not DEBUG, because DEBUG is gated on DEBUG_LOGGING and prints nothing
 * in production — a revoked key used to be completely invisible in Railway
 * while disabling the whole chapter feature for the process lifetime. That is
 * the "lost capability" half of the logging rule (AGENTS.md §3.10); the
 * per-video failures below are the "expected but notable" half and stay DEBUG.
 */
const disableChapters = (reason: string, context?: Record<string, unknown>): void => {
  const first = keyFault === null || Date.now() - keyFault.at > KEY_FAULT_TTL_MS;
  keyFault = { at: Date.now(), reason };
  if (!first) return;
  Logger.warn(
    { reason, ...context },
    '[Music] Description chapters DISABLED: the YouTube Data API credential cannot work',
  );
};

interface DataApiErrorEnvelope {
  error?: { status?: unknown; message?: unknown; errors?: unknown; details?: unknown };
}

/**
 * The two MARKERS that identify a rejected key, not two body shapes: an
 * API_KEY-shaped `reason` in `errors`/`details`, or the `message` wording. The
 * full body below was measured directly; the shorter `status`+`message` body
 * in the test file was measured on the same endpoint and is accepted because
 * the message marker alone identifies it.
 */
const KEY_MESSAGE_RE = /api key not valid/i;
const KEY_REASON_RE = /API_KEY/;

/**
 * The credential-rejection reason, or null for every other failure.
 *
 * MEASURED (a revoked/typo'd key, `videos.list`, HTTP 400):
 *
 *   { "error": { "code": 400, "status": "INVALID_ARGUMENT",
 *                "message": "API key not valid. Please pass a valid API key.",
 *                "errors":  [ { "reason": "badRequest" } ],
 *                "details": [ { "reason": "API_KEY_INVALID" } ] } }
 *
 * so the two markers that identify it are the envelope's `status` and an
 * API_KEY-shaped `reason`; the message is accepted too because a shorter body
 * carrying only `status` + `message` was also observed on the same endpoint.
 * Nothing else was observed, so nothing else is claimed: a 403 quota response,
 * a 404, a 500 and a 400 with any other `status` all return null here and keep
 * the ordinary 10-minute negative cache. Anything unparseable returns null as
 * well, which is the safe direction — an unrecognised failure degrades to the
 * old behaviour rather than latching the feature off on a guess.
 */
const credentialRejection = (status: number, body: unknown): string | null => {
  if (status !== 400) return null;
  const envelope = (body as DataApiErrorEnvelope | null | undefined)?.error;
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.status !== 'INVALID_ARGUMENT') return null;
  const reasons: string[] = [];
  for (const list of [envelope.errors, envelope.details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = (entry as { reason?: unknown } | null | undefined)?.reason;
      if (typeof reason === 'string') reasons.push(reason);
    }
  }
  const apiKeyReason = reasons.find((r) => KEY_REASON_RE.test(r));
  if (apiKeyReason) return apiKeyReason;
  const message = typeof envelope.message === 'string' ? envelope.message : '';
  return KEY_MESSAGE_RE.test(message) ? message : null;
};

/**
 * `r.json()` on a non-OK response is a real body this module now has to read,
 * and an error body is not guaranteed to be JSON. Never throws: an unparseable
 * body is `null`, which reads as "cannot answer" and lands in the ordinary
 * negative case.
 */
const readJson = async (r: Response): Promise<unknown> => {
  try {
    return await r.json();
  } catch {
    return null;
  }
};

async function probe(id: string, key: string): Promise<VideoChapterDto[] | null> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = await readJson(r);

    if (!r.ok) {
      const rejected = credentialRejection(r.status, body);
      if (rejected) {
        // No negCache entry: the fault belongs to the credential, not this id.
        // (Unobservable either way while KEY_FAULT_TTL_MS exceeds NEG_TTL_MS and
        // the latch is checked first, but a stale per-video entry outliving a
        // fixed key is exactly the kind of thing that becomes observable the
        // day someone reorders these two checks.)
        disableChapters(rejected, { id, status: r.status });
        return null;
      }
      negCache.set(id, Date.now());
      Logger.debug({ id, status: r.status }, '[Music] Data API chapters unavailable');
      return null;
    }

    const description = (body as { items?: Array<{ snippet?: { description?: unknown } }> } | null | undefined)?.items?.[0]
      ?.snippet?.description;
    if (typeof description !== 'string') {
      negCache.set(id, Date.now());
      Logger.debug({ id, status: r.status }, '[Music] Data API chapters unavailable');
      return null;
    }
    const chapters = parseTimestampLines(description);
    posCache.set(id, { at: Date.now(), chapters });
    evictOldest(posCache);
    return chapters;
  } catch (err) {
    negCache.set(id, Date.now());
    Logger.debug({ err, id }, '[Music] Data API chapters failed');
    return null;
  }
}

const evictOldest = (m: Map<string, unknown>): void => {
  while (m.size > CACHE_CAP) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};

export const __resetDescriptionChaptersForTests = (): void => {
  posCache.clear();
  negCache.clear();
  inflight.clear();
  keyFault = null;
};
