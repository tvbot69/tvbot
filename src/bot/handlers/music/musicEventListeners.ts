import type { Client } from 'discord.js';
import type { Manager, Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { mapMoonlinkTrack } from '@domain/models/music/musicTrack';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { healthFor, YoutubeHealth } from '@bot/services/music/youtubeHealth';
import { isLiveVideo } from '@bot/services/music/videoChapters';
import type { QueueService } from '@bot/services/music/queueService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { chapterKeyFor, clientFailuresText, fingerprintFor } from './cardFingerprint';
import type { LyricWindow } from '@bot/services/music/syncedLyrics';
import type { ChapterCard } from '@bot/services/music/videoChapters';

/** Post-seek catch-up grace before normal recovery machinery resumes. */
const SEEK_GRACE_WINDOW_MS = 300000;
/** Bounded: past this many cycles a genuinely dead stream still fails loud. */
const MAX_SEEK_GRACE_STUCKS = 10;
/** Only a track that survives this counts toward node health. */
const HEALTH_SURVIVAL_MS = 15000;
/** Auto-disconnect after this much inactivity once the queue ends. */
const INACTIVITY_DISCONNECT_MS = 180000;

/**
 * The eight Moonlink event listeners, one method per event.
 *
 * Extracted from MusicHandler. This is the one place that legitimately knows
 * about every collaborator, so the win is not separation — it is that each
 * listener is now a named method you can read, test and change on its own
 * instead of one 600-line closure chain.
 *
 * Bodies are moved verbatim. Everything they touch is either a module import
 * (healthFor, MusicBuilders, isLiveVideo) or injected: the five Maps by
 * reference, so `clearCardTimers`/`forgetGuild` and the tests still own them,
 * and the cross-cluster calls through the host, so `vi.spyOn` on the handler
 * still intercepts them.
 */
export interface EventListenerHost {
  clearInactivityTimeout(guildId: string): void;
  clearOkTimer(guildId: string): void;
  clearCardTimers(guildId: string): void;
  clearFallbackState(guildId: string): void;
  clearKickGrace(guildId: string): void;
  forgetNowPlaying(player: Player): void;
  updateChapterStatus(player: Player): void;
  armKaraokeTimer(player: Player): void;
  armChapterTimer(player: Player): void;
  swapChapterOnSeek(player: Player, positionMs: number): void;
  scheduleImmediateProgress(player: Player, delayMs?: number): void;
  resolveKaraokeLines(player: Player, title: string, artist: string, durationMs: number): Promise<void>;
  resolveVideoChapters(player: Player, track: Track | null | undefined): void;
  chapterCardFor(player: Player, positionMs: number): ChapterCard | null;
  lyricWindowFor(player: Player, positionMs: number): LyricWindow | null;
  isSongExhausted(guildId: string, track: Track): boolean;
  checkFallbackBudget(guildId: string, failedKey: string): boolean;
  findAlternatePlayableTrack(
    manager: Manager,
    player: Player,
    failedTrack: Track | null | undefined,
    guildId: string,
    failedKey: string,
    err?: unknown,
  ): Promise<Track | null>;
  frozenPosition(player: Player): number;
  resumeFallbackAt(player: Player, fallback: Track, resumeMs: number): Promise<void>;
}

export class MusicEventListeners {
  public constructor(
    private readonly host: EventListenerHost,
    private readonly moonlinkManager: MoonlinkManager,
    private readonly queueService: QueueService,
    private readonly client: Client,
    private readonly colorService: ColorService | undefined,
    private readonly voiceChannelStatusService: VoiceChannelStatusService | undefined,
    private readonly botScrobblingService: BotScrobblingService | undefined,
    private readonly okTimers: Map<string, NodeJS.Timeout>,
    private readonly progressFingerprints: Map<string, string>,
    private readonly inFlightFallbacks: Map<string, string>,
    private readonly emptyChannelTimeouts: Map<string, NodeJS.Timeout>,
    private readonly inactivityTimeouts: Map<string, NodeJS.Timeout>,
    private readonly pendingPublish: Set<string>,
    private readonly progressPublishing: Map<string, number>,
  ) {}

  public register(): void {
    const manager = this.moonlinkManager.getManager();
    // Each callback RETURNS its promise rather than discarding it. The bodies
    // were `async` before the move and the suite drives these listeners
    // directly with `await`; a `void`-returning wrapper would resolve
    // immediately and every such test would race the work it is asserting on.
    manager.on('trackStart', (player: Player, track: Track) => this.onTrackStart(manager, player, track));
    manager.on('playerTriggeredSeek', (player: Player, position: number) => this.onPlayerTriggeredSeek(player, position));
    manager.on('playerSeek', (player: Player, position: number) => this.onPlayerSeek(player, position));
    manager.on('trackEnd', (player: Player, track: Track, reason: string) => this.onTrackEnd(player, track, reason));
    manager.on('trackStuck', (player: Player, track: Track, threshold: number) =>
      this.onTrackStuck(manager, player, track, threshold),
    );
    manager.on('trackException', (player: Player, track: Track, exception: unknown) =>
      this.onTrackException(manager, player, track, exception),
    );
    manager.on('queueEnd', (player: Player) => this.onQueueEnd(player));
    manager.on('playerDestroy', (player: Player) => this.onPlayerDestroy(player));
  }

  public async onTrackStart(manager: Manager, player: Player, track: Track): Promise<void> {
    // New activity cancels any pending idle disconnect.
    this.host.clearInactivityTimeout(player.guildId);
    // Prioritize player.current which retains clean Spotify / custom metadata and artwork
    const currentTrack = player.current ? mapMoonlinkTrack(player.current) : mapMoonlinkTrack(track);

    Logger.info(
      `[Music] Track started in guild ${player.guildId} via node "${player.node?.identifier ?? 'unknown'}": "${currentTrack.title}" by "${currentTrack.author}"`,
    );

    // Success tracking for the YouTube health ladder: only a track that
    // survives 15s counts (log lines prove starts die at ~2s otherwise).
    // Resolver ('local') tracks never feed YouTube health either way.
    const startedSource = (player.current ?? track)?.sourceName;
    if (startedSource === 'youtube') {
      const nodeId = player.node?.identifier ?? 'unknown';
      const existingOk = this.okTimers.get(player.guildId);
      if (existingOk) clearTimeout(existingOk);
      this.okTimers.set(
        player.guildId,
        setTimeout(() => {
          this.okTimers.delete(player.guildId);
          healthFor(nodeId).recordSuccess();
        }, HEALTH_SURVIVAL_MS),
      );
    }

    player.set('trackStartedAt', Date.now());
    player.set('seekStallRetried', false);
    if (player.current) {
      player.current.position = 0;
      player.current.time = Date.now();
    }

    // Bookkeeping must never reject the listener (unhandled) or skip the card.
    try {
      this.queueService.recordTrackStart(player.guildId, player.current ?? track);

      // Update voice channel status to the song name
      if (player.voiceChannelId && this.voiceChannelStatusService) {
        void this.voiceChannelStatusService.setStatus(
          player.voiceChannelId,
          currentTrack.title,
          currentTrack.author,
        );
      }

      // Record voice track for bot scrobbling
      if (player.voiceChannelId && this.botScrobblingService) {
        this.botScrobblingService.recordTrackStart({
          guildId: player.guildId,
          voiceChannelId: player.voiceChannelId,
          title: currentTrack.title,
          artist: currentTrack.author,
          durationMs: currentTrack.duration,
          startedAt: Date.now(),
        });
      }
    } catch (err) {
      Logger.warn({ err, guildId: player.guildId }, '[Music] trackStart bookkeeping failed');
    }

    // Auto-post interactive Now Playing controller card
    if (!player.textChannelId) return;
    try {
      const channel =
        this.client.channels.cache.get(player.textChannelId) ??
        (await this.client.channels.fetch(player.textChannelId).catch(() => null));
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;

      // Delete previous Now Playing card to keep chat clean
      const prevMsgId = player.get<string>('nowPlayingMessageId');
      if (prevMsgId && 'messages' in channel) {
        await (channel as unknown as { messages: { delete: (id: string) => Promise<unknown> } })
          .messages.delete(prevMsgId)
          .catch(() => undefined);
      }

      const queue = this.queueService.getQueueInfo(player);
      await this.host.resolveKaraokeLines(player, currentTrack.title, currentTrack.author, currentTrack.duration);
      this.host.resolveVideoChapters(player, player.current ?? track);
      // The REAL position, not a hardcoded 0: a track that starts part-way
      // through (fallback resume, a restored session) must render the chapter
      // it is actually on.
      const chapter = this.host.chapterCardFor(player, this.queueService.calculatePosition(player));
      // Same cover resolution the publisher uses, so the first post and
      // every later edit agree on what is on screen (and on the key).
      const postedCover = chapter?.artworkUrl ?? queue.current?.artworkUrl ?? null;
      // Accent follows the displayed cover (chapter art when present),
      // mirroring the on-demand publisher below.
      const accentColor = this.colorService
        ? await this.colorService.getAccentColorAsync(player.guildId, postedCover)
        : undefined;
      const postedLyric = this.host.lyricWindowFor(player, 0);
      const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor, postedLyric, chapter);

      // Timing triangulation (artwork flash diagnosis): lookup start is
      // stamped in maybeBackfillArt, resolve is stamped there with an
      // outcome, and this marks first card render. Correlate ~10-15
      // normal tracks from the Railway logs before optimizing further.
      try {
        const curRec = (player.current ?? track) as unknown as {
          _artLookupStartedAt?: unknown;
          _artLookupResolvedAt?: unknown;
          _artLookupOutcome?: unknown;
        };
        const lookupStarted = typeof curRec._artLookupStartedAt === 'number' ? curRec._artLookupStartedAt : null;
        const resolvedAt = typeof curRec._artLookupResolvedAt === 'number' ? curRec._artLookupResolvedAt : null;
        const outcome = typeof curRec._artLookupOutcome === 'string' ? curRec._artLookupOutcome : 'no-lookup';
        const now = Date.now();
        Logger.info(
          {
            guildId: player.guildId,
            title: currentTrack.title,
            lookupStartedMsAgo: lookupStarted !== null ? now - lookupStarted : null,
            artPresent: !!currentTrack.artworkUrl,
          },
          '[Music] Card render timing',
        );
        const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 23);
        const line =
          lookupStarted === null
            ? `[art-timing] "${currentTrack.title}" — ${currentTrack.author} | no lookup (art present from resolve) | art at render: ${currentTrack.artworkUrl ? 'yes' : 'no'}`
            : `[art-timing] "${currentTrack.title}" — ${currentTrack.author} | lookup ${clock(lookupStarted)}` +
              (resolvedAt !== null
                ? ` → resolve +${resolvedAt - lookupStarted}ms (${outcome})`
                : ` → unresolved at render (${outcome}, late pending)`) +
              ` → render +${now - lookupStarted}ms | art at render: ${currentTrack.artworkUrl ? 'yes' : 'no'}`;
        Logger.info(line);
      } catch {
        // Timing only — never break the card.
      }

      const payload = response.toMessagePayload();
      const sent = await (
        channel as unknown as { send: (p: unknown) => Promise<{ id: string }> }
      )
        .send(payload)
        .catch(async (err) => {
          Logger.warn(
            { err, guildId: player.guildId },
            'Failed to dispatch trackStart Now Playing card via toMessagePayload, falling back to embeds',
          );
          return (channel as unknown as { send: (p: unknown) => Promise<{ id: string }> })
            .send({
              embeds: response.buildEmbed(),
              components: response.buildComponents(),
            })
            .catch(() => null);
        });

      if (sent && sent.id) {
        player.set('nowPlayingMessageId', sent.id);
        // Sync the fingerprint to what was just posted: a same-track
        // re-post must neither double-publish identical state nor
        // suppress the next real change (which a stale fingerprint from
        // a previous card would do, freezing the new card).
        const postedLyricKey = postedLyric ? `${postedLyric.current ?? ''}~${postedLyric.next ?? ''}` : 'none';
        const postedChapterKey = chapterKeyFor(chapter, postedCover);
        this.progressFingerprints.set(
          player.guildId,
          fingerprintFor(queue, postedLyricKey, postedChapterKey),
        );
        // Event-driven card: arm boundary timers instead of polling.
        this.host.updateChapterStatus(player);
        this.host.armKaraokeTimer(player);
        this.host.armChapterTimer(player);
      }
    } catch (err) {
      Logger.warn({ err, guildId: player.guildId }, 'Failed to dispatch trackStart Now Playing card');
    }
  }

  /**
   * Emitted synchronously by Player#seek for every seek call site, before
   * the REST round-trip — the earliest reliable seek signal (stock
   * Lavalink v4 does not send a SeekEvent back over the websocket).
   */
  public onPlayerTriggeredSeek(player: Player, position: number): void {
    this.host.swapChapterOnSeek(player, position);
    // Position jumped — boundary timers armed to the old clock are wrong.
    this.host.armKaraokeTimer(player);
    this.host.armChapterTimer(player);
  }

  /**
   * Node-initiated seek (Lavalink's own recovery, a remote restart, a
   * dashboard jump). moonlink applies the new position but leaves
   * current.time at the last update, so the position calculator keeps
   * extrapolating from a stale base for up to a minute and can cross a
   * chapter boundary early. Re-stamp the clock and swap the chapter.
   */
  public onPlayerSeek(player: Player, position: number): void {
    try {
      const cur = player.current as unknown as { position?: unknown; time?: unknown } | null;
      if (cur) {
        cur.position = position;
        cur.time = Date.now();
      }
      this.host.swapChapterOnSeek(player, position);
      this.host.armKaraokeTimer(player);
      this.host.armChapterTimer(player);
      this.host.scheduleImmediateProgress(player);
    } catch {
      // Never break playback.
    }
  }

  public onTrackEnd(player: Player, track: Track, reason: string): void {
    Logger.debug(`[Music] Track ended in guild ${player.guildId}: "${track.title}" (reason: ${reason})`);
    this.host.clearCardTimers(player.guildId);
    this.host.clearOkTimer(player.guildId);

    // The card dies with the song — no lingering until disconnect. The
    // next trackStart posts a fresh card (its delete-prev no-ops).
    const endMsgId = player.get<string>('nowPlayingMessageId');
    const endChannelId = player.textChannelId;
    this.host.forgetNowPlaying(player);
    if (endMsgId && endChannelId) {
      void (async () => {
        try {
          const channel = await this.client.channels.fetch(endChannelId).catch(() => null);
          if (channel && 'messages' in channel) {
            await (channel as unknown as { messages: { delete: (id: string) => Promise<unknown> } })
              .messages.delete(endMsgId)
              .catch(() => undefined);
          }
        } catch {
          // Card already gone — state is clean regardless.
        }
      })();
    }

    // Preview-cut detection: some SoundCloud uploads (major-label artists)
    // only expose 30s preview streams while reporting full metadata
    // durations. A track "finishing" in under a minute of a multi-minute
    // runtime is a cut preview, not a completed play — count it toward
    // abandoning the song so future encounters skip it faster.
    if (track && reason === 'finished') {
      const startedAt = player.get<number>('trackStartedAt') ?? 0;
      const playedMs = startedAt > 0 ? Date.now() - startedAt : 0;
      const duration = track.duration || 0;
      if (duration > 90000 && playedMs > 0 && playedMs < Math.min(60000, duration * 0.5)) {
        const source = (track as unknown as { sourceName?: string }).sourceName ?? 'unknown';
        Logger.warn(
          { guildId: player.guildId, track: track.title, source, playedMs, duration },
          `[Music] Track ended after ${(playedMs / 1000).toFixed(0)}s of ${(duration / 1000).toFixed(0)}s — likely a preview cut.`,
        );
        this.host.isSongExhausted(player.guildId, track);
      }
    }

    if (player.voiceChannelId && this.botScrobblingService) {
      void this.botScrobblingService.handleTrackEnd(this.client, player.guildId, player.voiceChannelId);
    }
  }

  public async onTrackStuck(
    manager: Manager,
    player: Player,
    track: Track,
    threshold: number,
  ): Promise<void> {
    // No clearCardTimers here: a stall often resolves on the SAME
    // track (re-seek below, or Moonlink's own nudge), and the fingerprint
    // dirty-check already suppresses useless edits while frozen. Stopping
    // it would freeze the card + progress bar permanently for recovered
    // playback — terminal paths (trackEnd/queueEnd/playerDestroy) stop it.
    this.host.clearOkTimer(player.guildId);

    // Moonlink can emit with a null track when the failure arrives after the
    // player already moved on (stop/skip/queueEnd). Property access on null
    // used to crash this whole listener as an unhandled rejection.
    if (!track) {
      Logger.warn(
        { guildId: player.guildId, threshold },
        '[Music] Track stuck event with no track — nothing to retry.',
      );
      return;
    }

    // Guard against double-skip: Moonlink may already have advanced past this track
    // while our async fallback search was in flight.
    const failedKey = track.encoded ?? track.uri ?? track.identifier;
    const stillCurrent = (): boolean => {
      const cur = player.current as unknown as { encoded?: string; uri?: string; identifier?: string } | null;
      if (!cur) return false;
      return (cur.encoded ?? cur.uri ?? cur.identifier) === failedKey;
    };

    // Seek-stall recovery: a stall within seconds of a USER seek is usually
    // the range request dying (especially on pot-bound YouTube streams),
    // not a poison upload. Re-issue the same seek once — no fallback
    // budget burn, no per-song strike — and only fall through to the
    // alternate-upload machinery if it stalls again.
    const lastSeekAt = player.get<number>('lastUserSeekAt') ?? 0;
    const seekRetried = player.get<boolean>('seekStallRetried') ?? false;
    if (!seekRetried && lastSeekAt > 0 && Date.now() - lastSeekAt < 25000 && stillCurrent()) {
      player.set('seekStallRetried', true);
      const pos = player.get<number>('lastUserSeekPos') ?? 0;
      Logger.info(
        { guildId: player.guildId, track: track.title, pos },
        '[Music] Stall right after user seek — re-issuing seek once instead of fallback.',
      );
      // Align Moonlink's own post-emit nudge (currentPosition+1000) with
      // our target: it reads this state after our sync prefix, so a stale
      // 0 (seek never took server-side) would teleport a deep recovery
      // to 0:01. Ours lands first; its nudge becomes a harmless +1s.
      if (player.current) {
        player.current.position = pos;
        player.current.time = Date.now();
      }
      await player.seek(pos).catch(() => undefined);
      return;
    }

    // Seek-download grace (SABR long-form class, measured live): a far seek
    // into a long plugin stream downloads ~30MB sequentially (~55s at the
    // observed ~0.5MB/s), which always outlasts the 10s stuck clock. The
    // retained buffer accumulates across re-demands, so the seek WOULD land
    // if nothing interfered — but Moonlink stops/skips at its 3rd strike
    // and our fallback below would replace the track (empty buffer, progress
    // lost). While grace remains: reset Moonlink's strike counter (our sync
    // prefix runs during emit, before its post-emit counting) and return
    // without touching fallback machinery. Bounded: after MAX cycles the
    // normal path resumes, so a genuinely dead stream still fails loud.
    // Short tracks skip this entirely — their post-seek stalls are real.
    if (
      seekRetried &&
      lastSeekAt > 0 &&
      Date.now() - lastSeekAt < SEEK_GRACE_WINDOW_MS &&
      isLiveVideo(track.duration) &&
      stillCurrent()
    ) {
      const graceSeekAt = player.get<number>('seekStallGraceSeekAt') ?? 0;
      const graceUsed = graceSeekAt === lastSeekAt ? (player.get<number>('seekStallGraceUsed') ?? 0) : 0;
      if (graceUsed < MAX_SEEK_GRACE_STUCKS) {
        player.set('seekStallGraceSeekAt', lastSeekAt);
        player.set('seekStallGraceUsed', graceUsed + 1);
        player.set('stuckCount', 0);
        Logger.info(
          { guildId: player.guildId, track: track.title, cycle: graceUsed + 1 },
          '[Music] Post-seek stall inside grace — holding for catch-up download, no fallback.',
        );
        return;
      }
    }

    if (this.host.isSongExhausted(player.guildId, track)) {
      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Giving up on stuck "${track.title}" after repeated failures.`,
      );
      if (stillCurrent() && player.queue.size > 0) {
        await player.skip().catch(() => undefined);
      }
      return;
    }

    const failedKeyStr = String(failedKey ?? 'unknown');
    // Moonlink can emit BOTH trackStuck and trackException for the same
    // track. The budget check below is check-then-act, so both handlers used
    // to pass it, run identical searches, and enqueue the SAME alternate
    // twice — then skip twice for one visible failure. Claim the track first
    // so the second event returns immediately.
    const inFlight = this.inFlightFallbacks.get(player.guildId);
    if (inFlight === failedKeyStr) {
      Logger.debug(
        { guildId: player.guildId, track: track.title },
        '[Music] Fallback already in flight for this track — skipping duplicate',
      );
      return;
    }
    if (!this.host.checkFallbackBudget(player.guildId, failedKeyStr)) {
      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Fallback budget exhausted for stuck track — leaving Moonlink recovery to handle it.`,
      );
      return;
    }

    Logger.warn(
      { guildId: player.guildId, track: track.title, threshold },
      `[Music] Track stuck (${threshold}ms) — looking for an alternate upload for "${track.title}"...`,
    );
    this.inFlightFallbacks.set(player.guildId, failedKeyStr);
    let fallback: Track | null = null;
    try {
      fallback = await this.host.findAlternatePlayableTrack(manager, player, track, player.guildId, failedKeyStr);
    } finally {
      this.inFlightFallbacks.delete(player.guildId);
    }
    if (fallback) {
      const resumeMs = this.host.frozenPosition(player);
      player.queue.unshift(fallback);
      Logger.info(
        { guildId: player.guildId, track: track.title },
        `[Music] Alternate upload queued for stuck track — advancing to it.`,
      );
      // Moonlink does NOT auto-advance on stuck (it seeks/retries by default), so we
      // must advance ourselves. Only skip if the stuck track is still current.
      // If Moonlink already stopped the player while our search was in flight, the
      // fallback would otherwise sit orphaned in the queue — start it explicitly.
      if (stillCurrent()) {
        await player.skip().catch((err: unknown) => {
          Logger.warn({ err, guildId: player.guildId }, '[Music] Skip to alternate upload failed');
        });
      } else if (!player.playing && !player.paused) {
        await player.play().catch((err: unknown) => {
          Logger.warn({ err, guildId: player.guildId }, '[Music] Play of alternate upload failed');
        });
      }
      await this.host.resumeFallbackAt(player, fallback, resumeMs);
      return;
    }

    Logger.warn(
      { guildId: player.guildId, track: track.title, threshold },
      `[Music] Track stuck (${threshold}ms) — no alternate upload, leaving Moonlink recovery to handle it.`,
    );
  }

  public async onTrackException(
    manager: Manager,
    player: Player,
    track: Track,
    exception: unknown,
  ): Promise<void> {
    // Same updater reasoning as trackStuck: the dirty-check suppresses
    // edits while frozen, and every terminal path stops it. Only a track
    // that never resumes keeps stale output — which is correct output.

    // Same null-track guard as trackStuck: late-arriving failures for an
    // already-advanced player carry no track to retry.
    if (!track) {
      Logger.warn(
        { err: exception, guildId: player.guildId },
        '[Music] Track exception event with no track — leaving advancement to Moonlink.',
      );
      return;
    }

    // A 15s survival was pending for this track — a failure means it never
    // gets to count as healthy.
    this.host.clearOkTimer(player.guildId);

    // Feed the per-node outage detector (YouTube-source tracks only).
    if (track?.sourceName === 'youtube') {
      healthFor(player.node?.identifier ?? 'unknown').recordFailure(
        `${track.author} - ${track.title}`,
        exception,
      );
    }

    // Guard against double-skip: Moonlink auto-skips fault-severity exceptions on its
    // own, which may complete while our async fallback search is in flight.
    const failedKey = track.encoded ?? track.uri ?? track.identifier;
    const stillCurrent = (): boolean => {
      const cur = player.current as unknown as { encoded?: string; uri?: string; identifier?: string } | null;
      if (!cur) return false;
      return (cur.encoded ?? cur.uri ?? cur.identifier) === failedKey;
    };
    const skipPastFailed = async (): Promise<void> => {
      if (!stillCurrent()) return;
      try {
        // skip() with a non-empty queue plays the next track; with an empty queue it
        // stops the player (which then fires queueEnd). Either way the poison track
        // can't stall the queue — Moonlink only auto-skips fault/suspicious severity.
        await player.skip();
      } catch (err) {
        Logger.warn({ err, guildId: player.guildId }, '[Music] Skip past failed track failed');
      }
    };

    if (this.host.isSongExhausted(player.guildId, track)) {
      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Giving up on "${track.title}" after repeated failures — skipping past it.`,
      );
      await skipPastFailed();
      return;
    }

    const failedKeyStr = String(failedKey ?? 'unknown');
    // Same claim as the stuck path: a track can raise BOTH events, and two
    // concurrent fallbacks enqueue the same alternate twice and skip twice.
    if (this.inFlightFallbacks.get(player.guildId) === failedKeyStr) {
      Logger.debug(
        { guildId: player.guildId, track: track.title },
        '[Music] Fallback already in flight for this track — skipping duplicate',
      );
      return;
    }
    if (!this.host.checkFallbackBudget(player.guildId, failedKeyStr)) {
      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Fallback budget exhausted for failed track — skipping past it.`,
      );
      await skipPastFailed();
      return;
    }

    const failureClients = clientFailuresText((exception as { message?: unknown } | null)?.message);
    Logger.warn(
      {
        guildId: player.guildId,
        track: track.title,
        severity: (exception as { severity?: unknown } | null)?.severity,
        reason: failureClients,
      },
      YoutubeHealth.isOutage(exception)
        ? `[Music] Track failed (YouTube outage) — looking for a fallback for "${track.title}"...`
        : `[Music] Track failed — looking for an alternate upload for "${track.title}"...`,
    );
    this.inFlightFallbacks.set(player.guildId, failedKeyStr);
    let fallback: Track | null = null;
    try {
      fallback = await this.host.findAlternatePlayableTrack(
        manager,
        player,
        track,
        player.guildId,
        failedKeyStr,
        exception,
      );
    } finally {
      this.inFlightFallbacks.delete(player.guildId);
    }
    if (fallback) {
      // Inject at the front of the queue so it plays next, then advance to it —
      // Moonlink only auto-skips fault-severity exceptions, so common-severity
      // YouTube failures (unavailable/age-restricted/blocked) would stall forever.
      const resumeMs = this.host.frozenPosition(player);
      player.queue.unshift(fallback);
      Logger.info(
        { guildId: player.guildId, track: track.title },
        `[Music] Alternate upload queued for "${track.title}" — advancing to it.`,
      );
      // Race: Moonlink may have stopped the player (empty queue → queueEnd) while our
      // search was in flight. Then skipPastFailed() is a no-op (nothing is current)
      // and the fallback would sit orphaned — start it explicitly instead.
      if (!player.playing && !player.paused && !stillCurrent()) {
        try {
          await player.play();
        } catch (err) {
          Logger.warn({ err, guildId: player.guildId }, '[Music] Play of alternate upload failed');
        }
        await this.host.resumeFallbackAt(player, fallback, resumeMs);
        return;
      }
      await skipPastFailed();
      await this.host.resumeFallbackAt(player, fallback, resumeMs);
      return;
    }

    Logger.error(
      { err: exception, guildId: player.guildId, track: track.title },
      `[Music] Track exception in guild ${player.guildId} — no alternate upload, skipping past failed track.`,
    );
    await skipPastFailed();
  }

  public onQueueEnd(player: Player): void {
    Logger.info(`[Music] Queue ended in guild ${player.guildId}`);
    this.host.clearCardTimers(player.guildId);
    this.host.clearFallbackState(player.guildId);

    if (player.voiceChannelId && this.voiceChannelStatusService) {
      void this.voiceChannelStatusService.clearStatus(player.voiceChannelId);
    }

    const is247 = this.queueService.is247(player.guildId);
    if (!is247 && !player.autoPlay) {
      // Auto-disconnect after 3 minutes of inactivity (own map — never
      // clobbered by the empty-voice-channel timer, and always cleaned up).
      this.host.clearInactivityTimeout(player.guildId);
      const timeout = setTimeout(() => {
        this.inactivityTimeouts.delete(player.guildId);
        if (player.queue.isEmpty && !player.playing) {
          Logger.info(`[Music] Inactivity timeout: disconnecting player in guild ${player.guildId}`);
          player.destroy('Inactivity timeout').catch(() => undefined);
        }
      }, INACTIVITY_DISCONNECT_MS);
      this.inactivityTimeouts.set(player.guildId, timeout);
    }
  }

  public async onPlayerDestroy(player: Player): Promise<void> {
    this.host.clearCardTimers(player.guildId);
    this.host.clearOkTimer(player.guildId);
    this.host.clearFallbackState(player.guildId);
    this.host.clearKickGrace(player.guildId);
    this.host.clearInactivityTimeout(player.guildId);
    this.progressFingerprints.delete(player.guildId);
    this.pendingPublish.delete(player.guildId);
    this.progressPublishing.delete(player.guildId);
    this.inFlightFallbacks.delete(player.guildId);

    if (player.voiceChannelId && this.voiceChannelStatusService) {
      void this.voiceChannelStatusService.clearStatus(player.voiceChannelId);
    }

    const timeout = this.emptyChannelTimeouts.get(player.guildId);
    if (timeout) {
      clearTimeout(timeout);
      this.emptyChannelTimeouts.delete(player.guildId);
    }

    // Cleanup Now Playing card on player destroy
    const prevMsgId = player.get<string>('nowPlayingMessageId');
    if (prevMsgId && player.textChannelId) {
      try {
        const channel = await this.client.channels.fetch(player.textChannelId).catch(() => null);
        if (channel && 'messages' in channel) {
          await (channel as unknown as { messages: { delete: (id: string) => Promise<unknown> } })
            .messages.delete(prevMsgId)
            .catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }
  }
}
