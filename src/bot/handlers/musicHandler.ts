
import type { Manager, Player } from 'moonlink.js';
import { Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { FallbackBudget } from './music/fallbackBudget';
import { KaraokeController, type KaraokeHost } from './music/karaokeController';
import { NowPlayingCardPublisher, type CardPublisherHost } from './music/nowPlayingCardPublisher';
import { ChapterArtController, type ChapterArtHost } from './music/chapterArtController';
import { AlternateTrackFinder } from './music/alternateTrackFinder';
import { VoiceLifecycle, type VoiceLifecycleHost } from './music/voiceLifecycle';
import { ChapterTimeline, type ChapterTimelineHost } from './music/chapterTimeline';
import { buildFallbackQuery, chapterKeyFor, clientFailuresText, fingerprintFor } from './music/cardFingerprint';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { ArtworkService } from '@bot/services/artworkService';
import type { LyricWindow } from '@bot/services/music/syncedLyrics';
import {
  extractArtistFromTitle,
  getVideoTitle,
  isLiveVideo,

  type ChapterCard,
  type VideoChapter,
} from '@bot/services/music/videoChapters';
import { cleanTrackTitle, mapMoonlinkTrack } from '@domain/models/music/musicTrack';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';
import { healthFor, ladderFor, YoutubeHealth, HOME_NODE } from '@bot/services/music/youtubeHealth';
import { CHAPTER_ART_RETRY_MS, CHAPTER_JUMP_CONFIRM_MS, CHAPTER_REGRESSION_TOLERANCE_MS } from '@bot/services/music/musicConstants';

import type { Client } from 'discord.js';

export class MusicHandler {
  private readonly client: Client;
  private readonly moonlinkManager: MoonlinkManager;
  private readonly queueService: QueueService;
  private readonly colorService?: ColorService;
  private readonly voiceChannelStatusService?: VoiceChannelStatusService;
  private readonly botScrobblingService?: BotScrobblingService;
  private readonly lyricsService?: LyricsService;
  private readonly artworkService?: ArtworkService;
  private readonly emptyChannelTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly inactivityTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly kickGraceTimeouts = new Map<string, NodeJS.Timeout>();
  // Boundary timers (replacing the old 5s poll): one-shots armed to the
  // next lyric line / chapter start. Zero edits while nothing changes, exact
  // refresh the moment it does. Cleared on track change, seek, end, destroy.
  private readonly karaokeTimers = new Map<string, NodeJS.Timeout>();
  private readonly chapterTimers = new Map<string, NodeJS.Timeout>();
  /** Dedicated cover-retry timers (one per guild), cleared with the card timers. */
  private readonly chapterArtRetryTimers = new Map<string, NodeJS.Timeout>();
  /** Last chapter title pushed to voice status per guild (change-gated). */
  private readonly lastChapterStatus = new Map<string, string | null>();
  // Debounced on-demand publishes (chapter attach / art resolve bursts
  // collapse into one edit). No polling behind it.
  private readonly progressNudgeTimers = new Map<string, NodeJS.Timeout>();
  private readonly progressPublishing = new Map<string, number>();
  /** Consecutive failed publishes per guild (bounded retry budget). */
  private readonly publishRetries = new Map<string, number>();

  /**
   * A publish whose awaited work hangs (REST stall) must never wedge the card
   * forever: a guard older than this is treated as dead and retaken, so the
   * next trigger publishes instead of skipping.
   */


  constructor(
    client: Client,
    moonlinkManager: MoonlinkManager,
    queueService: QueueService,
    colorService?: ColorService,
    voiceChannelStatusService?: VoiceChannelStatusService,
    botScrobblingService?: BotScrobblingService,
    lyricsService?: LyricsService,
    artworkService?: ArtworkService,
  ) {
    this.client = client;
    this.moonlinkManager = moonlinkManager;
    this.queueService = queueService;
    this.colorService = colorService;
    this.voiceChannelStatusService = voiceChannelStatusService;
    this.botScrobblingService = botScrobblingService;
    this.lyricsService = lyricsService;
    this.artworkService = artworkService;

    this.cards = new NowPlayingCardPublisher(
      this as unknown as CardPublisherHost,
      this.progressNudgeTimers,
      this.progressPublishing,
      this.progressFingerprints,
      this.publishRetries,
      this.pendingPublish,
    );
    this.voice = new VoiceLifecycle(
      this as unknown as VoiceLifecycleHost,
      this.kickGraceTimeouts,
      this.emptyChannelTimeouts,
      this.inactivityTimeouts,
    );
    this.chapterArt = new ChapterArtController(
      this as unknown as ChapterArtHost,
      this.chapterArtRetryTimers,
    );
    this.karaoke = new KaraokeController(
      this as unknown as KaraokeHost,
      this.karaokeTimers,
    );
    this.fallbackBudget = new FallbackBudget(
      this.fallbackAttempts,
      this.guildFallbackBudget,
      this.triedFallbackIds,
      this.songFailureCounts,
    );
    this.chapters3 = new ChapterTimeline(
      this as unknown as ChapterTimelineHost,
      this.chapterArt,
    );
    this.fallbacks = new AlternateTrackFinder({
      moonlinkManager: this.moonlinkManager,
      queueService: this.queueService,
      budget: this.fallbackBudget,
    });
    this.registerMoonlinkEvents();
    this.registerDiscordEvents();
  }

  /**
   * Karaoke window for the card at a playback position. Reads the synced
   * lines stored at track start; honors the per-guild toggle. Lyrics follow
   * the real clock with no startup offset. Null when disabled, missing, or
  /** Chapter artwork — see music/chapterArtController.ts.
   * `chapterArtRetryTimers` stays owned here and is passed in by reference, so
   * clearChapterTimer/clearCardTimers/forgetGuild still sweep it. */
  private readonly chapterArt: ChapterArtController;

  private async getChapterCover(
    chapterTitle: string,
    song: string,
    artist: string | undefined,
  ): Promise<string | null> {
    return this.chapterArt.getChapterCover(chapterTitle, song, artist);
  }

  private prefetchChapterArts(player: Player, chapters: VideoChapter[], indices: number[]): void {
    this.chapterArt.prefetchChapterArts(player, chapters, indices);
  }

  private scheduleChapterArtRetry(player: Player, idx: number, chapters: VideoChapter[]): void {
    this.chapterArt.scheduleChapterArtRetry(player, idx, chapters);
  }

  private clearChapterArtRetryTimer(guildId: string): void {
    this.chapterArt.clearChapterArtRetryTimer(guildId);
  }

  private async resolveChapterArt(
    player: Player,
    idx: number,
    chapters: VideoChapter[],
    coverOnly = false,
  ): Promise<void> {
    return this.chapterArt.resolveChapterArt(player, idx, chapters, coverOnly);
  }

  /** Chapter timeline — see music/chapterTimeline.ts. Takes the art
   * controller directly; the boundary timer and the card publisher stay on the
   * handler and are reached through the host. */
  private readonly chapters3: ChapterTimeline;

  private resolveVideoChapters(player: Player, track: Track | null | undefined): void {
    this.chapters3.resolveVideoChapters(player, track);
  }

  private chapterCardFor(player: Player, positionMs: number): ChapterCard | null {
    return this.chapters3.chapterCardFor(player, positionMs);
  }

  private swapChapterOnSeek(player: Player, positionMs: number): void {
    this.chapters3.swapChapterOnSeek(player, positionMs);
  }

  private readonly progressFingerprints = new Map<string, string>();
  /**
   * Guilds with a fallback search currently running, keyed by the FAILED
   * track. Stops a track that raises both `trackStuck` and `trackException`
   * from producing two identical alternate uploads and two skips.
   */
  private readonly inFlightFallbacks = new Map<string, string>();
  /**
   * Guilds with a publish that arrived while another was in flight. The
   * set is the coalescing queue: presence means "re-derive once the current
   * publish settles", absence means "nothing waiting".
   */
  private readonly pendingPublish = new Set<string>();
  /**
   * Chapter part of the visible fingerprint. The COVER URL is part of the
   * key, not just its presence: a chapter whose art lands late (or replaces
   * the held cover from the previous song) is a visible change, and keying
   * on `title~hasArt` alone made every art swap look identical to the state
   * already posted — the card kept the previous song's cover indefinitely.
   */
  /**
   * Static delegates onto cardFingerprint.ts. That module is pure (no state,
   * no timers), but these call sites — including a test that reads the static
   * straight off the class — have always gone through MusicHandler, so the
   * aliases keep the split invisible to every caller.
   */
  private static chapterKeyFor = chapterKeyFor;
  private static fingerprintFor = fingerprintFor;
  private static clientFailuresText = clientFailuresText;

  /** See cardFingerprint.buildFallbackQuery. */
  private buildFallbackQuery(track: Track | null | undefined): string | null {
    return buildFallbackQuery(track);
  }

  /** 15s node-health survival probe, armed on trackStart. */
  private readonly okTimers = new Map<string, NodeJS.Timeout>();

  private clearCardTimers(guildId: string): void {
    const nudge = this.progressNudgeTimers.get(guildId);
    if (nudge) {
      clearTimeout(nudge);
      this.progressNudgeTimers.delete(guildId);
    }
    this.clearKaraokeTimer(guildId);
    this.clearChapterTimer(guildId);
    this.lastChapterStatus.delete(guildId);
    this.publishRetries.delete(guildId);
  }

  /** Karaoke controller — see music/karaokeController.ts.
   * `karaokeTimers` stays owned here and is passed in by reference, so the
   * tests can still read it and forgetGuild still sweeps it. */
  private readonly karaoke: KaraokeController;

  private lyricWindowFor(player: Player, positionMs: number): LyricWindow | null {
    return this.karaoke.lyricWindowFor(player, positionMs);
  }

  private async resolveKaraokeLines(
    player: Player,
    title: string,
    artist: string,
    durationMs: number,
  ): Promise<void> {
    return this.karaoke.resolveKaraokeLines(player, title, artist, durationMs);
  }

  private clearKaraokeTimer(guildId: string): void {
    this.karaoke.clearKaraokeTimer(guildId);
  }

  private armKaraokeTimer(player: Player): void {
    this.karaoke.armKaraokeTimer(player);
  }

  private clearChapterTimer(guildId: string): void {
    const timer = this.chapterTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.chapterTimers.delete(guildId);
    }
    this.clearChapterArtRetryTimer(guildId);
  }

  /**
   * Arms a one-shot to the next chapter start so live shows follow
   * themselves with zero polling. Same recheck rules as karaoke.
   */
  private armChapterTimer(player: Player): void {
    this.clearChapterTimer(player.guildId);
    try {
      const chapters = player.get<VideoChapter[] | null>('chapters');
      if (!chapters || chapters.length < 2) return;
      const idx = player.get<number>('chapterIdx') ?? -2;
      const next = idx < 0 ? chapters[0] : chapters[idx + 1];
      if (!next || typeof next.startMs !== 'number') return;
      const position = this.queueService.calculatePosition(player);
      let delay = next.startMs - position;
      if (player.paused || delay < 0) delay = 15000;
      const timer = setTimeout(() => {
        this.chapterTimers.delete(player.guildId);
        try {
          const at = this.queueService.calculatePosition(player);
          this.chapterCardFor(player, at);
          this.updateChapterStatus(player);
          void this.publishProgress(player);
        } catch {
          // Timer errors must never break the chain below.
        }
        this.armChapterTimer(player);
      }, Math.max(delay, 1500));
      timer.unref?.();
      this.chapterTimers.set(player.guildId, timer);
    } catch {
      // Chapters are decoration — never break playback.
    }
  }

  /**
   * Pushes the current chapter to the voice channel status, change-gated
   * (one REST call per chapter, never per tick). Falls back to the track
   * when the card clears (generic chapter) so the status never goes stale.
   */
  private updateChapterStatus(player: Player): void {
    try {
      const svc = this.voiceChannelStatusService;
      if (!svc || !player.voiceChannelId) return;
      const card = player.get<ChapterCard | null>('chapterCard');
      const cur = player.current as unknown as { title?: string; author?: string } | null;
      const key = card?.title ?? cur?.title ?? '';
      if ((this.lastChapterStatus.get(player.guildId) ?? null) === key) return;
      this.lastChapterStatus.set(player.guildId, key);
      if (!card) {
        if (cur?.title) {
          // While a generic chapter is up (an intro), the status fell back to
          // the raw video title with the UPLOADER CHANNEL as the artist, so
          // the room read "gloss - EsDeeKid - Live at Wembley (Official)".
          // Use the display-cleaned title and the performer named in it.
          const displayTitle = cleanTrackTitle(cur.title ?? '', cur.author);
          const artist = extractArtistFromTitle(getVideoTitle(cur)) ?? cur?.author;
          void svc.setStatus(player.voiceChannelId, displayTitle, artist).catch(() => undefined);
        }
        return;
      }
      const artist = extractArtistFromTitle(getVideoTitle(cur)) ?? cur?.author;
      void svc.setStatus(player.voiceChannelId, card.title, artist).catch(() => undefined);
    } catch {
      // Status is decoration.
    }
  }

  /** External refresh entry (karaoke toggle) — never throws into callers. */
  public refreshGuildCard(guildId: string): void {
    try {
      const player = this.moonlinkManager.getManager().players.get(guildId);
      if (!player) return;
      if (this.queueService.isKaraokeEnabled(guildId)) this.armKaraokeTimer(player as Player);
      else this.clearKaraokeTimer(guildId);
      // The chapter timer is the ONLY thing that advances chapters on a long
      // set, and it is dropped by channel deletion, a re-attach, or any
      // swallowed throw inside armChapterTimer. Nothing else re-arms it, so a
      // single loss freezes the card on one song for the rest of the show.
      // Re-arming here is idempotent (armChapterTimer clears its own timer)
      // and this is also the late-artwork notifier, so it is the natural
      // heartbeat for a live show.
      const chapters = (player as Player).get<unknown[]>('chapters');
      if (chapters && chapters.length >= 2) this.armChapterTimer(player as Player);
      void this.publishProgress(player as Player);
    } catch {
      // Never break commands.
    }
  }

  private clearOkTimer(guildId: string): void {
    const timer = this.okTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.okTimers.delete(guildId);
    }
  }

  /**
   * One-line system notice in the guild's now-playing channel (skipped
   * tracks, queue cap). Best-effort: never throws, never awaits a caller.
   */
  public sendSystemMusicNotice(guildId: string, content: string): void {
    try {
      const player = this.moonlinkManager.getManager().players.get(guildId);
      const channelId = player?.textChannelId;
      if (!channelId) return;
      const channel = this.client.channels.cache.get(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        void channel.send({ content }).catch(() => undefined);
      }
    } catch (err) {
      Logger.debug({ err, guildId }, '[Music] System notice send failed');
    }
  }

  /** Card publisher — see music/nowPlayingCardPublisher.ts.
   * The five Maps stay owned here and are passed in BY REFERENCE, so the tests
   * can still read them and clearCardTimers/forgetGuild still sweep them. */
  private readonly cards: NowPlayingCardPublisher;

  private async publishProgress(player: Player): Promise<void> {
    return this.cards.publishProgress(player);
  }

  private forgetNowPlaying(player: Player): void {
    this.cards.forgetNowPlaying(player);
  }

  private scheduleImmediateProgress(player: Player, delayMs = 300): void {
    this.cards.scheduleImmediateProgress(player, delayMs);
  }

  // Fallback budgets: every failure runs up to 2 node searches. A poison
  // playlist must never turn that into a search storm or an infinite
  // fallback-that-fails loop.
  private readonly fallbackAttempts = new Map<string, number>();
  private readonly guildFallbackBudget = new Map<string, { count: number; windowStart: number }>();
  private readonly triedFallbackIds = new Map<string, Set<string>>();
  // Song-identity circuit breaker state, owned here and passed to FallbackBudget.
  private readonly songFailureCounts = new Map<string, { count: number; firstAt: number }>();
  // Post-seek catch-up grace for far seeks in long videos before normal
  // machinery resumes. Generous on purpose: slow downloads (SABR streams,
  // still-growing local files) stall repeatedly while catching up, and each
  // stall must not burn fallback budget toward skipping an hour-long show.
  // Bounded — past this, the normal loud path resumes.
  private static readonly MAX_SEEK_GRACE_STUCKS = 10;
  private static readonly SEEK_GRACE_WINDOW_MS = 300000;
  private static readonly MAX_FALLBACKS_PER_GUILD_WINDOW = 5;
  private static readonly FALLBACK_BUDGET_WINDOW_MS = 60000;
  // Borrowed-cover window and the chapter-jump settle window live in
  // musicConstants so the handler and the interaction surface cannot drift
  // apart (they used to be separate literals for one concept).

  /** Fallback budget + song circuit breaker — see music/fallbackBudget.ts.
   * The Maps stay owned by this handler and are passed in BY REFERENCE, so
   * forgetGuild still sweeps them and the tests can still read them here. */
  private readonly fallbackBudget: FallbackBudget;

  private checkFallbackBudget(guildId: string, failedKey: string): boolean {
    return this.fallbackBudget.checkFallbackBudget(guildId, failedKey);
  }

  private recordFallbackAttempt(guildId: string, failedKey: string, fallbackId?: string): void {
    return this.fallbackBudget.recordFallbackAttempt(guildId, failedKey, fallbackId);
  }

  private clearFallbackState(guildId: string): void {
    return this.fallbackBudget.clearFallbackState(guildId);
  }

  private isSongExhausted(guildId: string, track: Track): boolean {
    return this.fallbackBudget.isSongExhausted(guildId, track);
  }

  private matchesFallbackDuration(failedTrack: Track, duration?: number): boolean {
    return this.fallbackBudget.matchesFallbackDuration(failedTrack, duration);
  }

  private isFreshCandidate(failedTrack: Track, guildId: string, t: Track): boolean {
    return this.fallbackBudget.isFreshCandidate(failedTrack, guildId, t);
  }

  /** Alternate-track ladder — see music/alternateTrackFinder.ts. */
  private readonly fallbacks: AlternateTrackFinder;

  public adoptFallbackMetadata(fallback: Track, failedTrack: Track, source: string): void {
    this.fallbacks.adoptFallbackMetadata(fallback, failedTrack, source);
  }

  private frozenPosition(player: Player): number {
    return this.fallbacks.frozenPosition(player);
  }

  private async resumeFallbackAt(player: Player, fallback: Track, resumeMs: number): Promise<void> {
    return this.fallbacks.resumeFallbackAt(player, fallback, resumeMs);
  }

  private async searchYoutubeAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    return this.fallbacks.searchYoutubeAlternate(manager, failedTrack, guildId);
  }

  private async searchSoundcloudAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    return this.fallbacks.searchSoundcloudAlternate(manager, failedTrack, guildId);
  }

  private async tryResolver(player: Player, src: Track): Promise<Track | null> {
    return this.fallbacks.tryResolver(player, src);
  }

  private async findAlternatePlayableTrack(
    manager: Manager,
    player: Player,
    failedTrack: Track | null | undefined,
    guildId: string,
    failedKey: string,
    err?: unknown,
  ): Promise<Track | null> {
    return this.fallbacks.findAlternatePlayableTrack(manager, player, failedTrack, guildId, failedKey, err);
  }

  private registerMoonlinkEvents(): void {
    const manager = this.moonlinkManager.getManager();

    manager.on('trackStart', async (player: Player, track: Track) => {
      // New activity cancels any pending idle disconnect.
      this.clearInactivityTimeout(player.guildId);
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
          }, 15000),
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
        await this.resolveKaraokeLines(player, currentTrack.title, currentTrack.author, currentTrack.duration);
        this.resolveVideoChapters(player, player.current ?? track);
        // The REAL position, not a hardcoded 0: a track that starts part-way
        // through (fallback resume, a restored session) must render the chapter
        // it is actually on.
        const chapter = this.chapterCardFor(player, this.queueService.calculatePosition(player));
        // Same cover resolution the publisher uses, so the first post and
        // every later edit agree on what is on screen (and on the key).
        const postedCover = chapter?.artworkUrl ?? queue.current?.artworkUrl ?? null;
        // Accent follows the displayed cover (chapter art when present),
        // mirroring the on-demand publisher below.
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(player.guildId, postedCover)
          : undefined;
        const postedLyric = this.lyricWindowFor(player, 0);
        const response = MusicBuilders.buildNowPlayingResponse(
          queue,
          accentColor,
          postedLyric,
          chapter,
        );

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
            Logger.warn({ err, guildId: player.guildId }, 'Failed to dispatch trackStart Now Playing card via toMessagePayload, falling back to embeds');
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
          const postedChapterKey = MusicHandler.chapterKeyFor(chapter, postedCover);
          this.progressFingerprints.set(
            player.guildId,
            MusicHandler.fingerprintFor(queue, postedLyricKey, postedChapterKey),
          );
          // Event-driven card: arm boundary timers instead of polling.
          this.updateChapterStatus(player);
          this.armKaraokeTimer(player);
          this.armChapterTimer(player);
        }
      } catch (err) {
        Logger.warn({ err, guildId: player.guildId }, 'Failed to dispatch trackStart Now Playing card');
      }
    });

    // Emitted synchronously by Player#seek for every seek call site, before
    // the REST round-trip — the earliest reliable seek signal (stock
    // Lavalink v4 does not send a SeekEvent back over the websocket).
    manager.on('playerTriggeredSeek', (player: Player, position: number) => {
      this.swapChapterOnSeek(player, position);
      // Position jumped — boundary timers armed to the old clock are wrong.
      this.armKaraokeTimer(player);
      this.armChapterTimer(player);
    });

    // Node-initiated seek (Lavalink's own recovery, a remote restart, a
    // dashboard jump). moonlink applies the new position but leaves
    // current.time at the last update, so the position calculator keeps
    // extrapolating from a stale base for up to a minute and can cross a
    // chapter boundary early. Re-stamp the clock and swap the chapter.
    manager.on('playerSeek', (player: Player, position: number) => {
      try {
        const cur = player.current as unknown as { position?: unknown; time?: unknown } | null;
        if (cur) {
          cur.position = position;
          cur.time = Date.now();
        }
        this.swapChapterOnSeek(player, position);
        this.armKaraokeTimer(player);
        this.armChapterTimer(player);
        this.scheduleImmediateProgress(player);
      } catch {
        // Never break playback.
      }
    });

    manager.on('trackEnd', (player: Player, track: Track, reason: string) => {
      Logger.debug(
        `[Music] Track ended in guild ${player.guildId}: "${track.title}" (reason: ${reason})`,
      );
      this.clearCardTimers(player.guildId);
      this.clearOkTimer(player.guildId);

      // The card dies with the song — no lingering until disconnect. The
      // next trackStart posts a fresh card (its delete-prev no-ops).
      const endMsgId = player.get<string>('nowPlayingMessageId');
      const endChannelId = player.textChannelId;
      this.forgetNowPlaying(player);
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
          this.isSongExhausted(player.guildId, track);
        }
      }

      if (player.voiceChannelId && this.botScrobblingService) {
        void this.botScrobblingService.handleTrackEnd(this.client, player.guildId, player.voiceChannelId);
      }
    });

    manager.on('trackStuck', async (player: Player, track: Track, threshold: number) => {
      // No clearCardTimers here: a stall often resolves on the SAME
      // track (re-seek below, or Moonlink's own nudge), and the fingerprint
      // dirty-check already suppresses useless edits while frozen. Stopping
      // it would freeze the card + progress bar permanently for recovered
      // playback — terminal paths (trackEnd/queueEnd/playerDestroy) stop it.
      this.clearOkTimer(player.guildId);

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
        Date.now() - lastSeekAt < MusicHandler.SEEK_GRACE_WINDOW_MS &&
        isLiveVideo(track.duration) &&
        stillCurrent()
      ) {
        const graceSeekAt = player.get<number>('seekStallGraceSeekAt') ?? 0;
        const graceUsed = graceSeekAt === lastSeekAt ? (player.get<number>('seekStallGraceUsed') ?? 0) : 0;
        if (graceUsed < MusicHandler.MAX_SEEK_GRACE_STUCKS) {
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

      if (this.isSongExhausted(player.guildId, track)) {
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
      if (!this.checkFallbackBudget(player.guildId, failedKeyStr)) {
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
        fallback = await this.findAlternatePlayableTrack(manager, player, track, player.guildId, failedKeyStr);
      } finally {
        this.inFlightFallbacks.delete(player.guildId);
      }
      if (fallback) {
        const resumeMs = this.frozenPosition(player);
        player.queue.unshift(fallback);
        Logger.info({ guildId: player.guildId, track: track.title }, `[Music] Alternate upload queued for stuck track — advancing to it.`);
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
        await this.resumeFallbackAt(player, fallback, resumeMs);
        return;
      }

      Logger.warn(
        { guildId: player.guildId, track: track.title, threshold },
        `[Music] Track stuck (${threshold}ms) — no alternate upload, leaving Moonlink recovery to handle it.`,
      );
    });


    manager.on('trackException', async (player: Player, track: Track, exception: unknown) => {
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
      this.clearOkTimer(player.guildId);

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

      if (this.isSongExhausted(player.guildId, track)) {
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
      if (!this.checkFallbackBudget(player.guildId, failedKeyStr)) {
        Logger.warn(
          { guildId: player.guildId, track: track.title },
          `[Music] Fallback budget exhausted for failed track — skipping past it.`,
        );
        await skipPastFailed();
        return;
      }

      const failureClients = MusicHandler.clientFailuresText(
        (exception as { message?: unknown } | null)?.message,
      );
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
        fallback = await this.findAlternatePlayableTrack(manager, player, track, player.guildId, failedKeyStr, exception);
      } finally {
        this.inFlightFallbacks.delete(player.guildId);
      }
      if (fallback) {
        // Inject at the front of the queue so it plays next, then advance to it —
        // Moonlink only auto-skips fault-severity exceptions, so common-severity
        // YouTube failures (unavailable/age-restricted/blocked) would stall forever.
        const resumeMs = this.frozenPosition(player);
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
          await this.resumeFallbackAt(player, fallback, resumeMs);
          return;
        }
        await skipPastFailed();
        await this.resumeFallbackAt(player, fallback, resumeMs);
        return;
      }

      Logger.error(
        { err: exception, guildId: player.guildId, track: track.title },
        `[Music] Track exception in guild ${player.guildId} — no alternate upload, skipping past failed track.`,
      );
      await skipPastFailed();
    });


    manager.on('queueEnd', (player: Player) => {
      Logger.info(`[Music] Queue ended in guild ${player.guildId}`);
      this.clearCardTimers(player.guildId);
      this.clearFallbackState(player.guildId);

      if (player.voiceChannelId && this.voiceChannelStatusService) {
        void this.voiceChannelStatusService.clearStatus(player.voiceChannelId);
      }

      const is247 = this.queueService.is247(player.guildId);
      if (!is247 && !player.autoPlay) {
        // Auto-disconnect after 3 minutes of inactivity (own map — never
        // clobbered by the empty-voice-channel timer, and always cleaned up).
        this.clearInactivityTimeout(player.guildId);
        const timeout = setTimeout(() => {
          this.inactivityTimeouts.delete(player.guildId);
          if (player.queue.isEmpty && !player.playing) {
            Logger.info(`[Music] Inactivity timeout: disconnecting player in guild ${player.guildId}`);
            player.destroy('Inactivity timeout').catch(() => undefined);
          }
        }, 180000);
        this.inactivityTimeouts.set(player.guildId, timeout);
      }
    });

    manager.on('playerDestroy', async (player: Player) => {
      this.clearCardTimers(player.guildId);
      this.clearOkTimer(player.guildId);
      this.clearFallbackState(player.guildId);
      this.clearKickGrace(player.guildId);
      this.clearInactivityTimeout(player.guildId);
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
    });
  }

  /** Discord voice/channel/guild lifecycle — see music/voiceLifecycle.ts.
   * The three timer Maps stay owned here and are passed in by reference. */
  private readonly voice: VoiceLifecycle;

  private clearKickGrace(guildId: string): void {
    this.voice.clearKickGrace(guildId);
  }

  private clearInactivityTimeout(guildId: string): void {
    this.voice.clearInactivityTimeout(guildId);
  }

  private registerDiscordEvents(): void {
    this.voice.register();
  }

  /**
   * Everything this handler holds for one guild. GuildDelete used to clear
   * timers and fallback state but left the card fingerprints, the chapter
   * status memo, the publish bookkeeping and the coalescing sets behind, so a
   * bot that churns through guilds accumulates them for the process lifetime.
   */
  private forgetGuild(guildId: string): void {
    this.clearCardTimers(guildId);
    this.clearFallbackState(guildId);
    this.clearKickGrace(guildId);
    this.clearInactivityTimeout(guildId);
    this.clearOkTimer(guildId);
    this.progressFingerprints.delete(guildId);
    this.progressPublishing.delete(guildId);
    this.publishRetries.delete(guildId);
    this.pendingPublish.delete(guildId);
    this.inFlightFallbacks.delete(guildId);
    this.lastChapterStatus.delete(guildId);
    this.guildFallbackBudget.delete(guildId);
    this.triedFallbackIds.delete(guildId);
    const empty = this.emptyChannelTimeouts.get(guildId);
    if (empty) {
      clearTimeout(empty);
      this.emptyChannelTimeouts.delete(guildId);
    }
  }
}
