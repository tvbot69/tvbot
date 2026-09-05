import type { IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';
import type { IUserRepository } from '@domain/interfaces/iuserRepository';
import type { Guild as DiscordGuild } from 'discord.js';
import { Logger } from '@domain/logger';

export class GuildUserService {
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly userRepository: IUserRepository;

  constructor(
    guildUserRepository: IGuildUserRepository,
    userRepository: IUserRepository,
  ) {
    this.guildUserRepository = guildUserRepository;
    this.userRepository = userRepository;
  }

  public async ensureUserInGuild(guildId: string, userId: number): Promise<void> {
    await this.guildUserRepository.upsert(guildId, userId);
  }

  public async removeUserFromGuild(guildId: string, userId: number): Promise<void> {
    await this.guildUserRepository.remove(guildId, userId);
  }

  public async getUserIdsForGuild(guildId: string): Promise<number[]> {
    return this.guildUserRepository.getUserIdsForGuild(guildId);
  }

  public async storeGuildUsers(guild: DiscordGuild): Promise<number> {
    try {
      const members = await guild.members.fetch();
      const discordIds = [...members.keys()];
      const registered = await this.userRepository.getUsersByDiscordIds(discordIds);
      if (registered.size === 0) {
        return 0;
      }
      const userIds = [...registered.values()].map((u) => u.userId);
      await this.guildUserRepository.upsertMany(guild.id, userIds);
      Logger.info(`Stored ${userIds.length} guild users for ${guild.name}`);
      return userIds.length;
    } catch (err) {
      Logger.warn({ err }, `Failed to store guild users for ${guild.name}`);
      return 0;
    }
  }
}
