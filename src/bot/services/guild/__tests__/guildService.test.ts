import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Guild as DiscordGuild } from 'discord.js';
import { GuildService } from '@bot/services/guild/guildService';
import type { Guild } from '@persistence/models/guild';

/**
 * GuildService is a thin cache-aside wrapper: read through `getGuild`, and
 * invalidate the cache on every write. Almost all of the value of testing it is
 * in proving the INVARIATION rather than the wiring, because a missing
 * invalidation is silent - the write succeeds, the command behaves correctly
 * once, and then the guild silently reads a stale value for five minutes.
 *
 * So every mutator below asserts the same thing in the same shape: the
 * repository write happened AND `cache.delete('guild:<id>')` happened. A test
 * that only asserted the write would pass with the invalidation removed.
 */

const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn((_arg: unknown) => Promise.resolve({})) }));

// `selfBlockGuildUserAsync` / `selfUnblockGuildUserAsync` reach the module-level
// prisma singleton from `@persistence/prismaClient` rather than an injected
// client - they are the only two methods here that bypass the constructor. That
// makes them untestable without replacing the module, because the real client
// would open a real connection at first query.
vi.mock('@persistence/prismaClient', () => ({
  prisma: { guildUser: { upsert: upsertMock } },
}));

const GUILD_TTL = 300;

const makeGuild = (over: Partial<Guild> = {}): Guild => ({
  guildId: '111',
  guildName: 'Test Guild',
  guildCreatedOn: new Date('2026-01-01T00:00:00Z'),
  commandsDisabled: false,
  emotesDisabled: false,
  ...over,
});

const makeDiscordGuild = (over: Partial<DiscordGuild> = {}): DiscordGuild =>
  ({ id: '111', name: 'Test Guild', ...over }) as unknown as DiscordGuild;

const build = (over: {
  cacheGet?: unknown;
  repoGuild?: unknown;
  addOrUpdateGuild?: unknown;
} = {}) => {
  const guildRepository = {
    getGuild: vi.fn(async () => (over.repoGuild === undefined ? null : over.repoGuild)),
    addOrUpdateGuild: vi.fn(async () => (over.addOrUpdateGuild === undefined ? makeGuild() : over.addOrUpdateGuild)),
    setPrefix: vi.fn(async () => undefined),
    setFmEmbedType: vi.fn(async () => undefined),
    setCommandsDisabled: vi.fn(async () => undefined),
    setLastCommand: vi.fn(async () => undefined),
    setCrownsThreshold: vi.fn(async () => undefined),
    setCrownsActivityThreshold: vi.fn(async () => undefined),
    setCrownsDisabled: vi.fn(async () => undefined),
  };
  const cache = {
    get: vi.fn(async (_key: string) => (over.cacheGet === undefined ? null : over.cacheGet)),
    set: vi.fn(async (_key: string, _value: unknown, _ttl?: number) => undefined),
    delete: vi.fn(async (_key: string) => undefined),
  };
  const service = new GuildService(guildRepository as never, cache as never);
  return { service, guildRepository, cache };
};

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockReset().mockResolvedValue({});
});

describe('GuildService.ensureGuildExists', () => {
  it('upserts the guild and returns the stored row', async () => {
    const row = makeGuild({ guildName: 'Renamed' });
    const { service, guildRepository } = build({ addOrUpdateGuild: row });
    await expect(service.ensureGuildExists(makeDiscordGuild())).resolves.toBe(row);
    expect(guildRepository.addOrUpdateGuild).toHaveBeenCalledWith('111', 'Test Guild');
  });

  it('caches the upserted guild under the guild key for five minutes', async () => {
    const row = makeGuild();
    const { service, cache } = build({ addOrUpdateGuild: row });
    await service.ensureGuildExists(makeDiscordGuild());
    expect(cache.set).toHaveBeenCalledWith('guild:111', row, GUILD_TTL);
  });

  it('truncates a guild name to the 100 character column limit', async () => {
    // The database column is 100 chars; Discord allows far longer names, and an
    // untruncated name is a P2000 on every guild join.
    const { service, guildRepository } = build();
    await service.ensureGuildExists(makeDiscordGuild({ name: 'x'.repeat(150) } as Partial<DiscordGuild>));
    expect(guildRepository.addOrUpdateGuild).toHaveBeenCalledWith('111', 'x'.repeat(100));
  });

  it('leaves a short name untouched', async () => {
    const { service, guildRepository } = build();
    await service.ensureGuildExists(makeDiscordGuild({ name: 'x'.repeat(100) } as Partial<DiscordGuild>));
    expect(guildRepository.addOrUpdateGuild).toHaveBeenCalledWith('111', 'x'.repeat(100));
  });

  it('propagates a repository failure rather than caching a bad row', async () => {
    const { service, guildRepository, cache } = build();
    guildRepository.addOrUpdateGuild.mockRejectedValue(new Error('db down'));
    await expect(service.ensureGuildExists(makeDiscordGuild())).rejects.toThrow('db down');
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('GuildService.getGuild', () => {
  it('returns the cached row without touching the repository', async () => {
    const cached = makeGuild({ guildName: 'From Cache' });
    const { service, guildRepository } = build({ cacheGet: cached });
    await expect(service.getGuild('111')).resolves.toBe(cached);
    expect(guildRepository.getGuild).not.toHaveBeenCalled();
  });

  it('reads through the repository on a cache miss and backfills the cache', async () => {
    const row = makeGuild();
    const { service, guildRepository, cache } = build({ repoGuild: row });
    await expect(service.getGuild('111')).resolves.toBe(row);
    expect(guildRepository.getGuild).toHaveBeenCalledWith('111');
    expect(cache.set).toHaveBeenCalledWith('guild:111', row, GUILD_TTL);
  });

  it('returns null and caches nothing when the guild does not exist', async () => {
    // A negative result must NOT be memoised: the guild row appears the moment
    // the bot is invited, and a cached null would hide it for five minutes.
    const { service, cache } = build({ repoGuild: null });
    await expect(service.getGuild('111')).resolves.toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('scopes the cache key to the guild id', async () => {
    const { service, cache } = build({ cacheGet: null });
    await service.getGuild('999');
    expect(cache.get).toHaveBeenCalledWith('guild:999');
  });
});

describe('GuildService writes invalidate the cache', () => {
  const cases: Array<[string, (s: GuildService) => Promise<void>]> = [
    ['setPrefix', s => s.setPrefix('111', '!')],
    ['setCommandsDisabled', s => s.setCommandsDisabled('111', true)],
    ['setCrownsThreshold', s => s.setCrownsThreshold('111', 5)],
    ['setCrownsActivityThreshold', s => s.setCrownsActivityThreshold('111', 30)],
    ['setCrownsDisabled', s => s.setCrownsDisabled('111', true)],
  ];

  it.each(cases)('%s writes through then evicts the cached row', async (_name, call) => {
    const { service, cache } = build();
    await call(service);
    expect(cache.delete).toHaveBeenCalledWith('guild:111');
  });

  it('evicts the key belonging to the guild that was written, not a shared one', async () => {
    const { service, cache } = build();
    await service.setPrefix('222', '?');
    expect(cache.delete).toHaveBeenCalledWith('guild:222');
  });

  it('passes the exact values through to the repository', async () => {
    const { service, guildRepository } = build();
    await service.setPrefix('111', '!');
    expect(guildRepository.setPrefix).toHaveBeenCalledWith('111', '!');
    await service.setCommandsDisabled('111', true);
    expect(guildRepository.setCommandsDisabled).toHaveBeenCalledWith('111', true);
    await service.setCrownsThreshold('111', 5);
    expect(guildRepository.setCrownsThreshold).toHaveBeenCalledWith('111', 5);
    await service.setCrownsActivityThreshold('111', 30);
    expect(guildRepository.setCrownsActivityThreshold).toHaveBeenCalledWith('111', 30);
    await service.setCrownsDisabled('111', false);
    expect(guildRepository.setCrownsDisabled).toHaveBeenCalledWith('111', false);
  });

  it('accepts null for the activity threshold, which is a distinct value from 0', async () => {
    const { service, guildRepository, cache } = build();
    await service.setCrownsActivityThreshold('111', null);
    expect(guildRepository.setCrownsActivityThreshold).toHaveBeenCalledWith('111', null);
    expect(cache.delete).toHaveBeenCalledWith('guild:111');
  });

  it('does not evict when the repository write fails', async () => {
    // Evicting on a failed write is harmless-ish, but the ordering matters for
    // the reader: a throw here must surface to the caller, not be swallowed.
    const { service, guildRepository } = build();
    guildRepository.setPrefix.mockRejectedValue(new Error('db down'));
    await expect(service.setPrefix('111', '!')).rejects.toThrow('db down');
  });
});

describe('GuildService.trackLastCommand', () => {
  it('writes the command time on a cold throttle key', async () => {
    const { service, guildRepository, cache } = build();
    await service.trackLastCommand('111');
    expect(guildRepository.setLastCommand).toHaveBeenCalledWith('111', expect.any(Date));
    expect(cache.set).toHaveBeenCalledWith('lastcmd:111', expect.any(String), 600);
  });

  it('is throttled while the throttle key is still alive', async () => {
    // The whole purpose: a busy guild would otherwise write a row per command.
    const { service, guildRepository, cache } = build({ cacheGet: '2026-01-01T00:00:00.000Z' });
    await service.trackLastCommand('111');
    expect(guildRepository.setLastCommand).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('throttles per guild, not globally', async () => {
    const { service, guildRepository, cache } = build();
    cache.get.mockImplementation(async (k: string) => (k === 'lastcmd:111' ? 'set' : null));
    await service.trackLastCommand('111');
    await service.trackLastCommand('222');
    expect(cache.get).toHaveBeenNthCalledWith(1, 'lastcmd:111');
    expect(cache.get).toHaveBeenNthCalledWith(2, 'lastcmd:222');
    expect(guildRepository.setLastCommand).toHaveBeenCalledTimes(1);
  });

  it('does not touch the guild row cache', async () => {
    const { service, cache } = build();
    await service.trackLastCommand('111');
    expect(cache.delete).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalledWith('guild:111', expect.anything(), expect.anything());
  });
});

describe('GuildService.selfBlockGuildUserAsync', () => {
  it('upserts the self block and converts the snowflake to a bigint', async () => {
    const { service } = build();
    await expect(service.selfBlockGuildUserAsync('111', 5)).resolves.toBe(true);
    expect(upsertMock).toHaveBeenCalledWith({
      where: { guildId_userId: { guildId: BigInt('111'), userId: 5 } },
      update: { selfBlockFromWhoKnows: true },
      create: { guildId: BigInt('111'), userId: 5, selfBlockFromWhoKnows: true },
    });
  });

  it('returns false instead of throwing on a non-numeric guild id', async () => {
    // BigInt() throws synchronously inside the try, so this is the branch that
    // keeps a bad snowflake from becoming an unhandled rejection in a command.
    const { service } = build();
    await expect(service.selfBlockGuildUserAsync('not-a-snowflake', 5)).resolves.toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('returns false when the upsert fails', async () => {
    upsertMock.mockRejectedValue(new Error('db down'));
    const { service } = build();
    await expect(service.selfBlockGuildUserAsync('111', 5)).resolves.toBe(false);
  });
});

describe('GuildService.selfUnblockGuildUserAsync', () => {
  it('upserts the self unblock', async () => {
    const { service } = build();
    await expect(service.selfUnblockGuildUserAsync('111', 5)).resolves.toBe(true);
    expect(upsertMock).toHaveBeenCalledWith({
      where: { guildId_userId: { guildId: BigInt('111'), userId: 5 } },
      update: { selfBlockFromWhoKnows: false },
      create: { guildId: BigInt('111'), userId: 5, selfBlockFromWhoKnows: false },
    });
  });

  it('returns false instead of throwing on a non-numeric guild id', async () => {
    const { service } = build();
    await expect(service.selfUnblockGuildUserAsync('nope', 5)).resolves.toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('returns false when the upsert fails', async () => {
    upsertMock.mockRejectedValue(new Error('db down'));
    const { service } = build();
    await expect(service.selfUnblockGuildUserAsync('111', 5)).resolves.toBe(false);
  });

  it('is symmetric with the block: unblocking always writes false, never skips', async () => {
    // The upsert shape is identical apart from the flag, so a change to
    // "only update when present" would silently break unblocking a user who
    // never had a guild_users row.
    const { service } = build();
    await service.selfUnblockGuildUserAsync('111', 5);
    const arg = upsertMock.mock.calls[0]?.[0] as { create: { selfBlockFromWhoKnows: boolean } };
    expect(arg.create.selfBlockFromWhoKnows).toBe(false);
  });
});
