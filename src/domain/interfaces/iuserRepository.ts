import type { User } from '@persistence/domain/models/user';
import type { Friend } from '@persistence/domain/models/user';

export interface IUserRepository {
  getUserByDiscordUserId(discordUserId: string): Promise<User | null>;
  getUserByLastFmName(userNameLastFm: string): Promise<User | null>;
  getUserById(userId: number): Promise<User | null>;
  addUser(userNameLastFm: string, discordUserId: string): Promise<User>;
  updateUserLastFmName(userId: number, userNameLastFm: string): Promise<void>;
  updateUserStats(userId: number, totalPlayCount: number, lastUpdate: Date): Promise<void>;
  updateLastIndexed(userId: number, lastIndexed: Date): Promise<void>;
  setUserRegisteredLfm(userId: number, registeredLastFm: Date): Promise<void>;
  setSessionKey(userId: number, sessionKey: string | null): Promise<void>;
  removeUser(userId: number): Promise<boolean>;
  getOutdatedUsers(cutoff: Date, limit?: number): Promise<User[]>;
  getUsersWithStaleIndex(cutoff: Date, limit?: number): Promise<User[]>;
  getPrivacyHiddenUserIds(limit?: number): Promise<number[]>;
  getUsersByDiscordIds(discordUserIds: string[]): Promise<Map<string, User>>;

  /** Delta sync: set the timestamp of the user's most recent scrobble */
  setLastScrobbleUpdate(userId: number, date: Date): Promise<void>;
  /** Delta sync: update lastUpdate timestamp */
  setLastUpdate(userId: number, date: Date): Promise<void>;
  /** Delta sync: atomically increment total play count */
  incrementTotalPlayCount(userId: number, delta: number): Promise<void>;
  /** Delta sync: touch lastUsed for activity tracking */
  touchLastUsed(userId: number): Promise<void>;
}

export type { User, Friend };
