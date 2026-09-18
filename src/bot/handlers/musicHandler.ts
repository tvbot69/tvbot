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
  private readonly updateIntervals = new Map<string, NodeJS.Timeout>();

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

  private startProgressUpdater(player: Player): void {
    this.stopProgressUpdater(player.guildId);

    const interval = setInterval(async () => {
      try {
        if (!player.playing || player.paused || !player.textChannelId) return;

        const msgId = player.get<string>('nowPlayingMessageId');
        if (!msgId) return;

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

        const queue = this.queueService.getQueueInfo(player);
        const currentArtworkUrl = queue.current?.artworkUrl;
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(player.guildId, currentArtworkUrl)
          : undefined;
        const response = MusicBuilders.buildNowPlayingResponse(queue, accentColor);

        await msg
          .edit(response.toMessagePayload() as unknown as Record<string, unknown>)
          .catch(() => undefined);
      } catch {
        // Silently skip if rate limited or network hiccup
      }
    }, 5000);

    this.updateIntervals.set(player.guildId, interval);
  }

  private stopProgressUpdater(guildId: string): void {
    const existing = this.updateIntervals.get(guildId);
    if (existing) {
      clearInterval(existing);
      this.updateIntervals.delete(guildId);
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

  /**
   * Finds an alternate playable upload for a failed/stuck track.
   * Order matters:
   *  1. Alternate YouTube upload — official label uploads are the most likely to be
   *     region/age/embed-blocked for Lavalink; lyric and fan re-uploads of the same
   *     duration (different video id) usually play fine.
   *  2. SoundCloud version — last resort; duration-gated so we never silently play a
   *     wrong song (worse UX than skipping).
   * Returns null when nothing playable exists so the caller can skip past the poison track.
   */
  private async findAlternatePlayableTrack(
    manager: Manager,
    failedTrack: Track,
  ): Promise<Track | null> {
    const query = this.buildFallbackQuery(failedTrack);
    if (!query) return null;

    const failedId = failedTrack.identifier;
    const failedDuration = failedTrack.duration || 0;
    const matchesDuration = (duration?: number): boolean => {
      if (!duration || !failedDuration) return true;
      return Math.abs(duration - failedDuration) <= 30000;
    };

    try {
      const yt = await manager.search({ query, source: 'youtube' });
      const alt = yt?.tracks?.find(
        (t: Track) => t.identifier !== failedId && matchesDuration(t.duration),
      );
      if (alt) {
        this.adoptFallbackMetadata(alt, failedTrack, 'youtube');
        Logger.info(
          { guildId: 'n/a', query, uri: alt.uri },
          `[Music] Alternate YouTube upload found for "${failedTrack.title}" — retrying without the blocked upload.`,
        );
        return alt;
      }
    } catch (err) {
      Logger.debug({ err }, '[Music] Alternate YouTube search failed');
    }

    try {
      const sc = await manager.search({ query, source: 'soundcloud' });
      const alt = sc?.tracks?.find((t: Track) => matchesDuration(t.duration));
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

  private registerMoonlinkEvents(): void {
    const manager = this.moonlinkManager.getManager();

    manager.on('trackStart', async (player: Player, track: Track) => {
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

      Logger.warn(
        { guildId: player.guildId, track: track.title, threshold },
        `[Music] Track stuck (${threshold}ms) — looking for an alternate upload for "${track.title}"...`,
      );
      const fallback = await this.findAlternatePlayableTrack(manager, track);
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

      Logger.warn(
        { guildId: player.guildId, track: track.title },
        `[Music] Track failed — looking for an alternate upload for "${track.title}"...`,
      );
      const fallback = await this.findAlternatePlayableTrack(manager, track);
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

      if (player.voiceChannelId && this.voiceChannelStatusService) {
        void this.voiceChannelStatusService.clearStatus(player.voiceChannelId);
      }

      const is247 = this.queueService.is247(player.guildId);
      if (!is247 && !player.autoPlay) {
        // Auto-disconnect after 3 minutes of inactivity
        const timeout = setTimeout(() => {
          if (player.queue.isEmpty && !player.playing) {
            Logger.info(`[Music] Inactivity timeout: disconnecting player in guild ${player.guildId}`);
            player.destroy('Inactivity timeout').catch(() => undefined);
          }
        }, 180000);
        this.emptyChannelTimeouts.set(player.guildId, timeout);
      }
    });

    manager.on('playerDestroy', async (player: Player) => {
      this.stopProgressUpdater(player.guildId);

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
        // Bot disconnected from voice
        if (!newState.channelId) {
          Logger.info(`[Music] Bot was disconnected from voice in guild ${guildId}`);
          if (oldState.channelId && this.voiceChannelStatusService) {
            void this.voiceChannelStatusService.clearStatus(oldState.channelId);
          }
          this.queueService.set247(guildId, false);
          player.destroy('Disconnected from voice channel').catch(() => undefined);
          return;
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
      }
    });
  }
}
