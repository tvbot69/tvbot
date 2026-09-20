import { Client, Events, VoiceChannel, StageChannel } from 'discord.js';
import type { Manager, Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { cleanTrackTitle, mapMoonlinkTrack } from '@domain/models/music/musicTrack';

export class MusicHandler {
  private readonly client: Client;
  private readonly moonlinkManager: MoonlinkManager;
  private readonly queueService: QueueService;
  private readonly colorService?: ColorService;
  private readonly voiceChannelStatusService?: VoiceChannelStatusService;
  private readonly botScrobblingService?: BotScrobblingService;
  private readonly emptyChannelTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly inactivityTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly updateIntervals = new Map<string, NodeJS.Timeout>();
  private readonly kickGraceTimeouts = new Map<string, NodeJS.Timeout>();
  private static readonly KICK_GRACE_MS = 180000;

  constructor(
    client: Client,
    moonlinkManager: MoonlinkManager,
    queueService: QueueService,
    colorService?: ColorService,
    voiceChannelStatusService?: VoiceChannelStatusService,
    botScrobblingService?: BotScrobblingService,
  ) {
    this.client = client;
    this.moonlinkManager = moonlinkManager;
    this.queueService = queueService;
    this.colorService = colorService;
    this.voiceChannelStatusService = voiceChannelStatusService;
    this.botScrobblingService = botScrobblingService;

    this.registerMoonlinkEvents();
    this.registerDiscordEvents();
  }

  private readonly progressFingerprints = new Map<string, string>();
  private static readonly PROGRESS_UPDATE_MS = 15000;

  private startProgressUpdater(player: Player): void {
    this.stopProgressUpdater(player.guildId);

    const interval = setInterval(async () => {
      try {
        if (!player.playing || !player.textChannelId) return;

        const msgId = player.get<string>('nowPlayingMessageId');
        if (!msgId) return;

        const queue = this.queueService.getQueueInfo(player);
        // Dirty check: skip the edit when nothing visible changed (same track,
        // pause state, queue size, loop, volume, and 15s position bucket).
        const fingerprint = [
          queue.current?.identifier ?? queue.current?.uri ?? 'none',
          queue.isPaused ? 'p' : 'r',
          queue.tracks.length,
          queue.loopMode,
          queue.volume,
          Math.floor(queue.position / MusicHandler.PROGRESS_UPDATE_MS),
        ].join('|');
        if (this.progressFingerprints.get(player.guildId) === fingerprint) return;

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

        const msg = (msgManager.cache.get(msgId) ??
          (await msgManager.fetch(msgId).catch(() => null))) as {
          edit: (data: unknown) => Promise<unknown>;
        } | null;

        if (!msg) return;

        const currentArtworkUrl = queue.current?.artworkUrl;
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(player.guildId, currentArtworkUrl)
          : undefined;
        const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor);

        await msg
          .edit(response.toMessagePayload() as unknown as Record<string, unknown>)
          .then(() => this.progressFingerprints.set(player.guildId, fingerprint))
          .catch(() => undefined);
      } catch {
        // Silently skip if rate limited or network hiccup
      }
    }, MusicHandler.PROGRESS_UPDATE_MS);

    this.updateIntervals.set(player.guildId, interval);
  }

  private stopProgressUpdater(guildId: string): void {
    const existing = this.updateIntervals.get(guildId);
    if (existing) {
      clearInterval(existing);
      this.updateIntervals.delete(guildId);
    }
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
  private buildFallbackQuery(track: Track): string | null {
    if (!track.title || !track.author) return null;
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

  private adoptFallbackMetadata(fallback: Track, failedTrack: Track, source: string): void {
    fallback.requester = failedTrack.requester;
    fallback.title = failedTrack.title;
    fallback.author = failedTrack.author;
    if (failedTrack.artworkUrl) fallback.artworkUrl = failedTrack.artworkUrl;
    const rec = fallback as unknown as Record<string, unknown>;
    rec.sourceName = source;
    rec.source = source;
  }

  // Fallback budgets: every failure runs up to 2 node searches. A poison
  // playlist must never turn that into a search storm or an infinite
  // fallback-that-fails loop.
  private readonly fallbackAttempts = new Map<string, number>();
  private readonly guildFallbackBudget = new Map<string, { count: number; windowStart: number }>();
  private readonly triedFallbackIds = new Map<string, Set<string>>();
  private static readonly MAX_FALLBACKS_PER_TRACK = 3;
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
  private async findAlternatePlayableTrack(
    manager: Manager,
    failedTrack: Track,
    guildId: string,
    failedKey: string,
  ): Promise<Track | null> {
    const query = this.buildFallbackQuery(failedTrack);
    if (!query) return null;

    const failedId = failedTrack.identifier;
    const tried = this.triedFallbackIds.get(guildId) ?? new Set<string>();
    const failedDuration = failedTrack.duration || 0;
    const matchesDuration = (duration?: number): boolean => {
      if (!duration || !failedDuration) return true;
      return Math.abs(duration - failedDuration) <= 30000;
    };
    const isFreshCandidate = (t: Track): boolean =>
      t.identifier !== failedId && !tried.has(t.identifier) && matchesDuration(t.duration);

    try {
      const yt = await manager.search({ query, source: 'youtube' });
      const alt = yt?.tracks?.find((t: Track) => isFreshCandidate(t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'youtube');
        this.recordFallbackAttempt(guildId, failedKey, alt.identifier);
        Logger.info(
          { guildId, query, uri: alt.uri },
          `[Music] Alternate YouTube upload found for "${failedTrack.title}" — retrying without the blocked upload.`,
        );
        return alt;
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] Alternate YouTube search failed');
    }

    try {
      const sc = await manager.search({ query, source: 'soundcloud' });
      const alt = sc?.tracks?.find((t: Track) => isFreshCandidate(t));
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'soundcloud');
        this.recordFallbackAttempt(guildId, failedKey, alt.identifier);
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
        `[Music] Track started in guild ${player.guildId}: "${currentTrack.title}" by "${currentTrack.author}"`,
      );
      this.queueService.recordTrackStart(player.guildId, player.current ?? track);

      player.set('trackStartedAt', Date.now());
      if (player.current) {
        player.current.position = 0;
        player.current.time = Date.now();
      }

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
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(player.guildId, currentTrack.artworkUrl)
          : undefined;
        const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor);

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
          this.startProgressUpdater(player);
        }
      } catch (err) {
        Logger.warn({ err, guildId: player.guildId }, 'Failed to dispatch trackStart Now Playing card');
      }
    });

    manager.on('trackEnd', (player: Player, track: Track, reason: string) => {
      Logger.debug(
        `[Music] Track ended in guild ${player.guildId}: "${track.title}" (reason: ${reason})`,
      );
      this.stopProgressUpdater(player.guildId);

      if (player.voiceChannelId && this.botScrobblingService) {
        void this.botScrobblingService.handleTrackEnd(this.client, player.guildId, player.voiceChannelId);
      }
    });

    manager.on('trackStuck', async (player: Player, track: Track, threshold: number) => {
      this.stopProgressUpdater(player.guildId);

      // Guard against double-skip: Moonlink may already have advanced past this track
      // while our async fallback search was in flight.
      const failedKey = track.encoded ?? track.uri ?? track.identifier;
      const stillCurrent = (): boolean => {
        const cur = player.current as unknown as { encoded?: string; uri?: string; identifier?: string } | null;
        if (!cur) return false;
        return (cur.encoded ?? cur.uri ?? cur.identifier) === failedKey;
      };

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
      const fallback = await this.findAlternatePlayableTrack(manager, track, player.guildId, failedKeyStr);
      if (fallback) {
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
        return;
      }

      Logger.warn(
        { guildId: player.guildId, track: track.title, threshold },
        `[Music] Track stuck (${threshold}ms) — no alternate upload, leaving Moonlink recovery to handle it.`,
      );
    });


    manager.on('trackException', async (player: Player, track: Track, exception: unknown) => {
      this.stopProgressUpdater(player.guildId);

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

      const failedKeyStr = String(failedKey ?? 'unknown');
      if (!this.checkFallbackBudget(player.guildId, failedKeyStr)) {
        Logger.warn(
          { guildId: player.guildId, track: track.title },
          `[Music] Fallback budget exhausted for failed track — skipping past it.`,
        );
        await skipPastFailed();
        return;
      }

      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Track failed — looking for an alternate upload for "${track.title}"...`,
      );
      const fallback = await this.findAlternatePlayableTrack(manager, track, player.guildId, failedKeyStr);
      if (fallback) {
        // Inject at the front of the queue so it plays next, then advance to it —
        // Moonlink only auto-skips fault-severity exceptions, so common-severity
        // YouTube failures (unavailable/age-restricted/blocked) would stall forever.
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
          return;
        }
        await skipPastFailed();
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
      this.stopProgressUpdater(player.guildId);
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
      this.stopProgressUpdater(player.guildId);
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
                  const restarted = await player.restart().catch(() => false);
                  if (!restarted) {
                    await player.resume().catch(() => undefined);
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
          this.stopProgressUpdater(guildId);
          player.setTextChannelId('');
        }
      }
    });

    this.client.on(Events.GuildDelete, (guild) => {
      const guildId = guild.id;
      Logger.info(`[Music] Left/kicked from guild ${guildId} — cleaning player state`);
      this.stopProgressUpdater(guildId);
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
