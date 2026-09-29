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
  AltLimitExceeded = 'AltLimitExceeded',
  /**
   * The alt-account guard could not be evaluated, so the link was refused.
   * Distinct from AltLimitExceeded: the cap was never actually hit.
   */
  GuardUnavailable = 'GuardUnavailable',
}

// Sybil guard: one Last.fm library may back a handful of Discord rows
// (re-links, alt accounts), but unbounded rows break leaderboards.
const MAX_DISCORD_ROWS_PER_LASTFM = 5;

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

        // The alt cap is a security control, so its input must never be a
        // number the database failed to produce. A 0 from a failed query is
        // indistinguishable from "nothing is linked to this name", and since
        // the check below is `linkedCount >= 5`, one database blip silently
        // removed the ceiling on how many Discord rows can share one Last.fm
        // account. A control that disables itself on failure is worse than the
        // outage that caused it, so fail closed: refuse the link.
        //
        // The pending token is deliberately NOT deleted. The Last.fm session is
        // still valid, so retrying is one Confirm click, and the guard is
        // re-evaluated on every attempt.
        let linkedCount: number;
        try {
          linkedCount = await this.userRepository.countUsersByLastFmName(session.name);
        } catch (err) {
          Logger.error(
            { err, discordUserId, lastFm: session.name },
            '[Login] Alt-account guard unavailable — refusing link (fail closed)',
          );
          return { status: LoginStatus.GuardUnavailable, userName: session.name };
        }

        // CORRECT AS IS, and it fails in the right direction. `null` here makes
        // `isRelink` false, so a re-link of the SAME Last.fm account is treated
        // as a first link and the alt cap applies — which refuses the link and
        // logs the reason at line 104. A control that disables itself on failure
        // is the failure mode the guard above was written to avoid, and this
        // does not do that: the only cost is a relink that has to be retried
        // once the database answers.
        const alreadyLinked = await this.userService.getUserByDiscordId(discordUserId).catch(() => null);
        const isRelink = alreadyLinked?.userNameLastFm.toLowerCase() === session.name.toLowerCase();
        if (!isRelink && linkedCount >= MAX_DISCORD_ROWS_PER_LASTFM) {
          Logger.warn(
            { discordUserId, lastFm: session.name, linkedCount },
            'Login refused — too many Discord rows share this Last.fm account',
          );
          await this.cache.delete(`auth-pending:${discordUserId}`);
          return { status: LoginStatus.AltLimitExceeded, userName: session.name };
        }

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
