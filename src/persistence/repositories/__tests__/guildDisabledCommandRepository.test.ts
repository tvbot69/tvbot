import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GuildDisabledCommandRepository } from '../guildDisabledCommandRepository';

/**
 * guildDisabledCommandRepository had NO unit test at all. It is three methods
 * and it owns the per-guild disabled-command list, so the thing worth holding
 * is IDEMPOTENCY.
 *
 * `add` is an `upsert` with an EMPTY update branch on purpose. Disabling a
 * command twice is the normal case - a user clicks the toggle, sees nothing
 * happen, clicks again - and with a plain `create` the second call raises a
 * unique violation on `@@id([guildId, commandName])`, which surfaces to the user
 * as a failed command toggle while the list already contains what they asked
 * for. `remove` is `deleteMany` rather than `delete` for the same reason: the
 * command may not be in the list, and "remove something that is not there"
 * must succeed.
 *
 * `guildId` is `BigInt` and every method coerces raw with no `/^\d+$/` guard,
 * so a malformed id raises a `SyntaxError`. Pinned as the class-wide shape.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

const makePrisma = () => ({
  guildDisabledCommand: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    upsert: vi.fn(async (..._args: unknown[]) => ({ guildId: 1n, commandName: 'w' })),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
  },
});

type Double = ReturnType<typeof makePrisma>;

const GUILD = '8800001';

let d: Double;
let repo: GuildDisabledCommandRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new GuildDisabledCommandRepository(d as unknown as PrismaClient);
});

describe('GuildDisabledCommandRepository.getAllForGuild', () => {
  it('maps rows with the BigInt guild id stringified', async () => {
    d.guildDisabledCommand.findMany.mockResolvedValue([
      { guildId: 8800001n, commandName: 'w' },
      { guildId: 8800001n, commandName: 'serverstats' },
    ] as never);

    const got = await repo.getAllForGuild(GUILD);

    expect(got).toEqual([
      { guildId: '8800001', commandName: 'w' },
      { guildId: '8800001', commandName: 'serverstats' },
    ]);
    // A BigInt reaching JSON.stringify throws, which in practice means the
    // whole embed fails to send.
    expect(() => JSON.stringify(got)).not.toThrow();
  });

  it('scopes the read to one guild with no extra filter', async () => {
    await repo.getAllForGuild(GUILD);
    expect(callArg(d.guildDisabledCommand.findMany)).toEqual({ where: { guildId: 8800001n } });
  });

  it('returns an empty list for a guild that has disabled nothing', async () => {
    d.guildDisabledCommand.findMany.mockResolvedValue([] as never);
    expect(await repo.getAllForGuild(GUILD)).toEqual([]);
  });

  it('propagates a read failure rather than reporting "nothing is disabled"', async () => {
    // The list drives a disabled-commands embed. An empty list on failure reads
    // as "every command is available here", which is a confident wrong answer
    // about what the bot can do.
    d.guildDisabledCommand.findMany.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getAllForGuild(GUILD)).rejects.toThrow('connection reset');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws rather than returning empty', async () => {
    await expect(repo.getAllForGuild('not-a-guild')).rejects.toThrow(/BigInt/);
    expect(d.guildDisabledCommand.findMany).not.toHaveBeenCalled();
  });
});

describe('GuildDisabledCommandRepository.add', () => {
  it('upserts on the (guildId, commandName) composite key', async () => {
    await repo.add(GUILD, 'w');

    expect(callArg(d.guildDisabledCommand.upsert)).toEqual({
      where: { guildId_commandName: { guildId: 8800001n, commandName: 'w' } },
      update: {},
      create: { guildId: 8800001n, commandName: 'w' },
    });
  });

  it('the update branch is EMPTY, which is what makes disabling twice idempotent', async () => {
    // `@@id([guildId, commandName])` is the primary key, so a plain `create`
    // would raise a unique violation on the second disable - surfacing to the
    // user as a failed toggle for a change that had already been made.
    await repo.add(GUILD, 'w');

    const arg = callArg<{ update: Args; create: Args }>(d.guildDisabledCommand.upsert);
    expect(arg.update).toEqual({});
    expect(arg.create).toEqual({ guildId: 8800001n, commandName: 'w' });
  });

  it('keeps the command name exactly as given, with no case folding', async () => {
    // Folding case here would make `.W` and `.w` one row while the command
    // registry holds both, so one of them would be silently disabled and the
    // other would still run.
    await repo.add(GUILD, 'ServerStats');
    expect(callArg<{ where: Args }>(d.guildDisabledCommand.upsert).where.guildId_commandName).toEqual({
      guildId: 8800001n,
      commandName: 'ServerStats',
    });
  });

  it('propagates a write failure rather than resolving on a silent no-op', async () => {
    d.guildDisabledCommand.upsert.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.add(GUILD, 'w')).rejects.toThrow('write failed');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws before the write', async () => {
    await expect(repo.add('not-a-guild', 'w')).rejects.toThrow(/BigInt/);
    expect(d.guildDisabledCommand.upsert).not.toHaveBeenCalled();
  });
});

describe('GuildDisabledCommandRepository.remove', () => {
  it('deletes exactly that guild and command', async () => {
    await repo.remove(GUILD, 'w');

    expect(callArg(d.guildDisabledCommand.deleteMany)).toEqual({
      where: { guildId: 8800001n, commandName: 'w' },
    });
  });

  it('is deleteMany, not delete, so removing an absent command SUCCEEDS', async () => {
    // Re-enabling a command that was never disabled is a normal thing for a
    // user to do. `delete` would throw P2025 and the user would be told the
    // re-enable failed when the state is already what they asked for.
    d.guildDisabledCommand.deleteMany.mockResolvedValue({ count: 0 } as never);
    await expect(repo.remove(GUILD, 'w')).resolves.toBeUndefined();
  });

  it('does not report a count, so the caller cannot mistake 0 for a failure', async () => {
    // The signature is Promise<void>: a returned 0 would invite a caller to
    // branch on it, and the honest answer is "whatever was there is gone".
    await repo.remove(GUILD, 'w');
    expect(await repo.remove(GUILD, 'w')).toBeUndefined();
  });

  it('propagates a delete failure rather than reporting the command re-enabled', async () => {
    d.guildDisabledCommand.deleteMany.mockRejectedValue(new Error('deadlock detected') as never);
    await expect(repo.remove(GUILD, 'w')).rejects.toThrow('deadlock detected');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws before the write', async () => {
    await expect(repo.remove('not-a-guild', 'w')).rejects.toThrow(/BigInt/);
    expect(d.guildDisabledCommand.deleteMany).not.toHaveBeenCalled();
  });
});
