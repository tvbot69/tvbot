import { Client, Events, VoiceChannel, StageChannel } from 'discord.js';
import type { Player, Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { ColorService } from '@bot/services/colorService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import { mapMoonlinkTrack } from '@domain/models/music/musicTrack';

export class MusicHandler {
  private readonly client: Client;
  private readonly moonlinkManager: MoonlinkManager;
  private readonly queueService: QueueService;
  private readonly colorService?: ColorService;
  private readonly voiceChannelStatusService?: VoiceChannelStatusService;
  private readonly emptyChannelTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly updateIntervals = new Map<string, NodeJS.Timeout>();

  constructor(
    client: Client,
    moonlinkManager: MoonlinkManager,
    queueService: QueueService,
    colorService?: ColorService,
    voiceChannelStatusService?: VoiceChannelStatusService,
  ) {
    this.client = client;
    this.moonlinkManager = moonlinkManager;
    this.queueService = queueService;
    this.colorService = colorService;
    this.voiceChannelStatusService = voiceChannelStatusService;

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
        const accentColor = this.colorService
          ? await this.colorService.getAccentColorAsync(player.guildId)
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
          ? await this.colorService.getAccentColorAsync(player.guildId)
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
    });

    manager.on('trackStuck', (player: Player, track: Track, threshold: number) => {
      Logger.warn(
        `[Music] Track stuck in guild ${player.guildId}: "${track.title}" (threshold: ${threshold}ms). Skipping...`,
      );
      this.stopProgressUpdater(player.guildId);
      player.skip().catch(() => undefined);
    });

    manager.on('trackException', (player: Player, track: Track, exception: unknown) => {
      Logger.error(
        { err: exception, guildId: player.guildId, track: track.title },
        `[Music] Track exception in guild ${player.guildId}`,
      );
      this.stopProgressUpdater(player.guildId);
      player.skip().catch(() => undefined);
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
