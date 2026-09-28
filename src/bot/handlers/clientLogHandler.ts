import { inject, injectable } from 'tsyringe';
import { Client, Events } from 'discord.js';
import { Logger } from '@domain/logger';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildUserService } from '@bot/services/guild/guildUserService';

@injectable()
export class ClientLogHandler {
  constructor(
    @inject(Client) private readonly client: Client,
    @inject(GuildService) private readonly guildService: GuildService,
    @inject(GuildUserService) private readonly guildUserService: GuildUserService,
  ) {

    this.client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
      const unavail = unavailableGuilds ? `${unavailableGuilds.size} unavailable` : 'all available';
      Logger.shardEvent('ready', shardId, `${client.guilds.cache.size} guilds (${unavail})`);
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      Logger.shardEvent('disconnected', shardId, `Code: ${event.code}`);
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      Logger.shardEvent('connected', shardId, 'Reconnecting');
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      Logger.shardEvent('resumed', shardId, `Replayed ${replayedEvents} events`);
    });

    this.client.on(Events.GuildCreate, (guild) => {
      Logger.info(`JoinedGuild: ${guild.name} / ${guild.id} | ${guild.memberCount ?? 0} members`);
      // storeGuildUsers fetches the full member list; without the privileged
      // GuildMembers intent that throws, and an unhandled rejection here is
      // reported as a fatal process error on every single guild join.
      void guildService.ensureGuildExists(guild).catch((err) => {
        Logger.warn({ err, guildId: guild.id }, 'Failed to ensure guild exists');
      });
      void guildUserService.storeGuildUsers(guild).catch((err) => {
        Logger.warn({ err, guildId: guild.id }, 'Failed to store guild users');
      });
    });

    this.client.on(Events.GuildDelete, (guild) => {
      Logger.info(`LeftGuild: ${guild.name ?? 'unknown'} / ${guild.id} | ${guild.memberCount ?? 0} members`);
    });

    this.client.on(Events.Error, (error) => {
      Logger.error({ err: error }, 'Client error');
    });

    this.client.on(Events.Warn, (message) => {
      Logger.warn(message);
    });
  }
}
