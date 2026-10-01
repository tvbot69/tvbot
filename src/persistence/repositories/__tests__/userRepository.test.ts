import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { UserRepository } from '../userRepository';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import { UserType, DataSource } from '@persistence/domain/models/user';

/**
 * UserRepository was at 14.9% line coverage. It is the root of the persistence
 * layer - nearly every other repository resolves a user through it - so the
 * paths worth holding are:
 *
 *  - the BigInt guards. `discordUserId` arrives from Discord as a string and is
 *    stored as `BigInt`. `BigInt('abc')` THROWS, so a non-numeric id would
 *    reject rather than return "not found". Every entry point that can receive
 *    an arbitrary string guards with `/^\d+$/` first, and that guard is the
 *    thing under test here.
 *  - `addUser` is a get-or-update-or-create in three round trips. If the
 *    existing branch stops re-reading the row, it returns the STALE user and
 *    the caller writes the new Last.fm name nowhere useful.
 *  - `getOutdatedUsers` builds a two-part AND. Reading it as "outdated OR active"
 *    instead of "outdated AND active" silently re-indexes the whole user table
 *    on every sync tick, so the exact shape is asserted.
 */

const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const userEntity = (over: Record<string, unknown> = {}) => ({
  userId: 1,
  userNameLastFm: 'someone',
  discordUserId: 4242n,
  registeredOn: new Date('2026-01-01T00:00:00Z'),
  registeredLastFm: null,
  sessionKey: null,
  userType: 'User',
  dataSource: 'LastFm',
  timeZone: null,
  mode: null,
  whoKnowsMode: null,
  coverType: null,
  lastUsed: null,
  lastUpdate: null,
  lastIndexed: null,
  totalPlayCount: null,
  lastScrobbleUpdate: null,
  privacyLevel: 'Default',
  ...over,
});

const makePrisma = () => ({
  user: {
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    count: vi.fn(async (..._args: unknown[]) => 0),
    create: vi.fn(async (..._args: unknown[]) => userEntity()),
    update: vi.fn(async (..._args: unknown[]) => userEntity()),
    delete: vi.fn(async (..._args: unknown[]) => userEntity()),
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: UserRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new UserRepository(d as unknown as PrismaClient);
});

describe('UserRepository.getUserByDiscordUserId', () => {
  it('converts the numeric string to BigInt and maps the row', async () => {
    d.user.findUnique.mockResolvedValue(userEntity({ discordUserId: 4242n }) as never);

    const got = await repo.getUserByDiscordUserId('4242');

    expect(got?.discordUserId).toBe('4242');
    expect(callArg(d.user.findUnique)).toEqual({ where: { discordUserId: 4242n } });
  });

  it('returns null for a non-numeric id WITHOUT querying (BigInt would throw)', async () => {
    expect(await repo.getUserByDiscordUserId('not-a-number')).toBeNull();
    expect(d.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an empty id', async () => {
    expect(await repo.getUserByDiscordUserId('')).toBeNull();
    expect(d.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the user is not registered', async () => {
    d.user.findUnique.mockResolvedValue(null as never);

    expect(await repo.getUserByDiscordUserId('4242')).toBeNull();
  });

  it('propagates a read failure rather than reporting "not registered"', async () => {
    d.user.findUnique.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getUserByDiscordUserId('4242')).rejects.toThrow('db down');
  });
});

describe('UserRepository name and id lookups', () => {
  it('getUserByLastFmName looks up by name and maps the row', async () => {
    d.user.findUnique.mockResolvedValue(userEntity() as never);

    const got = await repo.getUserByLastFmName('someone');

    expect(got?.userNameLastFm).toBe('someone');
    expect(callArg(d.user.findUnique)).toEqual({ where: { userNameLastFm: 'someone' } });
  });

  it('getUserByLastFmName returns null when absent', async () => {
    d.user.findUnique.mockResolvedValue(null as never);

    expect(await repo.getUserByLastFmName('nobody')).toBeNull();
  });

  it('getUserById maps the row', async () => {
    d.user.findUnique.mockResolvedValue(userEntity() as never);

    expect((await repo.getUserById(1))?.userId).toBe(1);
    expect(callArg(d.user.findUnique)).toEqual({ where: { userId: 1 } });
  });

  it('getUserById returns null when absent', async () => {
    d.user.findUnique.mockResolvedValue(null as never);

    expect(await repo.getUserById(404)).toBeNull();
  });

  it('countUsersByLastFmName counts case-insensitively', async () => {
    d.user.count.mockResolvedValue(2 as never);

    expect(await repo.countUsersByLastFmName('Someone')).toBe(2);
    expect(callArg(d.user.count)).toEqual({
      where: { userNameLastFm: { equals: 'Someone', mode: 'insensitive' } },
    });
  });
});

describe('UserRepository.addUser', () => {
  it('creates when the discord id is not registered yet', async () => {
    d.user.findUnique.mockResolvedValue(null as never);
    d.user.create.mockResolvedValue(userEntity({ userId: 5, userNameLastFm: 'newname' }) as never);

    const got = await repo.addUser('newname', '4242');

    expect(got.userId).toBe(5);
    expect(d.user.update).not.toHaveBeenCalled();
    expect(callArg(d.user.create)).toEqual({
      data: { userNameLastFm: 'newname', discordUserId: 4242n },
    });
  });

  it('updates the name and RE-READS the row when the user already exists', async () => {
    // findUnique #1 (addUser's own check) -> existing. Then update. Then
    // findUnique #2 (getUserById) -> the row as it now stands.
    d.user.findUnique
      .mockResolvedValueOnce(userEntity({ userId: 9, userNameLastFm: 'oldname' }) as never)
      .mockResolvedValueOnce(userEntity({ userId: 9, userNameLastFm: 'newname' }) as never);

    const got = await repo.addUser('newname', '4242');

    expect(got.userNameLastFm).toBe('newname');
    expect(callArg(d.user.update)).toEqual({
      where: { userId: 9 },
      data: { userNameLastFm: 'newname' },
    });
    expect(d.user.create).not.toHaveBeenCalled();
    // Two reads: the existence check and the post-update re-read.
    expect(d.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure from the existence check', async () => {
    d.user.findUnique.mockRejectedValue(new Error('db down') as never);

    await expect(repo.addUser('newname', '4242')).rejects.toThrow('db down');
    expect(d.user.create).not.toHaveBeenCalled();
  });
});

describe('UserRepository writers', () => {
  it('updateUserLastFmName writes only the name', async () => {
    await repo.updateUserLastFmName(1, 'newname');

    expect(callArg(d.user.update)).toEqual({ where: { userId: 1 }, data: { userNameLastFm: 'newname' } });
  });

  it('updateUserStats writes the count and the timestamp together', async () => {
    const when = new Date('2026-04-04T00:00:00Z');

    await repo.updateUserStats(1, 500, when);

    expect(callArg(d.user.update)).toEqual({
      where: { userId: 1 },
      data: { totalPlayCount: 500, lastUpdate: when },
    });
  });

  it('updateLastIndexed writes only lastIndexed', async () => {
    const when = new Date('2026-04-05T00:00:00Z');

    await repo.updateLastIndexed(1, when);

    expect(callArg(d.user.update)).toEqual({ where: { userId: 1 }, data: { lastIndexed: when } });
  });

  it('setUserRegisteredLfm writes registeredLastFm', async () => {
    const when = new Date('2026-04-06T00:00:00Z');

    await repo.setUserRegisteredLfm(1, when);

    expect(callArg(d.user.update)).toEqual({
      where: { userId: 1 },
      data: { registeredLastFm: when },
    });
  });

  it('setSessionKey stores a key', async () => {
    await repo.setSessionKey(1, 'session-abc');

    expect(callArg(d.user.update)).toEqual({
      where: { userId: 1 },
      data: { sessionKey: 'session-abc' },
    });
  });

  it('setSessionKey stores null to clear the key', async () => {
    await repo.setSessionKey(1, null);

    expect(callArg<{ data: { sessionKey: unknown } }>(d.user.update)?.data.sessionKey).toBeNull();
  });

  it('setLastScrobbleUpdate and setLastUpdate write their own columns', async () => {
    const a = new Date('2026-04-07T00:00:00Z');
    const b = new Date('2026-04-08T00:00:00Z');

    await repo.setLastScrobbleUpdate(1, a);
    expect(callArg(d.user.update)).toEqual({ where: { userId: 1 }, data: { lastScrobbleUpdate: a } });

    await repo.setLastUpdate(1, b);
    expect(callArg(d.user.update, 1)).toEqual({ where: { userId: 1 }, data: { lastUpdate: b } });
  });

  it('incrementTotalPlayCount uses an atomic increment, not a read-modify-write', async () => {
    await repo.incrementTotalPlayCount(1, 3);

    expect(callArg(d.user.update)).toEqual({
      where: { userId: 1 },
      data: { totalPlayCount: { increment: 3 } },
    });
  });

  it('touchLastUsed stamps a Date', async () => {
    await repo.touchLastUsed(1);

    const data = callArg<{ data: { lastUsed: Date } }>(d.user.update)?.data;
    expect(data?.lastUsed).toBeInstanceOf(Date);
    expect(callArg(d.user.update)).toEqual({ where: { userId: 1 }, data: { lastUsed: data?.lastUsed } });
  });

  it('propagates a write failure rather than reporting success', async () => {
    d.user.update.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.incrementTotalPlayCount(1, 3)).rejects.toThrow('write failed');
  });
});

describe('UserRepository.removeUser', () => {
  it('reports true when the row was deleted', async () => {
    expect(await repo.removeUser(1)).toBe(true);
    expect(callArg(d.user.delete)).toEqual({ where: { userId: 1 } });
  });

  it('reports false when Prisma raises P2025 (row already gone)', async () => {
    d.user.delete.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }) as never);

    expect(await repo.removeUser(1)).toBe(false);
  });

  it('reports false for a non-P2025 failure too, and never rethrows', async () => {
    d.user.delete.mockRejectedValue(new Error('connection reset') as never);

    expect(await repo.removeUser(1)).toBe(false);
  });
});

describe('UserRepository bulk reads', () => {
  it('getOutdatedUsers ANDs the stale condition with the still-active one', async () => {
    const cutoff = new Date('2026-06-01T00:00:00Z');
    d.user.findMany.mockResolvedValue([userEntity()] as never);

    const got = await repo.getOutdatedUsers(cutoff);

    expect(got).toHaveLength(1);
    const where = callArg<{ where: { AND: unknown[] }; take: number; orderBy: unknown }>(
      d.user.findMany,
    )?.where;
    expect(where?.AND).toHaveLength(2);
    // Read as OR-of-ORs this would re-index every user on every tick.
    expect(where?.AND[0]).toEqual({
      OR: [{ lastUpdate: null }, { lastUpdate: { lt: cutoff } }],
    });
    expect(where?.AND[1]).toEqual({
      OR: [{ lastUsed: null }, { lastUsed: { gt: expect.any(Date) } }],
    });
    expect(callArg<{ take: number }>(d.user.findMany)?.take).toBe(2000);
  });

  it('getOutdatedUsers honours an explicit limit', async () => {
    d.user.findMany.mockResolvedValue([] as never);

    await repo.getOutdatedUsers(new Date(), 10);

    expect(callArg<{ take: number }>(d.user.findMany)?.take).toBe(10);
  });

  it('getOutdatedUsers returns empty when nobody needs re-syncing', async () => {
    d.user.findMany.mockResolvedValue([] as never);

    expect(await repo.getOutdatedUsers(new Date())).toEqual([]);
  });

  it('getUsersWithStaleIndex selects never-indexed or indexed-before-cutoff, oldest first', async () => {
    const cutoff = new Date('2026-06-02T00:00:00Z');
    d.user.findMany.mockResolvedValue([userEntity()] as never);

    const got = await repo.getUsersWithStaleIndex(cutoff);

    expect(got).toHaveLength(1);
    expect(callArg(d.user.findMany)).toEqual({
      where: { OR: [{ lastIndexed: null }, { lastIndexed: { lt: cutoff } }] },
      take: 2000,
      orderBy: { lastIndexed: 'asc' },
    });
  });

  it('getPrivacyHiddenUserIds returns only userIds for privacy=Hide', async () => {
    d.user.findMany.mockResolvedValue([{ userId: 3 }, { userId: 4 }] as never);

    expect(await repo.getPrivacyHiddenUserIds()).toEqual([3, 4]);
    expect(callArg(d.user.findMany)).toEqual({
      where: { privacyLevel: 'Hide' },
      select: { userId: true },
      take: 5000,
    });
  });

  it('getUsersByDiscordIds keys the map by the STRING discord id', async () => {
    d.user.findMany.mockResolvedValue([userEntity({ discordUserId: 4242n })] as never);

    const got = await repo.getUsersByDiscordIds(['4242']);

    expect(got.get('4242')?.userId).toBe(1);
    expect(callArg<{ where: { discordUserId: { in: bigint[] } } }>(d.user.findMany)?.where.discordUserId.in).toEqual([
      4242n,
    ]);
  });

  it('getUsersByDiscordIds filters non-numeric ids before touching the database', async () => {
    d.user.findMany.mockResolvedValue([] as never);

    const got = await repo.getUsersByDiscordIds(['abc', '', '77']);

    expect(got.size).toBe(0);
    expect(callArg<{ where: { discordUserId: { in: bigint[] } } }>(d.user.findMany)?.where.discordUserId.in).toEqual([
      77n,
    ]);
  });

  it('getUsersByDiscordIds returns an empty map and skips the query when no id is valid', async () => {
    const got = await repo.getUsersByDiscordIds(['abc', '', 'xyz']);

    expect(got.size).toBe(0);
    expect(d.user.findMany).not.toHaveBeenCalled();
  });
});

describe('UserRepository entity mapping', () => {
  it('maps Hide privacy to the enum and Default otherwise', async () => {
    d.user.findUnique.mockResolvedValueOnce(userEntity({ privacyLevel: 'Hide' }) as never);

    expect((await repo.getUserById(1))?.privacyLevel).toBe(PrivacyLevel.Hide);

    d.user.findUnique.mockResolvedValueOnce(userEntity({ privacyLevel: 'Default' }) as never);
    expect((await repo.getUserById(1))?.privacyLevel).toBe(PrivacyLevel.Default);
  });

  it('maps every user_type variant and falls back to User', async () => {
    for (const [value, expected] of [
      ['Contributor', UserType.Contributor],
      ['Admin', UserType.Admin],
      ['Owner', UserType.Owner],
      ['User', UserType.User],
      ['Nonsense', UserType.User],
    ] as const) {
      d.user.findUnique.mockResolvedValueOnce(userEntity({ userType: value }) as never);
      expect((await repo.getUserById(1))?.userType).toBe(expected);
    }
  });

  it('maps every data_source variant and falls back to LastFm', async () => {
    for (const [value, expected] of [
      ['SpotifyImport', DataSource.SpotifyImport],
      ['AppleMusicImport', DataSource.AppleMusicImport],
      ['LastFm', DataSource.LastFm],
      ['Whatever', DataSource.LastFm],
    ] as const) {
      d.user.findUnique.mockResolvedValueOnce(userEntity({ dataSource: value }) as never);
      expect((await repo.getUserById(1))?.dataSource).toBe(expected);
    }
  });

  it('turns null optional columns into undefined', async () => {
    d.user.findUnique.mockResolvedValue(userEntity() as never);

    const got = await repo.getUserById(1);

    expect(got?.registeredLastFm).toBeUndefined();
    expect(got?.sessionKey).toBeUndefined();
    expect(got?.timeZone).toBeUndefined();
    expect(got?.mode).toBeUndefined();
    expect(got?.whoKnowsMode).toBeUndefined();
    expect(got?.coverType).toBeUndefined();
    expect(got?.lastUsed).toBeUndefined();
    expect(got?.lastUpdate).toBeUndefined();
    expect(got?.lastIndexed).toBeUndefined();
    expect(got?.totalPlayCount).toBeUndefined();
    expect(got?.lastScrobbleUpdate).toBeUndefined();
  });

  it('carries optional values through, including a zero play count', async () => {
    d.user.findUnique.mockResolvedValue(
      userEntity({
        registeredLastFm: new Date('2026-01-02T00:00:00Z'),
        sessionKey: 'k',
        timeZone: 'UTC',
        mode: 0,
        whoKnowsMode: 1,
        coverType: 2,
        lastUsed: new Date('2026-01-03T00:00:00Z'),
        lastUpdate: new Date('2026-01-04T00:00:00Z'),
        lastIndexed: new Date('2026-01-05T00:00:00Z'),
        totalPlayCount: 0,
        lastScrobbleUpdate: new Date('2026-01-06T00:00:00Z'),
      }) as never,
    );

    const got = await repo.getUserById(1);

    // totalPlayCount 0 must survive `?? undefined` - only null is dropped.
    expect(got?.totalPlayCount).toBe(0);
    expect(got?.mode).toBe(0);
    expect(got?.sessionKey).toBe('k');
    expect(got?.timeZone).toBe('UTC');
    expect(got?.whoKnowsMode).toBe(1);
    expect(got?.coverType).toBe(2);
    expect(got?.lastUsed).toEqual(new Date('2026-01-03T00:00:00Z'));
    expect(got?.lastUpdate).toEqual(new Date('2026-01-04T00:00:00Z'));
    expect(got?.lastIndexed).toEqual(new Date('2026-01-05T00:00:00Z'));
    expect(got?.registeredLastFm).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(got?.lastScrobbleUpdate).toEqual(new Date('2026-01-06T00:00:00Z'));
  });
});