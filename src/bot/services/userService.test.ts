import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UserService } from './userService';
import { UpdateType } from '@domain/enums/updateType';
import { UserType, DataSource, type User } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';

/**
 * UserService is the cache-aside front door for the user row plus a pile of
 * pure projection helpers that fmbot ports 1:1 (milestones, number format,
 * footers, session analytics). Those helpers are where the tests earn their
 * keep: they take raw counts and produce the exact string a user reads, and a
 * wrong answer there is not an exception, it is a confidently wrong number.
 *
 * Two structural notes before editing:
 *
 *  1. `prisma` is the FOURTH, OPTIONAL constructor arg. When it is absent the
 *     service falls back to the module-level singleton from
 *     `@persistence/prismaClient` - which would open a real connection on the
 *     first `this.db.user.count()`. Every test here injects a prisma double.
 *  2. The `setX` family shares one shape: write, evict the cache entry for the
 *     row that was returned, and return the requested value - and RAISE when
 *     the write could not run, because the command's "updated" reply is a claim
 *     about the user's own settings. The eviction uses `updated.discordUserId`
 *     rather than the requested userId, which is the only thing that can find
 *     the right `user-discord:` key. That is asserted everywhere, because a
 *     write that skips the eviction leaves the old value live for five minutes
 *     with no error anywhere.
 */

const USER_TTL = 300;

const makeUser = (over: Partial<User> = {}): User => ({
  userId: 1,
  userNameLastFm: 'moha',
  discordUserId: '900000000000000001',
  registeredOn: new Date('2026-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

const build = (over: {
  cacheGet?: unknown;
  byDiscordId?: unknown;
  byLastFmName?: unknown;
  byId?: unknown;
  addUser?: unknown;
  removeUser?: unknown;
  usersByDiscordIds?: unknown;
  enqueueResult?: boolean;
  userUpdate?: unknown;
  userCount?: number | (() => number);
} = {}) => {
  const userRepository = {
    getUserByDiscordUserId: vi.fn(async () => (over.byDiscordId === undefined ? null : over.byDiscordId)),
    getUserByLastFmName: vi.fn(async () => (over.byLastFmName === undefined ? null : over.byLastFmName)),
    getUserById: vi.fn(async () => (over.byId === undefined ? null : over.byId)),
    addUser: vi.fn(async () => (over.addUser === undefined ? makeUser() : over.addUser)),
    updateUserLastFmName: vi.fn(async () => undefined),
    updateUserStats: vi.fn(async () => undefined),
    updateLastIndexed: vi.fn(async () => undefined),
    setUserRegisteredLfm: vi.fn(async () => undefined),
    setSessionKey: vi.fn(async () => undefined),
    removeUser: vi.fn(async () => (over.removeUser === undefined ? true : over.removeUser)),
    getOutdatedUsers: vi.fn(async () => []),
    getUsersWithStaleIndex: vi.fn(async () => []),
    getPrivacyHiddenUserIds: vi.fn(async () => []),
    getUsersByDiscordIds: vi.fn(async () => (over.usersByDiscordIds === undefined ? new Map() : over.usersByDiscordIds)),
    countUsersByLastFmName: vi.fn(async () => 1),
    setLastScrobbleUpdate: vi.fn(async () => undefined),
    setLastUpdate: vi.fn(async () => undefined),
    incrementTotalPlayCount: vi.fn(async () => undefined),
    touchLastUsed: vi.fn(async () => undefined),
  };
  const cache = {
    get: vi.fn(async () => (over.cacheGet === undefined ? null : over.cacheGet)),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const updateQueue = {
    enqueue: vi.fn((_item: unknown) => (over.enqueueResult === undefined ? true : over.enqueueResult)),
    size: vi.fn(() => 0),
    registerProcessor: vi.fn(),
    pump: vi.fn(async () => undefined),
  };
  const userUpdate = vi.fn(async (_arg: unknown) => (over.userUpdate === undefined
    ? { userId: 1, discordUserId: '900000000000000001' }
    : over.userUpdate));
  const prisma = {
    user: {
      update: userUpdate,
      count: vi.fn(async (_args?: unknown) => (typeof over.userCount === 'function' ? over.userCount() : over.userCount ?? 0)),
    },
  };
  const service = new UserService(
    userRepository as never,
    cache as never,
    updateQueue as never,
    prisma as never,
  );
  return { service, userRepository, cache, updateQueue, prisma, userUpdate };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UserService.getUserByDiscordId', () => {
  it('returns the cached user without touching the repository', async () => {
    const cached = makeUser({ userNameLastFm: 'Cached' });
    const { service, userRepository, cache } = build({ cacheGet: cached });
    await expect(service.getUserByDiscordId('900000000000000001')).resolves.toBe(cached);
    expect(cache.get).toHaveBeenCalledWith('user-discord:900000000000000001');
    expect(userRepository.getUserByDiscordUserId).not.toHaveBeenCalled();
  });

  it('reads through the repository on a miss and caches for five minutes', async () => {
    const row = makeUser();
    const { service, userRepository, cache } = build({ byDiscordId: row });
    await expect(service.getUserByDiscordId('900000000000000001')).resolves.toBe(row);
    expect(userRepository.getUserByDiscordUserId).toHaveBeenCalledWith('900000000000000001');
    expect(cache.set).toHaveBeenCalledWith('user-discord:900000000000000001', row, USER_TTL);
  });

  it('does NOT cache a negative lookup', async () => {
    // A cached null would hide the user for five minutes after they link,
    // which reads as "the bot ignored my command".
    const { service, cache } = build({ byDiscordId: null });
    await expect(service.getUserByDiscordId('nope')).resolves.toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('UserService repository passthroughs', () => {
  it('looks up by Last.fm name without any caching', async () => {
    const row = makeUser();
    const { service, userRepository, cache } = build({ byLastFmName: row });
    await expect(service.getUserByLastFmName('moha')).resolves.toBe(row);
    expect(userRepository.getUserByLastFmName).toHaveBeenCalledWith('moha');
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('looks up by id without any caching', async () => {
    const row = makeUser();
    const { service, userRepository, cache } = build({ byId: row });
    await expect(service.getUserById(1)).resolves.toBe(row);
    expect(userRepository.getUserById).toHaveBeenCalledWith(1);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('batch loads by discord id and returns the repository map', async () => {
    const map = new Map([['a', makeUser()]]);
    const { service, userRepository } = build({ usersByDiscordIds: map });
    await expect(service.getMultipleUsers(['a'])).resolves.toBe(map);
    expect(userRepository.getUsersByDiscordIds).toHaveBeenCalledWith(['a']);
  });
});

describe('UserService.setUserLastFm', () => {
  it('adds the user and evicts the discord cache entry', async () => {
    const row = makeUser();
    const { service, userRepository, cache } = build({ addUser: row });
    await expect(service.setUserLastFm('900000000000000001', 'moha')).resolves.toBe(row);
    expect(userRepository.addUser).toHaveBeenCalledWith('moha', '900000000000000001');
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('does not evict when the add fails', async () => {
    const { service, userRepository, cache } = build();
    userRepository.addUser.mockRejectedValue(new Error('sybil guard'));
    await expect(service.setUserLastFm('1', 'moha')).rejects.toThrow('sybil guard');
    expect(cache.delete).not.toHaveBeenCalled();
  });
});

describe('UserService.removeUser', () => {
  it('returns false and writes nothing for an unknown discord id', async () => {
    const { service, userRepository, cache } = build({ byDiscordId: null });
    await expect(service.removeUser('nope')).resolves.toBe(false);
    expect(userRepository.removeUser).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('removes by the resolved userId, not by the discord id', async () => {
    const { service, userRepository, cache } = build({ byDiscordId: makeUser({ userId: 42 }) });
    await expect(service.removeUser('900000000000000001')).resolves.toBe(true);
    expect(userRepository.removeUser).toHaveBeenCalledWith(42);
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('still evicts the cache when the repository reports the row was already gone', async () => {
    const { service, cache } = build({ byDiscordId: makeUser(), removeUser: false });
    await expect(service.removeUser('900000000000000001')).resolves.toBe(false);
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });
});

describe('UserService.enqueueUserUpdate', () => {
  it('enqueues the identity triple and pumps the queue', async () => {
    const { service, updateQueue } = build();
    service.enqueueUserUpdate(makeUser(), UpdateType.Full);
    expect(updateQueue.enqueue).toHaveBeenCalledWith({
      userId: 1,
      discordUserId: '900000000000000001',
      userNameLastFm: 'moha',
    });
    expect(updateQueue.pump).toHaveBeenCalled();
  });

  it('does not pump when the queue refused the item', async () => {
    // enqueue() returns false when the user is already queued; pumping then
    // would be a wasted database round trip on every command.
    const { service, updateQueue } = build({ enqueueResult: false });
    service.enqueueUserUpdate(makeUser(), UpdateType.RecentPlays);
    expect(updateQueue.enqueue).toHaveBeenCalled();
    expect(updateQueue.pump).not.toHaveBeenCalled();
  });

  it('ignores the update type entirely', () => {
    // `_updateType` is unused: the queue item carries no type, so two different
    // update kinds cannot be distinguished downstream. Pinned so that a future
    // reader adding a type to the payload knows the flag is a deliberate stub.
    const { service, updateQueue } = build();
    service.enqueueUserUpdate(makeUser(), UpdateType.Full);
    service.enqueueUserUpdate(makeUser(), UpdateType.Tracks);
    const first = updateQueue.enqueue.mock.calls[0]?.[0];
    const second = updateQueue.enqueue.mock.calls[1]?.[0];
    expect(first).toEqual(second);
  });
});

describe('UserService.updateSessionKey', () => {
  it('returns false and writes nothing for an unknown user', async () => {
    const { service, userRepository, cache } = build({ byDiscordId: null });
    await expect(service.updateSessionKey('nope', 'key')).resolves.toBe(false);
    expect(userRepository.setSessionKey).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('stores the key against the resolved userId and evicts the cache', async () => {
    const { service, userRepository, cache } = build({ byDiscordId: makeUser({ userId: 7 }) });
    await expect(service.updateSessionKey('900000000000000001', 'key')).resolves.toBe(true);
    expect(userRepository.setSessionKey).toHaveBeenCalledWith(7, 'key');
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('accepts a null key, which is how a session is cleared', async () => {
    const { service, userRepository } = build({ byDiscordId: makeUser({ userId: 7 }) });
    await expect(service.updateSessionKey('900000000000000001', null)).resolves.toBe(true);
    expect(userRepository.setSessionKey).toHaveBeenCalledWith(7, null);
  });
});

describe('UserService block list', () => {
  it('starts empty', async () => {
    const { service } = build();
    await expect(service.isUserBlocked('1')).resolves.toBe(false);
  });

  it('blocks and unblocks a user', async () => {
    const { service } = build();
    service.blockUser('1');
    await expect(service.isUserBlocked('1')).resolves.toBe(true);
    service.unblockUser('1');
    await expect(service.isUserBlocked('1')).resolves.toBe(false);
  });

  it('is per service instance, so it does not leak between tests or guilds', async () => {
    const a = build().service;
    const b = build().service;
    a.blockUser('1');
    await expect(a.isUserBlocked('1')).resolves.toBe(true);
    await expect(b.isUserBlocked('1')).resolves.toBe(false);
  });

  it('unblocking a user who was never blocked is a no-op', async () => {
    const { service } = build();
    service.unblockUser('1');
    await expect(service.isUserBlocked('1')).resolves.toBe(false);
  });
});

describe('UserService referenced music', () => {
  it('stores and reads back through the command dispatcher', () => {
    const { service } = build();
    service.updateInteractionContext('msg-1', { artist: 'Radiohead', track: 'Airbag' });
    expect(service.getReferencedMusic('msg-1')).toEqual({ artist: 'Radiohead', track: 'Airbag' });
  });

  it('returns undefined for an unknown message id', () => {
    const { service } = build();
    expect(service.getReferencedMusic('never-stored')).toBeUndefined();
  });
});

describe('UserService.calculateMilestone', () => {
  it('uses 1000 as the first milestone', () => {
    const r = build().service.calculateMilestone(400);
    expect(r.currentMilestone).toBe(0);
    expect(r.nextMilestone).toBe(1000);
    expect(r.playsRemaining).toBe(600);
  });

  it('rolls the 1000-step milestones forward', () => {
    const r = build().service.calculateMilestone(1500);
    expect(r.currentMilestone).toBe(1000);
    expect(r.nextMilestone).toBe(2000);
    expect(r.playsRemaining).toBe(500);
    expect(r.percentageText).toBe('50.0%');
    expect(r.estimatedDaysLeft).toBe(13);
  });

  it('jumps straight to 10000 at exactly 5000 scrobbles', () => {
    // The >= 5000 branch is a fixed target, not a computed one, so a user at
    // 5000 has zero progress rather than a fifth of the way.
    const r = build().service.calculateMilestone(5000);
    expect(r.currentMilestone).toBe(5000);
    expect(r.nextMilestone).toBe(10000);
    expect(r.percentageText).toBe('0.0%');
  });

  it('switches to a 10000-step band at 10000 scrobbles', () => {
    const r = build().service.calculateMilestone(10000);
    expect(r.currentMilestone).toBe(10000);
    expect(r.nextMilestone).toBe(20000);
  });

  it('uses a 100000-step band from 500000 scrobbles', () => {
    const r = build().service.calculateMilestone(500000);
    expect(r.currentMilestone).toBe(500000);
    expect(r.nextMilestone).toBe(600000);
  });

  it('rounds the next milestone UP, so a boundary is never already passed', () => {
    // Math.ceil((total + 1) / step) is what keeps 9999 targeting 10000 rather
    // than a milestone the user has already reached.
    const r = build().service.calculateMilestone(9999);
    expect(r.nextMilestone).toBe(10000);
    expect(r.currentMilestone).toBe(5000);
  });

  it('rounds 99.99 up in the text while the number stays below 100', () => {
    // toFixed(1) of 99.99 is "100.0", so the rendered text can read 100% one
    // scrobble short of the milestone. Pinned as current behaviour.
    const r = build().service.calculateMilestone(19999);
    expect(r.percentage).toBeCloseTo(99.99, 2);
    expect(r.percentageText).toBe('100.0%');
    expect(r.playsRemaining).toBe(1);
  });

  it('never reports more than 100 percent', () => {
    const r = build().service.calculateMilestone(1000);
    expect(r.percentage).toBe(0);
    const over = build().service.calculateMilestone(1001);
    expect(over.percentage).toBeLessThanOrEqual(100);
  });

  it('falls back to a 40 plays-per-day average when none is supplied or it is invalid', () => {
    const zero = build().service.calculateMilestone(1000, 0);
    const negative = build().service.calculateMilestone(1000, -5);
    expect(zero.estimatedDaysLeft).toBe(25);
    expect(negative.estimatedDaysLeft).toBe(25);
  });

  it('honours a supplied daily average', () => {
    const r = build().service.calculateMilestone(1000, 100);
    expect(r.estimatedDaysLeft).toBe(10);
  });
});

describe('UserService.resolveTimeZone', () => {
  const svc = () => build().service;
  it('accepts a valid IANA zone', () => {
    expect(svc().resolveTimeZone('Europe/London')).toBe('Europe/London');
  });

  it('trims a padded valid zone', () => {
    expect(svc().resolveTimeZone('  Europe/London  ')).toBe('Europe/London');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(svc().resolveTimeZone('Mars/Olympus_Mons')).toBe('UTC');
  });

  it('falls back to UTC for empty, blank, null and non-string input', () => {
    expect(svc().resolveTimeZone(undefined)).toBe('UTC');
    expect(svc().resolveTimeZone(null)).toBe('UTC');
    expect(svc().resolveTimeZone('')).toBe('UTC');
    expect(svc().resolveTimeZone('   ')).toBe('UTC');
    expect(svc().resolveTimeZone(42 as unknown as string)).toBe('UTC');
  });
});

describe('UserService.calculateBotStats', () => {
  it('returns a zeroed report for no interactions', () => {
    expect(build().service.calculateBotStats([])).toEqual({
      totalCommands: 0,
      commandUsage: {},
      uniqueArtistsSearched: 0,
      uniqueAlbumsSearched: 0,
      uniqueTracksSearched: 0,
      topSearchedArtists: {},
      serversUsedIn: 0,
      errorRate: 0,
    });
  });

  it('returns a zeroed report for a null list', () => {
    expect(build().service.calculateBotStats(null as never).totalCommands).toBe(0);
  });

  it('counts commands per name', () => {
    const stats = build().service.calculateBotStats([
      { commandName: 'nowplaying', timestamp: new Date() },
      { commandName: 'nowplaying', timestamp: new Date() },
      { commandName: 'whoKnows', timestamp: new Date() },
    ]);
    expect(stats.totalCommands).toBe(3);
    expect(stats.commandUsage).toEqual({ nowplaying: 2, whoKnows: 1 });
  });

  it('dedupes artists case-insensitively but keys the histogram by original case', () => {
    // The Set is lowercased, the histogram is not - so "Radiohead" and
    // "radiohead" are one artist with two histogram entries. Pinned because a
    // card that says "1 unique artist" next to a two-entry list looks broken.
    const stats = build().service.calculateBotStats([
      { timestamp: new Date(), artist: 'Radiohead' },
      { timestamp: new Date(), artist: 'radiohead' },
    ]);
    expect(stats.uniqueArtistsSearched).toBe(1);
    expect(stats.topSearchedArtists).toEqual({ Radiohead: 1, radiohead: 1 });
  });

  it('counts albums and tracks case-insensitively', () => {
    const stats = build().service.calculateBotStats([
      { timestamp: new Date(), album: 'OK Computer' },
      { timestamp: new Date(), album: 'ok computer' },
      { timestamp: new Date(), track: 'Airbag' },
    ]);
    expect(stats.uniqueAlbumsSearched).toBe(1);
    expect(stats.uniqueTracksSearched).toBe(1);
  });

  it('treats a bigint and a string snowflake as the same server', () => {
    const stats = build().service.calculateBotStats([
      { timestamp: new Date(), discordGuildId: BigInt('123') },
      { timestamp: new Date(), discordGuildId: '123' },
    ]);
    expect(stats.serversUsedIn).toBe(1);
  });

  it('reports the error rate as a percentage to one decimal', () => {
    const stats = build().service.calculateBotStats([
      { timestamp: new Date() },
      { timestamp: new Date() },
      { timestamp: new Date() },
      { timestamp: new Date(), errorReferenceId: 'err-1' },
    ]);
    expect(stats.errorRate).toBe(25);
  });

  it('rounds the error rate to one decimal place', () => {
    const stats = build().service.calculateBotStats([
      { timestamp: new Date() },
      { timestamp: new Date() },
      { timestamp: new Date(), errorReferenceId: 'err-1' },
    ]);
    expect(stats.errorRate).toBe(33.3);
  });

  it('ignores rows with no command name or metadata', () => {
    const stats = build().service.calculateBotStats([{ timestamp: new Date() }]);
    expect(stats.commandUsage).toEqual({});
    expect(stats.totalCommands).toBe(1);
  });
});

describe('UserService.getFooterAsync', () => {
  it('returns an empty string with no arguments', () => {
    expect(build().service.getFooterAsync()).toBe('');
  });

  it('joins the supplied options with the bullet separator', () => {
    expect(build().service.getFooterAsync(['a', 'b'])).toBe('a • b');
  });

  it('drops empty segments instead of emitting a stray separator', () => {
    expect(build().service.getFooterAsync(['', 'b', ''])).toBe('b');
  });

  it('orders the parts as options, milestone, streak, genres', () => {
    const { service } = build();
    const milestone = service.calculateMilestone(1500);
    const footer = service.getFooterAsync(['opt'], 'indie rock', milestone, '3 day streak');
    expect(footer).toBe('opt • Progress: 50.0% (500 to 2,000) • 3 day streak • indie rock');
  });

  it('renders only the parts that were supplied', () => {
    expect(build().service.getFooterAsync([], 'indie rock')).toBe('indie rock');
    expect(build().service.getFooterAsync([], undefined, undefined, 'streak')).toBe('streak');
  });
});

describe('UserService presentation shims', () => {
  it('always returns the Last.fm red accent', async () => {
    await expect(build().service.getAccentColor()).resolves.toBe(0xb90000);
    await expect(build().service.getAccentColor(makeUser(), {})).resolves.toBe(0xb90000);
  });

  it('falls back to User for a missing user', async () => {
    await expect(build().service.getRankAsync(null)).resolves.toBe('User');
    await expect(build().service.getRankAsync(undefined)).resolves.toBe('User');
  });

  it('returns the user type as the rank', async () => {
    await expect(build().service.getRankAsync(makeUser({ userType: UserType.Admin }))).resolves.toBe('Admin');
    await expect(build().service.getRankAsync(makeUser({ userType: undefined as never }))).resolves.toBe('User');
  });

  it('uses the Last.fm name as the user title', async () => {
    await expect(build().service.getUserTitleAsync({}, makeUser())).resolves.toBe('moha');
  });
});

describe('UserService settings writers', () => {
  it('resolves the timezone before writing it and evicts on success', async () => {
    const { service, userUpdate, cache } = build();
    await expect(service.setTimeZone(1, '  Europe/London ')).resolves.toBe('Europe/London');
    expect(userUpdate).toHaveBeenCalledWith({
      where: { userId: 1 },
      data: { timeZone: 'Europe/London' },
    });
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('stores UTC for an invalid timezone rather than rejecting', async () => {
    const { service, userUpdate } = build();
    await expect(service.setTimeZone(1, 'Mars/Olympus_Mons')).resolves.toBe('UTC');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { timeZone: 'UTC' } });
  });

  it('raises and skips the eviction when the write cannot run', async () => {
    // This test used to assert the opposite: it pinned `resolves.toBe(...)` over
    // a rejected write, and called the swallow deliberate. That WAS the bug.
    // `.settimezone` replied "Timezone updated to `Europe/London`" over a row
    // that was never written, and because the eviction is keyed on the row the
    // write would have returned, the OLD value stayed live for the full 300s
    // TTL while the user believed the new one was in effect. The pair now: a
    // failure raises, and a write that RUNS still reports the honest value.
    const { service, cache } = build({ userUpdate: Promise.reject(new Error('db down')) });
    await expect(service.setTimeZone(1, 'Europe/London')).rejects.toThrow(/Database unavailable/);
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('still reports the value it wrote, and evicts, when the write ran', async () => {
    // The other half of the pair. Without it, "always throws" would pass the
    // test above, and the fix would have traded a confident lie for a confident
    // failure - users could never save a setting at all.
    const { service, userUpdate, cache } = build();
    await expect(service.setTimeZone(1, 'Europe/London')).resolves.toBe('Europe/London');
    expect(userUpdate).toHaveBeenCalledWith({
      where: { userId: 1 },
      data: { timeZone: 'Europe/London' },
    });
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });

  it('writes and evicts the numeric settings', async () => {
    const { service, userUpdate, cache } = build();
    await expect(service.setWhoKnowsMode(1, 2)).resolves.toBe(2);
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { whoKnowsMode: 2 } });
    await expect(service.setResponseMode(1, 3)).resolves.toBe(3);
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { mode: 3 } });
    await expect(service.setCoverType(1, 4)).resolves.toBe(4);
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { coverType: 4 } });
    await expect(service.setDataSource(1, 'SpotifyImport')).resolves.toBe('SpotifyImport');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { dataSource: 'SpotifyImport' } });
    expect(cache.delete).toHaveBeenCalledTimes(4);
  });

  it('evicts under the RETURNED row discord id, not the requested userId', async () => {
    // The cache key is `user-discord:<id>`, so evicting by `userId` would be a
    // no-op that leaves the old row live. Pinned explicitly.
    const { service, cache } = build({ userUpdate: { userId: 1, discordUserId: 'other-id' } });
    await service.setCoverType(1, 4);
    expect(cache.delete).toHaveBeenCalledWith('user-discord:other-id');
  });
});

describe('UserService.setPrivacyLevel', () => {
  it('maps hide to the stored Hide level and reports Server scope', async () => {
    const { service, userUpdate } = build();
    await expect(service.setPrivacyLevel(1, 'hide')).resolves.toBe('Server');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { privacyLevel: 'Hide' } });
  });

  it('collapses server onto the same stored Hide value, and reports the same scope', async () => {
    // The stored column has only two states, so `server` is written as `Hide`.
    // The reply value is derived from the STORED value, not the request, so a
    // per-guild "Server" scope request is answered "Server" and stored as Hide
    // - the two requests are indistinguishable afterwards. Pinned so nobody
    // "fixes" the return to echo the input and silently changes the contract.
    const { service, userUpdate } = build();
    await expect(service.setPrivacyLevel(1, 'server')).resolves.toBe('Server');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { privacyLevel: 'Hide' } });
  });

  it('is case-insensitive', async () => {
    const { service, userUpdate } = build();
    await expect(service.setPrivacyLevel(1, 'HIDE')).resolves.toBe('Server');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { privacyLevel: 'Hide' } });
  });

  it('falls back to Default for anything unrecognised', async () => {
    const { service, userUpdate } = build();
    await expect(service.setPrivacyLevel(1, 'martian')).resolves.toBe('Global');
    expect(userUpdate).toHaveBeenCalledWith({ where: { userId: 1 }, data: { privacyLevel: 'Default' } });
  });

  it('evicts the cache on success', async () => {
    const { service, cache } = build();
    await service.setPrivacyLevel(1, 'hide');
    expect(cache.delete).toHaveBeenCalledWith('user-discord:900000000000000001');
  });
});

describe('UserService lifecycle and counters', () => {
  it('deletes by userId through the repository', async () => {
    const { service, userRepository } = build();
    await expect(service.deleteUser(7)).resolves.toBe(true);
    expect(userRepository.removeUser).toHaveBeenCalledWith(7);
  });

  it('reports bot scrobbling as always enabled', async () => {
    const { service } = build();
    await expect(service.toggleBotScrobblingAsync(1)).resolves.toBe(true);
    await expect(service.toggleBotScrobblingAsync(1, true)).resolves.toBe(true);
  });

  it('counts all users', async () => {
    const { service, prisma } = build({ userCount: 5 });
    await expect(service.getTotalUserCountAsync()).resolves.toBe(5);
    expect(prisma.user.count).toHaveBeenCalledWith();
  });

  it('counts users active inside the default 30 day window', async () => {
    const { service, prisma } = build({ userCount: 2 });
    await expect(service.getTotalActiveUserCountAsync()).resolves.toBe(2);
    const arg = prisma.user.count.mock.calls[0]?.[0] as unknown as { where: { lastUsed: { gte: Date } } };
    const thirtyDays = Date.now() - 30 * 24 * 3600 * 1000;
    expect(arg.where.lastUsed.gte.getTime()).toBeGreaterThan(thirtyDays - 5000);
    expect(arg.where.lastUsed.gte.getTime()).toBeLessThan(thirtyDays + 5000);
  });

  it('honours a custom activity window', async () => {
    const { service, prisma } = build({ userCount: 0 });
    await service.getTotalActiveUserCountAsync(7);
    const arg = prisma.user.count.mock.calls[0]?.[0] as unknown as { where: { lastUsed: { gte: Date } } };
    const sevenDays = Date.now() - 7 * 24 * 3600 * 1000;
    expect(arg.where.lastUsed.gte.getTime()).toBeGreaterThan(sevenDays - 5000);
    expect(arg.where.lastUsed.gte.getTime()).toBeLessThan(sevenDays + 5000);
  });
});
