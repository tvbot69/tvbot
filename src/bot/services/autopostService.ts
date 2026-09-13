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
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { IGuildRepository } from '@domain/interfaces/iguildRepository';
import { AutopostRepository } from '@persistence/repositories/autopostRepository';
import { EmbedBuilder } from 'discord.js';
import { DiscordConstants } from '@bot/resources/discordConstants';

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
  created?: Date;
}

@singleton()
export class AutopostService {
  private readonly inMemoryAutoposts = new Map<string, AutopostConfig>();

  constructor(
    private readonly artistsService: ArtistsService,
    private readonly albumService: AlbumService,
    private readonly trackService: TrackService,
    private readonly crownService: CrownService,
    private readonly telemetryService: TelemetryService,
    @inject('IGuildRepository') private readonly guildRepository?: IGuildRepository,
    @inject(AutopostRepository) private readonly autopostRepository?: AutopostRepository,
  ) {}

  /**
   * Register or update an autopost configuration in memory (and persist if repository available)
   */
  public setAutopost(config: AutopostConfig): void {
    this.inMemoryAutoposts.set(config.id, { ...config });
    if (this.autopostRepository) {
      void this.autopostRepository.createAutopost({
        guildId: config.guildId,
        channelId: config.channelId,
        contentType: config.contentType,
        schedule: config.schedule,
      }).then((saved) => {
        this.inMemoryAutoposts.delete(config.id);
        this.inMemoryAutoposts.set(saved.id, saved);
      }).catch(() => undefined);
    }
    Logger.info(`[Autopost] Configured ${config.contentType} (${config.schedule}) for guild ${config.guildId} in #${config.channelId}`);
  }

  /**
   * Create an autopost asynchronously with database persistence
   */
  public async createAutopost(config: Omit<AutopostConfig, 'id'>): Promise<AutopostConfig> {
    if (this.autopostRepository) {
      const created = await this.autopostRepository.createAutopost({
        guildId: config.guildId,
        channelId: config.channelId,
        contentType: config.contentType,
        schedule: config.schedule,
      });
      this.inMemoryAutoposts.set(created.id, created);
      return created;
    }

    const id = String(Date.now());
    const fullConfig: AutopostConfig = { ...config, id };
    this.inMemoryAutoposts.set(id, fullConfig);
    return fullConfig;
  }

  /**
   * Remove an autopost configuration
   */
  public removeAutopost(id: string, guildId?: string): boolean {
    const deleted = this.inMemoryAutoposts.delete(id);
    if (this.autopostRepository && guildId) {
      const numId = parseInt(id, 10);
      if (!isNaN(numId)) {
        void this.autopostRepository.deleteAutopost(numId, guildId);
      }
    }
    return deleted;
  }

  /**
   * Toggle enabled status of an autopost
   */
  public async toggleAutopost(id: string, guildId?: string): Promise<AutopostConfig | null> {
    if (this.autopostRepository && guildId) {
      const numId = parseInt(id, 10);
      if (!isNaN(numId)) {
        const res = await this.autopostRepository.toggleAutopost(numId, guildId);
        if (res) {
          this.inMemoryAutoposts.set(res.id, res);
          return res;
        }
      }
    }

    const existing = this.inMemoryAutoposts.get(id);
    if (!existing) return null;
    existing.enabled = !existing.enabled;
    return existing;
  }

  /**
   * Get all autoposts for a guild (synchronous from memory cache)
   */
  public getAutopostsForGuild(guildId: string): AutopostConfig[] {
    return Array.from(this.inMemoryAutoposts.values()).filter((a) => a.guildId === guildId);
  }

  /**
   * Fetch and synchronize all autoposts for a guild from DB
   */
  public async fetchAutopostsForGuild(guildId: string): Promise<AutopostConfig[]> {
    if (this.autopostRepository) {
      const dbAutoposts = await this.autopostRepository.getAutopostsForGuild(guildId);
      for (const a of dbAutoposts) {
        this.inMemoryAutoposts.set(a.id, a);
      }
      return dbAutoposts;
    }
    return this.getAutopostsForGuild(guildId);
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
   * Post an individual autopost immediately
   */
  public async postAutopost(autopost: AutopostConfig, client: Client): Promise<boolean> {
    const channel = await client.channels.fetch(autopost.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      Logger.warn(`[Autopost] Channel ${autopost.channelId} not found or not text-based for guild ${autopost.guildId}`);
      autopost.lastPosted = new Date();
      if (this.autopostRepository) {
        const numId = parseInt(autopost.id, 10);
        if (!isNaN(numId)) {
          void this.autopostRepository.updateLastPosted(numId, autopost.lastPosted);
        }
      }
      return false;
    }

    const guildName = (channel as TextChannel).guild?.name ?? 'Server';

    try {
      if (autopost.contentType === 'ServerCrowns') {
        const { entries, totalActiveCrowns } = await this.crownService.getGuildLeaderboard(autopost.guildId);
        const response = CrownBuilders.buildCrownLeaderboardResponse(
          guildName,
          entries,
          undefined,
          1,
          totalActiveCrowns,
        );
        await (channel as TextChannel).send(response.toMessagePayload());
      } else {
        const embed = new EmbedBuilder()
          .setColor(DiscordConstants.LastFmColorBlue)
          .setTitle(`📊 ${autopost.schedule} ${guildName} Music Recap`)
          .setDescription(`Here is your server's **${autopost.contentType.replace('Top', 'Top ')}** overview for this ${autopost.schedule.toLowerCase()} cycle!`)
          .setFooter({ text: `tvbot Autopost • ${autopost.schedule}` })
          .setTimestamp();

        await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err: any) {
      Logger.warn({ err: err?.message }, `[Autopost] Failed to send message to channel ${autopost.channelId}`);
      autopost.lastPosted = new Date();
      if (this.autopostRepository) {
        const numId = parseInt(autopost.id, 10);
        if (!isNaN(numId)) {
          await this.autopostRepository.updateLastPosted(numId, autopost.lastPosted);
        }
      }
      return false;
    }

    autopost.lastPosted = new Date();
    if (this.autopostRepository) {
      const numId = parseInt(autopost.id, 10);
      if (!isNaN(numId)) {
        await this.autopostRepository.updateLastPosted(numId, autopost.lastPosted);
      }
    }
    return true;
  }

  /**
   * Execute scheduled autoposts across all registered guilds
   */
  public async runScheduledAutoposts(client: Client): Promise<{ executed: number; failed: number }> {
    const now = new Date();
    let executed = 0;
    let failed = 0;

    let allAutoposts: AutopostConfig[] = [];
    if (this.autopostRepository) {
      allAutoposts = await this.autopostRepository.getAllActiveAutoposts();
    } else {
      allAutoposts = Array.from(this.inMemoryAutoposts.values());
    }

    for (const autopost of allAutoposts) {
      if (!this.isAutopostDue(autopost, now)) {
        continue;
      }

      const start = Date.now();
      try {
        const success = await this.postAutopost(autopost, client);
        if (success) {
          executed++;
          const duration = Date.now() - start;
          this.telemetryService.recordCommandExecution(`autopost:${autopost.contentType.toLowerCase()}`, duration, true);
        } else {
          failed++;
        }
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
