import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IUserRepository } from '@domain/interfaces/iuserRepository';
import { CacheService } from './cacheService';
import { UserService } from './userService';
import { IndexService } from './indexService';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

export enum LoginStatus {
  Success = 'Success',
  NoPendingLogin = 'NoPendingLogin',
  NotAuthorizedYet = 'NotAuthorizedYet',
}

const PENDING_TOKEN_TTL_SECONDS = 3300;
const MAX_CONFIRM_ATTEMPTS = 5;

export class LoginService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly userService: UserService;
  private readonly userRepository: IUserRepository;
  private readonly cache: CacheService;
  private readonly indexService: IndexService;

  constructor(
    lastfmRepository: ILastfmRepository,
    userService: UserService,
    cache: CacheService,
    indexService: IndexService,
    userRepository: IUserRepository,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.userService = userService;
    this.cache = cache;
    this.indexService = indexService;
    this.userRepository = userRepository;
  }

  public async startLogin(discordUserId: string): Promise<string | null> {
    const token = await this.lastfmRepository.getAuthToken();
    if (!token) {
      return null;
    }

    await this.cache.set(
      `auth-pending:${discordUserId}`,
      token,
      PENDING_TOKEN_TTL_SECONDS,
    );

    const publicKey = ConfigData.Data.lastFm.publicKey;
    return `https://www.last.fm/api/auth?api_key=${publicKey}&token=${token}`;
  }

  public async confirmLogin(discordUserId: string): Promise<{
    status: LoginStatus;
    userName?: string;
  }> {
    const token = await this.cache.get<string>(`auth-pending:${discordUserId}`);
    if (!token) {
      return { status: LoginStatus.NoPendingLogin };
    }

    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
      const session = await this.lastfmRepository.getAuthSession(token);
      if (session) {
        Logger.info(`LastfmAuth: ${session.name} logged in (discordUserId: ${discordUserId})`);

        const user = await this.userService.setUserLastFm(discordUserId, session.name);
        await this.userRepository.setSessionKey(user.userId, session.key);
        await this.cache.delete(`user-discord:${discordUserId}`);
        await this.cache.delete(`auth-pending:${discordUserId}`);

        void this.indexService.indexUser(user.userId);

        return { status: LoginStatus.Success, userName: session.name };
      }
      await delay(2000);
    }

    return { status: LoginStatus.NotAuthorizedYet };
  }

  public async logout(discordUserId: string): Promise<boolean> {
    const user = await this.userService.getUserByDiscordId(discordUserId);
    if (!user) {
      return false;
    }
    await this.userRepository.setSessionKey(user.userId, null);
    await this.cache.delete(`user-discord:${discordUserId}`);
    await this.cache.delete(`auth-pending:${discordUserId}`);
    return true;
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
