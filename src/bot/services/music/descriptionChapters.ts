import { Logger } from '@domain/logger';
import type { VideoChapterDto } from './ytResolver';

const FETCH_TIMEOUT_MS = 8_000;
const POS_TTL_MS = 7 * 24 * 3_600_000;
const EMPTY_TTL_MS = 24 * 3_600_000;
const NEG_TTL_MS = 10 * 60_000;
const CACHE_CAP = 2_000;

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
  return out.sort((a, b) => a.startMs - b.startMs);
};

/**
 * Chapter list parsed from the video's YouTube description timestamps
 * (official Data API, one ~4KB videos.list call — no bot checks, works
 * from any IP). Returns null when unusable (missing key, API error, video
 * gone) — distinct from `[]`, which means the description simply carries
 * no timestamp lines (desc edits can add them later, hence the 24h empty
 * cache). Deliberately side-effect-free.
 */
export async function fetchDescriptionChapters(id: string): Promise<VideoChapterDto[] | null> {
  if (!/^[\w-]{11}$/.test(id)) return null;
  const key = (process.env.YOUTUBE_API_KEY ?? '').trim();
  if (!key) return null;
  const now = Date.now();

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

async function probe(id: string, key: string): Promise<VideoChapterDto[] | null> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = r.ok ? ((await r.json()) as { items?: Array<{ snippet?: { description?: unknown } }> } | null) : null;
    const description = body?.items?.[0]?.snippet?.description;
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
};
