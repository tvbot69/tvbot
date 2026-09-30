import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { FriendsRepository } from './friendsRepository';

/**
 * The `include` / `map` mismatch on `getFriended`, pinned as a CROSS-METHOD
 * invariant rather than as a single method's behaviour.
 *
 * `friendsRepository.test.ts` already documents this bug inside
 * `describe('FriendsRepository.getFriended')`: the query asks for
 * `include: { user: true }` while the shared `map` reads `entity.friendUser`,
 * so the relation is fetched and then discarded. This file is not a second
 * copy of that. It is the part the other file cannot state, because it needs
 * all three reads at once:
 *
 *   - `getFriendsByUserId` and `getFriend` name `friendUser` in their `include`
 *     and therefore DO populate `friendUser` on the DTO.
 *   - `getFriended` names `user` and therefore never does.
 *
 * So the mapper is not at fault and neither are the other two queries. There is
 * exactly one wrong relation name, on one method, and the only symptom is that
 * the one caller which reads `friendUser` silently takes its fallback branch.
 * Stated that way, "fix" has exactly one place to change - and this file is the
 * assertion that has to change with it.
 *
 * The live consequence, for the record (not asserted here, that is the command
 * layer's job): `friendsCommands.friendedAsync` renders
 *   `f.friendUser?.userNameLastFm ?? f.lastFmUserName`
 * so `.friended` always prints the name TYPED ON THE FRIEND ROW rather than the
 * name the adder has since registered under.
 *
 * NOT FIXED HERE. This is a reporting task, and per the A-tier bar the shape
 * must be pinned before anything is changed so the change is visible.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

const userEntity = (over: Args = {}) => ({
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

/**
 * A friend row where the adder has since RENAMED themselves. The row still
 * carries the old typed name; the `user` relation carries the new registered
 * one. The two differ, which is the whole point: with them equal, the bug is
 * invisible in the output and nobody would ever file it.
 */
const friendRow = (over: Args = {}) => ({
  friendId: 10,
  userId: 99,
  lastFmUserName: 'oldname',
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
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: FriendsRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new FriendsRepository(d as unknown as PrismaClient);
});

describe('FriendsRepository: which reads populate friendUser', () => {
  it('getFriendsByUserId names friendUser in its include, and populates it', async () => {
    d.friend.findMany.mockResolvedValue([
      friendRow({ lastFmUserName: 'someone', friendUser: userEntity({ userNameLastFm: 'renamed' }) }),
    ] as never);

    const [f] = await repo.getFriendsByUserId(99);

    expect(callArg<{ include: Args }>(d.friend.findMany).include).toEqual({ friendUser: true });
    expect(f?.friendUser?.userNameLastFm).toBe('renamed');
  });

  it('getFriend names friendUser in its include, and populates it', async () => {
    d.friend.findUnique.mockResolvedValue(
      friendRow({ lastFmUserName: 'someone', friendUser: userEntity({ userNameLastFm: 'renamed' }) }) as never,
    );

    const got = await repo.getFriend(10);

    expect(callArg<{ include: Args }>(d.friend.findUnique).include).toEqual({ friendUser: true });
    expect(got?.friendUser?.userNameLastFm).toBe('renamed');
  });

  it('getFriended names `user` in its include, and therefore populates NOTHING', async () => {
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userNameLastFm: 'renamed' }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    // The relation that was asked for, and the relation the mapper reads, are
    // two different columns of the same table. `friends.user` is the ADDER;
    // `friends.friend_user` is the ADDED. The query fetches the adder and the
    // mapper reads the added.
    expect(callArg<{ include: Args }>(d.friend.findMany).include).toEqual({ user: true });
    expect(f?.friendUser).toBeUndefined();
  });

  it('the mismatch is the ONLY difference between the three reads', async () => {
    // Same model, same mapper, same DTO type. Which is why this cannot be
    // caught by a type checker, a linter, or a test that only exercises one
    // method: the wrong key is a runtime `undefined`.
    d.friend.findMany.mockResolvedValue([
      friendRow({ friendUser: userEntity({ userNameLastFm: 'via-friend-user' }) }),
    ] as never);
    const viaFriendUser = (await repo.getFriendsByUserId(99))[0]?.friendUser?.userNameLastFm;

    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userNameLastFm: 'via-user' }) }),
    ] as never);
    const viaUser = (await repo.getFriended(2))[0]?.friendUser?.userNameLastFm;

    expect(viaFriendUser).toBe('via-friend-user');
    expect(viaUser).toBeUndefined();
  });
});

describe('FriendsRepository.getFriended: what the caller actually gets to render', () => {
  it('renders the NAME TYPED ON THE FRIEND ROW, not the adder registered name', async () => {
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userNameLastFm: 'registeredname' }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    // The exact expression `friendsCommands.friendedAsync` evaluates.
    const rendered = f?.friendUser?.userNameLastFm ?? f?.lastFmUserName;

    // The relation that holds the adder's real, current name was fetched and
    // dropped, so the output is the stale typed name.
    expect(rendered).toBe('oldname');
  });

  it('still carries friendUserId, so the id needed to render correctly IS present', async () => {
    // What makes this a subtle bug rather than an obvious one: the FK is
    // mapped, so the row looks complete. Nothing is missing from the result;
    // the JOIN to the user row simply is not in it.
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userNameLastFm: 'registeredname' }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    expect(f?.friendUserId).toBe(2);
    expect(f?.friendUser).toBeUndefined();
  });

  it('carries the flat fields the caller reads, including created for the age stamp', async () => {
    const created = new Date('2026-03-03T00:00:00Z');
    d.friend.findMany.mockResolvedValue([friendRow({ created })] as never);

    const [f] = await repo.getFriended(2);

    expect(f?.friendId).toBe(10);
    expect(f?.userId).toBe(99);
    expect(f?.created).toEqual(created);
    expect(f?.friendType).toBe(1);
  });

  it('leaves friendUser undefined for an unresolved friend, which is CORRECT here', async () => {
    // `friend_user_id` is nullable and set to NULL when the target user is
    // deleted. On this path the DTO is right for the wrong reason, and it must
    // stay `undefined` rather than becoming an empty object.
    d.friend.findMany.mockResolvedValue([
      friendRow({ friendUserId: null, user: null }),
    ] as never);

    const [f] = await repo.getFriended(2);

    expect(f?.friendUser).toBeUndefined();
    expect(f?.friendUserId).toBeUndefined();
  });

  it('filters by friendUserId - the ADDED - and orders newest first', async () => {
    d.friend.findMany.mockResolvedValue([] as never);

    await repo.getFriended(2);

    // `getFriends` is filtered on `userId` and `getFriended` on
    // `friendUserId`: they are opposite directions, and swapping them would
    // make "my friends" and "who added me" the same list.
    expect(callArg(d.friend.findMany)).toEqual({
      where: { friendUserId: 2 },
      include: { user: true },
      orderBy: { created: 'desc' },
    });
  });
});

describe('FriendsRepository.getFriended: empty is empty, failure is a failure', () => {
  it('returns an empty list when nobody has added this user', async () => {
    d.friend.findMany.mockResolvedValue([] as never);
    // The caller renders "Nobody has added you to their friends list yet."
    // That is an honest answer and must stay reachable.
    expect(await repo.getFriended(2)).toEqual([]);
  });

  it('propagates a read failure rather than reporting "nobody has added you"', async () => {
    // This is the A1 rule, and it is the one that matters here: an empty list
    // on a dead connection is rendered to the user as a statement about their
    // social graph, and there is no way to tell it from the truth.
    d.friend.findMany.mockRejectedValue(new Error('db down') as never);
    await expect(repo.getFriended(2)).rejects.toThrow('db down');
  });
});
