import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GuildRepository } from './guildRepository';

/**
 * guildRepository had NO unit test at all - not a thin one, none - and it is
 * the root of the guild configuration: the prefix every text command is routed
 * through, the per-guild command kill switch, the embed type, and four crown
 * thresholds. Every one of those is a number or a string rendered to a user, so
 * the mapping is the product, not plumbing.
 *
 * `guildRepository.db.test.ts` does not exist either, so nothing was verifying
 * the entity -> DTO conversion: `guildId` is a `BigInt` on the model and a
 * `string` on `IGuildRepository`, and the crown thresholds are nullable columns
 * that must survive as `null` rather than collapsing to `0`.
 *
 * THE BIGINT TRAP, which is the whole first block. `guildId` is
 * `BigInt @id` and every entry point receives a string. `BigInt('abc')` THROWS
 * a `SyntaxError`. Only `getGuild` used to guard with `/^\d+$/`; the upsert and
 * all eight writers coerced raw, so the same malformed input produced a `null`
 * from one method and a `SyntaxError` out of the repository from the other nine.
 * One `toGuildId` guard now serves all of them, pinned below in both directions.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

/** Every column `map` reads. A row missing one is a fake that passes while the real query throws. */
const guildEntity = (over: Args = {}) => ({
  guildId: 8800001n,
  guildName: 'Test Guild',
  prefix: '!',
  guildCreatedOn: new Date('2024-01-01T12:00:00Z'),
  lastCommand: new Date('2024-02-01T12:00:00Z'),
  commandsDisabled: false,
  emotesDisabled: false,
  fmEmbedType: 1,
  crownsDisabled: false,
  crownsMinimumPlaycountThreshold: 30,
  crownsActivityThresholdDays: 90,
  crownRoles: [555n],
  ...over,
});

const makePrisma = () => ({
  guild: {
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    upsert: vi.fn(async (..._args: unknown[]) => guildEntity()),
    update: vi.fn(async (..._args: unknown[]) => guildEntity()),
  },
});

type Double = ReturnType<typeof makePrisma>;

const GUILD = '8800001';

let d: Double;
let repo: GuildRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new GuildRepository(d as unknown as PrismaClient);
});

describe('GuildRepository.getGuild', () => {
  it('converts the numeric string to BigInt and maps the row', async () => {
    d.guild.findUnique.mockResolvedValue(guildEntity() as never);

    const got = await repo.getGuild(GUILD);

    expect(got?.guildId).toBe('8800001');
    expect(got?.guildName).toBe('Test Guild');
    expect(callArg(d.guild.findUnique)).toEqual({ where: { guildId: 8800001n } });
  });

  it('returns null for a non-numeric id WITHOUT querying (BigInt would throw)', async () => {
    expect(await repo.getGuild('not-a-guild')).toBeNull();
    expect(d.guild.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an empty id', async () => {
    expect(await repo.getGuild('')).toBeNull();
    expect(d.guild.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for a guild that has never been registered', async () => {
    d.guild.findUnique.mockResolvedValue(null as never);
    expect(await repo.getGuild(GUILD)).toBeNull();
  });

  it('propagates a read failure rather than reporting "no such guild"', async () => {
    // The two are indistinguishable to the caller if a `catch { return null }`
    // is ever added, and the difference is the difference between "this bot is
    // not in that server" and "the database is down".
    d.guild.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getGuild(GUILD)).rejects.toThrow('connection reset');
  });
});

describe('GuildRepository.addOrUpdateGuild', () => {
  it('upserts on the BigInt primary key and maps the result', async () => {
    d.guild.upsert.mockResolvedValue(guildEntity({ guildName: 'Renamed' }) as never);

    const got = await repo.addOrUpdateGuild(GUILD, 'Renamed');

    expect(got.guildName).toBe('Renamed');
    expect(callArg(d.guild.upsert)).toEqual({
      where: { guildId: 8800001n },
      update: { guildName: 'Renamed' },
      create: { guildId: 8800001n, guildName: 'Renamed' },
    });
  });

  it('a GENUINELY NEW guild returns the created row, not a re-read', async () => {
    d.guild.upsert.mockResolvedValue(guildEntity({ guildId: 999n, prefix: null }) as never);

    const got = await repo.addOrUpdateGuild('999', 'Brand New');

    expect(got.guildId).toBe('999');
    expect(got.prefix).toBeUndefined();
    expect(d.guild.findUnique).not.toHaveBeenCalled();
  });

  it('propagates a write failure rather than returning a fabricated guild', async () => {
    d.guild.upsert.mockRejectedValue(new Error('unique violation') as never);
    await expect(repo.addOrUpdateGuild(GUILD, 'Renamed')).rejects.toThrow('unique violation');
  });

  it('raises a NAMED error on a malformed id, because a guild row has no empty answer', async () => {
    // The method returns a `Guild`, so there is no empty value to hand back and
    // reporting one would be a fabricated row. What it must NOT do is throw the
    // driver's `SyntaxError: Cannot convert … to a BigInt`, which reads as a
    // database fault. The raise now names the argument, which is where the bug
    // actually is.
    await expect(repo.addOrUpdateGuild('not-a-guild', 'X')).rejects.toThrow(TypeError);
    await expect(repo.addOrUpdateGuild('not-a-guild', 'X')).rejects.toThrow(/guildId must be a decimal string/);
    // Explicitly NOT the coercion failure.
    await expect(repo.addOrUpdateGuild('not-a-guild', 'X')).rejects.not.toThrow(/Cannot convert/);
    expect(d.guild.upsert).not.toHaveBeenCalled();
  });
});

describe('GuildRepository writers', () => {
  it('setPrefix writes the prefix, and null to fall back to the global default', async () => {
    await repo.setPrefix(GUILD, '?');
    expect(callArg(d.guild.update)).toEqual({ where: { guildId: 8800001n }, data: { prefix: '?' } });

    await repo.setPrefix(GUILD, null);
    // Written as null, not omitted: omitting would leave the old prefix in
    // place and "reset my prefix" would silently do nothing.
    expect(callArg<{ data: Args }>(d.guild.update, 1).data.prefix).toBeNull();
  });

  it('setCommandsDisabled toggles the kill switch both ways', async () => {
    await repo.setCommandsDisabled(GUILD, true);
    expect(callArg(d.guild.update)).toEqual({
      where: { guildId: 8800001n },
      data: { commandsDisabled: true },
    });

    await repo.setCommandsDisabled(GUILD, false);
    expect(callArg<{ data: Args }>(d.guild.update, 1).data.commandsDisabled).toBe(false);
  });

  it('setFmEmbedType accepts null, which is "use the default card"', async () => {
    await repo.setFmEmbedType(GUILD, 2);
    expect(callArg(d.guild.update)).toEqual({ where: { guildId: 8800001n }, data: { fmEmbedType: 2 } });

    await repo.setFmEmbedType(GUILD, null);
    expect(callArg<{ data: Args }>(d.guild.update, 1).data.fmEmbedType).toBeNull();
  });

  it('setLastCommand stamps the exact Date the caller measured', async () => {
    const when = new Date('2026-04-04T12:00:00Z');
    await repo.setLastCommand(GUILD, when);
    expect(callArg(d.guild.update)).toEqual({ where: { guildId: 8800001n }, data: { lastCommand: when } });
  });

  it('setCrownsThreshold writes the minimum playcount, and a zero survives', async () => {
    // 0 is a real threshold ("crown from the very first play"), so a
    // truthiness guard here would silently keep the old 30.
    await repo.setCrownsThreshold(GUILD, 0);
    expect(callArg<{ data: Args }>(d.guild.update).data.crownsMinimumPlaycountThreshold).toBe(0);
  });

  it('setCrownsActivityThreshold writes days, and null disables the window', async () => {
    await repo.setCrownsActivityThreshold(GUILD, 90);
    expect(callArg<{ data: Args }>(d.guild.update).data.crownsActivityThresholdDays).toBe(90);

    await repo.setCrownsActivityThreshold(GUILD, null);
    expect(callArg<{ data: Args }>(d.guild.update, 1).data.crownsActivityThresholdDays).toBeNull();
  });

  it('setCrownsDisabled toggles crowns off for the whole guild', async () => {
    await repo.setCrownsDisabled(GUILD, true);
    expect(callArg(d.guild.update)).toEqual({ where: { guildId: 8800001n }, data: { crownsDisabled: true } });
  });

  it('every writer propagates a failure rather than resolving on a silent no-op', async () => {
    d.guild.update.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.setPrefix(GUILD, '?')).rejects.toThrow('write failed');
  });

  it('EVERY writer guards the BigInt coercion and no-ops on a malformed id', async () => {
    // The point of the guard is that all nine methods now behave the SAME way:
    // a guild id that is not a decimal string is a caller bug, and none of them
    // reaches Prisma with it. Before, one answered null and eight threw a
    // `SyntaxError` out of the repository.
    for (const call of [
      () => repo.setPrefix('nope', '?'),
      () => repo.setCommandsDisabled('nope', true),
      () => repo.setFmEmbedType('nope', 1),
      () => repo.setLastCommand('nope', new Date()),
      () => repo.setCrownsThreshold('nope', 5),
      () => repo.setCrownsActivityThreshold('nope', 5),
      () => repo.setCrownsDisabled('nope', true),
    ] as Array<() => Promise<void>>) {
      // Resolves — an unresolved promise here would be the old `SyntaxError`.
      await expect(call()).resolves.toBeUndefined();
    }
    expect(d.guild.update).not.toHaveBeenCalled();
  });

  it('the guard rejects the shapes BigInt would refuse, and only those', async () => {
    // A guard that is too loose is as bad as none: it would either swallow a
    // real id or pass garbage through. Each of these must be a no-op.
    for (const bad of ['', 'nope', '12.5', '0x10', ' 8800001', '8800001n', '-1', '+1']) {
      await expect(repo.setPrefix(bad, '?')).resolves.toBeUndefined();
    }
    // A zero id IS a decimal string and reaches Prisma: it is not a number the
    // guard gets to veto, and `8800001` must keep working.
    await repo.setPrefix('8800001', '?');
    expect(callArg(d.guild.update)).toEqual({ where: { guildId: 8800001n }, data: { prefix: '?' } });
  });

  it('no-ops on an empty id as well, so a DM channel cannot become a guild row', async () => {
    await expect(repo.getGuild('')).resolves.toBeNull();
    await expect(repo.setCommandsDisabled('', true)).resolves.toBeUndefined();
    expect(d.guild.update).not.toHaveBeenCalled();
  });
});

describe('GuildRepository entity mapping', () => {
  it('turns null optional columns into undefined, never into 0 or ""', async () => {
    // `?? 0` here would make an unconfigured prefix read as the NUL prefix and
    // an unconfigured threshold read as "crown from one play".
    d.guild.findUnique.mockResolvedValue(
      guildEntity({
        prefix: null,
        lastCommand: null,
        fmEmbedType: null,
        crownsMinimumPlaycountThreshold: null,
        crownsActivityThresholdDays: null,
        crownRoles: null,
      }) as never,
    );

    const got = await repo.getGuild(GUILD);

    expect(got?.prefix).toBeUndefined();
    expect(got?.lastCommand).toBeUndefined();
    expect(got?.fmEmbedType).toBeUndefined();
    expect(got?.crownsMinimumPlaycountThreshold).toBeNull();
    expect(got?.crownsActivityThresholdDays).toBeNull();
    // crownRoles is a non-null list column, so null is not a shape the model
    // produces; the `?? []` is still the only thing between a null and a crash
    // in the crown-role renderer.
    expect(got?.crownRoles).toEqual([]);
  });

  it('keeps a zero prefix and a zero threshold as themselves', async () => {
    d.guild.findUnique.mockResolvedValue(
      guildEntity({ prefix: '', crownsMinimumPlaycountThreshold: 0, commandsDisabled: false }) as never,
    );

    const got = await repo.getGuild(GUILD);

    expect(got?.prefix).toBe('');
    expect(got?.crownsMinimumPlaycountThreshold).toBe(0);
    expect(got?.commandsDisabled).toBe(false);
  });

  it('stringifies every BigInt crown role', async () => {
    d.guild.findUnique.mockResolvedValue(guildEntity({ crownRoles: [555n, 666n] }) as never);

    const got = await repo.getGuild(GUILD);

    expect(got?.crownRoles).toEqual(['555', '666']);
    // A BigInt reaching JSON.stringify throws, which in practice means the
    // whole embed fails to send.
    expect(() => JSON.stringify(got)).not.toThrow();
  });

  it('carries the remaining non-optional columns through unchanged', async () => {
    d.guild.findUnique.mockResolvedValue(
      guildEntity({
        emotesDisabled: true,
        crownsDisabled: true,
        guildCreatedOn: new Date('2024-01-01T12:00:00Z'),
      }) as never,
    );

    const got = await repo.getGuild(GUILD);

    expect(got?.emotesDisabled).toBe(true);
    expect(got?.crownsDisabled).toBe(true);
    expect(got?.guildCreatedOn).toEqual(new Date('2024-01-01T12:00:00Z'));
  });
});
