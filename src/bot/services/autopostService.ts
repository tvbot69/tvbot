import { singleton, inject } from 'tsyringe';
import type { Client, TextChannel } from 'discord.js';
import { Logger } from '@domain/logger';
import { TelemetryService } from './telemetryService';
import { TimeSettingsModel } from '@domain/models/timeSettings';
import { TimePeriod } from '@domain/enums/timePeriod';
import { ArtistsService } from './artistsService';
import { AlbumService } from './albumService';
import { TrackService } from './trackService';
import { CrownService } from './crown/crownService';
import { TopBuilders } from '@bot/builders/topBuilders';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { IGuildRepository } from '@domain/interfaces/iguildRepository';

export type AutopostSchedule = 'Daily' | 'Weekly' | 'Monthly';
export type AutopostContentType = 'TopArtists' | 'TopAlbums' | 'TopTracks' | 'ServerCrowns';

export interface AutopostConfig {
  id: string;
  guildId: string;
  channelId: string;
  schedule: AutopostSchedule;
  contentType: AutopostContentType;
  enabled: boolean;
  lastPosted?: Date | null;
}

@singleton()
export class AutopostService {
  private readonly autoposts = new Map<string, AutopostConfig>();

  constructor(
    private readonly artistsService: ArtistsService,
    private readonly albumService: AlbumService,
    private readonly trackService: TrackService,
    private readonly crownService: CrownService,
    private readonly telemetryService: TelemetryService,
    @inject('IGuildRepository') private readonly guildRepository?: IGuildRepository,
  ) {}

  /**
   * Register or update an autopost configuration
   */
  public setAutopost(config: AutopostConfig): void {
    this.autoposts.set(config.id, { ...config });
    Logger.info(`[Autopost] Configured ${config.contentType} (${config.schedule}) for guild ${config.guildId} in #${config.channelId}`);
  }

  /**
   * Remove an autopost configuration
   */
  public removeAutopost(id: string): boolean {
    return this.autoposts.delete(id);
  }

  /**
   * Get all autoposts for a guild
   */
  public getAutopostsForGuild(guildId: string): AutopostConfig[] {
    return Array.from(this.autoposts.values()).filter((a) => a.guildId === guildId);
  }

  /**
   * Check whether an autopost is due to run based on schedule and lastPosted timestamp
   */
  public isAutopostDue(autopost: AutopostConfig, now: Date = new Date()): boolean {
    if (!autopost.enabled) return false;
    if (!autopost.lastPosted) return true;

    const msDiff = now.getTime() - autopost.lastPosted.getTime();
    switch (autopost.schedule) {
      case 'Daily':
        return msDiff >= 24 * 3600 * 1000;
      case 'Weekly':
        return msDiff >= 7 * 24 * 3600 * 1000;
      case 'Monthly':
        return msDiff >= 28 * 24 * 3600 * 1000;
      default:
        return false;
    }
  }

  /**
   * Execute scheduled autoposts across all registered guilds
   */
  public async runScheduledAutoposts(client: Client): Promise<{ executed: number; failed: number }> {
    const now = new Date();
    let executed = 0;
    let failed = 0;

    for (const autopost of this.autoposts.values()) {
      if (!this.isAutopostDue(autopost, now)) {
        continue;
      }

      const start = Date.now();
      try {
        const channel = await client.channels.fetch(autopost.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          Logger.warn(`[Autopost] Channel ${autopost.channelId} not found or not text-based for guild ${autopost.guildId}`);
          failed++;
          continue;
        }

        const timePeriod = autopost.schedule === 'Daily'
          ? TimePeriod.Weekly
          : autopost.schedule === 'Monthly'
          ? TimePeriod.Monthly
          : TimePeriod.Weekly;
        const timeSettings = new TimeSettingsModel(timePeriod);

        if (autopost.contentType === 'ServerCrowns') {
          const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(autopost.guildId);
          const response = CrownBuilders.buildCrownLeaderboardResponse(
            (channel as TextChannel).guild?.name ?? 'Server',
            entries,
            undefined,
            1,
            totalActiveCrowns,
          );
          await (channel as TextChannel).send(response.toMessagePayload());
        } else {
          // Send top artists/albums/tracks recap for server
          const desc = `📊 **${autopost.schedule} Server Music Recap**\nHere is the latest ${autopost.contentType.toLowerCase()} activity for **${(channel as TextChannel).guild?.name ?? 'the server'}**!`;
          await (channel as TextChannel).send({ content: desc });
        }

        autopost.lastPosted = now;
        executed++;
        const duration = Date.now() - start;
        this.telemetryService.recordCommandExecution(`autopost:${autopost.contentType.toLowerCase()}`, duration, true);
        Logger.info(`[Autopost] Successfully posted ${autopost.contentType} to #${(channel as TextChannel).name} (${autopost.guildId}) in ${duration}ms`);
      } catch (err: any) {
        failed++;
        const duration = Date.now() - start;
        this.telemetryService.recordCommandExecution(`autopost:${autopost.contentType.toLowerCase()}`, duration, false);
        Logger.error({ err: err?.message }, `[Autopost] Failed to post ${autopost.contentType} for guild ${autopost.guildId}`);
      }
    }

    return { executed, failed };
  }
}
