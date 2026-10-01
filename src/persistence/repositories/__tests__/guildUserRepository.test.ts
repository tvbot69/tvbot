import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GuildUserRepository } from '../guildUserRepository';

/**
 * GuildUserRepository was at 15.4% line coverage. It is the guild-membership
 * join table, and every method takes a raw Discord guild id as a STRING.
 *
 * The `/^\d+$/` guard at the top of each method is the whole point of this
 * file's coverage. `guildId` comes off an interaction, and `BigInt('abc')`
 * THROWS rather than returning something falsy - so an unguarded call is a
 * rejected promise escaping into a command handler, not a quiet no-op. The
 * guards return `[]`/`undefined` instead. If a guard is ever removed, these
 * tests fail, which is the point.
 *
 * `getGuildUsers` also does the other BigInt -> string conversion on the way
 * out, and `String(privacyLevel)` rather than an enum mapping - the DTO type is
 * `privacyLevel?: string`, so that is deliberate and pinned.
 */

const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const makePrisma = () => ({
  guildUser: {
    upsert: vi.fn(async (..._args: unknown[]) => undefined),
    createMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    updateMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: GuildUserRepository;

const BAD_IDS = ['', 'abc', '123abc', '12 34', '-1', '1.5'];

beforeEach(() => {
  d = makePrisma();
  repo = new GuildUserRepository(d as unknown as PrismaClient);
});

describe('GuildUserRepository.upsert', () => {
  it('upserts on the (guildId, userId) composite key with BigInt guild id', async () => {
    await repo.upsert('111', 5);

    expect(callArg(d.guildUser.upsert)).toEqual({
      where: { guildId_userId: { guildId: 111n, userId: 5 } },
      update: {},
      create: { guildId: 111n, userId: 5 },
    });
  });

  it.each(BAD_IDS)('refuses guild id %j without querying', async (bad) => {
    await repo.upsert(bad, 5);

    expect(d.guildUser.upsert).not.toHaveBeenCalled();
  });

  it('propagates a write failure', async () => {
    d.guildUser.upsert.mockRejectedValue(new Error('db down') as never);

    await expect(repo.upsert('111', 5)).rejects.toThrow('db down');
  });
});

describe('GuildUserRepository.upsertMany', () => {
  it('creates one row per user id with skipDuplicates', async () => {
    await repo.upsertMany('111', [5, 6, 7]);

    expect(callArg(d.guildUser.createMany)).toEqual({
      data: [
        { guildId: 111n, userId: 5 },
        { guildId: 111n, userId: 6 },
        { guildId: 111n, userId: 7 },
      ],
      skipDuplicates: true,
    });
  });

  it('does nothing for an empty id list', async () => {
    await repo.upsertMany('111', []);

    expect(d.guildUser.createMany).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)('refuses guild id %j without querying', async (bad) => {
    await repo.upsertMany(bad, [5]);

    expect(d.guildUser.createMany).not.toHaveBeenCalled();
  });
});

describe('GuildUserRepository.remove', () => {
  it('deletes the matching row', async () => {
    await repo.remove('111', 5);

    expect(callArg(d.guildUser.deleteMany)).toEqual({
      where: { guildId: 111n, userId: 5 },
    });
  });

  it.each(BAD_IDS)('refuses guild id %j without querying', async (bad) => {
    await repo.remove(bad, 5);

    expect(d.guildUser.deleteMany).not.toHaveBeenCalled();
  });

  it('propagates a delete failure', async () => {
    d.guildUser.deleteMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.remove('111', 5)).rejects.toThrow('db down');
  });
});

describe('GuildUserRepository.getUserIdsForGuild', () => {
  it('projects userId only and returns the ids', async () => {
    d.guildUser.findMany.mockResolvedValue([{ userId: 5 }, { userId: 6 }] as never);

    expect(await repo.getUserIdsForGuild('111')).toEqual([5, 6]);
    expect(callArg(d.guildUser.findMany)).toEqual({
      where: { guildId: 111n },
      select: { userId: true },
    });
  });

  it('returns empty when the guild has no linked users', async () => {
    d.guildUser.findMany.mockResolvedValue([] as never);

    expect(await repo.getUserIdsForGuild('111')).toEqual([]);
  });

  it.each(BAD_IDS)('refuses guild id %j and returns empty without querying', async (bad) => {
    expect(await repo.getUserIdsForGuild(bad)).toEqual([]);
    expect(d.guildUser.findMany).not.toHaveBeenCalled();
  });

  it('propagates a read failure rather than reporting an empty guild', async () => {
    d.guildUser.findMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getUserIdsForGuild('111')).rejects.toThrow('db down');
  });
});

describe('GuildUserRepository.getGuildUsers', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    userId: 5,
    whoKnowsWhitelisted: null,
    whoKnowsBanned: false,
    blockedFromCrowns: false,
    selfBlockFromWhoKnows: false,
    user: {
      discordUserId: 4242n,
      userNameLastFm: 'someone',
      lastUsed: null,
      privacyLevel: 'Default',
    },
    ...over,
  });

  it('stringifies the nested discord id and carries the ban flags through', async () => {
    d.guildUser.findMany.mockResolvedValue([
      row({
        whoKnowsWhitelisted: true,
        whoKnowsBanned: true,
        blockedFromCrowns: true,
        selfBlockFromWhoKnows: true,
      }),
    ] as never);

    const got = await repo.getGuildUsers('111');

    expect(got[0]).toEqual({
      userId: 5,
      discordUserId: '4242',
      userNameLastFm: 'someone',
      lastUsed: undefined,
      whoKnowsWhitelisted: true,
      whoKnowsBanned: true,
      blockedFromCrowns: true,
      selfBlockFromWhoKnows: true,
      privacyLevel: 'Default',
    });
  });

  it('preserves the whoKnowsWhitelisted tri-state as null, true and false', async () => {
    d.guildUser.findMany.mockResolvedValue([
      row({ userId: 1, whoKnowsWhitelisted: null }),
      row({ userId: 2, whoKnowsWhitelisted: true }),
      row({ userId: 3, whoKnowsWhitelisted: false }),
    ] as never);

    const got = await repo.getGuildUsers('111');

    expect(got.map((g) => g.whoKnowsWhitelisted)).toEqual([null, true, false]);
  });

  it('passes lastUsed through when present and undefined when null', async () => {
    const lastUsed = new Date('2026-07-07T00:00:00Z');
    d.guildUser.findMany.mockResolvedValue([
      row({ userId: 1, user: { discordUserId: 1n, userNameLastFm: 'a', lastUsed, privacyLevel: 'Default' } }),
      row({
        userId: 2,
        user: { discordUserId: 2n, userNameLastFm: 'b', lastUsed: null, privacyLevel: 'Hide' },
      }),
    ] as never);

    const got = await repo.getGuildUsers('111');

    expect(got[0]?.lastUsed).toBe(lastUsed);
    expect(got[1]?.lastUsed).toBeUndefined();
    // privacyLevel is a plain string on the DTO, not the privacy_level enum.
    expect(got[1]?.privacyLevel).toBe('Hide');
  });

  it('returns empty when no users are linked to the guild', async () => {
    d.guildUser.findMany.mockResolvedValue([] as never);

    expect(await repo.getGuildUsers('111')).toEqual([]);
  });

  it.each(BAD_IDS)('refuses guild id %j and returns empty without querying', async (bad) => {
    expect(await repo.getGuildUsers(bad)).toEqual([]);
    expect(d.guildUser.findMany).not.toHaveBeenCalled();
  });

  it('propagates a read failure rather than reporting an empty guild', async () => {
    d.guildUser.findMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.getGuildUsers('111')).rejects.toThrow('db down');
  });
});

describe('GuildUserRepository.setBlockStatus', () => {
  it('blocks by setting BOTH the who-knows and crown flags', async () => {
    await repo.setBlockStatus('111', 5, true);

    expect(callArg(d.guildUser.updateMany)).toEqual({
      where: { guildId: 111n, userId: 5 },
      data: { whoKnowsBanned: true, blockedFromCrowns: true },
    });
  });

  it('unblocks by clearing both flags', async () => {
    await repo.setBlockStatus('111', 5, false);

    expect(callArg<{ data: { whoKnowsBanned: boolean; blockedFromCrowns: boolean } }>(
      d.guildUser.updateMany,
    )?.data).toEqual({ whoKnowsBanned: false, blockedFromCrowns: false });
  });

  /**
   * NOTE (documented, not a bug): `setBlockStatus` is the ONLY method here with
   * no `/^\d+$/` guard - `BigInt(bad)` rejects rather than returning early.
   * That is survivable only because every caller already holds a resolved
   * guild id. Pinned so the asymmetry is a decision, not an accident.
   */
  it('rejects rather than returning early on a malformed guild id', async () => {
    await expect(repo.setBlockStatus('abc', 5, true)).rejects.toThrow();
    expect(d.guildUser.updateMany).not.toHaveBeenCalled();
  });

  it('propagates a write failure', async () => {
    d.guildUser.updateMany.mockRejectedValue(new Error('db down') as never);

    await expect(repo.setBlockStatus('111', 5, true)).rejects.toThrow('db down');
  });
});