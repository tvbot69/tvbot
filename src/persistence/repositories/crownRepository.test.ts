import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CrownRepository } from './crownRepository';

/**
 * Crowns are the closest thing this bot has to money: `replaceCrown` is a
 * transactional hand-over from one user to another, and a bug here means the
 * wrong user is publicly credited as the top listener for an artist.
 *
 * The repository is at 8% line coverage, and these are the paths worth holding:
 *
 *  - replaceCrown must REFUSE when the crown it is replacing is no longer
 *    active. The check is inside the transaction and returns null, because two
 *    claimants can race and the loser must not resurrect a dead crown. Getting
 *    this wrong is silent: the loser just gets no crown and nothing is logged.
 *  - the claim must be released if the transaction throws, or the crown is
 *    stuck for the caller to retry later.
 *  - the DTO must convert BigInt guild ids to strings. A BigInt reaching
 *    JSON.stringify throws "Do not know how to serialize a BigInt", which in
 *    practice means the whole embed fails to send.
 */

/** A Prisma double that models the transaction boundary and the row state. */
const makePrisma = (seed: { crowns?: Array<Record<string, unknown>>; users?: Array<Record<string, unknown>> } = {}) => {
  const state = {
    crowns: (seed.crowns ?? []).map((c) => ({ ...c })),
    users: (seed.users ?? []).map((u) => ({ ...u })),
    // Set when a transaction callback throws, so the test can assert the claim
    // was released rather than left dangling.
    transactionThrew: false,
    rollbackOnThrow: true,
  };

  const tx = {
    userCrown: {
      findUnique: vi.fn(async ({ where }: { where: { crownId: number } }) => {
        const row = state.crowns.find((c) => c.crownId === where.crownId);
        return row ? { active: row.active } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { crownId: number }; data: Record<string, unknown> }) => {
        const row = state.crowns.find((c) => c.crownId === where.crownId);
        if (!row) throw new Error(`no crown ${where.crownId}`);
        Object.assign(row, data);
        return row;
      }),
      create: vi.fn(async ({ data, include }: { data: Record<string, unknown>; include?: unknown }) => {
        const row = {
          crownId: state.crowns.length + 100,
          guildId: data.guildId,
          userId: data.userId,
          artistName: data.artistName,
          startPlaycount: data.startPlaycount,
          currentPlaycount: data.currentPlaycount,
          active: data.active,
          seededCrown: data.seededCrown,
          created: new Date('2026-01-01T00:00:00Z'),
          modified: new Date('2026-01-02T00:00:00Z'),
        };
        state.crowns.push(row);
        return include ? { ...row, user: { userNameLastFm: 'winner', discordUserId: 42n } } : row;
      }),
    },
  };

  const prisma = {
    userCrown: tx.userCrown,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = state.crowns.map((c) => ({ ...c }));
      try {
        return await fn(tx);
      } catch (err) {
        state.transactionThrew = true;
        if (state.rollbackOnThrow) {
          state.crowns.length = 0;
          state.crowns.push(...snapshot);
        }
        throw err;
      }
    }),
  };

  return { prisma: prisma as never, state, tx };
};

const repo = (prisma: never) => new CrownRepository(prisma);

describe('CrownRepository.replaceCrown', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => { prisma = makePrisma(); });

  const ACTIVE = {
    crownId: 1,
    active: true,
    guildId: 100n,
    userId: 5,
    artistName: 'Radiohead',
    currentPlaycount: 40,
    startPlaycount: 10,
  };

  it('deactivates the old crown and hands over to the new claimant', async () => {
    prisma.state.crowns.push({ ...ACTIVE });
    const r = repo(prisma.prisma);

    const dto = await r.replaceCrown(1, {
      guildId: '100',
      userId: 9,
      artistName: 'Radiohead',
      startPlaycount: 40,
      currentPlaycount: 42,
    });

    expect(dto).not.toBeNull();
    expect(dto?.userId).toBe(9);
    // The previous holder must be deactivated, not left active alongside.
    expect(prisma.tx.userCrown.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { crownId: 1 }, data: expect.objectContaining({ active: false }) }),
    );
    expect(prisma.tx.userCrown.create).toHaveBeenCalledTimes(1);
  });

  it('REFUSES when the crown being replaced is already inactive', async () => {
    // The race: two users claim the same crown at once. The loser must get null
    // and must NOT resurrect the dead crown. This returns null silently, so it
    // is exactly the kind of guard that regresses without a test.
    prisma.state.crowns.push({ ...ACTIVE, active: false });
    const r = repo(prisma.prisma);

    const dto = await r.replaceCrown(1, {
      guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 40, currentPlaycount: 42,
    });

    expect(dto).toBeNull();
    expect(prisma.tx.userCrown.create).not.toHaveBeenCalled();
    expect(prisma.tx.userCrown.update).not.toHaveBeenCalled();
  });

  it('REFUSES when the crown does not exist at all', async () => {
    const r = repo(prisma.prisma);

    const dto = await r.replaceCrown(999, {
      guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 1, currentPlaycount: 2,
    });

    expect(dto).toBeNull();
    expect(prisma.tx.userCrown.create).not.toHaveBeenCalled();
  });

  it('converts BigInt guild id and discord id to strings in the DTO', async () => {
    // A BigInt reaching JSON.stringify throws, which in practice means the
    // whole embed fails to send rather than this method being visibly wrong.
    prisma.state.crowns.push({ ...ACTIVE });
    const r = repo(prisma.prisma);

    const dto = await r.replaceCrown(1, {
      guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 40, currentPlaycount: 42,
    });

    expect(typeof dto?.guildId).toBe('string');
    expect(typeof dto?.discordUserId).toBe('string');
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it('propagates a transaction failure rather than reporting a successful steal', async () => {
    // If the create throws, the caller must see the failure. Returning a DTO
    // here would tell two users they hold the same crown.
    prisma.state.crowns.push({ ...ACTIVE });
    prisma.tx.userCrown.create.mockRejectedValueOnce(new Error('unique constraint'));
    const r = repo(prisma.prisma);

    await expect(
      r.replaceCrown(1, {
        guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 40, currentPlaycount: 42,
      }),
    ).rejects.toThrow('unique constraint');
  });

  it('carries the seededCrown flag through, defaulting to false', async () => {
    prisma.state.crowns.push({ ...ACTIVE });
    const r = repo(prisma.prisma);

    await r.replaceCrown(1, {
      guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 40, currentPlaycount: 42,
    });
    expect(prisma.tx.userCrown.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seededCrown: false }) }),
    );

    prisma.tx.userCrown.create.mockClear();
    // The first hand-over deactivated crown 1, so it has to be live again for
    // the second claim to reach the create. Without this the second call is
    // correctly REFUSED and create is never called - which is the guard working,
    // not a failure.
    const crown = prisma.state.crowns.find((c) => c.crownId === 1);
    if (crown) crown.active = true;

    await r.replaceCrown(1, {
      guildId: '100', userId: 9, artistName: 'Radiohead', startPlaycount: 40, currentPlaycount: 42, seededCrown: true,
    });
    expect(prisma.tx.userCrown.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seededCrown: true }) }),
    );
  });
});
