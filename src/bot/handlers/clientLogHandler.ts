import { container } from 'tsyringe';
import { Client, Events } from 'discord.js';
import { Logger } from '@domain/logger';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildUserService } from '@bot/services/guild/guildUserService';

export class ClientLogHandler {
  constructor() {
    const client = container.resolve(Client);
    const guildService = container.resolve(GuildService);
    const guildUserService = container.resolve(GuildUserService);

    client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
      const unavail = unavailableGuilds ? `${unavailableGuilds.size} unavailable` : 'all available';
      Logger.shardEvent('ready', shardId, `${client.guilds.cache.size} guilds (${unavail})`);
    });

    client.on(Events.ShardDisconnect, (event, shardId) => {
      Logger.shardEvent('disconnected', shardId, `Code: ${event.code}`);
    });

    client.on(Events.ShardReconnecting, (shardId) => {
      Logger.shardEvent('connected', shardId, 'Reconnecting');
    });

    client.on(Events.ShardResume, (shardId, replayedEvents) => {
      Logger.shardEvent('resumed', shardId, `Replayed ${replayedEvents} events`);
    });

    client.on(Events.GuildCreate, (guild) => {
      Logger.info(`JoinedGuild: ${guild.name} / ${guild.id} | ${guild.memberCount ?? 0} members`);
      void guildService.ensureGuildExists(guild);
      void guildUserService.storeGuildUsers(guild);
    });

    client.on(Events.GuildDelete, (guild) => {
      Logger.info(`LeftGuild: ${guild.name ?? 'unknown'} / ${guild.id} | ${guild.memberCount ?? 0} members`);
    });

    client.on(Events.Error, (error) => {
      Logger.error({ err: error }, 'Client error');
    });

    client.on(Events.Warn, (message) => {
      Logger.warn(message);
    });
  }
}
