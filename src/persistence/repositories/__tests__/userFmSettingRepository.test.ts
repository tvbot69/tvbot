import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { UserFmSettingRepository } from '@persistence/repositories/userFmSettingRepository';

/**
 * userFmSettingRepository had NO unit test at all. It is small and its whole
 * shape is one decision: every setter calls `getOrCreate(userId)` BEFORE its
 * `update`.
 *
 * That order is load-bearing twice over. `userFmSetting` is keyed on `userId`
 * alone, so `update` on a user who has never changed a setting throws P2025 and
 * every setter is unreachable. The `getOrCreate` is what makes the setter work
 * on a fresh user at all - and it is the kind of line that gets "simplified"
 * away as redundant by someone who has not seen the throw.
 *
 * The second thing worth holding is the DEFAULT. `footerOptions` defaults to
 * `BigInt(16)` and `buttons` to `BigInt(0)`, and both are bitmasks: a wrong
 * default does not throw, it renders a footer the user never chose. The
 * defaults are asserted as exact values rather than as "something".
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

/** Every column `map` reads, straight off the `UserFmSetting` model. */
const settingEntity = (over: Args = {}) => ({
  userId: 1,
  embedType: 0,
  footerOptions: 16n,
  buttons: 0n,
  smallTextType: null,
  privateButtonResponse: null,
  modified: null,
  ...over,
});

const makePrisma = () => ({
  userFmSetting: {
    findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    create: vi.fn(async (..._args: unknown[]) => settingEntity()),
    update: vi.fn(async (..._args: unknown[]) => settingEntity()),
  },
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: UserFmSettingRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new UserFmSettingRepository(d as unknown as PrismaClient);
});

describe('UserFmSettingRepository.get', () => {
  it('looks the row up by its bare userId primary key', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);

    const got = await repo.get(1);

    expect(got?.userId).toBe(1);
    expect(callArg(d.userFmSetting.findUnique)).toEqual({ where: { userId: 1 } });
  });

  it('returns null for a user who has never touched a setting', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(null as never);
    expect(await repo.get(1)).toBeNull();
  });

  it('propagates a read failure rather than reporting "no settings"', async () => {
    // This one matters more than usual: the caller cannot tell "this user has
    // the default card" from "the database is unreachable", and they are shown
    // very differently.
    d.userFmSetting.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.get(1)).rejects.toThrow('connection reset');
  });
});

describe('UserFmSettingRepository.getOrCreate', () => {
  it('returns the existing row and writes nothing', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity({ embedType: 2 }) as never);

    const got = await repo.getOrCreate(1);

    expect(got.embedType).toBe(2);
    expect(d.userFmSetting.create).not.toHaveBeenCalled();
  });

  it('creates with the DOCUMENTED defaults, and they are bitmask values', async () => {
    await repo.getOrCreate(1);

    // 16 is the default footer option bit; 0 is "no buttons". Getting either
    // wrong renders a footer the user never selected, and nothing throws.
    expect(callArg(d.userFmSetting.create)).toEqual({
      data: { userId: 1, embedType: 0, footerOptions: BigInt(16), buttons: BigInt(0) },
    });
  });

  it('does not stamp `modified` on create, so a fresh row reads as never touched', async () => {
    await repo.getOrCreate(1);
    const data = callArg<{ data: Args }>(d.userFmSetting.create).data;
    // `modified` is nullable and no default; a set-to-now here would claim the
    // user changed something at the moment they first loaded a card.
    expect(data.modified).toBeUndefined();
  });

  it('propagates a create failure rather than returning a fabricated default', async () => {
    d.userFmSetting.create.mockRejectedValue(new Error('unique violation') as never);
    await expect(repo.getOrCreate(1)).rejects.toThrow('unique violation');
  });
});

describe('UserFmSettingRepository setters', () => {
  /**
   * The order is the product. `update` against a missing row throws P2025, so
   * the `getOrCreate` in front of it is not defensive noise - it is what makes
   * the setter work for a user who has never opened a card.
   */
  it('every setter creates the row first, so the update can never hit a missing key', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(null as never);

    for (const call of [
      () => repo.setEmbedType(1, 2),
      () => repo.setFooterOptions(1, 32n),
      () => repo.setButtons(1, 8n),
      () => repo.setSmallTextType(1, 1),
      () => repo.setPrivateButtonResponse(1, true),
    ] as Array<() => Promise<unknown>>) {
      d.userFmSetting.create.mockClear();
      await call();
      expect(d.userFmSetting.create).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT create when the row already exists', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    await repo.setEmbedType(1, 2);
    expect(d.userFmSetting.create).not.toHaveBeenCalled();
  });

  it('setEmbedType writes the type and stamps modified', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockResolvedValue(settingEntity({ embedType: 3 }) as never);

    const got = await repo.setEmbedType(1, 3);

    expect(got.embedType).toBe(3);
    const data = callArg<{ data: Args }>(d.userFmSetting.update).data;
    expect(data.embedType).toBe(3);
    expect(data.modified).toBeInstanceOf(Date);
  });

  it('setEmbedType writes 0, which is a real card style and not an absence', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    await repo.setEmbedType(1, 0);
    expect(callArg<{ data: Args }>(d.userFmSetting.update).data.embedType).toBe(0);
  });

  it('setFooterOptions writes the bigint mask unchanged', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockResolvedValue(settingEntity({ footerOptions: 48n }) as never);

    const got = await repo.setFooterOptions(1, 48n);

    expect(got.footerOptions).toBe(48n);
    expect(callArg<{ data: Args }>(d.userFmSetting.update).data.footerOptions).toBe(48n);
  });

  it('setButtons writes a ZERO mask, which clears the buttons', async () => {
    // 0n is the answer for "no buttons". A truthiness guard would skip the
    // write and leave the buttons on the footer forever.
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockResolvedValue(settingEntity({ buttons: 0n }) as never);

    expect((await repo.setButtons(1, 0n)).buttons).toBe(0n);
    expect(callArg<{ data: Args }>(d.userFmSetting.update).data.buttons).toBe(0n);
  });

  it('setSmallTextType accepts null, which means "no small text"', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockResolvedValue(settingEntity({ smallTextType: null }) as never);

    const got = await repo.setSmallTextType(1, null);

    expect(got.smallTextType).toBeNull();
    expect(callArg<{ data: Args }>(d.userFmSetting.update).data.smallTextType).toBeNull();
  });

  it('setSmallTextType keeps a zero type, which is a real option', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockResolvedValue(settingEntity({ smallTextType: 0 }) as never);

    expect((await repo.setSmallTextType(1, 0)).smallTextType).toBe(0);
  });

  it('setPrivateButtonResponse writes false, and null resets to the default', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);

    d.userFmSetting.update.mockResolvedValue(settingEntity({ privateButtonResponse: false }) as never);
    expect((await repo.setPrivateButtonResponse(1, false)).privateButtonResponse).toBe(false);

    d.userFmSetting.update.mockResolvedValue(settingEntity({ privateButtonResponse: null }) as never);
    expect((await repo.setPrivateButtonResponse(1, null)).privateButtonResponse).toBeNull();
  });

  it('every setter propagates the getOrCreate failure rather than updating nothing', async () => {
    d.userFmSetting.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.setEmbedType(1, 2)).rejects.toThrow('connection reset');
    expect(d.userFmSetting.update).not.toHaveBeenCalled();
  });

  it('every setter propagates the update failure', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);
    d.userFmSetting.update.mockRejectedValue(new Error('write failed') as never);
    await expect(repo.setButtons(1, 8n)).rejects.toThrow('write failed');
  });
});

describe('UserFmSettingRepository entity mapping', () => {
  it('carries nullable columns through as null rather than as undefined or 0', async () => {
    // The DTO types them `| null`, and `null` is how "reset to default" is
    // represented. Collapsing to `0` would render a small-text style the user
    // never chose.
    d.userFmSetting.findUnique.mockResolvedValue(settingEntity() as never);

    const got = await repo.get(1);

    expect(got?.smallTextType).toBeNull();
    expect(got?.privateButtonResponse).toBeNull();
    expect(got?.modified).toBeNull();
  });

  it('keeps the bigint columns as bigints - they are bitmasks, not numbers', async () => {
    d.userFmSetting.findUnique.mockResolvedValue(
      settingEntity({ footerOptions: 1n << 40n, buttons: 3n }) as never,
    );

    const got = await repo.get(1);

    expect(typeof got?.footerOptions).toBe('bigint');
    expect(got?.footerOptions).toBe(1n << 40n);
    expect(got?.buttons).toBe(3n);
  });
});
