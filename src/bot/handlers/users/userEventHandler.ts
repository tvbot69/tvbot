import { inject, injectable } from 'tsyringe';
import {
  Client,
  Events,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import { Logger } from '@domain/logging/logger';
import { UserService } from '@bot/services/user/userService';
import { GuildUserService } from '@bot/services/guild/guildUserService';

@injectable()
export class UserEventHandler {

  constructor(
    @inject(Client)
    private readonly client: Client,
    @inject(UserService)
    private readonly userService: UserService,
    @inject(GuildUserService)
    private readonly guildUserService: GuildUserService,
  ) {
    this.client.on(Events.GuildMemberAdd, (member) => {
      void this.handleMemberAdd(member);
    });

    this.client.on(Events.GuildMemberRemove, (member) => {
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
