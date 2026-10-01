import { singleton, inject } from 'tsyringe';
import type { Client, TextChannel } from 'discord.js';
import { Logger } from '@domain/logger';
import { TelemetryService } from './system/telemetryService';


import { ArtistsService } from './artistsService';
import { AlbumService } from './albumService';
import { TrackService } from './trackService';
import { CrownService } from './crown/crownService';
import { CrownBuilders } from '@bot/builders/crownBuilders';
import { IGuildRepository } from '@domain/interfaces/iguildRepository';
import { AutopostRepository } from '@persistence/repositories/autopostRepository';
import { EmbedBuilder } from 'discord.js';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { errorMessage } from '@domain/discordErrors';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';

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

/**
 * A scheduled post is a claim the user never asked for at the time, and it
 * outlives the sweep that made it, so a database failure here cannot be
 * degraded to a default: the guild's leaderboard/crowns would be published from
 * a failed read and nothing would ever correct it.
 *
 * The one query below is a `count`, so raising cannot reach a genuine zero: a
 * count that runs and matches nothing SUCCEEDS with 0. Every other failure is
 * a database that did not answer, and 0 is the one value that would silently
 * disable the spam guard, so it is not the default any more.
 */
const orDatabaseUnavailable = async <T>(
  method: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: `${method}:${label}`, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${method} (${label}); refusing to answer as if the guard read zero`,
    );
    throw new SourceUnavailableError(
      `autopostService.${method}:${label}`,
      err,
      'Database unavailable',
    );
  }
};

/**
 * The Discord JSON error code, when the failure carries one. discord.js puts a
 * numeric `code` on a `DiscordAPIError`; a network failure, a rate limit and a
 * plain `throw new Error(...)` do not.
 */
const discordErrorCode = (err: unknown): number | null => {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' ? code : null;
};

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
      }).catch((err: unknown) => {
        // CORRECT AS IS is not available on this path. The in-memory entry stays
        // keyed by the caller's own id and no row was written, while the sweep
        // below reads `getAllActiveAutoposts()` from the database — so the post
        // never happens, ever, and the user has already been told
        // "[Autopost] Configured ...". Raising is not possible either (the
        // caller is fire-and-forget), so the failure has to be loud.
        Logger.error(
          { err, guildId: config.guildId, contentType: config.contentType, schedule: config.schedule },
          '[Autopost] Configuration could not be persisted; this autopost will never post',
        );
      });
    }
    Logger.info(`[Autopost] Configured ${config.contentType} (${config.schedule}) for guild ${config.guildId} in #${config.channelId}`);
  }

  public static readonly MAX_AUTOPOSTS_PER_GUILD = 10;

  /**
   * Create an autopost asynchronously with database persistence.
   * Returns null when the guild already has the maximum (spam guard).
   */
  public async createAutopost(config: Omit<AutopostConfig, 'id'>): Promise<AutopostConfig | null> {
    if (this.autopostRepository) {
      const repository = this.autopostRepository;
      const existing = await orDatabaseUnavailable(
        'createAutopost',
        'guildAutopost.count',
        () => repository.countForGuild(config.guildId),
      );
      if (existing >= AutopostService.MAX_AUTOPOSTS_PER_GUILD) {
        Logger.warn(`[Autopost] Guild ${config.guildId} at autopost cap, refusing new one`);
        return null;
      }
      const created = await repository.createAutopost({
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
   * Post an individual autopost immediately. Never touches lastPosted — the
   * runner owns the claim (stamp) and the rollback, so failures retry next
   * sweep instead of being silently skipped until the following cycle.
   */
  public async postAutopost(autopost: AutopostConfig, client: Client): Promise<boolean> {
    // The RETRY POLICY IS UNCHANGED and deliberate: every failure below returns
    // false, the caller counts it as `failed`, rolls the due-claim back and tries
    // again next sweep. What changes is that the operator is told WHICH failure
    // it was, because these need different fixes and one shared WARN line said
    // none of them:
    //
    //   50001 Unknown Channel      the configured channel is gone. Re-point or
    //                              remove the autopost.
    //   50013 Missing Access       the channel EXISTS and the bot cannot post in
    //                              it. Re-invite the bot or grant View Channel +
    //                              Send Messages. This one never resolves on its
    //                              own, so it is the case that used to look like
    //                              a network blip in the log.
    //   anything else, or `null`  a transient fetch failure. Do nothing; the next
    //                              sweep retries.
    let channel: Awaited<ReturnType<Client['channels']['fetch']>> = null;
    try {
      channel = await client.channels.fetch(autopost.channelId);
    } catch (err) {
      const code = discordErrorCode(err);
      const context = { err: errorMessage(err), code, channelId: autopost.channelId, guildId: autopost.guildId };
      if (code === 50013) {
        Logger.warn(context, '[Autopost] The bot cannot access the configured channel (Missing Access). It exists, so this will fail every sweep: re-invite the bot to the server or grant View Channel + Send Messages, then re-run the autopost.');
      } else if (code === 50001) {
        Logger.warn(context, '[Autopost] The configured channel no longer exists (Unknown Channel). This will fail every sweep: point the autopost at another channel or remove it.');
      } else {
        Logger.warn(context, '[Autopost] Channel fetch failed before the channel could be read; treating it as transient and retrying next sweep.');
      }
      return false;
    }

    if (!channel) {
      Logger.warn(
        { channelId: autopost.channelId, guildId: autopost.guildId },
        '[Autopost] The configured channel could not be found. This will fail every sweep: point the autopost at another channel or remove it.',
      );
      return false;
    }

    if (!channel.isTextBased()) {
      // A channel that exists and is the wrong KIND: the admin pointed the
      // autopost at a voice channel or a category. Different fix again.
      Logger.warn(
        { channelId: autopost.channelId, guildId: autopost.guildId },
        '[Autopost] The configured channel exists but is not a text channel, so nothing can be sent to it. Point the autopost at a text channel.',
      );
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
    } catch (err) {
      Logger.warn({ err: errorMessage(err) }, `[Autopost] Failed to send message to channel ${autopost.channelId}`);
      return false;
    }

    autopost.lastPosted = new Date();
    return true;
  }

  private dueCutoff(schedule: AutopostConfig['schedule'], now: Date): Date | null {
    switch (schedule) {
      case 'Daily':
        return new Date(now.getTime() - 24 * 3600 * 1000);
      case 'Weekly':
        return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      case 'Monthly':
        return new Date(now.getTime() - 28 * 24 * 3600 * 1000);
      default:
        return null;
    }
  }

  /**
   * Execute scheduled autoposts across all registered guilds. Each due post is
   * atomically claimed first (double runners / restarts can't double-post);
   * failures roll the claim back so the next sweep retries.
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

      // Atomic claim: losers (second runner, stale re-run) skip silently.
      let previousLastPosted: Date | null | undefined;
      const numId = parseInt(autopost.id, 10);
      if (this.autopostRepository && !isNaN(numId)) {
        const cutoff = this.dueCutoff(autopost.schedule, now);
        if (!cutoff) continue;
        let claimed: Date | null | undefined;
        try {
          claimed = await this.autopostRepository.claimDueAutopost(numId, cutoff);
        } catch (err) {
          // A claim that could not be read is NOT "not due". Treating the two
          // alike skipped the post for this sweep and, because nothing counts
          // it, nothing anywhere said so. Nothing is stamped, so the next sweep
          // still retries — the retry is the correct behaviour, the silence was
          // not.
          failed++;
          Logger.error(
            { err: errorMessage(err), guildId: autopost.guildId, autopostId: autopost.id },
            '[Autopost] Due-claim query failed; post skipped this sweep and will retry',
          );
          continue;
        }
        if (claimed === null) continue;
        previousLastPosted = claimed;
        autopost.lastPosted = new Date();
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
          if (this.autopostRepository && !isNaN(numId)) {
            await this.releaseClaimQuietly(this.autopostRepository, numId, previousLastPosted, autopost);
          }
        }
      } catch (err) {
        failed++;
        if (this.autopostRepository && !isNaN(numId)) {
          await this.releaseClaimQuietly(this.autopostRepository, numId, previousLastPosted, autopost);
        }
        const duration = Date.now() - start;
        this.telemetryService.recordCommandExecution(`autopost:${autopost.contentType.toLowerCase()}`, duration, false);
        Logger.error({ err: errorMessage(err) }, `[Autopost] Failed to post ${autopost.contentType} for guild ${autopost.guildId}`);
      }
    }

    return { executed, failed };
  }

  /**
   * Roll the due-claim back so the next sweep retries. A rollback that fails is
   * the worst silent failure in this service: the stamp stays, so the post is
   * suppressed for a whole cycle and the guild silently stops getting its recap.
   *
   * It must also never rethrow — the failure path above has already counted this
   * autopost as failed, and a throw here would land in the outer catch and count
   * it a second time.
   */
  private async releaseClaimQuietly(
    repository: AutopostRepository,
    numId: number,
    previousLastPosted: Date | null | undefined,
    autopost: AutopostConfig,
  ): Promise<void> {
    try {
      await repository.releaseClaim(numId, previousLastPosted);
    } catch (err) {
      Logger.error(
        { err: errorMessage(err), guildId: autopost.guildId, autopostId: autopost.id },
        '[Autopost] Could not roll the due-claim back; this autopost is suppressed for a full cycle',
      );
    }
  }
}
