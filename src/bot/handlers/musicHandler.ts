import { Client, Events, VoiceChannel, StageChannel } from 'discord.js';
import type { Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { mapMoonlinkTrack } from '@domain/models/music/musicTrack';

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

      const trackRecord = track as unknown as Record<string, unknown>;
      const source = String((trackRecord['sourceName'] as string | undefined) ?? (trackRecord['source'] as string | undefined) ?? '').toLowerCase();
      // Spotify-labeled tracks are still YouTube-encoded under the hood (musicService
      // resolves Spotify metadata -> YouTube via Lavalink), so they need the fallback too.
      const isFallbackEligible = !source || source === 'youtube' || source === 'spotify';
      // Guard against double-skip: Moonlink may already have advanced past this track
      // (e.g. fault-severity auto-skip) while our async SoundCloud search was in flight.
      const failedKey = track.encoded ?? track.uri ?? track.identifier;
      const stillCurrent = (): boolean => {
        const cur = player.current as unknown as { encoded?: string; uri?: string; identifier?: string } | null;
        if (!cur) return false;
        return (cur.encoded ?? cur.uri ?? cur.identifier) === failedKey;
      };

      if (isFallbackEligible && track.title && track.author) {
        Logger.warn(
          { guildId: player.guildId, track: track.title, threshold },
          `[Music] YouTube track stuck (${threshold}ms) — retrying "${track.title}" on SoundCloud...`,
        );
        try {
          const res = await manager.search({ query: `${track.author} - ${track.title}`, source: 'soundcloud' });
          if (res?.tracks && res.tracks.length > 0) {
            const fallback = res.tracks[0]!;
            fallback.requester = track.requester;
            fallback.title = track.title;
            fallback.author = track.author;
            if (track.artworkUrl) fallback.artworkUrl = track.artworkUrl;
            const rec = fallback as unknown as Record<string, unknown>;
            rec.sourceName = 'soundcloud';
            rec.source = 'soundcloud';
            player.queue.unshift(fallback);
            Logger.info({ guildId: player.guildId, track: track.title }, `[Music] SoundCloud fallback queued for stuck track — skipping to it.`);
            // Moonlink does NOT auto-advance on stuck (it seeks/retries by default), so we
            // must advance ourselves. Only skip if the stuck track is still current.
            if (stillCurrent()) {
              await player.skip().catch((err: unknown) => {
                Logger.warn({ err, guildId: player.guildId }, '[Music] Skip to SoundCloud fallback failed');
              });
            }
            return;
          }
        } catch { /* fall through */ }
      }

      Logger.warn(
        { guildId: player.guildId, track: track.title, threshold },
        `[Music] Track stuck (${threshold}ms) — no fallback, leaving Moonlink recovery to handle it.`,
      );
    });


    manager.on('trackException', async (player: Player, track: Track, exception: unknown) => {
      this.stopProgressUpdater(player.guildId);

      // Spotify-labeled tracks are still YouTube-encoded under the hood (musicService
      // resolves Spotify metadata -> YouTube via Lavalink), so they need the fallback too.
      const trackRecord = track as unknown as Record<string, unknown>;
      const source = String((trackRecord['sourceName'] as string | undefined) ?? (trackRecord['source'] as string | undefined) ?? '').toLowerCase();
      const isFallbackEligible = !source || source === 'youtube' || source === 'spotify';
      // Guard against double-skip: Moonlink auto-skips fault-severity exceptions on its
      // own, which may complete while our async SoundCloud search is in flight.
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

      if (isFallbackEligible && track.title && track.author) {
        Logger.warn(
          { guildId: player.guildId, track: track.title, source },
          `[Music] YouTube track failed — retrying "${track.title}" on SoundCloud...`,
        );
        try {
          const query = `${track.author} - ${track.title}`;
          const res = await manager.search({ query, source: 'soundcloud' });
          if (res?.tracks && res.tracks.length > 0) {
            const fallback = res.tracks[0]!;
            // Preserve original metadata
            fallback.requester = track.requester;
            fallback.title = track.title;
            fallback.author = track.author;
            if (track.artworkUrl) fallback.artworkUrl = track.artworkUrl;
            const rec = fallback as unknown as Record<string, unknown>;
            rec.sourceName = 'soundcloud';
            rec.source = 'soundcloud';

            // Inject at the front of the queue so it plays next, then advance to it —
            // Moonlink only auto-skips fault-severity exceptions, so common-severity
            // YouTube failures (unavailable/age-restricted/blocked) would stall forever.
            player.queue.unshift(fallback);
            Logger.info(
              { guildId: player.guildId, track: track.title },
              `[Music] SoundCloud fallback queued for "${track.title}" — skipping to it.`,
            );
            await skipPastFailed();
            return;
          }
        } catch (retryErr) {
          Logger.warn({ err: retryErr, guildId: player.guildId }, '[Music] SoundCloud fallback search failed');
        }
      }

      Logger.error(
        { err: exception, guildId: player.guildId, track: track.title },
        `[Music] Track exception in guild ${player.guildId} — skipping past failed track.`,
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
