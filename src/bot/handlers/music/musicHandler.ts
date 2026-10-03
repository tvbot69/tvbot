
import type { Manager, Player } from 'moonlink.js';
import { Track } from 'moonlink.js';
import { Logger } from '@domain/logging/logger';
import { FallbackBudget } from '@bot/handlers/music/fallbackBudget';
import { KaraokeController, type KaraokeHost } from '@bot/handlers/music/karaokeController';
import { NowPlayingCardPublisher, type CardPublisherHost } from '@bot/handlers/music/nowPlayingCardPublisher';
import { ChapterArtController, type ChapterArtHost } from '@bot/handlers/music/chapterArtController';
import { AlternateTrackFinder } from '@bot/handlers/music/alternateTrackFinder';
import { VoiceLifecycle, type VoiceLifecycleHost } from '@bot/handlers/music/voiceLifecycle';
import { ChapterTimeline, type ChapterTimelineHost } from '@bot/handlers/music/chapterTimeline';
import { MusicEventListeners, type EventListenerHost } from '@bot/handlers/music/musicEventListeners';
import { chapterKeyFor, clientFailuresText, fingerprintFor } from '@bot/handlers/music/cardFingerprint';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import type { ColorService } from '@bot/services/system/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { ArtworkService } from '@bot/services/media/artworkService';
import type { LyricWindow } from '@bot/services/music/syncedLyrics';
import {
  extractArtistFromTitle,
  getVideoTitle,
  type ChapterCard,
  type VideoChapter,
} from '@bot/services/music/videoChapters';
import { cleanTrackTitle } from '@domain/models/music/musicTrack';


import type { Client } from 'discord.js';

/**
 * The playback presentation host.
 *
 * Every collaborator below was extracted out of this class and is handed
 * `this` as its host, which is why the handler `implements` all six host
 * interfaces rather than being cast into them. The `this as unknown as X`
 * casts this replaces were load-bearing lies: they silenced the one check that
 * would have caught a renamed delegate at compile time, and every one of them
 * sat on a constructor line where a mismatch produced a collaborator pointing
 * at a method the handler no longer had — a `TypeError` at the first event,
 * not at build.
 *
 * The widened members are exactly the six hosts' surfaces. They stay the SAME
 * delegates on the SAME object, which is the part the suite depends on: tests
 * reach privates through `as unknown as {...}` casts and replace methods or
 * services as own properties, and every collaborator calls back through
 * `host.<member>` so those shadows still intercept. Nothing here moved, was
 * wrapped, or started being captured by value.
 */
export class MusicHandler implements
  CardPublisherHost,
  VoiceLifecycleHost,
  ChapterArtHost,
  KaraokeHost,
  EventListenerHost,
  ChapterTimelineHost {
  public readonly client: Client;
  public readonly moonlinkManager: MoonlinkManager;
  public readonly queueService: QueueService;
  public readonly colorService?: ColorService;
  public readonly voiceChannelStatusService?: VoiceChannelStatusService;
  public readonly botScrobblingService?: BotScrobblingService;
  public readonly lyricsService?: LyricsService;
  public readonly artworkService?: ArtworkService;
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
      this,
      this.progressNudgeTimers,
      this.progressPublishing,
      this.progressFingerprints,
      this.publishRetries,
      this.pendingPublish,
    );
    this.voice = new VoiceLifecycle(
      this,
      this.kickGraceTimeouts,
      this.emptyChannelTimeouts,
      this.inactivityTimeouts,
    );
    this.chapterArt = new ChapterArtController(this, this.chapterArtRetryTimers);
    this.karaoke = new KaraokeController(this, this.karaokeTimers);
    this.fallbackBudget = new FallbackBudget(
      this.fallbackAttempts,
      this.guildFallbackBudget,
      this.triedFallbackIds,
      this.songFailureCounts,
    );
    this.listeners = new MusicEventListeners(
      this,
      this.moonlinkManager,
      this.queueService,
      this.client,
      this.colorService,
      this.voiceChannelStatusService,
      this.botScrobblingService,
      this.okTimers,
      this.progressFingerprints,
      this.inFlightFallbacks,
      this.emptyChannelTimeouts,
      this.inactivityTimeouts,
      this.pendingPublish,
      this.progressPublishing,
    );
    this.chapterTimeline = new ChapterTimeline(this, this.chapterArt);
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
  private readonly chapterTimeline: ChapterTimeline;

  public resolveVideoChapters(player: Player, track: Track | null | undefined): void {
    this.chapterTimeline.resolveVideoChapters(player, track);
  }

  public chapterCardFor(player: Player, positionMs: number): ChapterCard | null {
    return this.chapterTimeline.chapterCardFor(player, positionMs);
  }

  public swapChapterOnSeek(player: Player, positionMs: number): void {
    this.chapterTimeline.swapChapterOnSeek(player, positionMs);
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

  /** 15s node-health survival probe, armed on trackStart. */
  private readonly okTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Live read-only views for tests. Maps stay owned here — no copy, so
   * `forgetGuild` sweeps and timer identity stay intact. Tests read through
   * these instead of `as unknown as` casts reaching privates.
   */
  public get progressPublishingView(): Map<string, number> {
    return this.progressPublishing;
  }

  public get progressFingerprintsView(): Map<string, string> {
    return this.progressFingerprints;
  }

  public get karaokeTimersView(): Map<string, NodeJS.Timeout> {
    return this.karaokeTimers;
  }

  public get chapterTimersView(): Map<string, NodeJS.Timeout> {
    return this.chapterTimers;
  }

  public get publishRetriesView(): Map<string, number> {
    return this.publishRetries;
  }

  public get progressNudgeTimersView(): Map<string, NodeJS.Timeout> {
    return this.progressNudgeTimers;
  }

  public get okTimersView(): Map<string, NodeJS.Timeout> {
    return this.okTimers;
  }

  public get songFailureCountsView(): Map<string, { count: number; firstAt: number }> {
    return this.songFailureCounts;
  }

  public clearCardTimers(guildId: string): void {
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

  public lyricWindowFor(player: Player, positionMs: number, startupOffsetMs?: number): LyricWindow | null {
    return this.karaoke.lyricWindowFor(player, positionMs, startupOffsetMs);
  }

  public async resolveKaraokeLines(
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

  public armKaraokeTimer(player: Player): void {
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
  public armChapterTimer(player: Player): void {
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
  public updateChapterStatus(player: Player): void {
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
          // CORRECT AS IS: a refused status write is decoration, and it
          // costs at most one stale label — the change-gate key above was
          // already set, so this particular key is not retried, but the next
          // chapter change writes a fresh one. The CARD is the source of
          // truth and is unaffected.
          void svc.setStatus(player.voiceChannelId, displayTitle, artist).catch(() => undefined);
        }
        return;
      }
      const artist = extractArtistFromTitle(getVideoTitle(cur)) ?? cur?.author;
      // Same reasoning as the fallback branch above: one lost write is one
      // stale label, not a wrong claim about what is playing.
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

  public clearOkTimer(guildId: string): void {
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
        // CORRECT AS IS: a courtesy one-liner (queue cap, skipped tracks).
        // The state that produced it is already logged and the chunk manager
        // already recorded the skip count, so a lost notice degrades to
        // silence rather than to a wrong count. The outer catch logs the
        // synchronous failures; this one covers the async send.
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

  public async publishProgress(player: Player): Promise<void> {
    return this.cards.publishProgress(player);
  }

  public forgetNowPlaying(player: Player): void {
    this.cards.forgetNowPlaying(player);
  }

  public scheduleImmediateProgress(player: Player, delayMs = 300): void {
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

  public checkFallbackBudget(guildId: string, failedKey: string): boolean {
    return this.fallbackBudget.checkFallbackBudget(guildId, failedKey);
  }

  private recordFallbackAttempt(guildId: string, failedKey: string, fallbackId?: string): void {
    return this.fallbackBudget.recordFallbackAttempt(guildId, failedKey, fallbackId);
  }

  public clearFallbackState(guildId: string): void {
    return this.fallbackBudget.clearFallbackState(guildId);
  }

  public isSongExhausted(guildId: string, track: Track): boolean {
    return this.fallbackBudget.isSongExhausted(guildId, track);
  }

  /** Alternate-track ladder — see music/alternateTrackFinder.ts. */
  private readonly fallbacks: AlternateTrackFinder;

  public frozenPosition(player: Player): number {
    return this.fallbacks.frozenPosition(player);
  }

  public async resumeFallbackAt(player: Player, fallback: Track, resumeMs: number): Promise<void> {
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

  public async findAlternatePlayableTrack(
    manager: Manager,
    player: Player,
    failedTrack: Track | null | undefined,
    guildId: string,
    failedKey: string,
    err?: unknown,
  ): Promise<Track | null> {
    return this.fallbacks.findAlternatePlayableTrack(manager, player, failedTrack, guildId, failedKey, err);
  }

  /** Moonlink event listeners — see music/musicEventListeners.ts.
   * One named method per event; every Map stays owned here and is passed in
   * by reference, and all cross-cluster calls go through the host. */
  private readonly listeners: MusicEventListeners;

  private registerMoonlinkEvents(): void {
    this.listeners.register();
  }

  /** Discord voice/channel/guild lifecycle — see music/voiceLifecycle.ts.
   * The three timer Maps stay owned here and are passed in by reference. */
  private readonly voice: VoiceLifecycle;

  public clearKickGrace(guildId: string): void {
    this.voice.clearKickGrace(guildId);
  }

  public clearInactivityTimeout(guildId: string): void {
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
  public forgetGuild(guildId: string): void {
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
