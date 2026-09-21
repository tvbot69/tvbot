let pausedUntil = 0;

export const resolverEnabled = (): boolean =>
  !!process.env.HOME_RESOLVER_URL &&
  !!process.env.HOME_RESOLVER_TOKEN &&
  Date.now() >= pausedUntil;

/**
 * Asks the home PC's yt-dlp resolver to materialize a YouTube video id into
 * a cached audio file. Returns the node's local filesystem path, or null.
 * 502 = yt-dlp failed for this id (not an outage, no pause). Anything else
 * (PC asleep, tunnel down) pauses the resolver for 2 minutes.
 */
export async function resolveViaHome(id: string): Promise<string | null> {
  if (!resolverEnabled()) return null;
  const base = process.env.HOME_RESOLVER_URL as string;
  const token = process.env.HOME_RESOLVER_TOKEN as string;
  try {
    // Server kills downloads at 60s: this must cover a full cold-cache
    // fetch, otherwise every uncached first-play aborts here and only
    // succeeds on the fallback pass once the server-side fetch warmed
    // the cache. Unreachable resolver still fails fast (refused/timeout
    // at connect) and pauses below.
    const r = await fetch(`${base}/?id=${id}`, {
      headers: { authorization: token },
      signal: AbortSignal.timeout(65_000),
    });
    if (r.status === 502) return null;
    if (!r.ok) throw new Error(`resolver ${r.status}`);
    const body = (await r.json()) as { path?: string };
    return body.path ?? null;
  } catch {
    pausedUntil = Date.now() + 120_000;
    return null;
  }
}
