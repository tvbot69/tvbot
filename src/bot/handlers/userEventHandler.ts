import { container } from 'tsyringe';
import {
  Client,
  Events,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import { Logger } from '@domain/logger';
import { UserService } from '@bot/services/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';

export class UserEventHandler {
  private readonly userService: UserService;
  private readonly guildUserService: GuildUserService;

  constructor() {
    const client = container.resolve(Client);
    this.userService = container.resolve(UserService);
    this.guildUserService = container.resolve(GuildUserService);

    client.on(Events.GuildMemberAdd, (member) => {
      void this.handleMemberAdd(member);
    });

    client.on(Events.GuildMemberRemove, (member) => {
      void this.handleMemberRemove(member);
    });
  }

  private async handleMemberAdd(member: GuildMember | PartialGuildMember): Promise<void> {
    try {
      const user = await this.userService.getUserByDiscordId(member.id);
      if (user) {
        await this.guildUserService.ensureUserInGuild(member.guild.id, user.userId);
        Logger.debug(`Linked registered user ${user.userId} to guild ${member.guild.id}`);
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to handle guild member add');
    }
  }

  private async handleMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    try {
      const user = await this.userService.getUserByDiscordId(member.id);
      if (user) {
        await this.guildUserService.removeUserFromGuild(member.guild.id, user.userId);
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to handle guild member remove');
    }
  }
}
