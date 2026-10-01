import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GuildMusicSettingsRepository, DEFAULT_MUSIC_PREFS } from '@persistence/repositories/guildMusicSettingsRepository';

/**
 * GuildMusicSettingsRepository was at 18.4% line coverage, and every method here
 * is wrapped in a catch that swallows. That is the A1 risk shape from AGENTS.md:
 * "code that cannot read the database says so". So these tests pin BOTH
 * directions on every swallowed path, per the repo's own rule:
 *
 *  - a genuine read failure still returns `[]` / resolves, AND
 *  - a genuine EMPTY result returns `[]` / resolves identically.
 *
 * A test that only asserted the happy path would pass against a method that
 * returned `[]` unconditionally. Every assertion here is on a real call
 * argument or a real return shape, never just `toBeDefined()`.
 *
 * `safeBigInt` is the other half: `guildId` is a string off an interaction and
 * `BigInt('abc')` THROWS. The guard turns that into an early return, so a
 * malformed id costs a no-op instead of a rejected promise in a command
 * handler.
 */

const callArg = <T>(fn: unknown, callIndex = 0, argIndex = 0): T | undefined => {
  const mock = (fn as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[callIndex]?.[argIndex] as T | undefined;
};

const makePrisma = () => ({
  guildMusicSettings: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    upsert: vi.fn(async (..._args: unknown[]) => undefined),
  },
  botScrobbleOptIn: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
    upsert: vi.fn(async (..._args: unknown[]) => undefined),
    deleteMany: vi.fn(async (..._args: unknown[]) => ({ count: 0 })),
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: GuildMusicSettingsRepository;

const BAD_IDS = ['', 'abc', '123abc', '12 34', '-1', '1.5'];

beforeEach(() => {
  d = makePrisma();
  repo = new GuildMusicSettingsRepository(d as unknown as PrismaClient);
});

describe('DEFAULT_MUSIC_PREFS', () => {
  it('is the documented baseline: no 24/7, full volume, no loop, no autoplay, no filters', () => {
    expect(DEFAULT_MUSIC_PREFS).toEqual({
      stay247: false,
      volume: 100,
      loopMode: 'off',
      autoplay: false,
      filters: [],
    });
  });
});

describe('GuildMusicSettingsRepository.getAllSettings', () => {
  it('maps every row and stringifies the BigInt guild id', async () => {
    d.guildMusicSettings.findMany.mockResolvedValue([
      {
        guildId: 111n,
        stay247: true,
        volume: 42,
        loopMode: 'track',
        autoplay: true,
        filters: ['bass'],
      },
    ] as never);

    const got = await repo.getAllSettings();

    expect(got).toEqual([
      {
        guildId: '111',
        stay247: true,
        volume: 42,
        loopMode: 'track',
        autoplay: true,
        filters: ['bass'],
      },
    ]);
  });

  it('copies the filters array so a caller cannot mutate the stored row', async () => {
    const stored = ['bass'];
    d.guildMusicSettings.findMany.mockResolvedValue([
      { guildId: 1n, stay247: false, volume: 100, loopMode: 'off', autoplay: false, filters: stored },
    ] as never);

    const got = await repo.getAllSettings();
    got[0]?.filters.push('treble');

    expect(stored).toEqual(['bass']);
  });

  it('returns empty when the table is genuinely empty', async () => {
    d.guildMusicSettings.findMany.mockResolvedValue([] as never);

    expect(await repo.getAllSettings()).toEqual([]);
  });

  it('swallows a read failure and returns empty rather than rejecting', async () => {
    d.guildMusicSettings.findMany.mockRejectedValue(new Error('db down') as never);

    expect(await repo.getAllSettings()).toEqual([]);
  });
});

describe('GuildMusicSettingsRepository.saveSettings', () => {
  it('writes only the supplied keys into the update branch', async () => {
    await repo.saveSettings('111', { volume: 30 });

    expect(callArg(d.guildMusicSettings.upsert)).toEqual({
      where: { guildId: 111n },
      update: { volume: 30 },
      create: {
        guildId: 111n,
        stay247: false,
        volume: 30,
        loopMode: 'off',
        autoplay: false,
        filters: [],
      },
    });
  });

  it('keeps the distinction between omitted and falsy keys', async () => {
    // `false` and `[]` are real values and must be written; a key that was
    // never passed must not be written at all. `!== undefined` is what does it.
    await repo.saveSettings('111', { stay247: false, filters: [], autoplay: false });

    expect(callArg<{ update: Record<string, unknown> }>(d.guildMusicSettings.upsert)?.update).toEqual({
      stay247: false,
      autoplay: false,
      filters: [],
    });
  });

  it('sends an empty update object for a no-op partial', async () => {
    await repo.saveSettings('111', {});

    expect(callArg<{ update: Record<string, unknown> }>(d.guildMusicSettings.upsert)?.update).toEqual({});
  });

  it('fills every create default from a partial so the insert is complete', async () => {
    await repo.saveSettings('111', { loopMode: 'queue' });

    expect(callArg<{ create: Record<string, unknown> }>(d.guildMusicSettings.upsert)?.create).toEqual({
      guildId: 111n,
      stay247: false,
      volume: 100,
      loopMode: 'queue',
      autoplay: false,
      filters: [],
    });
  });

  it('writes a full partial verbatim', async () => {
    await repo.saveSettings('111', {
      stay247: true,
      volume: 7,
      loopMode: 'song',
      autoplay: true,
      filters: ['nightcore', 'karaoke'],
    });

    expect(callArg<{ create: Record<string, unknown> }>(d.guildMusicSettings.upsert)?.create).toEqual({
      guildId: 111n,
      stay247: true,
      volume: 7,
      loopMode: 'song',
      autoplay: true,
      filters: ['nightcore', 'karaoke'],
    });
  });

  it('supports volume 0, which a truthiness guard would drop', async () => {
    await repo.saveSettings('111', { volume: 0 });

    expect(callArg<{ create: { volume: number } }>(d.guildMusicSettings.upsert)?.create.volume).toBe(0);
  });

  it.each(BAD_IDS)('refuses guild id %j without writing', async (bad) => {
    await repo.saveSettings(bad, { volume: 30 });

    expect(d.guildMusicSettings.upsert).not.toHaveBeenCalled();
  });

  it('swallows a write failure and resolves (the in-memory map is already updated)', async () => {
    d.guildMusicSettings.upsert.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.saveSettings('111', { volume: 30 })).resolves.toBeUndefined();
  });
});

describe('GuildMusicSettingsRepository.getOptedInDiscordIds', () => {
  it('stringifies each opted-in BigInt id', async () => {
    d.botScrobbleOptIn.findMany.mockResolvedValue([{ discordUserId: 11n }, { discordUserId: 22n }] as never);

    expect(await repo.getOptedInDiscordIds()).toEqual(['11', '22']);
    expect(callArg(d.botScrobbleOptIn.findMany)).toEqual({ select: { discordUserId: true } });
  });

  it('returns empty when nobody has opted in', async () => {
    d.botScrobbleOptIn.findMany.mockResolvedValue([] as never);

    expect(await repo.getOptedInDiscordIds()).toEqual([]);
  });

  it('swallows a read failure and returns empty rather than rejecting', async () => {
    d.botScrobbleOptIn.findMany.mockRejectedValue(new Error('db down') as never);

    expect(await repo.getOptedInDiscordIds()).toEqual([]);
  });
});

describe('GuildMusicSettingsRepository.setOptIn', () => {
  it('upserts an empty update on enable', async () => {
    await repo.setOptIn('4242', true);

    expect(callArg(d.botScrobbleOptIn.upsert)).toEqual({
      where: { discordUserId: 4242n },
      update: {},
      create: { discordUserId: 4242n },
    });
    expect(d.botScrobbleOptIn.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes on disable and never upserts', async () => {
    await repo.setOptIn('4242', false);

    expect(callArg(d.botScrobbleOptIn.deleteMany)).toEqual({ where: { discordUserId: 4242n } });
    expect(d.botScrobbleOptIn.upsert).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)('refuses discord id %j without writing', async (bad) => {
    await repo.setOptIn(bad, true);

    expect(d.botScrobbleOptIn.upsert).not.toHaveBeenCalled();
  });

  it('swallows an enable failure and resolves', async () => {
    d.botScrobbleOptIn.upsert.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.setOptIn('4242', true)).resolves.toBeUndefined();
  });

  it('swallows a disable failure and resolves', async () => {
    d.botScrobbleOptIn.deleteMany.mockRejectedValue(new Error('write failed') as never);

    await expect(repo.setOptIn('4242', false)).resolves.toBeUndefined();
  });
});