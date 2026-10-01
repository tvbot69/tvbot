import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { FriendsRepository } from '../friendsRepository';
import { FriendType } from '@domain/enums/friendType';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import { UserType, DataSource } from '@persistence/domain/models/user';

/**
 * FriendsRepository was at 13.9% line coverage. Two things make it worth
 * holding hard:
 *
 *  - `map`/`mapUser` are the entity -> DTO boundary and they stringify BigInt
 *    `discordUserId`. A BigInt that reaches `JSON.stringify` throws "Do not know
 *    how to serialize a BigInt", which in this bot means the whole embed fails
 *    to send, so the conversion is not cosmetic.
 *  - `getFriended` is documented below. It runs the relationship in the
 *    opposite direction to the other two reads, so the counterpart on the DTO
 *    is the ADDER rather than the ADDED, and the query is the only one that
 *    fetches it as `user`.
 */

const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const userEntity = (over: Record<string, unknown> = {}) => ({
  userId: 2,
  userNameLastFm: 'thetarget',
  discordUserId: 4242n,
  registeredOn: new Date('2026-01-01T00:00:00Z'),
  registeredLastFm: null,
  sessionKey: null,
  userType: 'User',
  dataSource: 'LastFm',
  timeZone: null,
  lastUsed: null,
  lastUpdate: null,
  lastIndexed: null,
  totalPlayCount: null,
  lastScrobbleUpdate: null,
  privacyLevel: 'Default',
  ...over,
});

const friendEntity = (over: Record<string, unknown> = {}) => ({
  friendId: 10,
  userId: 1,
  lastFmUserName: 'theadder',
  friendUserId: 2,
  lastFmFriend: false,
  friendType: 1,
  created: new Date('2026-02-02T00:00:00Z'),
  modified: null,
  ...over,
});

const makePrisma = () => ({
  user: {
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
  },
  friend: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    upsert: vi.fn(async (..._args: unknown[]) => friendEntity()),
    update: vi.fn(async (..._args: unknown[]) => friendEntity()),
    delete: vi.fn(async (..._args: unknown[]) => friendEntity()),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    count: vi.fn(async (..._args: unknown[]) => 0),
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: FriendsRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new FriendsRepository(d as unknown as PrismaClient);
});

describe('FriendsRepository.getFriends', () => {
  it('resolves the discord id to a user id, then reads that user friends', async () => {
    d.user.findUnique.mockResolvedValue({ userId: 1 } as never);
    d.friend.findMany.mockResolvedValue([friendEntity({ friendUser: userEntity() })] as never);

    const got = await repo.getFriends('4242');

    expect(callArg(d.user.findUnique)).toEqual({
      where: { discordUserId: 4242n },
      select: { userId: true },
    });
    expect(callArg<{ where: { userId: number } }>(d.friend.findMany)?.where.userId).toBe(1);
    expect(got).toHaveLength(1);
  });

  it('returns empty and never queries friends when the discord user is unknown', async () => {
    d.user.findUnique.mockResolvedValue(null as never);

    expect(await repo.getFriends('9999')).toEqual([]);
    expect(d.friend.findMany).not.toHaveBeenCalled();
  });
});

describe('FriendsRepository.getFriendsByUserId', () => {
  it('maps rows and stringifies the nested friendUser discord id', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({ friendUser: userEntity({ discordUserId: 777n, userNameLastFm: 'theadder' }) }),
    ] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got[0]?.friendUser?.discordUserId).toBe('777');
    expect(got[0]?.friendUser?.userNameLastFm).toBe('theadder');
  });

  it('orders close friends first, then Last.fm name ascending', async () => {
    d.friend.findMany.mockResolvedValue([] as never);

    await repo.getFriendsByUserId(1);

    expect(callArg(d.friend.findMany)).toEqual({
      where: { userId: 1 },
      include: { friendUser: true },
      orderBy: [{ friendType: 'desc' }, { lastFmUserName: 'asc' }],
    });
  });

  it('leaves friendUser undefined when the row has no resolved friend', async () => {
    d.friend.findMany.mockResolvedValue([friendEntity({ friendUserId: null })] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got[0]?.friendUser).toBeUndefined();
    expect(got[0]?.friendUserId).toBeUndefined();
  });

  it('returns empty when the user has no friends', async () => {
    d.friend.findMany.mockResolvedValue([] as never);

    expect(await repo.getFriendsByUserId(1)).toEqual([]);
  });

  it('propagates a read failure rather than reporting "no friends"', async () => {
    d.friend.findMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getFriendsByUserId(1)).rejects.toThrow('db down');
  });
});

describe('FriendsRepository.getFriended', () => {
  /**
   * The relationship runs BACKWARDS here. `friendsRepository.ts` filters on
   * `friendUserId`, so on every row `friendUserId` is the caller and `userId`
   * is the person who added them:
   *
   *   - `user`       - the ADDER (`Friend.user`, `onDelete: Cascade`, so it is
   *                    never null on a row that exists)
   *   - `friendUser` - the ADDED, i.e. the caller themselves
   *   - `lastFmUserName` - the name the ADDER typed for the ADDED
   *
   * `getFriendsByUserId` and `getFriend` filter on `userId`, so there the
   * ADDER is the caller and the counterpart is `friendUser`. The DTO has ONE
   * counterpart field and both the repository's other reads and
   * `friendsCommands.friendedAsync` reach for it, so the counterpart is what
   * gets mapped — from `friendUser` on those two reads and from `user` here.
   *
   * That is the whole fix. Reading the shared `map` and finding `friendUser`
   * undefined was not a stray `include` key: `friendUser` on these rows is the
   * person running the command, so populating it from `include: { friendUser:
   * true }` would have made `.friended` print the CALLER's own name once per
   * row — a confident wrong answer in place of a stale one.
   */
  it('queries by friendUserId descending by created', async () => {
    d.friend.findMany.mockResolvedValue([] as never);

    await repo.getFriended(5);

    expect(callArg(d.friend.findMany)).toEqual({
      where: { friendUserId: 5 },
      include: { user: true },
      orderBy: { created: 'desc' },
    });
  });

  it('maps the ADDER — the `user` relation — into the counterpart field', async () => {
    // Two names, deliberately different. `lastFmUserName` is what the adder
    // typed; `user.userNameLastFm` is what the adder goes by now. A fixture
    // where they were equal could not fail whichever branch ran, which is
    // exactly why the original report went unnoticed.
    d.friend.findMany.mockResolvedValue([
      friendEntity({
        userId: 42,
        friendUserId: 5,
        lastFmUserName: 'oldname',
        user: userEntity({ userId: 42, userNameLastFm: 'registeredname' }),
      }),
    ] as never);

    const got = await repo.getFriended(5);

    expect(got[0]?.friendUser?.userNameLastFm).toBe('registeredname');
    // Proof the fixture discriminates: the two names are NOT interchangeable,
    // so this assertion cannot be satisfied by the row's own typed name.
    expect(got[0]?.friendUser?.userNameLastFm).not.toBe(got[0]?.lastFmUserName);
    expect(got[0]?.lastFmUserName).toBe('oldname');
  });

  it('never maps the caller themself as the counterpart', async () => {
    // The failure mode the fix has to avoid. `friendUserId` IS the caller, so a
    // row carrying a `friendUser` relation here means a query fetched the wrong
    // side, and the name rendered for "who added you" would be your own.
    d.friend.findMany.mockResolvedValue([
      friendEntity({
        userId: 42,
        friendUserId: 5,
        lastFmUserName: 'addertyped',
        user: userEntity({ userId: 42, userNameLastFm: 'adderregistered' }),
        friendUser: userEntity({ userId: 5, userNameLastFm: 'thecaller' }),
      }),
    ] as never);

    const got = await repo.getFriended(5);

    expect(got[0]?.friendUser?.userNameLastFm).toBe('adderregistered');
    expect(got[0]?.friendUser?.userNameLastFm).not.toBe('thecaller');
  });

  it('still returns the flat Friend fields the caller reads', async () => {
    d.friend.findMany.mockResolvedValue([friendEntity({ created: new Date('2026-03-03T00:00:00Z') })] as never);

    const got = await repo.getFriended(5);

    expect(got[0]?.friendId).toBe(10);
    expect(got[0]?.userId).toBe(1);
    expect(got[0]?.created).toEqual(new Date('2026-03-03T00:00:00Z'));
  });

  it('returns empty when nobody has added this user', async () => {
    d.friend.findMany.mockResolvedValue([] as never);

    expect(await repo.getFriended(5)).toEqual([]);
  });
});

describe('FriendsRepository.getFriend', () => {
  it('maps the row when it exists', async () => {
    d.friend.findUnique.mockResolvedValue(
      friendEntity({ friendUser: userEntity({ discordUserId: 5n }) }) as never,
    );

    const got = await repo.getFriend(10);

    expect(got?.friendId).toBe(10);
    expect(got?.friendUser?.discordUserId).toBe('5');
  });

  it('returns null when the row is gone', async () => {
    d.friend.findUnique.mockResolvedValue(null as never);

    expect(await repo.getFriend(404)).toBeNull();
  });
});

describe('FriendsRepository.addFriend', () => {
  it('upserts on the (userId, lastFmUserName) unique key and returns the new id', async () => {
    d.friend.upsert.mockResolvedValue(friendEntity({ friendId: 77 }) as never);

    const got = await repo.addFriend(1, 'theadder', 2, FriendType.CloseFriend);

    expect(got).toBe(77);
    expect(callArg(d.friend.upsert)).toEqual({
      where: { userId_lastFmUserName: { userId: 1, lastFmUserName: 'theadder' } },
      update: { friendUserId: 2, friendType: 3 },
      create: { userId: 1, lastFmUserName: 'theadder', friendUserId: 2, friendType: 3 },
    });
  });

  it('defaults to FriendType.Normal and a null friendUserId when unresolved', async () => {
    d.friend.upsert.mockResolvedValue(friendEntity({ friendId: 78 }) as never);

    await repo.addFriend(1, 'theadder');

    expect(callArg(d.friend.upsert)).toEqual({
      where: { userId_lastFmUserName: { userId: 1, lastFmUserName: 'theadder' } },
      update: { friendUserId: undefined, friendType: 1 },
      create: { userId: 1, lastFmUserName: 'theadder', friendUserId: null, friendType: 1 },
    });
  });

  it('omits friendUserId from the update branch rather than nulling a resolved link', async () => {
    d.friend.upsert.mockResolvedValue(friendEntity({ friendId: 79 }) as never);

    await repo.addFriend(1, 'theadder');

    expect(callArg<{ update: { friendUserId?: unknown } }>(d.friend.upsert)?.update.friendUserId).toBeUndefined();
  });
});

describe('FriendsRepository mutations and counts', () => {
  it('setFriendType writes the numeric enum value', async () => {
    await repo.setFriendType(10, FriendType.VisibleInNowPlaying);

    expect(callArg(d.friend.update)).toEqual({
      where: { friendId: 10 },
      data: { friendType: 2 },
    });
  });

  it('removeFriend reports true when the delete succeeds', async () => {
    expect(await repo.removeFriend(10)).toBe(true);
    expect(callArg(d.friend.delete)).toEqual({ where: { friendId: 10 } });
  });

  it('removeFriend reports false when the row was already gone (P2025)', async () => {
    d.friend.delete.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }) as never);

    expect(await repo.removeFriend(10)).toBe(false);
  });

  it('removeFriendByLfm deletes case-insensitively and reports the count as a boolean', async () => {
    d.friend.deleteMany.mockResolvedValue({ count: 1 } as never);

    expect(await repo.removeFriendByLfm(1, 'TheAdder')).toBe(true);
    expect(callArg(d.friend.deleteMany)).toEqual({
      where: { userId: 1, lastFmUserName: { equals: 'TheAdder', mode: 'insensitive' } },
    });
  });

  it('removeFriendByLfm reports false when nothing matched', async () => {
    d.friend.deleteMany.mockResolvedValue({ count: 0 } as never);

    expect(await repo.removeFriendByLfm(1, 'nobody')).toBe(false);
  });

  it('removeFriendByLfm propagates a delete failure instead of reporting false', async () => {
    d.friend.deleteMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.removeFriendByLfm(1, 'theadder')).rejects.toThrow('db down');
  });

  it('removeAllFriends returns the deleted row count', async () => {
    d.friend.deleteMany.mockResolvedValue({ count: 4 } as never);

    expect(await repo.removeAllFriends(1)).toBe(4);
    expect(callArg(d.friend.deleteMany)).toEqual({ where: { userId: 1 } });
  });

  it('getCloseFriendUserIds filters unresolved entries out of the id list', async () => {
    d.friend.findMany.mockResolvedValue([
      { friendUserId: 2 },
      { friendUserId: null },
      { friendUserId: 5 },
    ] as never);

    expect(await repo.getCloseFriendUserIds(1)).toEqual([2, 5]);
    expect(callArg(d.friend.findMany)).toEqual({
      where: { userId: 1, friendType: 3, friendUserId: { not: null } },
      select: { friendUserId: true },
    });
  });

  it('getTotalFriendCount passes the user filter through', async () => {
    d.friend.count.mockResolvedValue(9 as never);

    expect(await repo.getTotalFriendCount(1)).toBe(9);
    expect(callArg(d.friend.count)).toEqual({ where: { userId: 1 } });
  });
});

describe('FriendsRepository entity mapping', () => {
  it('maps Hide privacy to the PrivacyLevel.Hide enum, Default otherwise', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({ friendUser: userEntity({ privacyLevel: 'Hide' }) }),
      friendEntity({ friendId: 11, friendUser: userEntity({ privacyLevel: 'Default' }) }),
    ] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got[0]?.friendUser?.privacyLevel).toBe(PrivacyLevel.Hide);
    expect(got[1]?.friendUser?.privacyLevel).toBe(PrivacyLevel.Default);
  });

  it('maps every user_type variant and falls back to User for an unknown value', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({ friendId: 1, friendUser: userEntity({ userType: 'Contributor' }) }),
      friendEntity({ friendId: 2, friendUser: userEntity({ userType: 'Admin' }) }),
      friendEntity({ friendId: 3, friendUser: userEntity({ userType: 'Owner' }) }),
      friendEntity({ friendId: 4, friendUser: userEntity({ userType: 'User' }) }),
      friendEntity({ friendId: 5, friendUser: userEntity({ userType: 'Nonsense' }) }),
    ] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got.map((f) => f.friendUser?.userType)).toEqual([
      UserType.Contributor,
      UserType.Admin,
      UserType.Owner,
      UserType.User,
      UserType.User,
    ]);
  });

  it('maps every data_source variant and falls back to LastFm', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({ friendId: 1, friendUser: userEntity({ dataSource: 'SpotifyImport' }) }),
      friendEntity({ friendId: 2, friendUser: userEntity({ dataSource: 'AppleMusicImport' }) }),
      friendEntity({ friendId: 3, friendUser: userEntity({ dataSource: 'LastFm' }) }),
      friendEntity({ friendId: 4, friendUser: userEntity({ dataSource: 'Whatever' }) }),
    ] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got.map((f) => f.friendUser?.dataSource)).toEqual([
      DataSource.SpotifyImport,
      DataSource.AppleMusicImport,
      DataSource.LastFm,
      DataSource.LastFm,
    ]);
  });

  it('turns null optional columns into undefined rather than leaking nulls', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({
        friendUserId: null,
        modified: null,
        friendUser: userEntity({
          sessionKey: null,
          registeredLastFm: null,
          timeZone: null,
          lastUsed: null,
          lastUpdate: null,
          lastIndexed: null,
          totalPlayCount: null,
          lastScrobbleUpdate: null,
        }),
      }),
    ] as never);

    const [f] = await repo.getFriendsByUserId(1);
    const fu = f?.friendUser;

    expect(f?.modified).toBeUndefined();
    expect(fu?.sessionKey).toBeUndefined();
    expect(fu?.registeredLastFm).toBeUndefined();
    expect(fu?.timeZone).toBeUndefined();
    expect(fu?.lastUsed).toBeUndefined();
    expect(fu?.lastUpdate).toBeUndefined();
    expect(fu?.lastIndexed).toBeUndefined();
    expect(fu?.totalPlayCount).toBeUndefined();
    expect(fu?.lastScrobbleUpdate).toBeUndefined();
  });

  it('carries optional values through when they are present', async () => {
    const lastUsed = new Date('2026-05-05T00:00:00Z');
    const lastUpdate = new Date('2026-05-06T00:00:00Z');
    const lastIndexed = new Date('2026-05-07T00:00:00Z');
    const registeredLastFm = new Date('2026-05-08T00:00:00Z');

    d.friend.findMany.mockResolvedValue([
      friendEntity({
        modified: new Date('2026-05-09T00:00:00Z'),
        friendUser: userEntity({
          sessionKey: 'session-abc',
          timeZone: 'Europe/London',
          lastUsed,
          lastUpdate,
          lastIndexed,
          totalPlayCount: 1234,
          registeredLastFm,
        }),
      }),
    ] as never);

    const [f] = await repo.getFriendsByUserId(1);

    expect(f?.modified).toEqual(new Date('2026-05-09T00:00:00Z'));
    expect(f?.friendUser?.sessionKey).toBe('session-abc');
    expect(f?.friendUser?.timeZone).toBe('Europe/London');
    expect(f?.friendUser?.lastUsed).toBe(lastUsed);
    expect(f?.friendUser?.lastUpdate).toBe(lastUpdate);
    expect(f?.friendUser?.lastIndexed).toBe(lastIndexed);
    expect(f?.friendUser?.totalPlayCount).toBe(1234);
    expect(f?.friendUser?.registeredLastFm).toBe(registeredLastFm);
  });

  it('passes the stored friend_type straight through as the FriendType enum', async () => {
    d.friend.findMany.mockResolvedValue([
      friendEntity({ friendId: 1, friendType: 3 }),
      friendEntity({ friendId: 2, friendType: 2 }),
    ] as never);

    const got = await repo.getFriendsByUserId(1);

    expect(got[0]?.friendType).toBe(FriendType.CloseFriend);
    expect(got[1]?.friendType).toBe(FriendType.VisibleInNowPlaying);
  });
});