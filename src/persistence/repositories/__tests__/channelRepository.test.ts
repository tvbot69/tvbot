import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ChannelRepository } from '@persistence/repositories/channelRepository';

/**
 * channelRepository had NO unit test at all. It is small, but it owns the
 * per-channel command toggles - the mechanism behind "why is `.w` disabled in
 * this channel but not that one" - and the `toggled_commands` column is a
 * Postgres `String[]`, so an empty array and a null are genuinely different
 * states and the difference decides whether a channel inherits the guild's
 * command set.
 *
 * `channelId` is `BigInt @id` and `guildId` is `BigInt`. Every method coerces
 * raw, with no `/^\d+$/` guard, so a malformed id raises a `SyntaxError` out of
 * the middle of the repository. Unlike guildRepository, EVERY method does it -
 * so this is the shape of the whole class rather than an inconsistency inside
 * it, and it is pinned as such.
 */

/** Every column `map` reads, straight off the `Channel` model. */
const channelEntity = (over: Record<string, unknown> = {}) => ({
  channelId: 7000001n,
  guildId: 8800001n,
  toggledCommands: ['w', 'serverstats'],
  whoKnowsWhitelisted: false,
  fmEmbedType: 1,
  ...over,
});

const makePrisma = () => ({
  channel: {
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    upsert: vi.fn(async (..._args: unknown[]) => channelEntity()),
    update: vi.fn(async (..._args: unknown[]) => channelEntity()),
  },
});

type Double = ReturnType<typeof makePrisma>;

const callArg = <T = Record<string, unknown>>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

let d: Double;
let repo: ChannelRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new ChannelRepository(d as unknown as PrismaClient);
});

describe('ChannelRepository.getChannel', () => {
  it('converts the id to BigInt and maps the row', async () => {
    d.channel.findUnique.mockResolvedValue(channelEntity() as never);

    const got = await repo.getChannel('7000001');

    expect(got).toEqual({
      channelId: '7000001',
      guildId: '8800001',
      toggledCommands: ['w', 'serverstats'],
      whoKnowsWhitelisted: false,
      fmEmbedType: 1,
    });
    expect(callArg(d.channel.findUnique)).toEqual({ where: { channelId: 7000001n } });
  });

  it('returns null for a channel the bot has never seen', async () => {
    d.channel.findUnique.mockResolvedValue(null as never);
    // "no per-channel row" is the normal case: it means the channel inherits
    // the guild configuration, which is NOT the same as an empty toggle list.
    expect(await repo.getChannel('7000001')).toBeNull();
  });

  it('propagates a read failure rather than reporting "no row"', async () => {
    d.channel.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getChannel('7000001')).rejects.toThrow('connection reset');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws rather than returning null', async () => {
    await expect(repo.getChannel('not-a-channel')).rejects.toThrow(/BigInt/);
    expect(d.channel.findUnique).not.toHaveBeenCalled();
  });

  it('stringifies both BigInt ids, because a BigInt cannot be serialised', async () => {
    d.channel.findUnique.mockResolvedValue(channelEntity() as never);
    const got = await repo.getChannel('7000001');
    expect(() => JSON.stringify(got)).not.toThrow();
  });
});

describe('ChannelRepository.addOrUpdateChannel', () => {
  it('upserts on the channel id and maps the result', async () => {
    d.channel.upsert.mockResolvedValue(channelEntity() as never);

    const got = await repo.addOrUpdateChannel('7000001', '8800001');

    expect(got.channelId).toBe('7000001');
    expect(got.guildId).toBe('8800001');
  });

  it('writes an EMPTY toggle list on create, not null and not the guild list', async () => {
    // `toggled_commands` is `String[]` and the row is created the moment the bot
    // sees a channel. `null` would not even type against the model, and a null
    // toggle list is indistinguishable from "this channel overrides nothing".
    await repo.addOrUpdateChannel('7000001', '8800001');

    expect(callArg(d.channel.upsert)).toEqual({
      where: { channelId: 7000001n },
      update: {},
      create: { channelId: 7000001n, guildId: 8800001n, toggledCommands: [] },
    });
  });

  it('the update branch is empty, so re-adding a channel NEVER clears its toggles', async () => {
    // This is the load-bearing half of the upsert. A `update: { toggledCommands:
    // [] }` here would reset every channel's overrides each time the bot
    // restarts and the user would find their `.w` toggle silently gone.
    await repo.addOrUpdateChannel('7000001', '8800001');

    const arg = callArg<{ update: Record<string, unknown> }>(d.channel.upsert);
    expect(arg.update).toEqual({});
  });

  it('propagates a write failure', async () => {
    d.channel.upsert.mockRejectedValue(new Error('foreign key violation') as never);
    await expect(repo.addOrUpdateChannel('7000001', '8800001')).rejects.toThrow('foreign key violation');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws before the write', async () => {
    await expect(repo.addOrUpdateChannel('nope', '8800001')).rejects.toThrow(/BigInt/);
    await expect(repo.addOrUpdateChannel('7000001', 'nope')).rejects.toThrow(/BigInt/);
    expect(d.channel.upsert).not.toHaveBeenCalled();
  });
});

describe('ChannelRepository writers', () => {
  it('setToggledCommands writes the whole list, replacing rather than merging', async () => {
    // `update` with an array value REPLACES the Postgres array. A merge would
    // need an explicit read-modify-write, and the absence of one here is the
    // contract the caller relies on when it passes the complete set.
    await repo.setToggledCommands('7000001', ['w']);

    expect(callArg(d.channel.update)).toEqual({
      where: { channelId: 7000001n },
      data: { toggledCommands: ['w'] },
    });
  });

  it('setToggledCommands writes an empty array to CLEAR the overrides', async () => {
    await repo.setToggledCommands('7000001', []);
    const data = callArg<{ data: { toggledCommands: string[] } }>(d.channel.update).data;
    expect(data.toggledCommands).toEqual([]);
  });

  it('setWhoKnowsWhitelisted toggles the who-knows exemption both ways', async () => {
    await repo.setWhoKnowsWhitelisted('7000001', true);
    expect(callArg(d.channel.update)).toEqual({
      where: { channelId: 7000001n },
      data: { whoKnowsWhitelisted: true },
    });

    await repo.setWhoKnowsWhitelisted('7000001', false);
    expect(callArg<{ data: Record<string, unknown> }>(d.channel.update, 1).data.whoKnowsWhitelisted).toBe(false);
  });

  it('setFmEmbedType accepts null, which is "use the guild default"', async () => {
    await repo.setFmEmbedType('7000001', 3);
    expect(callArg(d.channel.update)).toEqual({ where: { channelId: 7000001n }, data: { fmEmbedType: 3 } });

    await repo.setFmEmbedType('7000001', null);
    // null rather than omitted: omitting leaves the old override in place, so
    // "reset this channel's embed type" would silently do nothing.
    expect(callArg<{ data: Record<string, unknown> }>(d.channel.update, 1).data.fmEmbedType).toBeNull();
  });

  it('propagates a write failure rather than resolving on a silent no-op', async () => {
    d.channel.update.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.setToggledCommands('7000001', ['w'])).rejects.toThrow('write failed');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: every writer throws on a malformed id', async () => {
    for (const call of [
      () => repo.setToggledCommands('nope', ['w']),
      () => repo.setWhoKnowsWhitelisted('nope', true),
      () => repo.setFmEmbedType('nope', 1),
    ] as Array<() => Promise<void>>) {
      await expect(call()).rejects.toThrow(/BigInt/);
    }
    expect(d.channel.update).not.toHaveBeenCalled();
  });
});

describe('ChannelRepository entity mapping', () => {
  it('turns a null fmEmbedType into undefined, not 0', async () => {
    // fmEmbedType 0 is a real card style, so collapsing null to 0 would render
    // "default" as a specific layout the guild never asked for.
    d.channel.findUnique.mockResolvedValue(channelEntity({ fmEmbedType: null }) as never);

    expect((await repo.getChannel('7000001'))?.fmEmbedType).toBeUndefined();
  });

  it('keeps fmEmbedType 0, which is a real style and not an absence', async () => {
    d.channel.findUnique.mockResolvedValue(channelEntity({ fmEmbedType: 0 }) as never);

    expect((await repo.getChannel('7000001'))?.fmEmbedType).toBe(0);
  });

  it('carries an empty toggle list through as an empty list, not undefined', async () => {
    // "this channel overrides nothing" and "this channel has no row at all" are
    // two different states, and the second is a null from getChannel.
    d.channel.findUnique.mockResolvedValue(channelEntity({ toggledCommands: [] }) as never);

    expect((await repo.getChannel('7000001'))?.toggledCommands).toEqual([]);
  });

  it('carries whoKnowsWhitelisted through unchanged', async () => {
    d.channel.findUnique.mockResolvedValue(channelEntity({ whoKnowsWhitelisted: true }) as never);
    expect((await repo.getChannel('7000001'))?.whoKnowsWhitelisted).toBe(true);
  });
});
