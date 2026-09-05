import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IUserUpdateQueue } from '@domain/interfaces/iuserUpdateQueue';
import { UpdateType } from '@domain/enums/updateType';
import { CacheService } from './cacheService';

const USER_CACHE_TTL_SECONDS = 300;

export class UserService {
  private readonly userRepository: IUserRepository;
  private readonly cache: CacheService;
  private readonly updateQueue: IUserUpdateQueue;

  constructor(
    userRepository: IUserRepository,
    cache: CacheService,
    updateQueue: IUserUpdateQueue,
  ) {
    this.userRepository = userRepository;
    this.cache = cache;
    this.updateQueue = updateQueue;
  }
  public async getUserByDiscordId(discordUserId: string): Promise<User | null> {
    const cacheKey = `user-discord:${discordUserId}`;
    const cached = await this.cache.get<User>(cacheKey);
    if (cached) {
      return cached;
    }
    const user = await this.userRepository.getUserByDiscordUserId(discordUserId);
    if (user) {
      await this.cache.set(cacheKey, user, USER_CACHE_TTL_SECONDS);
    }
    return user;
  }

  public async getUserByLastFmName(userNameLastFm: string): Promise<User | null> {
    return this.userRepository.getUserByLastFmName(userNameLastFm);
  }

  public async getUserById(userId: number): Promise<User | null> {
    return this.userRepository.getUserById(userId);
  }

  public async setUserLastFm(discordUserId: string, userNameLastFm: string): Promise<User> {
    const user = await this.userRepository.addUser(userNameLastFm, discordUserId);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return user;
  }

  public async removeUser(discordUserId: string): Promise<boolean> {
    const user = await this.getUserByDiscordId(discordUserId);
    if (!user) {
      return false;
    }
    const removed = await this.userRepository.removeUser(user.userId);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return removed;
  }

  public enqueueUserUpdate(user: User, _updateType: UpdateType): void {
    const enqueued = this.updateQueue.enqueue({
      userId: user.userId,
      discordUserId: user.discordUserId,
      userNameLastFm: user.userNameLastFm,
    });
    if (enqueued) {
      void this.updateQueue.pump();
    }
  }

  public async updateSessionKey(
    discordUserId: string,
    sessionKey: string | null,
  ): Promise<boolean> {
    const user = await this.getUserByDiscordId(discordUserId);
    if (!user) {
      return false;
    }
    await this.userRepository.setSessionKey(user.userId, sessionKey);
    await this.cache.delete(`user-discord:${discordUserId}`);
    return true;
  }
}
