import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { FriendsRepository } from './friendsRepository';

/**
 * The counterpart relation, pinned as a CROSS-METHOD invariant rather than as a
 * single method's behaviour.
 *
 * `friendsRepository.test.ts` covers `getFriended` on its own. This file is the
 * part that needs all three reads at once, because the three do not name the
 * same relation and the mapper is shared:
 *
 *   - `getFriendsByUserId` filters on `userId` and includes `friendUser`, so the
 *     ADDER is the caller and the counterpart is the person they added.
 *   - `getFriend` includes `friendUser` for the same reason.
 *   - `getFriended` filters on `friendUserId` and includes `user`. On those
 *     rows the ADDED is the caller, so the counterpart is the person who added
 *     them — the relation Prisma calls `user`, and the one the old code
 *     fetched and then dropped.
 *
 * So the old bug was not a mistyped `include` key. Reading the shared `map`,
 * finding `friendUser` undefined on `getFriended` rows, and "fixing" the query
 * to `include: { friendUser: true }` would have populated the counterpart with
 * the CALLER — `.friended` would then print your own name once per row, which
 * is a louder and more confidently wrong answer than the stale one it replaced.
 * The invariant is therefore not "every read includes `friendUser`"; it is
 * "every read populates the counterpart from ITS OWN side of the relationship",
 * and this file is the assertion of that.
 *
 * The live consequence, for the record (not asserted here, that is the command
 * layer's job): `friendsCommands.friendedAsync` renders
 *   `f.friendUser?.userNameLastFm ?? f.lastFmUserName`
 * and `lastFmUserName` is the name the ADDER typed for the ADDED — which on this
 * path is the caller's own name. The fallback is therefore not a safe answer
 * either, and the counterpart has to be populated for `.friended` to be right.
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

  it('getFriended names `user` in its include, and maps THAT into the counterpart', async () => {
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userId: 99, userNameLastFm: 'renamed' }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    // `userId: 99` is the adder on this row, because the row is filtered on
    // `friendUserId: 2` — the added, the caller. The relation fetched is the
    // adder, and the adder is what the counterpart field now carries.
    expect(callArg<{ include: Args }>(d.friend.findMany).include).toEqual({ user: true });
    expect(f?.friendUser?.userNameLastFm).toBe('renamed');
    expect(f?.friendUser?.userId).toBe(99);
  });

  it('all three reads populate the counterpart, from their own side of the row', async () => {
    // Same model, same mapper, same DTO type. Which is why the wrong relation
    // could not be caught by a type checker, a linter, or a test that only
    // exercises one method: the difference is a runtime `undefined`, and it was
    // the wrong value rather than a missing one that made it user-visible.
    d.friend.findMany.mockResolvedValue([
      friendRow({ friendUser: userEntity({ userId: 2, userNameLastFm: 'via-friend-user' }) }),
    ] as never);
    const viaFriendUser = (await repo.getFriendsByUserId(99))[0]?.friendUser?.userNameLastFm;

    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userId: 99, userNameLastFm: 'via-user' }) }),
    ] as never);
    const viaUser = (await repo.getFriended(2))[0]?.friendUser?.userNameLastFm;

    // Different relations, different names — and both the counterpart, which is
    // the whole point. Neither read populates the other side's relation.
    expect(viaFriendUser).toBe('via-friend-user');
    expect(viaUser).toBe('via-user');
  });
});

describe('FriendsRepository.getFriended: what the caller actually gets to render', () => {
  it('renders the ADDER registered name, not the name typed on the friend row', async () => {
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userId: 99, userNameLastFm: 'registeredname' }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    // The exact expression `friendsCommands.friendedAsync` evaluates.
    const rendered = f?.friendUser?.userNameLastFm ?? f?.lastFmUserName;

    // `registeredname` is the name the adder has since registered under;
    // `oldname` is the name the adder TYPED into the row, which is a name for
    // the ADDED — the caller — not for the adder. They differ, so this can only
    // be satisfied by the counterpart being populated.
    expect(rendered).toBe('registeredname');
    expect(rendered).not.toBe('oldname');
  });

  it('carries the counterparty as a full User, so the id and name are both there', async () => {
    // What made this subtle rather than obvious: `friendUserId` was mapped, so
    // the row looked complete. Nothing was missing from the result; the JOIN to
    // the other party's user row simply was not in it.
    d.friend.findMany.mockResolvedValue([
      friendRow({ user: userEntity({ userId: 99, userNameLastFm: 'registeredname', discordUserId: 99n }) }),
    ] as never);

    const [f] = await repo.getFriended(2);

    expect(f?.friendUserId).toBe(2);
    expect(f?.friendUser?.userId).toBe(99);
    // A BigInt that reached `JSON.stringify` would break the whole embed, so
    // the string conversion is part of this assertion rather than a detail.
    expect(f?.friendUser?.discordUserId).toBe('99');
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

  it('leaves the counterpart undefined when the join produced no row', async () => {
    // `Friend.user` is non-nullable with `onDelete: Cascade`, so the database
    // cannot produce this row shape — the guard is here because the other
    // failure is a rendered `undefined` in the middle of an embed, and because
    // `undefined` is what tells the caller its `?? f.lastFmUserName` fallback
    // is a real fallback rather than an empty object dressed up as a user.
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
