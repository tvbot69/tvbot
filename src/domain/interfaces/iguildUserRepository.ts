export interface GuildUserLink {
  guildId: string;
  userId: number;
  whoKnowsWhitelisted: boolean;
  whoKnowsBanned: boolean;
}

export interface FullGuildUserDetails {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  lastUsed?: Date;
  whoKnowsWhitelisted: boolean;
  whoKnowsBanned: boolean;
}

export interface IGuildUserRepository {
  upsert(guildId: string, userId: number): Promise<void>;
  upsertMany(guildId: string, userIds: number[]): Promise<void>;
  remove(guildId: string, userId: number): Promise<void>;
  getUserIdsForGuild(guildId: string): Promise<number[]>;
  getGuildUsers(guildId: string): Promise<FullGuildUserDetails[]>;
}

