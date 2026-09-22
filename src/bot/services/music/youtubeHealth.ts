import { resolverEnabled } from './ytResolver';

export type Rung = 'plugin' | 'resolver' | 'soundcloud';

export const HOME_NODE = 'Home';

/**
 * Trial rung: when HOME_LADDER_MODE=plugin-first-test, Home tries the
 * YouTube plugin first (yt-cipher + pot fixes under test), falling through
 * to resolver → soundcloud via the unchanged breakers. Any other value (or
 * unset) keeps the proven resolver-first order. Revert = unset the var.
 * Public nodes are never affected.
 */
export const pluginTestMode = (): boolean =>
  process.env.HOME_LADDER_MODE === 'plugin-first-test';

// Matches source-outage failures (login walls, bot checks, cipher death).
// Anything else (user errors, network blips) must NOT trip the breaker.
const OUTAGE_RE =
  /requires login|sign in to confirm|not a bot|all clients failed|no supported audio|sig function|page needs to be reloaded|player configuration error/i;

const errText = (e: unknown): string => {
  if (typeof e === 'string') return e;
  const parts: string[] = [];
  const rec = e as Record<string, unknown> | null;
  if (rec) {
    for (const key of ['message', 'cause', 'causeStackTrace']) {
      const v = rec[key];
      if (typeof v === 'string' && v) parts.push(v);
    }
  }
  try {
    const json = JSON.stringify(e);
    if (json && json !== '{}') parts.push(json);
  } catch {
    // ignore unserializable exceptions
  }
  return parts.join(' ');
};

/**
 * Per-node YouTube health: after N distinct songs die with outage-type
 * errors inside a short window, YouTube is declared down for a while.
 * While down, new plays go SoundCloud-first (resolver rung only on Home)
 * and failure handlers skip the pointless alternate-YouTube-upload search.
 * One probe per minute is let through to detect recovery; any 15s-surviving
 * playback clears the state immediately.
 */
export class YoutubeHealth {
  private downUntil = 0;
  private probeUntil = 0;
  private recent: Array<{ song: string; at: number }> = [];

  constructor(
    private readonly o = { distinctSongs: 3, windowMs: 120_000, downMs: 600_000 },
  ) {}

  public static isOutage(e: unknown): boolean {
    return OUTAGE_RE.test(errText(e));
  }

  /** Rungs to try for a NEW play request, in order. Resolver goes first:
   * the plugin's audio step is wall-clock dead (login/cipher walls on every
   * video), so leading with it only buys a doomed attempt plus dead air.
   * The shared ytsearch still runs to get the video id; the resolver rung
   * materializes that id via yt-dlp. `plugin: false` drops the plugin rung
   * (used on Home via HOME_PLUGIN_RUNG) while keeping the probe slot shape.
   * `pluginFirst: true` (Home trial rung behind
   * HOME_LADDER_MODE=plugin-first-test) leads with the plugin instead; the
   * outage filter in musicHandler.ts still skips it on outage errors so a
   * plugin failure falls through to resolver in the same call.
   */
  public ladder(
    opts: { resolver: boolean; plugin?: boolean; pluginFirst?: boolean },
    now: number = Date.now(),
  ): Rung[] {
    const wantPlugin = opts.plugin ?? true;
    const head: Rung[] = [];
    if (opts.pluginFirst && wantPlugin) head.push('plugin');
    if (opts.resolver) head.push('resolver');
    if (wantPlugin && !opts.pluginFirst) head.push('plugin');
    const full: Rung[] = [...head, 'soundcloud'];
    const rest: Rung[] = opts.resolver ? ['resolver', 'soundcloud'] : ['soundcloud'];
    if (!this.downUntil) return full;
    if (now < this.downUntil || now < this.probeUntil) return rest;
    this.probeUntil = now + 60_000;
    return full;
  }

  public recordFailure(song: string, e: unknown, now: number = Date.now()): void {
    if (!YoutubeHealth.isOutage(e)) return;
    if (this.downUntil) {
      if (now >= this.downUntil) {
        this.downUntil = now + this.o.downMs;
        this.probeUntil = 0;
      }
      return;
    }
    this.recent = this.recent.filter((f) => now - f.at < this.o.windowMs);
    this.recent.push({ song, at: now });
    if (new Set(this.recent.map((f) => f.song)).size >= this.o.distinctSongs) {
      this.downUntil = now + this.o.downMs;
      this.recent = [];
    }
  }

  public recordSuccess(): void {
    this.downUntil = 0;
    this.probeUntil = 0;
    this.recent = [];
  }

  public isDown(now: number = Date.now()): boolean {
    return this.downUntil > now;
  }
}

const byNode = new Map<string, YoutubeHealth>();

export const healthFor = (nodeId: string): YoutubeHealth => {
  const existing = byNode.get(nodeId);
  if (existing) return existing;
  const created = new YoutubeHealth();
  byNode.set(nodeId, created);
  return created;
};

export const ladderFor = (player: { node?: { identifier?: string } | null }): Rung[] => {
  const id = player.node?.identifier ?? 'unknown';
  const home = id === HOME_NODE;
  // Plugin rung on Home is gated behind HOME_PLUGIN_RUNG=on (default off):
  // it has never produced audio, and each attempt costs ~2s dead air plus a
  // failure event feeding the breakers. Flip it manually after a
  // youtube-source release that actually fixes cipher/login, scratch-node
  // verified first. The plugin stays installed regardless — ytsearch is what
  // the resolver rung resolves. Public nodes always keep their plugin rung.
  // Trial rung: HOME_LADDER_MODE=plugin-first-test forces the plugin rung on
  // AND first (plugin → resolver → soundcloud) so cipher/pot fixes can be
  // measured live; the outage + per-song breakers still cap the cost of a
  // miss to one failed try before falling through. Unset to revert.
  const trial = home && pluginTestMode();
  const plugin = trial || (!home || (process.env.HOME_PLUGIN_RUNG ?? 'off') === 'on');
  return healthFor(id).ladder({
    resolver: resolverEnabled() && home,
    plugin,
    pluginFirst: trial,
  });
};
