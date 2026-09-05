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

    client.on(Events.GuildCreate, (guild) => {
      Logger.info(`Joined guild ${guild.name} (${guild.id})`);
      void guildService.ensureGuildExists(guild);
      void guildUserService.storeGuildUsers(guild);
    });

    client.on(Events.GuildDelete, (guild) => {
      Logger.info(`Removed from guild ${guild.name ?? guild.id}`);
    });

    client.on(Events.Error, (error) => {
      Logger.error({ err: error }, 'Client error');
    });

    client.on(Events.Warn, (message) => {
      Logger.warn(message);
    });
  }
}
