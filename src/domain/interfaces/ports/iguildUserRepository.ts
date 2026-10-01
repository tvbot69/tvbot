export interface GuildUserLink {
  guildId: string;
  userId: number;
  /** Tri-state since 20260928220000: null = undecided (included), true = whitelisted, false = excluded. */
  whoKnowsWhitelisted: boolean | null;
  whoKnowsBanned: boolean;
}

export interface FullGuildUserDetails {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  lastUsed?: Date;
  /** Tri-state since 20260928220000: null = undecided (included), true = whitelisted, false = excluded. */
  whoKnowsWhitelisted: boolean | null;
  whoKnowsBanned: boolean;
  blockedFromCrowns?: boolean;
  selfBlockFromWhoKnows?: boolean;
  privacyLevel?: string;
}

export interface IGuildUserRepository {
  upsert(guildId: string, userId: number): Promise<void>;
  upsertMany(guildId: string, userIds: number[]): Promise<void>;
  remove(guildId: string, userId: number): Promise<void>;
  getUserIdsForGuild(guildId: string): Promise<number[]>;
  getGuildUsers(guildId: string): Promise<FullGuildUserDetails[]>;
  setBlockStatus(guildId: string, userId: number, blocked: boolean): Promise<void>;
}

