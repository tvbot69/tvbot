import { inject, injectable } from 'tsyringe';
import type { Client, VoiceBasedChannel } from 'discord.js';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IUserRepository } from '@domain/interfaces/iuserRepository';
import { Logger } from '@domain/logger';

export interface PlayingVoiceTrack {
  guildId: string;
  voiceChannelId: string;
  title: string;
  artist: string;
  durationMs: number;
  startedAt: number;
}

@injectable()
export class BotScrobblingService {
  private readonly optedInUsers = new Set<string>();
  private readonly activeTracks = new Map<string, PlayingVoiceTrack>();

  constructor(
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {}

  public isUserOptedIn(discordUserId: string): boolean {
    return this.optedInUsers.has(discordUserId);
  }

  public toggleUserOptIn(discordUserId: string, enable?: boolean): boolean {
    const newState = enable !== undefined ? enable : !this.optedInUsers.has(discordUserId);
    if (newState) {
      this.optedInUsers.add(discordUserId);
    } else {
      this.optedInUsers.delete(discordUserId);
    }
    return newState;
  }

  public recordTrackStart(track: PlayingVoiceTrack): void {
    this.activeTracks.set(track.guildId, track);
  }

  public getNowPlaying(guildId: string): PlayingVoiceTrack | undefined {
    return this.activeTracks.get(guildId);
  }

  public async handleTrackEnd(
    client: Client,
    guildId: string,
    voiceChannelId: string,
  ): Promise<number> {
    const track = this.activeTracks.get(guildId);
    if (!track) return 0;

    this.activeTracks.delete(guildId);

    const elapsedMs = Date.now() - track.startedAt;
    // Standard Last.fm scrobble rule: song must have played for at least 30 seconds
    // and either 50% of duration or 4 minutes
    const minRequiredMs = Math.min(track.durationMs * 0.5, 240000);
    if (elapsedMs < Math.max(30000, minRequiredMs)) {
      Logger.debug(`[BotScrobbling] Track "${track.title}" ended before 50% or 30s threshold, skipping scrobbles.`);
      return 0;
    }

    const channel = client.channels.cache.get(voiceChannelId) as VoiceBasedChannel | undefined;
    if (!channel || !channel.isVoiceBased()) return 0;

    const voiceMemberIds: string[] = [];
    if (channel.members) {
      for (const [id, m] of channel.members) {
        if (!m.user?.bot) {
          voiceMemberIds.push(id);
        }
      }
    }
    if (voiceMemberIds.length === 0) return 0;

    let scrobbleCount = 0;
    const timestampSec = Math.floor(track.startedAt / 1000);

    for (const discordUserId of voiceMemberIds) {
      if (!this.isUserOptedIn(discordUserId)) continue;

      try {
        const user = await this.userRepository.getUserByDiscordUserId(discordUserId);
        if (!user || !user.sessionKey) continue;

        const success = await this.lastFmRepository.scrobbleTrack(
          track.artist,
          track.title,
          timestampSec,
          user.sessionKey,
        );

        if (success) {
          scrobbleCount++;
          Logger.debug(`[BotScrobbling] Scrobbled "${track.title}" for ${user.userNameLastFm} (${discordUserId})`);
        }
      } catch (err) {
        Logger.error({ err, discordUserId }, '[BotScrobbling] Failed to scrobble track for user');
      }
    }

    return scrobbleCount;
  }
}
