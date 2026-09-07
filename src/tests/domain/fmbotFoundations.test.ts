import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitService } from '@bot/services/rateLimitService';
import { UserService } from '@bot/services/userService';
import { SettingService } from '@bot/services/settingService';
import { Logger } from '@domain/logger';
import { TimePeriod } from '@domain/enums/timePeriod';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { IUserUpdateQueue } from '@domain/interfaces/iuserUpdateQueue';
import { CacheService } from '@bot/services/cacheService';

describe('Pillar 1: Industrial-Grade Logging & Observability', () => {
  it('generates unique 8-character alphanumeric reference IDs', () => {
    const id1 = Logger.generateReferenceId();
    const id2 = Logger.generateReferenceId();
    expect(id1).toHaveLength(8);
    expect(id2).toHaveLength(8);
    expect(id1).not.toBe(id2);
  });

  it('errorWithRef logs context and returns referenceId with clean error message', () => {
    const testError = new Error('Database connection timed out');
    const result = Logger.errorWithRef(testError, {
      commandName: 'fm',
      userName: 'moha',
      userId: '123456789',
      guildName: 'Test Guild',
      guildId: '987654321',
      shardId: 0,
      messageContent: '.fm',
    });

    expect(result.referenceId).toHaveLength(8);
    expect(result.message).toBe('Database connection timed out');
  });
});

describe('Pillar 1: Two-Tier Sliding Window Rate Limiter', () => {
  let rateLimitService: RateLimitService;
  const userId = '1122334455';

  beforeEach(() => {
    rateLimitService = new RateLimitService();
  });

  it('permits requests under the threshold (<= 13 requests in 10s)', () => {
    for (let i = 0; i < 13; i++) {
      const res = rateLimitService.checkUserRateLimit(userId);
      expect(res.rateLimited).toBe(false);
    }
  });

  it('rate limits on the 14th request within 10s and suppresses repeated error messages', () => {
    // 13 requests succeed
    for (let i = 0; i < 13; i++) {
      rateLimitService.checkUserRateLimit(userId);
    }

    // 14th request triggers rate limit for the first time
    const res14 = rateLimitService.checkUserRateLimit(userId);
    expect(res14.rateLimited).toBe(true);
    expect(res14.messageSent).toBe(false); // First time: message should be sent
    expect(res14.retryAfterSeconds).toBeGreaterThan(0);

    // 15th request is still rate limited, but message is marked as already sent (suppressed)
    const res15 = rateLimitService.checkUserRateLimit(userId);
    expect(res15.rateLimited).toBe(true);
    expect(res15.messageSent).toBe(true); // Suppressed
  });

  it('allows bypass users to execute unlimited requests without rate limiting', () => {
    const adminId = '999999999';
    rateLimitService.addBypassUser(adminId);

    for (let i = 0; i < 50; i++) {
      const res = rateLimitService.checkUserRateLimit(adminId);
      expect(res.rateLimited).toBe(false);
    }
  });

  it('resets rate limits on demand', () => {
    for (let i = 0; i < 13; i++) {
      rateLimitService.checkUserRateLimit(userId);
    }
    expect(rateLimitService.checkUserRateLimit(userId).rateLimited).toBe(true);

    rateLimitService.resetUser(userId);
    expect(rateLimitService.checkUserRateLimit(userId).rateLimited).toBe(false);
  });
});

describe('Pillar 2: SettingService Natural Language Time Parser', () => {
  const settingService = new SettingService();

  it('parses specific years (e.g. 2021)', () => {
    const parsed = settingService.getTimePeriod('2021');
    expect(parsed.timePeriod).toBe(TimePeriod.Custom);
    expect(parsed.description).toBe('2021');
    expect(parsed.startDateTime?.getUTCFullYear()).toBe(2021);
    expect(parsed.startDateTime?.getUTCMonth()).toBe(0); // January
    expect(parsed.startDateTime?.getUTCDate()).toBe(1);
    expect(parsed.endDateTime?.getUTCFullYear()).toBe(2021);
    expect(parsed.endDateTime?.getUTCMonth()).toBe(11); // December
    expect(parsed.endDateTime?.getUTCDate()).toBe(31);
    expect(parsed.searchValue).toBe('');
  });

  it('parses specific months (e.g. october)', () => {
    const parsed = settingService.getTimePeriod('october');
    expect(parsed.timePeriod).toBe(TimePeriod.Custom);
    expect(parsed.description).toBe('October');
    expect(parsed.startDateTime?.getUTCMonth()).toBe(9); // October is month index 9
    expect(parsed.startDateTime?.getUTCDate()).toBe(1);
    expect(parsed.endDateTime?.getUTCMonth()).toBe(9);
    expect(parsed.endDateTime?.getUTCDate()).toBe(31);
    expect(parsed.searchValue).toBe('');
  });

  it('parses combined month and year (e.g. october 2022)', () => {
    const parsed = settingService.getTimePeriod('october 2022');
    expect(parsed.timePeriod).toBe(TimePeriod.Custom);
    expect(parsed.description).toBe('October 2022');
    expect(parsed.startDateTime?.getUTCFullYear()).toBe(2022);
    expect(parsed.startDateTime?.getUTCMonth()).toBe(9);
    expect(parsed.startDateTime?.getUTCDate()).toBe(1);
    expect(parsed.endDateTime?.getUTCFullYear()).toBe(2022);
    expect(parsed.endDateTime?.getUTCMonth()).toBe(9);
    expect(parsed.endDateTime?.getUTCDate()).toBe(31);
    expect(parsed.searchValue).toBe('');
  });

  it('parses custom day spans (e.g. 45d)', () => {
    const parsed = settingService.getTimePeriod('45d');
    expect(parsed.timePeriod).toBe(TimePeriod.Custom);
    expect(parsed.description).toBe('45 days');
    expect(parsed.startDateTime).toBeDefined();
    expect(parsed.endDateTime).toBeDefined();
    const diffDays = Math.round((parsed.endDateTime!.getTime() - parsed.startDateTime!.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(45);
  });

  it('parses custom week spans (e.g. 2w)', () => {
    const parsed = settingService.getTimePeriod('2w');
    expect(parsed.timePeriod).toBe(TimePeriod.Custom);
    expect(parsed.description).toBe('2 weeks');
    const diffDays = Math.round((parsed.endDateTime!.getTime() - parsed.startDateTime!.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(14);
  });
});

describe('Pillar 2: UserService Production Calculations & Formatting', () => {
  const mockRepo = {} as unknown as IUserRepository;
  const mockCache = {} as unknown as CacheService;
  const mockQueue = {} as unknown as IUserUpdateQueue;
  const userService = new UserService(mockRepo, mockCache, mockQueue);

  it('accurately calculates milestone progress and days remaining', () => {
    // 8,740 total scrobbles -> Next milestone is 10,000. Current base is 5,000.
    // Interval: 5,000 plays. Progress: 3,740 / 5,000 = 74.8%.
    // Remaining: 1,260. At 40 plays/day: Math.ceil(1260 / 40) = 32 days.
    const milestone = userService.calculateMilestone(8740, 40);
    expect(milestone.nextMilestone).toBe(10000);
    expect(milestone.playsRemaining).toBe(1260);
    expect(milestone.percentageText).toBe('74.8%');
    expect(milestone.estimatedDaysLeft).toBe(32);
  });

  it('formats numbers according to user format settings', () => {
    const num = 1234567;
    expect(userService.formatNumber(num, 'comma')).toBe('1,234,567');
    expect(userService.formatNumber(num, 'space')).toBe('1 234 567');
    expect(userService.formatNumber(num, 'period')).toBe('1.234.567');
    expect(userService.formatNumber(num, 'dot')).toBe('1.234.567');
  });

  it('validates and resolves timezones safely with UTC fallback', () => {
    expect(userService.resolveTimeZone('America/New_York')).toBe('America/New_York');
    expect(userService.resolveTimeZone('Europe/London')).toBe('Europe/London');
    expect(userService.resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(userService.resolveTimeZone('Invalid/Timezone_123')).toBe('UTC');
    expect(userService.resolveTimeZone('')).toBe('UTC');
    expect(userService.resolveTimeZone(null)).toBe('UTC');
  });

  it('manages user blocklist', async () => {
    const badUserId = '666666';
    expect(await userService.isUserBlocked(badUserId)).toBe(false);

    userService.blockUser(badUserId);
    expect(await userService.isUserBlocked(badUserId)).toBe(true);

    userService.unblockUser(badUserId);
    expect(await userService.isUserBlocked(badUserId)).toBe(false);
  });
});
