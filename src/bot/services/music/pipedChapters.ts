import { Logger } from '@domain/logger';
import type { VideoChapterDto } from './ytResolver';

const DEFAULT_INSTANCES = [
  'https://pipedapi.ducks.party',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.kavin.rocks',
];

const FETCH_TIMEOUT_MS = 8_000;
const INSTANCE_COOLDOWN_MS = 5 * 60_000;
const POS_TTL_MS = 7 * 24 * 3_600_000;
const EMPTY_TTL_MS = 24 * 3_600_000;
const NEG_TTL_MS = 10 * 60_000;
const CACHE_CAP = 2_000;

// Shard-local in-memory state (no Redis): chapters are decoration on the
// now-playing card, so a repeat probe per shard is cheap next to the 8s
// instance timeout — same trade-off as ytResolver's misses map.
interface PosEntry {
  at: number;
  chapters: VideoChapterDto[];
}
const posCache = new Map<string, PosEntry>();
const negCache = new Map<string, number>();
const inflight = new Map<string, Promise<VideoChapterDto[] | null>>();
const cooldowns = new Map<string, number>();
let preferredIdx = 0;

const instances = (): string[] => {
  const raw = (process.env.PIPED_INSTANCES ?? '').trim();
  if (raw) {
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_INSTANCES;
};

const evictOldest = (m: Map<string, unknown>): void => {
  while (m.size > CACHE_CAP) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};

// Last instance that served a success is tried first on the next call.
const orderedInstances = (): string[] => {
  const list = instances();
  if (preferredIdx > 0 && preferredIdx < list.length) {
    return [list[preferredIdx] as string, ...list.slice(0, preferredIdx), ...list.slice(preferredIdx + 1)];
  }
  return list;
};

interface ChapterBody {
  chapters?: unknown;
  error?: unknown;
}

/**
 * Chapter list from the Piped API (GET /streams/{id} → chapters[] with
 * whole-second `start`). Rotates instances, cools each down 5 minutes on
 * any failure, and caches per id: non-empty 7 days, empty 24h, total
 * failure 10 minutes. Returns null only when every instance failed —
 * `[]` is a valid answer (video has no chapters). No side effects.
 */
export async function fetchPipedChapters(id: string): Promise<VideoChapterDto[] | null> {
  if (!/^[\w-]{11}$/.test(id)) return null;
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

  const run = probe(id).finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

async function probe(id: string): Promise<VideoChapterDto[] | null> {
  for (const base of orderedInstances()) {
    const until = cooldowns.get(base);
    if (until !== undefined && Date.now() < until) continue;
    try {
      const r = await fetch(`${base}/streams/${id}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const body = r.ok ? ((await r.json()) as ChapterBody | null) : null;
      // Piped errors look like {"error":"...","message":"..."} — bot-check
      // (LOGIN_REQUIRED) per video is common, so rotate rather than give up.
      if (!body || body.error !== undefined || !Array.isArray(body.chapters)) {
        cooldowns.set(base, Date.now() + INSTANCE_COOLDOWN_MS);
        continue;
      }
      const chapters: VideoChapterDto[] = [];
      for (const c of body.chapters) {
        const cc = c as { title?: unknown; start?: unknown };
        if (typeof cc.title !== 'string' || !cc.title.trim()) continue;
        if (typeof cc.start !== 'number' || !Number.isFinite(cc.start) || cc.start < 0) continue;
        chapters.push({ title: cc.title.trim(), startMs: Math.round(cc.start * 1000) });
      }
      chapters.sort((a, b) => a.startMs - b.startMs);
      posCache.set(id, { at: Date.now(), chapters });
      evictOldest(posCache);
      preferredIdx = instances().indexOf(base);
      return chapters;
    } catch (err) {
      cooldowns.set(base, Date.now() + INSTANCE_COOLDOWN_MS);
      Logger.debug({ err, instance: base }, '[Music] Piped chapters instance failed');
    }
  }
  negCache.set(id, Date.now());
  evictOldest(negCache);
  Logger.debug({ id }, '[Music] Piped chapters unavailable on all instances');
  return null;
}

export const __resetPipedChaptersForTests = (): void => {
  posCache.clear();
  negCache.clear();
  inflight.clear();
  cooldowns.clear();
  preferredIdx = 0;
};
