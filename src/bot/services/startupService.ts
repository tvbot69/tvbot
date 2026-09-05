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

      this.timerService.startAsync();
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
    const payloads = getSlashCommandPayloads();
    await this.client.application.commands.set(payloads);
    Logger.info(`Registered ${payloads.length} global slash commands`);
  }
}

