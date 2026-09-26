import { Client, Events, VoiceChannel, StageChannel } from 'discord.js';
import type { Manager, Player } from 'moonlink.js';
import { Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { ArtworkService } from '@bot/services/artworkService';
import { lyricWindowAt, type LyricWindow, type SyncedLine } from '@bot/services/music/syncedLyrics';
import {
  chapterIndexAt,
  extractArtistFromTitle,
  getSourceVideoId,
  getVideoTitle,
  isLiveVideo,
  isGenericChapterTitle,
  resolveDisplayedChapter,
  splitChapterTitle,
  transitionLeadSong,
  type ChapterCard,
  type VideoChapter,
} from '@bot/services/music/videoChapters';
import { getVideoChapters } from '@bot/services/music/ytResolver';
import { cleanTrackTitle, mapMoonlinkTrack } from '@domain/models/music/musicTrack';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';
import { healthFor, ladderFor, YoutubeHealth, HOME_NODE } from '@bot/services/music/youtubeHealth';
import { resolveViaHome } from '@bot/services/music/ytResolver';

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
  /** Last chapter title pushed to voice status per guild (change-gated). */
  private readonly lastChapterStatus = new Map<string, string | null>();
  // Debounced on-demand publishes (chapter attach / art resolve bursts
  // collapse into one edit). No polling behind it.
  private readonly progressNudgeTimers = new Map<string, NodeJS.Timeout>();
  private readonly progressPublishing = new Map<string, number>();
  /** Consecutive failed publishes per guild (bounded retry budget). */
  private readonly publishRetries = new Map<string, number>();
  private static readonly MAX_PUBLISH_RETRIES = 3;
  /**
   * A publish whose awaited work hangs (REST stall) must never wedge the card
   * forever: a guard older than this is treated as dead and retaken, so the
   * next trigger publishes instead of skipping.
   */
  private static readonly PUBLISH_STALL_MS = 30000;
  private static readonly KICK_GRACE_MS = 180000;

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

    this.registerMoonlinkEvents();
    this.registerDiscordEvents();
  }

  /**
   * Karaoke window for the card at a playback position. Reads the synced
   * lines stored at track start; honors the per-guild toggle. Lyrics follow
   * the real clock with no startup offset. Null when disabled, missing, or
   * nothing singable (card renders unchanged).
   */
  private static readonly CLOCK_STARTUP_OFFSET_MS = 3000;

  private lyricWindowFor(player: Player, positionMs: number): LyricWindow | null {
    try {
      if (!this.lyricsService) return null;
      if (!this.queueService.isKaraokeEnabled(player.guildId)) return null;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return null;
      return lyricWindowAt(lines, Math.max(0, positionMs));
    } catch {
      return null;
    }
  }

  /**
   * Resolves synced lines once per track start (bounded, never stalls the
   * card) and stores them on the player for the karaoke boundary timer.
   */
  private async resolveKaraokeLines(player: Player, title: string, artist: string, durationMs: number): Promise<void> {
    player.set('karaokeLines', null);
    if (!this.lyricsService) return;
    if (!this.queueService.isKaraokeEnabled(player.guildId)) return;
    if (!title || !artist) return;
    try {
      const lines = await Promise.race([
        this.lyricsService.getSyncedLyrics(title, artist, durationMs).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      if (lines && lines.length > 0) player.set('karaokeLines', lines);
    } catch {
      // No synced lyrics — standard card without the section.
    }
  }

  /**
   * Kicks off a chapter probe for a YouTube track (fire-and-forget: the card
   * goes out immediately and upgrades when chapters land). Only videos with
   * 2+ chapters qualify — a single chapter carries no segmentation info.
   * Resolver-side caching makes repeat plays free. Warms the first covers
   * so chapter one rarely starts cold.
   */
  private resolveVideoChapters(player: Player, track: Track | null | undefined): void {
    const rec = track as unknown as { sourceName?: string; identifier?: string } | null;
    const id = getSourceVideoId(rec);
    // Same video restarting (double trackStart, replay, loop): keep the
    // attached chapters, card and index — the trackStart post renders them
    // immediately instead of gaping through a wipe + re-probe.
    if (id && id === player.get<string>('chapterSourceId')) return;
    // Generation token: a slow probe from a skipped track must never attach
    // its chapters (or covers) to the next track. Bumped synchronously on
    // every track so orphans always fail the check below.
    const chapterToken = (player.get<number>('chapterToken') ?? 0) + 1;
    player.set('chapterToken', chapterToken);
    player.set('chapterSourceId', null);
    player.set('chapters', null);
    player.set('chapterIdx', -2);
    player.set('chapterCard', null);
    player.set('lastCoverUrl', null);
    player.set('chapterStartedAt', null);
    try {
      // Standalone live gate: chapters probe ONLY for long videos. Short
      // tracks and Spotify-link plays return here with zero probe cost and
      // byte-identical behavior to before the live system existed.
      if (!isLiveVideo(track?.duration)) return;
      if (!id) {
        Logger.debug({ guildId: player.guildId, title: track?.title }, '[Music] Chapter probe skipped — no video id');
        return;
      }
      const probeStartedAt = Date.now();
      void (async () => {
        try {
          const chapters = await getVideoChapters(id);
          if (player.get<number>('chapterToken') !== chapterToken) return;
          if (chapters && chapters.length >= 2) {
            player.set('chapterSourceId', id);
            player.set('chapters', chapters);
            Logger.info(
              { guildId: player.guildId, chapters: chapters.length, probeMs: Date.now() - probeStartedAt },
              '[Music] Video chapters attached',
            );
            this.prefetchChapterArts(player, chapters, [0, 1, 2]);
            // Chapters landed after track start (the trackStart timer check
            // found nothing) — arm following now, or transitions never fire.
            this.armChapterTimer(player);
            // Publish the chapter card now instead of waiting for a boundary
            // timer — the card is ready the moment chapters land.
            this.scheduleImmediateProgress(player);
          }
          // null (transient probe failure) deliberately does NOT retry here:
          // both cache layers negative-cache misses for 10 minutes, so a
          // quick retry could never succeed — the next track re-probes.
        } catch {
          // Plain card — chapters are decoration, never load-bearing.
        }
      })();
    } catch {
      // Plain card.
    }
  }

  /**
   * Cover lookup for a chapter with the transition fallback: medley
   * chapters ("BACKR00MS TO KICK OUT" — A fading into B) have no Spotify
   * track under the full title, so when it misses, retry with the
   * transition's lead song — its cover matches the chapter start. Real
   * songs ("Back To December", "NO BYSTANDERS") hit on the first attempt
   * and never reach the fallback.
   */
  private async getChapterCover(chapterTitle: string, song: string, artist: string | undefined): Promise<string | null> {
    const svc = this.artworkService;
    if (!svc) return null;
    const art = await svc.getTrackCoverUrl(song, artist).catch(() => null);
    if (art) return art;
    const lead = transitionLeadSong(chapterTitle);
    if (!lead || lead.toLowerCase() === song.trim().toLowerCase()) return null;
    Logger.debug({ chapter: chapterTitle, lead }, '[Music] Transition chapter — retrying art with lead song');
    return svc.getTrackCoverUrl(lead, artist).catch(() => null);
  }

  /**
   * Warms the shared artwork cache for upcoming chapters so their covers
   * are usually ready before the chapter starts. Results are discarded —
   * the cache (not player state) carries them to resolveChapterArt.
   * Bounded to a couple of chapters per call; misses stay cheap via the
   * cascade's own negative caching.
   */
  private prefetchChapterArts(player: Player, chapters: VideoChapter[], indices: number[]): void {
    try {
      const svc = this.artworkService;
      if (!svc) return;
      const cur = player.current as unknown as { title?: string } | null;
      const videoArtist = extractArtistFromTitle(getVideoTitle(cur)) ?? undefined;
      for (const i of indices) {
        const ch = chapters[i];
        if (!ch || isGenericChapterTitle(ch.title)) continue;
        const { artist, song } = splitChapterTitle(ch.title);
        if (!song) continue;
        // Warm the accent color alongside the cover: the art edit extracts
        // color from this exact URL, and downloading+quantizing serially
        // inside the publish path used to add seconds to every swap.
        void (async () => {
          const art = await this.getChapterCover(ch.title, song, artist ?? videoArtist);
          if (art && this.colorService) {
            await this.colorService.getAccentColorAsync(player.guildId, art).catch(() => undefined);
          }
        })();
      }
    } catch {
      // Prefetch is best-effort by definition.
    }
  }

  /**
   * Display-ready chapter card for the current position. Advances with
   * playback; on a chapter change it stages the title immediately and
   * resolves that chapter's cover in the background (late-attach via the
   * fingerprint). A missed cover is retried at most every 30s while the
   * chapter plays (the first attempt often loses to a cold provider
   * cascade). Generic container titles (Intro/Outro/...) suppress the card
   * but still warm the first real song's cover so shows open on music art.
   */
  private chapterCardFor(player: Player, positionMs: number): ChapterCard | null {
    try {
      const chapters = player.get<VideoChapter[] | null>('chapters');
      if (!chapters || chapters.length < 2) return player.get<ChapterCard | null>('chapterCard') ?? null;
      const idx = chapterIndexAt(chapters, Math.max(0, positionMs), MusicHandler.CLOCK_STARTUP_OFFSET_MS);
      const lastIdx = player.get<number>('chapterIdx') ?? -2;
      if (idx === lastIdx) {
        const stored = player.get<ChapterCard | null>('chapterCard') ?? null;
        // Generic chapters never display a card, so their art can never
        // attach — measured on Railway: a suppressed "08 DJ Intro" burned a
        // 2s cascade miss every 30s retry for nothing.
        if (!stored?.artworkUrl && idx >= 0 && !isGenericChapterTitle(chapters[idx]?.title)) {
          const retry = player.get<{ idx: number; at: number } | null>('chapterArtRetry');
          if (!retry || retry.idx !== idx || Date.now() - retry.at > 30000) {
            player.set('chapterArtRetry', { idx, at: Date.now() });
            void this.resolveChapterArt(player, idx, chapters);
          }
        }
        return stored;
      }
      player.set('chapterIdx', idx);
      player.set('chapterStartedAt', Date.now());
      const ch = idx >= 0 ? chapters[idx] : undefined;
      if (!ch || isGenericChapterTitle(ch.title)) {
        const hadCard = player.get<ChapterCard | null>('chapterCard') ?? null;
        player.set('chapterCard', null);
        if (hadCard) {
          Logger.debug({ guildId: player.guildId, chapter: hadCard.title }, '[Music] Chapter card cleared (generic/no chapter)');
        }
        // Hype/intro chapters stay off the card, but the show should still
        // open on the first real song's cover: warm it cover-only (title
        // untouched) so the gallery never sits bare behind the intro.
        const upcomingIdx = chapters.findIndex((c, i) => i > idx && !isGenericChapterTitle(c.title));
        if (upcomingIdx >= 0) {
          const retry = player.get<{ idx: number; at: number } | null>('chapterArtRetry');
          if (!retry || retry.idx !== upcomingIdx || Date.now() - retry.at > 30000) {
            player.set('chapterArtRetry', { idx: upcomingIdx, at: Date.now() });
            void this.resolveChapterArt(player, upcomingIdx, chapters, true);
          }
        }
        return null;
      }
      const card: ChapterCard = { title: ch.title, artworkUrl: null };
      player.set('chapterCard', card);
      player.set('chapterArtRetry', { idx, at: Date.now() });
      void this.resolveChapterArt(player, idx, chapters);
      this.prefetchChapterArts(player, chapters, [idx + 1, idx + 2]);
      return card;
    } catch {
      return null;
    }
  }

  private async resolveChapterArt(
    player: Player,
    idx: number,
    chapters: VideoChapter[],
    coverOnly = false,
  ): Promise<void> {
    // Generation captured before the cascade: a track change mid-resolve
    // must not paint this cover onto the next track's card.
    const chapterToken = player.get<number>('chapterToken');
    try {
      const ch = chapters[idx];
      if (!ch) return;
      const { artist, song } = splitChapterTitle(ch.title);
      if (!song) return;
      // Song-only chapters ("Rottweiler") carry no artist; fall back to the
      // performer named in the VIDEO title ("EsDeeKid - Live..."), since the
      // uploader channel often differs (or is useless) for lives.
      let useArtist = artist;
      if (!useArtist) {
        const cur = player.current as unknown as { title?: string } | null;
        useArtist = extractArtistFromTitle(getVideoTitle(cur)) ?? undefined;
      }
      const svc = this.artworkService;
      if (!svc) return;
      const artStartedAt = Date.now();
      const art = await Promise.race([
        this.getChapterCover(ch.title, song, useArtist),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      Logger.info(
        { guildId: player.guildId, idx, song, artMs: Date.now() - artStartedAt, ok: Boolean(art) },
        '[Music] Chapter art',
      );
      if (!art) return;
      // Only publish if the listener hasn't moved on meanwhile (track
      // generation AND chapter index — a list swap mid-resolve must not
      // paint the wrong cover).
      if (player.get<number>('chapterToken') !== chapterToken) return;
      if (coverOnly) {
        // Opening hype: show the first real song's cover WITHOUT naming it
        // (the card stays on the show until its chapter starts). The hold
        // rule picks it up on the next publish.
        player.set('lastCoverUrl', art);
        this.scheduleImmediateProgress(player);
        return;
      }
      if ((player.get<number>('chapterIdx') ?? -2) !== idx) return;
      player.set('chapterCard', { title: ch.title, artworkUrl: art });
      // Art landed with no publish scheduled — push the swap immediately.
      this.scheduleImmediateProgress(player);
    } catch {
      // Card keeps the track art.
    }
  }

  /**
   * Seek = instant chapter swap. Natural chapter transitions are caught by
   * the chapter boundary timer; a user seek that crosses a boundary used to
   * wait for it and then pay a cold art cascade (~3-5s before the cover
   * sat). Fires for every Player.seek() — user seeks, stall re-seeks,
   * fallback resume — but only a chapter change does work; same-chapter
   * seeks no-op.
   */
  private swapChapterOnSeek(player: Player, positionMs: number): void {
    try {
      const chapters = player.get<VideoChapter[] | null>('chapters');
      if (!chapters || chapters.length < 2) return;
      const idx = chapterIndexAt(chapters, Math.max(0, positionMs), MusicHandler.CLOCK_STARTUP_OFFSET_MS);
      if (idx === (player.get<number>('chapterIdx') ?? -2)) return;
      player.set('chapterIdx', idx);
      player.set('chapterStartedAt', Date.now());
      const ch = idx >= 0 ? chapters[idx] : undefined;
      if (!ch || isGenericChapterTitle(ch.title)) {
        player.set('chapterCard', null);
      } else {
        player.set('chapterCard', { title: ch.title, artworkUrl: null });
        player.set('chapterArtRetry', { idx, at: Date.now() });
        void this.resolveChapterArt(player, idx, chapters);
      }
      // Target ±1: backward seeks replay what a forward pass warmed;
      // forward seeks need idx+1/idx+2. idx itself warms the accent color
      // for the art swap about to resolve.
      this.prefetchChapterArts(
        player,
        chapters,
        [idx - 1, idx, idx + 1, idx + 2].filter((i) => i >= 0 && i < chapters.length),
      );
      this.scheduleImmediateProgress(player);
    } catch {
      // Chapter swap is decoration — never break the seek.
    }
  }

  private readonly progressFingerprints = new Map<string, string>();
  /**
   * Visible card fingerprint: track, pause state, queue shape, karaoke
   * window and chapter. On-demand publishes edit only on change; trackStart
   * syncs it to the posted card so a same-track re-post neither double-
   * publishes identical state nor suppresses the next real change.
   */
  private static fingerprintFor(
    queue: MusicQueueInfo,
    lyricKey: string,
    chapterKey: string,
  ): string {
    return [
      queue.current?.identifier ?? queue.current?.uri ?? 'none',
      queue.isPaused ? 'p' : 'r',
      queue.tracks.length,
      queue.loopMode,
      queue.volume,
      lyricKey,
      chapterKey,
    ].join('|');
  }
  // Event-driven card: no polling. Boundary one-shots (karaoke/chapter)
  // re-evaluate their section at the exact moment it changes, and an edit
  // only goes out when the fingerprint (track, state, lyric window, chapter)
  // actually changed — quiet stretches cost zero edits.
  private readonly okTimers = new Map<string, NodeJS.Timeout>();

  /** Clears every per-guild card timer (nudge, karaoke, chapter). */
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

  private clearKaraokeTimer(guildId: string): void {
    const timer = this.karaokeTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.karaokeTimers.delete(guildId);
    }
  }

  private clearChapterTimer(guildId: string): void {
    const timer = this.chapterTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.chapterTimers.delete(guildId);
    }
  }

  /**
   * Arms a one-shot to the next lyric-line boundary. Fires -> publish (the
   * fingerprint admits the edit only when the window actually changed) ->
   * re-arm. Paused/frozen clocks get a cheap 15s recheck instead of a hot
   * loop; the silence between lines costs zero edits and zero work.
   */
  private armKaraokeTimer(player: Player): void {
    this.clearKaraokeTimer(player.guildId);
    try {
      if (!this.lyricsService) return;
      if (!this.queueService.isKaraokeEnabled(player.guildId)) return;
      const lines = player.get<SyncedLine[] | null>('karaokeLines');
      if (!lines || lines.length === 0) return;
      const position = this.queueService.calculatePosition(player);
      const next = lines.find((l) => l.ms > position);
      if (!next) return;
      let delay = next.ms - position;
      if (player.paused || delay < 0) delay = 15000;
      const timer = setTimeout(() => {
        this.karaokeTimers.delete(player.guildId);
        try {
          void this.publishProgress(player);
        } catch {
          // Timer errors must never break the chain below.
        }
        this.armKaraokeTimer(player);
      }, Math.max(delay, 1500));
      timer.unref?.();
      this.karaokeTimers.set(player.guildId, timer);
    } catch {
      // Karaoke is decoration — never break playback.
    }
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
        if (cur?.title) void svc.setStatus(player.voiceChannelId, cur.title, cur.author).catch(() => undefined);
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
   * Publishes the now-playing card when its visible fingerprint changed.
   * Purely on-demand (track start, boundary timers, seeks, nudges) — there
   * is no polling loop. The fingerprint admits an edit only on real change.
   */
  private async publishProgress(player: Player): Promise<void> {
    const guildId = player.guildId;
    const guardSince = this.progressPublishing.get(guildId);
    if (guardSince !== undefined && Date.now() - guardSince < MusicHandler.PUBLISH_STALL_MS) return;
    this.progressPublishing.set(guildId, Date.now());
    try {
      if (!player.playing || !player.textChannelId) return;

      const msgId = player.get<string>('nowPlayingMessageId');
      if (!msgId) return;

      const queue = this.queueService.getQueueInfo(player);
      // Dirty check: skip the edit when nothing visible changed (same track,
      // pause state, queue size, loop, volume, karaoke window, chapter card).
      // There is no position bucket anymore — position is never displayed,
      // so movement alone must not cost an edit.
      const lyricWindow = this.lyricWindowFor(player, queue.position);
      const lyricKey = lyricWindow ? `${lyricWindow.current ?? ''}~${lyricWindow.next ?? ''}` : 'none';
      const chapter = this.chapterCardFor(player, queue.position);
      // Borrowed-cover expiry: holding the previous chapter's art avoids a
      // flash, but after ~90s without a resolve it looks like a confirmed
      // (wrong) answer. Fall through to track art instead.
      let holdCover = player.get<string | null>('lastCoverUrl') ?? null;
      if (chapter && !chapter.artworkUrl) {
        const startedAt = player.get<number | null>('chapterStartedAt') ?? null;
        if (typeof startedAt === 'number' && Date.now() - startedAt > 90000) {
          holdCover = null;
        }
      }
      const { card: displayChapter, shownCover } = resolveDisplayedChapter(
        chapter,
        holdCover,
        queue.current?.artworkUrl,
      );
      if (shownCover) player.set('lastCoverUrl', shownCover);
      const chapterKey = displayChapter ? `${displayChapter.title}~${displayChapter.artworkUrl ? 'a' : ''}` : 'none';
      const fingerprint = MusicHandler.fingerprintFor(queue, lyricKey, chapterKey);
      if (this.progressFingerprints.get(guildId) === fingerprint) return;

      const channel =
        this.client.channels.cache.get(player.textChannelId) ??
        (await this.client.channels.fetch(player.textChannelId).catch(() => null));
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return;

      const msgManager = (
        channel as unknown as {
          messages: {
            cache: { get: (id: string) => unknown };
            fetch: (id: string) => Promise<unknown>;
          };
        }
      ).messages;

      let unknownMessage = false;
      const msg = (msgManager.cache.get(msgId) ??
        (await msgManager.fetch(msgId).catch((err: { code?: number }) => {
          if (err?.code === 10008) unknownMessage = true;
          return null;
        }))) as {
        edit: (data: unknown) => Promise<unknown>;
      } | null;

      if (!msg) {
        if (unknownMessage) this.forgetNowPlaying(player);
        return;
      }

      // Accent follows the DISPLAYED cover (chapter art when present),
      // not just top-level track art — long-form tracks pin track art
      // to the video thumbnail while the card image follows chapters.
      const accentColor = this.colorService
        ? await this.colorService.getAccentColorAsync(player.guildId, shownCover ?? queue.current?.artworkUrl)
        : undefined;
      const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor, lyricWindow, displayChapter);

      // A hung edit settles nothing and would wedge the guard above: race
      // it so the publish always settles and the next trigger retries.
      // Successful publishes stay silent by design (no per-edit INFO spam).
      let editTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          msg.edit(response.toMessagePayload() as unknown as Record<string, unknown>),
          new Promise<never>((_, reject) => {
            editTimer = setTimeout(() => reject(new Error('Now-playing edit timed out')), 10000);
          }),
        ])
          .then(() => {
            this.progressFingerprints.set(guildId, fingerprint);
            this.publishRetries.delete(guildId);
            // Status follows successful edits only — updating it before the
            // edit permanently diverged room status from the card whenever
            // the edit failed (no tick retries it anymore).
            this.updateChapterStatus(player);
          })
          .catch((err: { code?: number }) => {
            if (err?.code === 10008) {
              this.publishRetries.delete(guildId);
              this.forgetNowPlaying(player);
              return;
            }
            // The card still exists but the edit failed (blip/rate-limit):
            // bounded retries so a chapter attach isn't lost to one bad
            // call. Boundary timers remain the steady-state retry path.
            const retries = (this.publishRetries.get(guildId) ?? 0) + 1;
            if (retries <= MusicHandler.MAX_PUBLISH_RETRIES) {
              this.publishRetries.set(guildId, retries);
              this.scheduleImmediateProgress(player, 5000);
            } else {
              this.publishRetries.delete(guildId);
            }
          });
      } finally {
        if (editTimer) clearTimeout(editTimer);
      }
    } catch {
      // Silently skip if rate limited or network hiccup
    } finally {
      this.progressPublishing.delete(guildId);
    }
  }

  /** The card was deleted out-of-band (user or channel cleanup) — stop ticking on a dead message id. */
  private forgetNowPlaying(player: Player): void {
    player.set('nowPlayingMessageId', null);
    this.progressFingerprints.delete(player.guildId);
    this.publishRetries.delete(player.guildId);
    Logger.debug({ guildId: player.guildId }, '[Music] Now-playing card gone — cleared card state');
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

  /**
   * Runs the card publish shortly after a state change (chapters attached,
   * chapter art resolved). Debounced per guild so bursts collapse into one
   * edit. The only deferred publish path — everything else is instant.
   */
  private scheduleImmediateProgress(player: Player, delayMs = 300): void {
    const guildId = player.guildId;
    const existing = this.progressNudgeTimers.get(guildId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.progressNudgeTimers.delete(guildId);
      void this.publishProgress(player);
    }, delayMs);
    this.progressNudgeTimers.set(guildId, timer);
  }

  private clearKickGrace(guildId: string): void {
    const grace = this.kickGraceTimeouts.get(guildId);
    if (grace) {
      clearTimeout(grace);
      this.kickGraceTimeouts.delete(guildId);
    }
  }

  private clearInactivityTimeout(guildId: string): void {
    const timeout = this.inactivityTimeouts.get(guildId);
    if (timeout) {
      clearTimeout(timeout);
      this.inactivityTimeouts.delete(guildId);
    }
  }

  /**
   * Builds a low-noise search query for fallback lookups.
   * Spotify display metadata is noisy ("Rauw Alejandro, Grand Theft Auto VI" as artist,
   * "(from GTAVI: The Album)" in the title) and full-noise queries return zero
   * SoundCloud hits. First billed artist + bracket-stripped title matches far better.
   */
  private buildFallbackQuery(track: Track | null | undefined): string | null {
    if (!track?.title || !track?.author) return null;
    const firstArtist =
      track.author
        .split(/[,/&]/)[0]
        ?.replace(/\s+(feat\.?|ft\.?|featuring|with|x)\s+.*$/i, '')
        .trim() || track.author;
    const strippedTitle =
      cleanTrackTitle(track.title, track.author)
        .replace(/\s*[([{\u3010].*?[)\]}\u3011]\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim() || track.title;
    return `${firstArtist} - ${strippedTitle}`;
  }

  /**
   * Compacts a Moonlink track exception into one log line per client
   * ("ANDROID_VR: requires login | WEB: no supported audio streams").
   * The old 300-char truncation hid every client except the first.
   */
  private static clientFailuresText(reason: unknown): string {
    const text = typeof reason === 'string' ? reason : String(reason ?? '');
    const hits = [...text.matchAll(/Client \[(\w+)\] failed: ([^\r\n]+)/g)].map(
      (m) => `${m[1] ?? '?'}: ${(m[2] ?? '').trim().replace(/\.$/, '')}`,
    );
    return hits.length > 0 ? hits.join(' | ') : text.slice(0, 200);
  }

  private adoptFallbackMetadata(fallback: Track, failedTrack: Track, source: string): void {
    fallback.requester = failedTrack.requester;
    fallback.title = failedTrack.title;
    fallback.author = failedTrack.author;
    if (failedTrack.artworkUrl) fallback.artworkUrl = failedTrack.artworkUrl;
    const rec = fallback as unknown as Record<string, unknown>;
    rec.sourceName = source;
    rec.source = source;
  }

  /** Frozen position snapshot for resume carryover; 0 when unknowable. */
  private frozenPosition(player: Player): number {
    try {
      const ms = this.queueService.calculatePosition(player);
      return typeof ms === 'number' && ms > 0 ? ms : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Resume-position carryover: when a stuck/failed track is replaced by a
   * fallback alternate, land the replacement where the listener was (the
   * frozen position ≈ the user's seek target after a seek-stall). Clamped
   * to the replacement's duration; skipped for streams/unknown lengths and
   * unless the replacement is actually current. Never throws — advancement
   * already succeeded when this runs.
   */
  private async resumeFallbackAt(player: Player, fallback: Track, resumeMs: number): Promise<void> {
    try {
      const totalMs = fallback.duration || 0;
      if (!resumeMs || resumeMs < 5000 || !totalMs) return;
      const cur = player.current as unknown as { encoded?: string; uri?: string | null; identifier?: string } | null;
      const key = (
        t: { encoded?: string; uri?: string | null; identifier?: string } | null | undefined,
      ): string => String(t?.encoded ?? t?.uri ?? t?.identifier ?? '');
      if (!cur || key(cur) !== key(fallback)) return;
      const at = Math.max(0, Math.min(resumeMs, totalMs - 1000));
      if (at <= 0) return;
      await player.seek(at).catch(() => undefined);
      if (player.current) {
        player.current.position = at;
        player.current.time = Date.now();
      }
      Logger.info({ guildId: player.guildId, at }, '[Music] Fallback resumed at last-known position.');
    } catch {
      // Best-effort only.
    }
  }

  // Fallback budgets: every failure runs up to 2 node searches. A poison
  // playlist must never turn that into a search storm or an infinite
  // fallback-that-fails loop.
  private readonly fallbackAttempts = new Map<string, number>();
  private readonly guildFallbackBudget = new Map<string, { count: number; windowStart: number }>();
  private readonly triedFallbackIds = new Map<string, Set<string>>();
  private static readonly MAX_FALLBACKS_PER_TRACK = 3;
  // Post-seek catch-up grace: ~5 extra stuck cycles (~50s past the first
  // stuck) for far seeks in long videos before normal machinery resumes.
  private static readonly MAX_SEEK_GRACE_STUCKS = 5;
  private static readonly SEEK_GRACE_WINDOW_MS = 90000;
  private static readonly MAX_FALLBACKS_PER_GUILD_WINDOW = 5;
  private static readonly FALLBACK_BUDGET_WINDOW_MS = 60000;

  private fallbackTrackKey(guildId: string, failedKey: string): string {
    return `${guildId}|${failedKey}`;
  }

  private checkFallbackBudget(guildId: string, failedKey: string): boolean {
    const attempts = this.fallbackAttempts.get(this.fallbackTrackKey(guildId, failedKey)) ?? 0;
    if (attempts >= MusicHandler.MAX_FALLBACKS_PER_TRACK) return false;
    const now = Date.now();
    const budget = this.guildFallbackBudget.get(guildId);
    if (!budget || now - budget.windowStart > MusicHandler.FALLBACK_BUDGET_WINDOW_MS) {
      this.guildFallbackBudget.set(guildId, { count: 0, windowStart: now });
    } else if (budget.count >= MusicHandler.MAX_FALLBACKS_PER_GUILD_WINDOW) {
      return false;
    }
    return true;
  }

  private recordFallbackAttempt(guildId: string, failedKey: string, fallbackId?: string): void {
    const trackKey = this.fallbackTrackKey(guildId, failedKey);
    this.fallbackAttempts.set(trackKey, (this.fallbackAttempts.get(trackKey) ?? 0) + 1);
    const budget = this.guildFallbackBudget.get(guildId);
    if (budget) budget.count++;
    if (fallbackId) {
      let tried = this.triedFallbackIds.get(guildId);
      if (!tried) {
        tried = new Set();
        this.triedFallbackIds.set(guildId, tried);
      }
      if (tried.size >= 10) tried.clear();
      tried.add(fallbackId);
    }
  }

  private clearFallbackState(guildId: string): void {
    this.guildFallbackBudget.delete(guildId);
    this.triedFallbackIds.delete(guildId);
    for (const key of this.fallbackAttempts.keys()) {
      if (key.startsWith(`${guildId}|`)) this.fallbackAttempts.delete(key);
    }
    for (const key of this.songFailureCounts.keys()) {
      if (key.startsWith(`${guildId}|`)) this.songFailureCounts.delete(key);
    }
  }

  // Song-identity circuit breaker: budgets keyed on track bytes can't stop a
  // poison SONG (every alternate upload is a new encoded id). After N failed
  // attempts at the same artist+title, abandon the song instead of burning
  // more searches and stuttering dead air.
  private readonly songFailureCounts = new Map<string, { count: number; firstAt: number }>();
  private static readonly MAX_FAILURES_PER_SONG = 2;
  private static readonly SONG_FAILURE_WINDOW_MS = 600000;

  private songIdentityKey(guildId: string, track: Track): string {
    return `${guildId}|${(track.author || '').toLowerCase().trim()} - ${(track.title || '').toLowerCase().trim()}`;
  }

  private isSongExhausted(guildId: string, track: Track): boolean {
    const key = this.songIdentityKey(guildId, track);
    const now = Date.now();
    const entry = this.songFailureCounts.get(key);
    if (!entry || now - entry.firstAt > MusicHandler.SONG_FAILURE_WINDOW_MS) {
      this.songFailureCounts.set(key, { count: 1, firstAt: now });
      return false;
    }
    entry.count++;
    return entry.count > MusicHandler.MAX_FAILURES_PER_SONG;
  }

  /**
   * Finds an alternate playable upload for a failed/stuck track.
   * Order matters:
   *  1. Alternate YouTube upload — official label uploads are the most likely to be
   *     region/age/embed-blocked for Lavalink; lyric and fan re-uploads of the same
   *     duration (different video id) usually play fine.
   *  2. SoundCloud version — last resort; duration-gated so we never silently play a
   *     wrong song (worse UX than skipping).
   * Previously-tried uploads are excluded so a failing fallback can't loop.
   * Returns null when nothing playable exists so the caller can skip past the poison track.
   */
  private matchesFallbackDuration(failedTrack: Track, duration?: number): boolean {
    const failedDuration = failedTrack.duration || 0;
    if (!duration || !failedDuration) return true;
    return Math.abs(duration - failedDuration) <= 30000;
  }

  private isFreshCandidate(failedTrack: Track, guildId: string, t: Track): boolean {
    const tried = this.triedFallbackIds.get(guildId) ?? new Set<string>();
    return (
      t.identifier !== failedTrack.identifier &&
      !tried.has(t.identifier) &&
      this.matchesFallbackDuration(failedTrack, t.duration)
    );
  }

  private async searchYoutubeAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    const query = this.buildFallbackQuery(failedTrack);
    if (!query) return null;
    try {
      const yt = await manager.search({ query, source: 'youtube' });
      const alt = yt?.tracks?.find((t: Track) => this.isFreshCandidate(failedTrack, guildId, t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'youtube');
        Logger.info(
          { guildId, query, uri: alt.uri },
          `[Music] Alternate YouTube upload found for "${failedTrack.title}" — retrying without the blocked upload.`,
        );
        return alt;
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] Alternate YouTube search failed');
    }
    return null;
  }

  private async searchSoundcloudAlternate(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
  ): Promise<Track | null> {
    const query = this.buildFallbackQuery(failedTrack);
    if (!query) return null;
    try {
      const sc = await manager.search({ query, source: 'soundcloud' });
      const alt = sc?.tracks?.find((t: Track) => this.isFreshCandidate(failedTrack, guildId, t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'soundcloud');
        return alt;
      }
      if (sc?.tracks && sc.tracks.length > 0) {
        Logger.warn(
          { query, topHit: sc.tracks[0]?.title },
          `[Music] SoundCloud top hit duration-mismatched — refusing to play a wrong song.`,
        );
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] SoundCloud fallback search failed');
    }
    return null;
  }

  /**
   * Resolves the exact video through the home PC's yt-dlp resolver and loads
   * it as a local file on the Home node. Only for Home players and YouTube
   * tracks; everything else returns null so the ladder moves on.
   */
  private async tryResolver(player: Player, src: Track): Promise<Track | null> {
    if (player.node?.identifier !== HOME_NODE) return null;
    // Skip fast when Home is REST-dead instead of burning a doomed loadTracks
    // (tolerant of partial test doubles).
    const coolingFn = this.moonlinkManager.isNodeCoolingDown;
    if (typeof coolingFn === 'function' && coolingFn.call(this.moonlinkManager, player.node?.identifier ?? '')) {
      return null;
    }
    const videoId = getSourceVideoId(src as unknown as { sourceName?: string; identifier?: string });
    if (!videoId) return null;
    const path = await resolveViaHome(videoId, {
      title: src.title,
      artist: src.author,
    });
    if (!path) return null;
    let res: unknown;
    try {
      res = await player.node.rest.loadTracks(path);
    } catch {
      return null;
    }
    const typed = res as { loadType?: string; data?: { encoded?: string } };
    if (typed?.loadType !== 'track' || !typed.data?.encoded) return null;
    try {
      const t = new Track(typed.data, src.requester);
      // Wrong-song guard BEFORE metadata adoption (adoption would mask the
      // probe): same ±30s rule as fallbacks. Missing durations pass through.
      if (!this.matchesFallbackDuration(src, t.duration)) {
        Logger.warn(
          { guildId: player.guildId, videoId: src.identifier, fileMs: t.duration, expectedMs: src.duration },
          '[Music] Resolver file duration-mismatched — refusing a wrong song.',
        );
        return null;
      }
      t.title = src.title;
      t.author = src.author;
      t.artworkUrl = src.artworkUrl;
      t.uri = src.uri;
      if (!t.duration || t.isStream) t.duration = src.duration;
      const srcRec = src as unknown as Record<string, unknown>;
      const dstRec = t as unknown as Record<string, unknown>;
      const rawTitle = srcRec._rawVideoTitle ?? getVideoTitle(src as unknown as { title?: string }) ?? src.title;
      if (typeof rawTitle === 'string' && rawTitle) dstRec._rawVideoTitle = rawTitle;
      if (videoId) dstRec._sourceVideoId = videoId;
      return t;
    } catch (err) {
      Logger.debug(
        { err, keys: typed.data ? Object.keys(typed.data) : [] },
        '[Music] Track construction from resolver data failed',
      );
      return null;
    }
  }

  private async findAlternatePlayableTrack(
    manager: Manager,
    player: Player,
    failedTrack: Track | null | undefined,
    guildId: string,
    failedKey: string,
    err?: unknown,
  ): Promise<Track | null> {
    if (!failedTrack) return null;
    const nodeId = player.node?.identifier ?? 'unknown';
    const outage = !!err && YoutubeHealth.isOutage(err);
    let rungs = ladderFor(player).filter((r) => !(outage && r === 'plugin'));
    // A resolved local file that failed must not be re-resolved.
    if (failedTrack.sourceName === 'local') {
      rungs = rungs.filter((r) => r !== 'resolver');
    }
    Logger.info(
      { guildId, node: nodeId, outage, rungs, track: failedTrack.title },
      '[Music] fallback ladder',
    );
    for (const rung of rungs) {
      const alt =
        rung === 'resolver'
          ? await this.tryResolver(player, failedTrack)
          : rung === 'plugin'
            ? await this.searchYoutubeAlternate(manager, failedTrack, guildId)
            : await this.searchSoundcloudAlternate(manager, failedTrack, guildId);
      Logger.info(
        { guildId, node: nodeId, rung, ok: !!alt, track: failedTrack.title },
        '[Music] fallback rung',
      );
      if (alt) {
        this.recordFallbackAttempt(guildId, failedKey, alt.identifier);
        return alt;
      }
    }
    this.recordFallbackAttempt(guildId, failedKey);
    return null;
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
        const chapter = this.chapterCardFor(player, 0);
        // Accent follows the displayed cover (chapter art when present),
        // mirroring the on-demand publisher below.
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(
              player.guildId,
              chapter?.artworkUrl ?? currentTrack.artworkUrl,
            )
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
          const postedChapterKey = chapter ? `${chapter.title}~${chapter.artworkUrl ? 'a' : ''}` : 'none';
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
      const fallback = await this.findAlternatePlayableTrack(manager, player, track, player.guildId, failedKeyStr);
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
      const fallback = await this.findAlternatePlayableTrack(manager, player, track, player.guildId, failedKeyStr, exception);
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

  private registerDiscordEvents(): void {
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const botId = this.client.user?.id;
      if (!botId) return;

      const guildId = newState.guild.id;
      const manager = this.moonlinkManager.getManager();
      const player = manager.players.get(guildId);
      if (!player) return;

      // 1. Bot voice state changed
      if (newState.id === botId) {
        // Bot disconnected from voice (kick or manual disconnect). Grace period:
        // keep the player + queue for 3 minutes — a rejoin resumes playback
        // instead of wiping the queue. Only the voice link drops here.
        if (!newState.channelId) {
          Logger.info(`[Music] Bot was disconnected from voice in guild ${guildId} — starting 3-min rejoin grace`);
          if (oldState.channelId && this.voiceChannelStatusService) {
            void this.voiceChannelStatusService.clearStatus(oldState.channelId);
          }
          player.set('kickedWhilePlaying', player.playing && !player.paused);
          if (player.current) {
            player.set('kickedPosition', this.queueService.calculatePosition(player));
          }
          void player.disconnect().catch(() => undefined);
          this.clearKickGrace(guildId);
          const timeout = setTimeout(() => {
            this.kickGraceTimeouts.delete(guildId);
            Logger.info(`[Music] Rejoin grace expired in guild ${guildId} — destroying player`);
            player.destroy('Rejoin grace expired after disconnect').catch(() => undefined);
          }, MusicHandler.KICK_GRACE_MS);
          this.kickGraceTimeouts.set(guildId, timeout);
          return;
        }

        // Bot (re)joined a voice channel — resume if returning inside the grace window
        if (!oldState.channelId && newState.channelId) {
          const grace = this.kickGraceTimeouts.get(guildId);
          if (grace) {
            this.clearKickGrace(guildId);
            Logger.info(`[Music] Bot rejoined voice in guild ${guildId} within grace — resuming`);
            player.setVoiceChannelId(newState.channelId);
            void (async () => {
              try {
                await player.connect({ selfDeaf: true });
                if (player.current && player.get<boolean>('kickedWhilePlaying')) {
                  player.set('kickedWhilePlaying', false);
                  // Never player.restart() here: Moonlink v5's restart()
                  // re-sends a voice payload WITHOUT channelId, which
                  // Lavalink 4.2.2 rejects with 400 (stock and fork alike),
                  // aborting the resume and replaying from zero. connect()
                  // above already re-established voice WITH channelId, so
                  // resume() (paused:false only, never 400s) plus an
                  // explicit seek-back is the correct, deterministic resume.
                  await player.resume().catch(() => undefined);
                  const saved = player.get<number>('kickedPosition') ?? 0;
                  const duration = player.current.duration || 0;
                  if (saved > 5000 && !player.current.isStream && (!duration || saved < duration)) {
                    await player.seek(Math.min(saved, duration ? duration - 1000 : saved)).catch(() => undefined);
                  }
                }
              } catch (err) {
                Logger.warn({ err, guildId }, '[Music] Failed to resume after rejoin');
              }
            })();
            return;
          }
        }

        // Bot moved to another voice channel
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
          Logger.info(
            `[Music] Bot moved to voice channel ${newState.channelId} in guild ${guildId}`,
          );
          if (this.voiceChannelStatusService) {
            void this.voiceChannelStatusService.clearStatus(oldState.channelId);
            if (player.current) {
              const currentTrack = mapMoonlinkTrack(player.current);
              void this.voiceChannelStatusService.setStatus(
                newState.channelId,
                currentTrack.title,
                currentTrack.author,
              );
            }
          }
          player.setVoiceChannelId(newState.channelId);
        }
      }

      // 2. Member left/joined voice channel where bot is playing
      const botVoiceChannelId = player.voiceChannelId;
      if (!botVoiceChannelId) return;

      const voiceChannel = newState.guild.channels.cache.get(botVoiceChannelId);
      if (
        voiceChannel &&
        (voiceChannel instanceof VoiceChannel || voiceChannel instanceof StageChannel)
      ) {
        const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);
        const is247 = this.queueService.is247(guildId);

        if (humanMembers.size === 0 && !is247) {
          // Auto-pause and start 2-minute leave timer
          if (!player.paused) {
            player.pause().catch(() => undefined);
            player.set('pausedByEmptyChannel', true);
          }

          if (!this.emptyChannelTimeouts.has(guildId)) {
            Logger.info(`[Music] Voice channel is empty in guild ${guildId}. Starting 2-min leave timer...`);
            const timeout = setTimeout(() => {
              const currentChannel = newState.guild.channels.cache.get(player.voiceChannelId);
              if (
                currentChannel &&
                (currentChannel instanceof VoiceChannel || currentChannel instanceof StageChannel)
              ) {
                const currentHumans = currentChannel.members.filter((m) => !m.user.bot);
                if (currentHumans.size === 0 && !this.queueService.is247(guildId)) {
                  Logger.info(`[Music] Leaving empty voice channel in guild ${guildId}`);
                  player.destroy('Voice channel empty').catch(() => undefined);
                }
              }
              this.emptyChannelTimeouts.delete(guildId);
            }, 120000);
            this.emptyChannelTimeouts.set(guildId, timeout);
          }
        } else {
          // Humans in the channel: cancel leave timer & resume if auto-paused
          const timeout = this.emptyChannelTimeouts.get(guildId);
          if (timeout) {
            clearTimeout(timeout);
            this.emptyChannelTimeouts.delete(guildId);
          }

          if (player.paused && player.get<boolean>('pausedByEmptyChannel')) {
            player.set('pausedByEmptyChannel', false);
            player.resume().catch(() => undefined);
          }
        }
      }
    });

    this.client.on(Events.ChannelDelete, (channel) => {
      if ('guild' in channel && channel.guild) {
        const guildId = channel.guild.id;
        const manager = this.moonlinkManager.getManager();
        const player = manager.players.get(guildId);
        if (player && player.voiceChannelId === channel.id) {
          Logger.info(`[Music] Voice channel was deleted in guild ${guildId}`);
          player.destroy('Voice channel deleted').catch(() => undefined);
        }
        // Text channel gone: stop the progress updater hammering a dead fetch.
        if (player && player.textChannelId === channel.id) {
          Logger.info(`[Music] Text channel was deleted in guild ${guildId} — detaching updater`);
          this.clearCardTimers(guildId);
          player.setTextChannelId('');
        }
      }
    });

    this.client.on(Events.GuildDelete, (guild) => {
      const guildId = guild.id;
      Logger.info(`[Music] Left/kicked from guild ${guildId} — cleaning player state`);
      this.clearCardTimers(guildId);
      this.clearFallbackState(guildId);
      this.clearKickGrace(guildId);
      const timeout = this.emptyChannelTimeouts.get(guildId);
      if (timeout) {
        clearTimeout(timeout);
        this.emptyChannelTimeouts.delete(guildId);
      }
      this.clearInactivityTimeout(guildId);
      const manager = this.moonlinkManager.getManager();
      const player = manager.players.get(guildId);
      if (player) {
        player.destroy('Guild removed').catch(() => undefined);
      }
    });
  }
}
