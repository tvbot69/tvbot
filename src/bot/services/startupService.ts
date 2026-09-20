import { createHash } from 'crypto';
import { container } from 'tsyringe';
import { Client, Events, ActivityType } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';
import { ClientLogHandler } from '@bot/handlers/clientLogHandler';
import { InteractionHandler } from '@bot/handlers/interactionHandler';
import { CommandHandler } from '@bot/handlers/commandHandler';
import { TimerService } from './timerService';
import { HealthServer } from './healthServer';
import { GuildService } from './guild/guildService';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { getSlashCommandPayloads } from '@bot/slashCommands';
import { MoonlinkManager } from './music/moonlinkManager';
import { MusicHandler } from '@bot/handlers/musicHandler';
import { LyricStatusService } from './lyricStatusService';
import { QueueService } from './music/queueService';
import { BotScrobblingService } from './music/botScrobblingService';

export class StartupService {
  private readonly client: Client;
  private readonly timerService: TimerService;
  private readonly puppeteerService: PuppeteerService;
  private readonly guildService: GuildService;
  private readonly moonlinkManager: MoonlinkManager;
  private readonly healthServer: HealthServer;

  constructor() {
    this.client = container.resolve(Client);
    this.timerService = container.resolve(TimerService);
    this.puppeteerService = container.resolve(PuppeteerService);
    this.guildService = container.resolve(GuildService);
    this.moonlinkManager = container.resolve(MoonlinkManager);
    this.healthServer = container.resolve(HealthServer);
  }

  public async startAsync(): Promise<void> {
    const settings = ConfigData.Data;

    // Start production health monitoring HTTP server
    this.healthServer.start();

    // Preheat Puppeteer in the background immediately
    void this.puppeteerService.preheatAsync();

    this.client.once(Events.ClientReady, async (ready) => {
      const guildsCount = ready.guilds.cache.size;
      const usersCount = ready.guilds.cache.reduce((acc, g) => acc + (g.memberCount || 0), 0);
      Logger.ready(`Connected as ${ready.user.tag} (Serving ${guildsCount} guilds, ${usersCount} users)`);

      try {
        this.client.user?.setPresence({
          activities: [{ name: 'scrobbles', type: ActivityType.Watching }],
          status: 'online',
        });
      } catch (err) {
        Logger.warn({ err }, 'Failed to set initial presence');
      }

      // Initialize Lavalink Music Manager
      try {
        await this.moonlinkManager.init(this.client);
      } catch (err) {
        Logger.error({ err }, 'Failed to initialize MoonlinkManager');
      }

      // Auto-register all guilds the bot is currently in
      for (const guild of ready.guilds.cache.values()) {
        void this.guildService.ensureGuildExists(guild).catch(() => undefined);
      }

      try {
        await this.registerSlashCommands();
      } catch (err: any) {
        const details = err?.rawError ? JSON.stringify(err.rawError) : err?.message;
        Logger.error({ err, details }, `Failed to register slash commands: ${details || err}`);
      }

      // Restore durable music state (247/prefs/opt-ins survive restarts now)
      try {
        if (container.isRegistered(QueueService)) {
          await container.resolve(QueueService).loadPersistedState();
        }
      } catch (err) {
        Logger.warn({ err }, 'Failed to restore persisted music settings');
      }
      try {
        if (container.isRegistered(BotScrobblingService)) {
          await container.resolve(BotScrobblingService).loadOptIns();
        }
      } catch (err) {
        Logger.warn({ err }, 'Failed to restore scrobbling opt-ins');
      }
      try {
        const { AbuseFilterService } = await import('./abuseFilterService');
        if (container.isRegistered(AbuseFilterService)) {
          await container.resolve(AbuseFilterService).refresh();
        }
      } catch (err) {
        Logger.warn({ err }, 'Failed to load abuse flags');
      }

      this.timerService.startAsync();

      if (container.isRegistered(LyricStatusService)) {
        void container.resolve(LyricStatusService).updateLyricStatusAsync().catch(() => undefined);
      }
    });

    // Auto-register when invited to any new guild
    this.client.on(Events.GuildCreate, (guild) => {
      Logger.info(`Joined new guild: ${guild.name} (${guild.id})`);
      void this.guildService.ensureGuildExists(guild).catch(() => undefined);
    });

    container.resolve(ClientLogHandler);
    container.resolve(InteractionHandler);
    container.resolve(CommandHandler);
    container.resolve(MusicHandler);

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.client.login(settings.discord.token);
        break;
      } catch (err) {
        if (attempt < maxRetries) {
          Logger.warn({ err, attempt }, `Discord login attempt ${attempt}/${maxRetries} failed, retrying in 3s...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } else {
          throw err;
        }
      }
    }
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client.application) {
      return;
    }
    // Exactly one writer: only shard 0 (or a single unsharded process) may
    // publish global commands. N shards × every boot = global 429s + races.
    const shardId = this.client.shard?.ids?.[0] ?? 0;
    if (shardId !== 0) {
      Logger.debug('Skipping slash command registration on non-zero shard');
      return;
    }
    if (process.env.SKIP_SLASH_REGISTER === 'true') {
      Logger.info('SKIP_SLASH_REGISTER=true — skipping slash command registration');
      return;
    }
    const payloads = getSlashCommandPayloads();
    // Skip the PUT entirely when nothing changed (global commands propagate
    // slowly; redundant sets only burn rate-limit budget).
    try {
      const { CacheService } = await import('./cacheService');
      const cache = container.resolve(CacheService);
      const hash = createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
      const prev = await cache.get<string>('slash-commands-payload-hash').catch(() => null);
      if (prev === hash) {
        Logger.info(`Slash commands unchanged (${payloads.length}), skipping registration`);
        return;
      }
      await this.client.application.commands.set(payloads);
      await cache.set('slash-commands-payload-hash', hash, 86400).catch(() => undefined);
      Logger.info(`Registered ${payloads.length} global slash commands`);
    } catch {
      // Cache unavailable — register unconditionally rather than risk stale commands.
      await this.client.application.commands.set(payloads);
      Logger.info(`Registered ${payloads.length} global slash commands (uncached)`);
    }
  }
}

