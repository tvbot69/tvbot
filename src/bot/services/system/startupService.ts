import { inject, injectable , container} from 'tsyringe';
import { createHash } from 'crypto';
import { Client, Events, ActivityType } from 'discord.js';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logging/logger';
import { ClientLogHandler } from '@bot/handlers/logs/clientLogHandler';
import { InteractionHandler } from '@bot/handlers/interactions/interactionHandler';
import { CommandHandler } from '@bot/handlers/commands/commandHandler';
import { TimerService } from '@bot/services/lastfm/timerService';
import { HealthServer } from '@bot/services/system/healthServer';
import { GuildService } from '@bot/services/guild/guildService';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { getSlashCommandDuplicates, getSlashCommandPayloads } from '@bot/slashCommands';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { LyricStatusService } from '@bot/services/music/lyricStatusService';
import { QueueService } from '@bot/services/music/queueService';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';

import { errorMessage } from '@domain/errors/discordErrors';
import { skipSlashRegister } from '@config/runtimeEnv';

@injectable()
export class StartupService {

  constructor(
    @inject(Client)
    private readonly client: Client,
    @inject(TimerService)
    private readonly timerService: TimerService,
    @inject(PuppeteerService)
    private readonly puppeteerService: PuppeteerService,
    @inject(GuildService)
    private readonly guildService: GuildService,
    @inject(MoonlinkManager)
    private readonly moonlinkManager: MoonlinkManager,
    @inject(HealthServer)
    private readonly healthServer: HealthServer,
  ) {
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
        // CORRECT AS IS is not available: a guild that fails to register has no
        // settings row, and every guild-scoped read afterwards (disabled
        // commands, autopost, ranks) then behaves as if the guild had no
        // configuration. Fire-and-forget, so it cannot be raised — but it must
        // not be invisible, or the operator reads a clean boot over a guild
        // that is silently half-wired.
        void this.guildService.ensureGuildExists(guild).catch((err: unknown) => {
          Logger.warn({ err, guildId: guild.id }, 'Failed to register guild at startup');
        });
      }

      try {
        await this.registerSlashCommands();
      } catch (err: unknown) {
        // A failed slash-command registration is survivable: the bot still
        // serves every text command, so log the real cause and keep booting
        // rather than taking the whole process down.
        //
        // `details` used to be `err.rawError ? JSON.stringify(...) :
        // err.message`, which rendered as "[object Object]" for a plain thrown
        // object and dropped the body for anything that was not
        // discord.js-shaped. errorMessage reads all three shapes.
        Logger.error({ err, details: errorMessage(err) }, 'Failed to register slash commands');
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
        const { AbuseFilterService } = await import('@bot/services/system/abuseFilterService');
        if (container.isRegistered(AbuseFilterService)) {
          await container.resolve(AbuseFilterService).refresh();
        }
      } catch (err) {
        Logger.warn({ err }, 'Failed to load abuse flags');
      }

      this.timerService.startAsync();

      if (container.isRegistered(LyricStatusService)) {
        // CORRECT AS IS: pure decoration. A failed presence update leaves the
        // default presence on screen and touches no statistic, no stored row and
        // no reply, so there is no claim here that could become false. Logging it
        // at WARN would fire on every boot during a Last.fm blip, which is
        // exactly the noise AGENTS.md §3.10 reserves for real losses.
        void container.resolve(LyricStatusService).updateLyricStatusAsync().catch(() => undefined);
      }
    });

    // Auto-register when invited to any new guild
    this.client.on(Events.GuildCreate, (guild) => {
      Logger.info(`Joined new guild: ${guild.name} (${guild.id})`);
      // Same reasoning as the startup sweep above: the join is announced as a
      // success, so an unregistered guild would be invisible from the log.
      void this.guildService.ensureGuildExists(guild).catch((err: unknown) => {
        Logger.warn({ err, guildId: guild.id }, 'Failed to register guild after join');
      });
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
    if (skipSlashRegister()) {
      Logger.info('SKIP_SLASH_REGISTER=true — skipping slash command registration');
      return;
    }
    // No silent overwrite: a duplicate top-level name means one command would
    // steal another at runtime and Discord would reject the whole deployment.
    // Throw before the PUT so deploy never ships a collided set.
    const duplicates = getSlashCommandDuplicates();
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate slash command names: ${[...new Set(duplicates)].sort().join(', ')}`,
      );
    }
    const payloads = getSlashCommandPayloads();
    // Skip the PUT entirely when nothing changed (global commands propagate
    // slowly; redundant sets only burn rate-limit budget).
    try {
      const { CacheService } = await import('@bot/services/system/cacheService');
      const cache = container.resolve(CacheService);
      const hash = createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
      // CORRECT AS IS: the catch is UNREACHABLE — `CacheService.get` catches its
      // own Redis errors and answers null, which is read here as "no stored
      // hash" and therefore as "register unconditionally". The only cost of a
      // cache miss is one extra PUT, and that PUT is the branch this is guarding.
      const prev = await cache.get<string>('slash-commands-payload-hash').catch(() => null);
      if (prev === hash) {
        Logger.info(`Slash commands unchanged (${payloads.length}), skipping registration`);
        return;
      }
      await this.client.application.commands.set(payloads);
      // CORRECT AS IS: same unreachable catch. Failing to store the hash only
      // means the next boot re-registers the same payload — no staleness, no
      // wrong command set. Note the throw cannot also reach the catch below and
      // double-register, precisely because `CacheService.set` cannot reject.
      await cache.set('slash-commands-payload-hash', hash, 86400).catch(() => undefined);
      Logger.info(`Registered ${payloads.length} global slash commands`);
    } catch {
      // CORRECT AS IS: "cache unavailable" is the honest reading here and the
      // fallback registers unconditionally, which is the safe direction — a
      // redundant PUT rather than a stale command set. Only the LOCAL reason (a
      // failing `commands.set`) can land in this catch, and it re-raises on the
      // same line, so the caller's ERROR names the real failure.
      await this.client.application.commands.set(payloads);
      Logger.info(`Registered ${payloads.length} global slash commands (uncached)`);
    }
  }
}

