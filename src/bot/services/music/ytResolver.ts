import { Logger } from '@domain/logger';

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

export const resolverEnabled = (): boolean =>
  !!process.env.HOME_RESOLVER_URL &&
  !!process.env.HOME_RESOLVER_TOKEN &&
  Date.now() >= pausedUntil;

/**
 * Asks the home PC's yt-dlp resolver to materialize a YouTube video id into
 * a cached audio file. Returns the node's local filesystem path, or null.
 * 25s client timeout, then fall through to SoundCloud: live samples resolve
 * in 5-8s, so anything slower is pathological. The server keeps working
 * past the abort (60s kill, per-id dedupe), so an abandoned download still
 * lands in the cache for the next request. 502 = yt-dlp failed for this id
 * (recorded in the negative cache, no pause). Anything else (PC asleep,
 * tunnel down) pauses the resolver for 2 minutes.
 */
export async function resolveViaHome(id: string): Promise<string | null> {
  if (!resolverEnabled()) return null;
  if (resolverMissed(id)) {
    Logger.debug({ id }, '[Music] Resolver negative-cache hit — skipping re-attempt');
    return null;
  }
  const base = process.env.HOME_RESOLVER_URL as string;
  const token = process.env.HOME_RESOLVER_TOKEN as string;
  const started = Date.now();
  try {
    const r = await fetch(`${base}/?id=${id}`, {
      headers: { authorization: token },
      signal: AbortSignal.timeout(25_000),
    });
    if (r.status === 502) {
      misses.set(id, Date.now());
      Logger.info({ id, resolveMs: Date.now() - started }, '[Music] Resolver miss (502) — cached, falling through');
      return null;
    }
    if (!r.ok) throw new Error(`resolver ${r.status}`);
    const body = (await r.json()) as { path?: string; cached?: boolean };
    Logger.info(
      { id, resolveMs: Date.now() - started, cached: body.cached ?? 'unknown' },
      '[Music] Resolver hit',
    );
    return body.path ?? null;
  } catch {
    pausedUntil = Date.now() + 120_000;
    Logger.warn({ id, resolveMs: Date.now() - started }, '[Music] Resolver unreachable — pausing 2 min');
    return null;
  }
}
