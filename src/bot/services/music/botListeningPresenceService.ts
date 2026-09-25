import { ActivityType, type Client } from 'discord.js';
import { Logger } from '@domain/logger';

/**
 * Spotify-mimic bot presence ("Listening to Spotify" with title, artist,
 * artwork and a live client-side progress bar).
 *
 * Why raw gateway instead of `client.user.setPresence`: discord.js v14's
 * `ClientPresence._parse` strips everything except `name/type/state/url`
 * (`src/structures/ClientPresence.js`), so `details`, `timestamps` and
 * `assets` never reach the wire. We send opcode 3 directly with the full
 * activity object — the same documented Update Presence payload user
 * clients send — so Discord renders the bar client-side from
 * `timestamps.start/end` with zero REST calls and zero ratelimit burn.
 *
 * Two honest caveats:
 * - The header icon stays the tvbot app icon (Discord derives it from our
 *   application_id; only the real Spotify app gets the Spotify logo).
 * - Per-track `large_image` is best-effort: external https artwork URLs are
 *   sent as-is and render on most clients; if Discord ever rejects them the
 *   card gracefully falls back to title/artist/bar. A static uploaded asset
 *   key (Dev Portal → Rich Presence → Art Assets) can be pinned via
 *   `STATIC_ASSET_KEY` for a guaranteed logo.
 */
export class BotListeningPresenceService {
  private static readonly ACTIVITY_NAME = 'Spotify';
  private static readonly DEFAULT_NAME = 'scrobbles';
  private static readonly MIN_INTERVAL_MS = 5000;
  private static readonly MAX_TEXT = 128;

  private readonly client: Client;
  private readonly staticAssetKey?: string;
  private shownGuildId: string | null = null;
  private lastSentAt = 0;

  constructor(client: Client, staticAssetKey?: string) {
    this.client = client;
    this.staticAssetKey = staticAssetKey;
  }

  public isShowingMusic(): boolean {
    return this.shownGuildId !== null;
  }

  /**
   * Shows the Spotify-style card. `positionMs` anchors the bar so it ticks
   * live client-side; callers only re-invoke on track change / pause /
   * resume / seek — never on a timer.
   */
  public showTrack(opts: {
    guildId: string;
    title: string;
    artist: string;
    artworkUrl?: string | null;
    durationMs?: number | null;
    positionMs?: number | null;
    paused?: boolean;
  }): void {
    const title = (opts.title || 'Unknown Title').slice(0, BotListeningPresenceService.MAX_TEXT);
    const artist = (opts.artist || 'Unknown Artist').slice(0, BotListeningPresenceService.MAX_TEXT - 2);
    const now = Date.now();
    if (now - this.lastSentAt < BotListeningPresenceService.MIN_INTERVAL_MS && this.shownGuildId === opts.guildId) {
      return;
    }

    const durationMs = typeof opts.durationMs === 'number' && opts.durationMs > 0 ? opts.durationMs : 0;
    const positionMs = Math.max(0, Math.min(typeof opts.positionMs === 'number' ? opts.positionMs : 0, durationMs || 0));
    const start = now - positionMs;

    const activity: Record<string, unknown> = {
      name: BotListeningPresenceService.ACTIVITY_NAME,
      type: ActivityType.Listening,
      details: title,
      state: opts.paused ? `⏸ ${artist}`.slice(0, BotListeningPresenceService.MAX_TEXT) : artist,
    };

    if (!opts.paused && durationMs > 0) {
      // Start + end => Discord renders the live progress bar (your screenshot).
      activity.timestamps = { start, end: start + durationMs };
    } else if (!opts.paused && durationMs <= 0) {
      // Livestream: count up, no bar — same as Spotify for live content.
      activity.timestamps = { start };
    }
    // Paused: no end timestamp, so the bar freezes instead of drifting.

    const art = opts.artworkUrl?.trim() || this.staticAssetKey?.trim();
    if (art) {
      activity.assets = { large_image: art, large_text: title };
    }

    this.send([activity], opts.guildId, `[Music] Presence → "${title}" by "${artist}"`);
  }

  /** Guild-scoped clear: a stale trackEnd must not wipe a newer guild's card. */
  public clearIfGuild(guildId: string): void {
    if (this.shownGuildId !== guildId) return;
    this.clear();
  }

  public clear(): void {
    if (this.shownGuildId === null && this.lastSentAt === 0) return;
    this.send(
      [{ name: BotListeningPresenceService.DEFAULT_NAME, type: ActivityType.Watching }],
      null,
      '[Music] Presence cleared (back to default)',
    );
  }

  private send(activities: Record<string, unknown>[], guildId: string | null, logMsg: string): void {
    try {
      const ws = this.client.ws as unknown as {
        broadcast?: (packet: unknown) => void;
        shards?: Map<number, { send: (packet: unknown) => void }>;
      } | null;
      if (!ws) return;
      const packet = {
        op: 3,
        d: { since: null, afk: false, status: 'online', activities },
      };
      if (typeof ws.broadcast === 'function') {
        ws.broadcast(packet);
      } else if (ws.shards) {
        for (const shard of ws.shards.values()) {
          try {
            shard.send(packet);
          } catch {
            // One dead shard must not block the rest.
          }
        }
      } else {
        return;
      }
      this.shownGuildId = guildId;
      this.lastSentAt = Date.now();
      Logger.debug(logMsg);
    } catch (err) {
      Logger.debug({ err }, '[Music] Failed to send listening presence');
    }
  }
}
