import { Events, StageChannel, VoiceChannel, type Client } from 'discord.js';
import type { Player } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { mapMoonlinkTrack } from '@domain/models/music/musicTrack';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import type { QueueService } from '@bot/services/music/queueService';
import type { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';

/** How long the queue survives the bot being kicked from voice. */
const KICK_GRACE_MS = 180_000;
/** How long an empty voice channel is tolerated before the player is dropped. */
const EMPTY_CHANNEL_LEAVE_MS = 120_000;

/**
 * Discord-side lifecycle: VoiceStateUpdate (kicked / rejoined / moved /
 * empty-channel pause+leave), ChannelDelete and GuildDelete.
 *
 * Extracted from MusicHandler. The three timer Maps are passed in BY REFERENCE
 * and stay owned by the handler, because `forgetGuild` and the tests read them
 * there. Two of the call-backs go through the host so a test that replaces
 * `clearCardTimers` with an own property still intercepts them.
 */
export interface VoiceLifecycleHost {
  readonly client: Client;
  readonly moonlinkManager: MoonlinkManager;
  readonly queueService: QueueService;
  readonly voiceChannelStatusService?: VoiceChannelStatusService;
  clearCardTimers(guildId: string): void;
  clearFallbackState(guildId: string): void;
  forgetGuild(guildId: string): void;
}

export class VoiceLifecycle {
  public constructor(
    private readonly host: VoiceLifecycleHost,
    private readonly kickGraceTimeouts: Map<string, NodeJS.Timeout>,
    private readonly emptyChannelTimeouts: Map<string, NodeJS.Timeout>,
    private readonly inactivityTimeouts: Map<string, NodeJS.Timeout>,
  ) {}

  public clearKickGrace(guildId: string): void {
    const grace = this.kickGraceTimeouts.get(guildId);
    if (grace) {
      clearTimeout(grace);
      this.kickGraceTimeouts.delete(guildId);
    }
  }

  public clearInactivityTimeout(guildId: string): void {
    const timeout = this.inactivityTimeouts.get(guildId);
    if (timeout) {
      clearTimeout(timeout);
      this.inactivityTimeouts.delete(guildId);
    }
  }

  public register(): void {
    this.host.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const botId = this.host.client.user?.id;
      if (!botId) return;

      const guildId = newState.guild.id;
      const manager = this.host.moonlinkManager.getManager();
      const player = manager.players.get(guildId);
      if (!player) return;

      // 1. Bot voice state changed
      if (newState.id === botId) {
        // Bot disconnected from voice (kick or manual disconnect). Grace period:
        // keep the player + queue for 3 minutes — a rejoin resumes playback
        // instead of wiping the queue. Only the voice link drops here.
        if (!newState.channelId) {
          Logger.info(`[Music] Bot was disconnected from voice in guild ${guildId} — starting 3-min rejoin grace`);
          if (oldState.channelId && this.host.voiceChannelStatusService) {
            void this.host.voiceChannelStatusService.clearStatus(oldState.channelId);
          }
          player.set('kickedWhilePlaying', player.playing && !player.paused);
          if (player.current) {
            player.set('kickedPosition', this.host.queueService.calculatePosition(player));
          }
          void player.disconnect().catch(() => undefined);
          this.clearKickGrace(guildId);
          const timeout = setTimeout(() => {
            this.kickGraceTimeouts.delete(guildId);
            Logger.info(`[Music] Rejoin grace expired in guild ${guildId} — destroying player`);
            player.destroy('Rejoin grace expired after disconnect').catch(() => undefined);
          }, KICK_GRACE_MS);
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
                    await player
                      .seek(Math.min(saved, duration ? duration - 1000 : saved))
                      .catch(() => undefined);
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
          Logger.info(`[Music] Bot moved to voice channel ${newState.channelId} in guild ${guildId}`);
          if (this.host.voiceChannelStatusService) {
            void this.host.voiceChannelStatusService.clearStatus(oldState.channelId);
            if (player.current) {
              const currentTrack = mapMoonlinkTrack(player.current);
              void this.host.voiceChannelStatusService.setStatus(
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
      if (voiceChannel && (voiceChannel instanceof VoiceChannel || voiceChannel instanceof StageChannel)) {
        const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);
        const is247 = this.host.queueService.is247(guildId);

        if (humanMembers.size === 0 && !is247) {
          // Auto-pause and start 2-minute leave timer
          if (!player.paused) {
            player.pause().catch(() => undefined);
            player.set('pausedByEmptyChannel', true);
          }

          if (!this.emptyChannelTimeouts.has(guildId)) {
            Logger.info(
              `[Music] Voice channel is empty in guild ${guildId}. Starting 2-min leave timer...`,
            );
            const timeout = setTimeout(() => {
              const currentChannel = newState.guild.channels.cache.get(player.voiceChannelId);
              if (
                currentChannel &&
                (currentChannel instanceof VoiceChannel || currentChannel instanceof StageChannel)
              ) {
                const currentHumans = currentChannel.members.filter((m) => !m.user.bot);
                if (currentHumans.size === 0 && !this.host.queueService.is247(guildId)) {
                  Logger.info(`[Music] Leaving empty voice channel in guild ${guildId}`);
                  player.destroy('Voice channel empty').catch(() => undefined);
                }
              }
              this.emptyChannelTimeouts.delete(guildId);
            }, EMPTY_CHANNEL_LEAVE_MS);
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

    this.host.client.on(Events.ChannelDelete, (channel) => {
      if ('guild' in channel && channel.guild) {
        const guildId = channel.guild.id;
        const manager = this.host.moonlinkManager.getManager();
        const player = manager.players.get(guildId);
        if (player && player.voiceChannelId === channel.id) {
          Logger.info(`[Music] Voice channel was deleted in guild ${guildId}`);
          player.destroy('Voice channel deleted').catch(() => undefined);
        }
        // Text channel gone: stop the progress updater hammering a dead fetch.
        if (player && player.textChannelId === channel.id) {
          Logger.info(`[Music] Text channel was deleted in guild ${guildId} — detaching updater`);
          this.host.clearCardTimers(guildId);
          player.setTextChannelId('');
        }
      }
    });

    this.host.client.on(Events.GuildDelete, (guild) => {
      const guildId = guild.id;
      Logger.info(`[Music] Left/kicked from guild ${guildId} — cleaning player state`);
      this.host.clearCardTimers(guildId);
      this.host.clearFallbackState(guildId);
      this.clearKickGrace(guildId);
      const timeout = this.emptyChannelTimeouts.get(guildId);
      if (timeout) {
        clearTimeout(timeout);
        this.emptyChannelTimeouts.delete(guildId);
      }
      this.clearInactivityTimeout(guildId);
      this.host.forgetGuild(guildId);
      const manager = this.host.moonlinkManager.getManager();
      const player = manager.players.get(guildId);
      if (player) {
        player.destroy('Guild removed').catch(() => undefined);
      }
    });
  }
}
