import type { Client } from 'discord.js';
import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import { MusicBuilders } from '@bot/builders/music/musicBuilders';
import { resolveDisplayedChapter } from '@bot/services/music/videoChapters';
import { BORROWED_COVER_MS } from '@bot/services/music/musicConstants';
import { chapterKeyFor, fingerprintFor } from '@bot/handlers/music/cardFingerprint';
import { asMessageChannel } from '@bot/services/music/moonlinkTypes';
import type { LyricWindow } from '@bot/services/music/syncedLyrics';
import { EDIT_LATENCY_CAP_MS, EDIT_LATENCY_FLOOR_MS } from '@bot/services/music/syncedLyrics';

import {
  discordRetryAfterMs,
  errorMessage,
  isTerminalDiscordError,
  isUnrecoverableMessageFetch,
} from '@domain/errors/discordErrors';

/** A hung edit settles nothing and would wedge the in-flight guard. */
const EDIT_TIMEOUT_MS = 10000;
/** Blend weight for the EWMA, so one throttled reply does not skew the track. */
const EDIT_LATENCY_EWMA = 0.4;
/** Bounded retries so a chapter attach isn't lost to one bad call. */
const MAX_PUBLISH_RETRIES = 3;
/** In-flight guard window: a slower edit than this is treated as stalled. */
const PUBLISH_STALL_MS = 30_000;

/**
 * The now-playing card publisher: fingerprint dirty-check, in-flight
 * coalescing, the `msg.edit` itself, 10008 recovery and bounded 429-aware
 * retries.
 *
 * Extracted from MusicHandler. The five Maps are passed in BY REFERENCE and
 * stay owned by the handler — the test suite reads `progressPublishing`,
 * `progressFingerprints`, `publishRetries` and `progressNudgeTimers` directly,
 * and `clearCardTimers`/`forgetGuild` sweep them.
 *
 * EVERY call back into the handler goes through `host`, never through this
 * object. `publishProgress` is spied at several sites in the suite and
 * `clearCardTimers` is replaced wholesale by an own property; a sibling call
 * would leave both un-intercepted and the card would silently freeze rather
 * than fail.
 */
export interface CardPublisherHost {
  readonly client: Client;
  readonly queueService: import('@bot/services/music/queueService').QueueService;
  /** Read live, never captured: tests reassign it after construction. */
  readonly colorService?: import('@bot/services/system/colorService').ColorService;
  lyricWindowFor(player: Player, positionMs: number): LyricWindow | null;
  chapterCardFor(player: Player, positionMs: number): { title: string; artworkUrl?: string | null } | null;
  updateChapterStatus(player: Player): void;
  forgetNowPlaying(player: Player): void;
  scheduleImmediateProgress(player: Player, delayMs?: number): void;
  publishProgress(player: Player): Promise<void>;
}

export class NowPlayingCardPublisher {
  /**
   * Last measured Discord edit round-trip per guild, in ms. This is how long
   * the card stays showing the PREVIOUS line after the clock crosses a
   * boundary, so the lyric clock leads by it. A fixed safety lag cannot model
   * this: the same node sees 200ms edits and 2s edits when Discord throttles,
   * and a wrong constant is either early or late every time.
   *
   * Owned by the host and passed in by reference like every other per-guild
   * map here, so `forgetGuild` sweeps it and a test can read it directly.
   */
  public constructor(
    private readonly host: CardPublisherHost,
    private readonly progressNudgeTimers: Map<string, NodeJS.Timeout>,
    private readonly progressPublishing: Map<string, number>,
    private readonly progressFingerprints: Map<string, string>,
    private readonly publishRetries: Map<string, number>,
    private readonly pendingPublish: Set<string>,
    private readonly editLatency: Map<string, number>,
  ) {}

  /**
   * How far the lyric clock must lead by, for this guild. The EWMA keeps a
   * single slow gateway response from dominating, and a low floor means the
   * very first edits of a track are not treated as instant.
   */
  public editLatencyFor(guildId: string): number {
    const last = this.editLatency.get(guildId);
    if (typeof last !== 'number' || !Number.isFinite(last)) return EDIT_LATENCY_FLOOR_MS;
    return Math.max(EDIT_LATENCY_FLOOR_MS, Math.min(last, EDIT_LATENCY_CAP_MS));
  }

  /**
   * Publishes the now-playing card when its visible fingerprint changed.
   * Purely on-demand (track start, boundary timers, seeks, nudges) — there
   * is no polling loop. The fingerprint admits an edit only on real change.
   *
   * Overlapping publishes COALESCE (they never drop): a chapter cover that
   * lands while an edit is in flight used to be discarded by the in-flight
   * guard, so the card kept the previous song's artwork until the next
   * chapter boundary — or forever on the last chapter of a set. Arriving
   * mid-edit now queues exactly one follow-up pass, which re-derives the
   * (new) state and publishes it if it is still visibly different.
   */
  public async publishProgress(player: Player): Promise<void> {
    const guildId = player.guildId;
    const guardSince = this.progressPublishing.get(guildId);
    if (guardSince !== undefined && Date.now() - guardSince < PUBLISH_STALL_MS) {
      this.pendingPublish.add(guildId);
      return;
    }
    this.progressPublishing.set(guildId, Date.now());
    try {
      if (!player.playing || !player.textChannelId) return;

      const msgId = player.get<string>('nowPlayingMessageId');
      if (!msgId) return;

      const queue = this.host.queueService.getQueueInfo(player);
      if (!queue) return;
      // Dirty check: skip the edit when nothing visible changed (same track,
      // pause state, queue size, loop, volume, karaoke window, chapter card).
      // There is no position bucket anymore — position is never displayed,
      // so movement alone must not cost an edit.
      const lyricWindow = this.host.lyricWindowFor(player, queue.position);
      const lyricKey = lyricWindow ? `${lyricWindow.current ?? ''}~${lyricWindow.next ?? ''}` : 'none';
      const chapter = this.host.chapterCardFor(player, queue.position);
      // Borrowed-cover expiry: holding the previous chapter's art avoids a
      // flash, but a chapter that never resolves must not sit on the wrong
      // song's cover. Short window, then fall through to the track's own art.
      let holdCover = player.get<string | null>('lastCoverUrl') ?? null;
      if (chapter && !chapter.artworkUrl) {
        const startedAt = player.get<number | null>('chapterStartedAt') ?? null;
        if (typeof startedAt === 'number' && Date.now() - startedAt > BORROWED_COVER_MS) {
          holdCover = null;
        }
      }
      const { card: displayChapter, shownCover } = resolveDisplayedChapter(
        chapter,
        holdCover,
        queue.current?.artworkUrl,
      );
      if (shownCover) player.set('lastCoverUrl', shownCover);
      const chapterKey = chapterKeyFor(displayChapter, shownCover);
      const fingerprint = fingerprintFor(queue, lyricKey, chapterKey);
      if (this.progressFingerprints.get(guildId) === fingerprint) return;

      const channel =
        this.host.client.channels.cache.get(player.textChannelId) ??
        // CORRECT AS IS: an unreachable channel is a skipped publish, not a
        // forgotten card — nothing below is reached, and crucially the
        // fingerprint is NOT written, so the next trigger (boundary timer,
        // seek, chapter attach) re-derives and edits once the channel is
        // back. forgetNowPlaying is reserved for a 10008/unknown MESSAGE.
        (await this.host.client.channels.fetch(player.textChannelId).catch(() => null));
      if (!channel || !channel.isTextBased()) return;
      const msgChannel = asMessageChannel(channel);
      if (!msgChannel) return;

      const msgManager = msgChannel.messages;

      let unknownMessage = false;
      const msg = (msgManager.cache.get(msgId) ??
        (await msgManager.fetch(msgId).catch((err: unknown) => {
          if (isUnrecoverableMessageFetch(err)) unknownMessage = true;
          return null;
        }))) as {
        edit: (data: unknown) => Promise<unknown>;
      } | null;

      if (!msg) {
        if (unknownMessage) this.host.forgetNowPlaying(player);
        return;
      }

      // Accent follows the DISPLAYED cover (chapter art when present),
      // not just top-level track art — long-form tracks pin track art
      // to the video thumbnail while the card image follows chapters.
      const colorService = this.host.colorService;
      const accentColor = colorService
        ? await colorService.getAccentColorAsync(player.guildId, shownCover ?? queue.current?.artworkUrl)
        : undefined;
      const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor, lyricWindow, displayChapter);

      // A hung edit settles nothing and would wedge the guard above: race
      // it so the publish always settles and the next trigger retries.
      // Successful publishes stay silent by design (no per-edit INFO spam).
      let editTimer: NodeJS.Timeout | undefined;
      const editStartedAt = Date.now();
      try {
        await Promise.race([
          msg.edit(response.toMessagePayload()),
          new Promise<never>((_, reject) => {
            editTimer = setTimeout(() => reject(new Error('Now-playing edit timed out')), EDIT_TIMEOUT_MS);
          }),
        ])
          .then(() => {
            this.progressFingerprints.set(guildId, fingerprint);
            this.publishRetries.delete(guildId);
            // Edit round-trip, MEASURED rather than guessed: the card only
            // shows the line once Discord accepts the edit, so the clock must
            // lead by this much or every line lands late by it. An EWMA over
            // the last few edits tracks a throttled or distant gateway, which
            // a fixed number never could.
            const tookMs = Date.now() - editStartedAt;
            const prior = this.editLatency.get(guildId);
            const blended =
              typeof prior === 'number' && Number.isFinite(prior)
                ? prior + EDIT_LATENCY_EWMA * (Math.min(tookMs, EDIT_LATENCY_CAP_MS) - prior)
                : Math.min(tookMs, EDIT_LATENCY_CAP_MS);
            this.editLatency.set(guildId, Math.max(0, blended));
            // Status follows successful edits only — updating it before the
            // edit permanently diverged room status from the card whenever
            // the edit failed (no tick retries it anymore).
            this.host.updateChapterStatus(player);
          })
          .catch((err: unknown) => {
            // 10008 = the card was deleted. Retrying cannot help, so forget it
            // rather than burning the retry budget on a message that is gone.
            if (isTerminalDiscordError(err)) {
              this.publishRetries.delete(guildId);
              this.host.forgetNowPlaying(player);
              return;
            }
            // The card still exists but the edit failed. Log the cause —
            // blind catches hid escalating Discord throttling here before —
            // and honor 429 retry_after instead of hammering a fixed delay.
            // The three-way ladder this replaces had the unit trap built in:
            // rawError.retry_after is SECONDS while retryAfter is MILLISECONDS.
            // Reading either as the other gives a 1000x-wrong backoff, which
            // either hammers Discord or stalls the card for minutes.
            const retryAfterMs = discordRetryAfterMs(err);
            const retryAfterSec = Math.ceil(retryAfterMs / 1000);
            Logger.warn(
              {
                guildId,
                retryAfterSec,
                message: errorMessage(err, 160),
              },
              '[Music] Card edit failed',
            );
            // Bounded retries so a chapter attach isn't lost to one bad
            // call. Boundary timers remain the steady-state retry path.
            const retries = (this.publishRetries.get(guildId) ?? 0) + 1;
            if (retries <= MAX_PUBLISH_RETRIES) {
              this.publishRetries.set(guildId, retries);
              const backoffMs = retryAfterSec > 0 ? Math.min(Math.ceil(retryAfterSec * 1000) + 1000, 60000) : 5000;
              this.host.scheduleImmediateProgress(player, backoffMs);
            } else {
              this.publishRetries.delete(guildId);
            }
          });
      } finally {
        if (editTimer) clearTimeout(editTimer);
      }
    } catch {
      // CORRECT AS IS: whatever threw above (a builder, the colour service,
      // a chapter derivation on a malformed player) skips this publish and
      // nothing else. The fingerprint is deliberately left UNWRITTEN, so
      // the next trigger retries the same state; the `finally` releases the
      // in-flight guard and the drain below still runs. Rate limiting is
      // NOT this path — a 429 is a rejected edit, handled by the inner
      // catch with Logger.warn and an honour-retry_after backoff.
    } finally {
      this.progressPublishing.delete(guildId);
    }
    // Drain the coalesced follow-up AFTER releasing the guard, so it can
    // actually run. Bounded by the fingerprint: a burst of chapter/art
    // updates collapses into at most one extra edit per settle.
    if (this.pendingPublish.delete(guildId)) {
      // CORRECT AS IS: the coalesced follow-up is fire-and-forget from a
      // void call site. publishProgress is already fully guarded and
      // resolves; the `.catch` is there so a future edit that made it
      // reject produces a log line instead of an unhandled rejection, and
      // this is the last statement of the method so there is nothing to
      // preserve.
      void this.host.publishProgress(player).catch(() => undefined);
    }
  }

  /** The card was deleted out-of-band (user or channel cleanup) — stop ticking on a dead message id. */
  public forgetNowPlaying(player: Player): void {
    player.set('nowPlayingMessageId', null);
    this.progressFingerprints.delete(player.guildId);
    this.publishRetries.delete(player.guildId);
    Logger.debug({ guildId: player.guildId }, '[Music] Now-playing card gone — cleared card state');
  }

  /**
   * Runs the card publish shortly after a state change (chapters attached,
   * chapter art resolved). Debounced per guild so bursts collapse into one
   * edit. The only deferred publish path — everything else is instant.
   */
  public scheduleImmediateProgress(player: Player, delayMs = 300): void {
    const guildId = player.guildId;
    const existing = this.progressNudgeTimers.get(guildId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.progressNudgeTimers.get(guildId) !== timer) return;
      this.progressNudgeTimers.delete(guildId);
      if (this.progressPublishing.has(guildId)) {
        this.pendingPublish.add(guildId);
        return;
      }
      void this.host.publishProgress(player).catch(() => undefined);
    }, delayMs);
    this.progressNudgeTimers.set(guildId, timer);
  }
}
