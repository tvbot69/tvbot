import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopostRepository } from './autopostRepository';
import type { AutopostConfig } from '@bot/services/autopostService';

/**
 * The autopost CRUD, which `autopostRepository.claimIsAuthoritative.test.ts`
 * does not touch - that file covers `claimDueAutopost` and `releaseClaim`, the
 * two methods that decide WHEN a scheduled post fires.
 *
 * The thing worth holding here is AUTHORISATION. Every method takes both an id
 * and a guildId, and that pairing is the only thing stopping a moderator in one
 * server reading, toggling or deleting another server's scheduled post. Both
 * writes scope their `where` on the guild, and `toggleAutopost` scopes its
 * READ rather than its update - a shape worth pinning explicitly, because
 * "simplifying" the read to a bare `findUnique({ where: { id } })` would turn a
 * cross-guild toggle from a silent no-op into a real one.
 *
 * The second thing is the id round trip. `AutopostConfig.id` is a STRING
 * (`r.id.toString()`) and `deleteAutopost`/`toggleAutopost` take a NUMBER, so
 * the caller has to parse it back. A BigInt or a string handed to the number
 * parameter is a different bug and is not what this file tests.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

const row = (over: Args = {}): Args => ({
  id: 1,
  guildId: 8800001n,
  channelId: 7000001n,
  contentType: 'TopArtists',
  schedule: 'Daily',
  enabled: true,
  lastPosted: null,
  created: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const makePrisma = () => ({
  guildAutopost: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    findFirst: vi.fn(async (..._args: unknown[]) => null as unknown),
    create: vi.fn(async (..._args: unknown[]) => row()),
    update: vi.fn(async (..._args: unknown[]) => row({ enabled: false })),
    updateMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
    count: vi.fn(async (..._args: unknown[]) => 0),
  },
});

type Double = ReturnType<typeof makePrisma>;

const GUILD = '8800001';

let d: Double;
let repo: AutopostRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new AutopostRepository(d as never);
});

describe('AutopostRepository.getAutopostsForGuild', () => {
  it('maps rows with every BigInt id stringified, oldest first', async () => {
    d.guildAutopost.findMany.mockResolvedValue([row({ id: 1 }), row({ id: 2 })] as never);

    const got = await repo.getAutopostsForGuild(GUILD);

    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      id: '1',
      guildId: '8800001',
      channelId: '7000001',
      contentType: 'TopArtists',
      schedule: 'Daily',
      enabled: true,
      lastPosted: null,
      created: new Date('2026-01-01T00:00:00Z'),
    });
    // A BigInt reaching JSON.stringify throws, which in practice means the
    // whole embed fails to send.
    expect(() => JSON.stringify(got)).not.toThrow();
  });

  it('scopes to one guild and orders by id so the list is stable', async () => {
    await repo.getAutopostsForGuild(GUILD);
    expect(callArg(d.guildAutopost.findMany)).toEqual({
      where: { guildId: 8800001n },
      orderBy: { id: 'asc' },
    });
  });

  it('returns an empty list for a guild with no scheduled posts', async () => {
    d.guildAutopost.findMany.mockResolvedValue([] as never);
    expect(await repo.getAutopostsForGuild(GUILD)).toEqual([]);
  });

  it('propagates a read failure rather than reporting "no autoposts configured"', async () => {
    // The list drives the `.autopost list` embed. Empty on failure reads as
    // "this server has nothing scheduled", which is a confident wrong answer.
    d.guildAutopost.findMany.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getAutopostsForGuild(GUILD)).rejects.toThrow('connection reset');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed guild id throws', async () => {
    await expect(repo.getAutopostsForGuild('not-a-guild')).rejects.toThrow(/BigInt/);
    expect(d.guildAutopost.findMany).not.toHaveBeenCalled();
  });
});

describe('AutopostRepository.getAllActiveAutoposts', () => {
  it('returns ONLY enabled rows, across every guild', async () => {
    d.guildAutopost.findMany.mockResolvedValue([row({ id: 1 }), row({ id: 2, guildId: 8800002n })] as never);

    const got = await repo.getAllActiveAutoposts();

    // The 15-minute sweep reads this: it is deliberately NOT guild-scoped.
    expect(got.map((a) => a.guildId)).toEqual(['8800001', '8800002']);
    expect(callArg(d.guildAutopost.findMany)).toEqual({ where: { enabled: true } });
  });

  it('carries lastPosted through so the sweep can tell due from not due', async () => {
    const posted = new Date('2026-01-01T06:00:00Z');
    d.guildAutopost.findMany.mockResolvedValue([row({ lastPosted: posted })] as never);

    expect((await repo.getAllActiveAutoposts())[0]?.lastPosted).toEqual(posted);
  });

  it('returns an empty list when nothing is scheduled anywhere', async () => {
    d.guildAutopost.findMany.mockResolvedValue([] as never);
    expect(await repo.getAllActiveAutoposts()).toEqual([]);
  });

  it('propagates a read failure rather than reporting a guild with no autopost as un-postable', async () => {
    // This one is the worst case in the file. The sweep turns an empty list
    // into "nobody is due", which is a silent skip rather than a wrong number -
    // but the guild gets no post and nobody finds out why.
    d.guildAutopost.findMany.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getAllActiveAutoposts()).rejects.toThrow('connection reset');
  });
});

describe('AutopostRepository.createAutopost', () => {
  it('creates an ENABLED post and returns it with stringified ids', async () => {
    d.guildAutopost.create.mockResolvedValue(row({ id: 5 }) as never);

    const got: AutopostConfig = await repo.createAutopost({
      guildId: GUILD,
      channelId: '7000001',
      contentType: 'TopArtists',
      schedule: 'Weekly',
    });

    expect(got.id).toBe('5');
    expect(got.enabled).toBe(true);
    expect(callArg(d.guildAutopost.create)).toEqual({
      data: {
        guildId: 8800001n,
        channelId: 7000001n,
        contentType: 'TopArtists',
        schedule: 'Weekly',
        enabled: true,
      },
    });
  });

  it('does not stamp lastPosted, so a new post is immediately DUE', async () => {
    d.guildAutopost.create.mockResolvedValue(row() as never);
    await repo.createAutopost({
      guildId: GUILD, channelId: '7000001', contentType: 'TopArtists', schedule: 'Daily',
    });

    // A `lastPosted: new Date()` here would delay the first post by a whole
    // schedule period, which is exactly the "I scheduled it and nothing
    // happened" report.
    const data = callArg<{ data: Args }>(d.guildAutopost.create).data;
    expect(data.lastPosted).toBeUndefined();
  });

  it('propagates a write failure rather than returning a fabricated config', async () => {
    d.guildAutopost.create.mockRejectedValue(new Error('foreign key violation') as never);
    await expect(
      repo.createAutopost({ guildId: GUILD, channelId: '7000001', contentType: 'TopArtists', schedule: 'Daily' }),
    ).rejects.toThrow('foreign key violation');
  });

  it('DOCUMENTS THE CLASS-WIDE SHAPE: a malformed id throws before the write', async () => {
    await expect(
      repo.createAutopost({ guildId: GUILD, channelId: 'nope', contentType: 'TopArtists', schedule: 'Daily' }),
    ).rejects.toThrow(/BigInt/);
    expect(d.guildAutopost.create).not.toHaveBeenCalled();
  });
});

describe('AutopostRepository.deleteAutopost', () => {
  it('scopes the delete on BOTH the id and the guild', async () => {
    d.guildAutopost.deleteMany.mockResolvedValue({ count: 1 } as never);

    expect(await repo.deleteAutopost(1, GUILD)).toBe(true);
    // The guild in the where clause is the authorisation check. Dropping it
    // turns "delete my scheduled post" into "delete any scheduled post".
    expect(callArg(d.guildAutopost.deleteMany)).toEqual({
      where: { id: 1, guildId: 8800001n },
    });
  });

  it('REFUSES a post that belongs to another guild', async () => {
    expect(await repo.deleteAutopost(1, '8800002')).toBe(false);
  });

  it('is idempotent: deleting an already-gone post reports false, not a crash', async () => {
    d.guildAutopost.deleteMany.mockResolvedValue({ count: 0 } as never);
    await expect(repo.deleteAutopost(1, GUILD)).resolves.toBe(false);
  });

  it('propagates a delete failure rather than reporting it removed', async () => {
    d.guildAutopost.deleteMany.mockRejectedValue(new Error('deadlock detected') as never);
    await expect(repo.deleteAutopost(1, GUILD)).rejects.toThrow('deadlock detected');
  });
});

describe('AutopostRepository.toggleAutopost', () => {
  it('flips enabled and returns the updated row', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(row({ enabled: true }) as never);
    d.guildAutopost.update.mockResolvedValue(row({ enabled: false, id: 5 }) as never);

    const got = await repo.toggleAutopost(1, GUILD);

    expect(got?.enabled).toBe(false);
    expect(got?.id).toBe('5');
    expect(callArg(d.guildAutopost.update)).toEqual({ where: { id: 1 }, data: { enabled: false } });
  });

  it('re-enables a disabled post', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(row({ enabled: false }) as never);
    d.guildAutopost.update.mockResolvedValue(row({ enabled: true }) as never);

    expect((await repo.toggleAutopost(1, GUILD))?.enabled).toBe(true);
    expect(callArg<{ data: Args }>(d.guildAutopost.update).data.enabled).toBe(true);
  });

  it('checks the OWNING GUILD in its read, not only in its write', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(row() as never);
    await repo.toggleAutopost(1, GUILD);

    // The update is keyed on the id alone, so the read is the ONLY thing
    // enforcing that this post belongs to the caller's guild. A bare
    // `findUnique({ where: { id } })` here would make a cross-guild toggle
    // work, and the update below would happily do it.
    expect(callArg(d.guildAutopost.findFirst)).toEqual({ where: { id: 1, guildId: 8800001n } });
    expect(callArg<{ where: Args }>(d.guildAutopost.update).where).toEqual({ id: 1 });
  });

  it('REFUSES a post that belongs to another guild, and writes nothing', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(null as never);

    expect(await repo.toggleAutopost(1, '8800002')).toBeNull();
    expect(d.guildAutopost.update).not.toHaveBeenCalled();
  });

  it('REFUSES a post that does not exist, and writes nothing', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(null as never);

    expect(await repo.toggleAutopost(404, GUILD)).toBeNull();
    expect(d.guildAutopost.update).not.toHaveBeenCalled();
  });

  it('propagates the read failure rather than reporting "no such autopost"', async () => {
    // Returning null here is indistinguishable from "wrong guild" and from
    // "gone", and the command renders all three as "that autopost does not
    // exist" - which is a plausible falsehood when the truth is a dead
    // connection.
    d.guildAutopost.findFirst.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.toggleAutopost(1, GUILD)).rejects.toThrow('connection reset');
  });

  it('propagates the write failure rather than reporting the new state', async () => {
    d.guildAutopost.findFirst.mockResolvedValue(row() as never);
    d.guildAutopost.update.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.toggleAutopost(1, GUILD)).rejects.toThrow('write failed');
  });
});

describe('AutopostRepository.countForGuild', () => {
  it('counts only that guild rows', async () => {
    d.guildAutopost.count.mockResolvedValue(3 as never);

    expect(await repo.countForGuild(GUILD)).toBe(3);
    expect(callArg(d.guildAutopost.count)).toEqual({ where: { guildId: 8800001n } });
  });

  it('counts DISABLED posts too, so the limit check cannot be dodged by pausing one', async () => {
    d.guildAutopost.count.mockResolvedValue(1 as never);
    await repo.countForGuild(GUILD);
    // No `enabled: true` filter: the cap exists to bound the sweep, and a
    // disabled row still occupies an id and still needs removing eventually.
    const where = callArg<{ where: Args }>(d.guildAutopost.count).where;
    expect(where).toEqual({ guildId: 8800001n });
    expect(where.enabled).toBeUndefined();
  });

  it('returns 0 for a guild with no autoposts', async () => {
    expect(await repo.countForGuild(GUILD)).toBe(0);
  });

  it('propagates a read failure rather than reporting zero autoposts', async () => {
    // This 0 gates a "you already have the maximum" refusal, so a failure here
    // would let a guild create posts past the cap.
    d.guildAutopost.count.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.countForGuild(GUILD)).rejects.toThrow('connection reset');
  });
});
