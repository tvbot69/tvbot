import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { MessageFlags } from 'discord.js';
import { FmModeInteractions, FM_MODE_PREFIX } from '../fmModeInteractions';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { UserType, DataSource } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { User } from '@persistence/domain/models/user';
import type { UserFmSetting } from '@domain/interfaces/iuserFmSettingRepository';
import type { StringSelectMenuInteraction } from 'discord.js';

const makeUser = (over: Partial<User> = {}): User => ({
  userId: 7,
  userNameLastFm: 'user1',
  discordUserId: 'caller1',
  registeredOn: new Date('2025-01-01'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

const makeSetting = (over: Partial<UserFmSetting> = {}): UserFmSetting => ({
  userId: 7,
  embedType: 0,
  footerOptions: BigInt(0),
  buttons: BigInt(0),
  smallTextType: null,
  privateButtonResponse: null,
  modified: null,
  ...over,
});

const makeSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    values,
    user: { id: 'caller1' },
    guildId: 'g1',
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    ...over,
  }) as unknown as StringSelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    ...(over.userService as object),
  };
  const fmSettingService = {
    getOrCreate: vi.fn(async () => makeSetting()),
    setEmbedType: vi.fn(async () => makeSetting()),
    setSmallTextType: vi.fn(async () => makeSetting()),
    setFooterOptions: vi.fn(async () => makeSetting()),
    setButtons: vi.fn(async () => makeSetting()),
    ...(over.fmSettingService as object),
  };
  const fmi = new FmModeInteractions(userService as never, fmSettingService as never);
  return { fmi, userService, fmSettingService };
};

const CONTAINER = { type: 17, components: [] } as unknown as NonNullable<
  ReturnType<typeof PlayBuilders.buildFmModeResponse>['componentsV2Container']
>;

let fmModeSpy: MockInstance<typeof PlayBuilders.buildFmModeResponse>;

beforeEach(() => {
  vi.restoreAllMocks();
  fmModeSpy = vi
    .spyOn(PlayBuilders, 'buildFmModeResponse')
    .mockReturnValue({ componentsV2Container: CONTAINER } as unknown as ReturnType<
      typeof PlayBuilders.buildFmModeResponse
    >);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FmModeInteractions — unlinked user', () => {
  it('replies ephemerally when the caller has no Last.fm account', async () => {
    const { fmi, fmSettingService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['1']);

    await fmi.handle(select);

    expect(select.reply).toHaveBeenCalledTimes(1);
    const payload = select.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Connect your Last.fm account first with `/register`.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(fmSettingService.getOrCreate).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
  });

  it('looks the user up by the presser discord id', async () => {
    const { fmi, userService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['1']);

    await fmi.handle(select);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
  });
});

describe('FmModeInteractions.handle — action routing', () => {
  it('routes "type" to setEmbedType as a number', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['3']);

    await fmi.handle(select);

    expect(fmSettingService.setEmbedType).toHaveBeenCalledWith(7, 3);
    expect(fmSettingService.setSmallTextType).not.toHaveBeenCalled();
    expect(fmSettingService.setFooterOptions).not.toHaveBeenCalled();
    expect(fmSettingService.setButtons).not.toHaveBeenCalled();
  });

  it('routes "text" to setSmallTextType as a number', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}text`, ['2']);

    await fmi.handle(select);

    expect(fmSettingService.setSmallTextType).toHaveBeenCalledWith(7, 2);
    expect(fmSettingService.setEmbedType).not.toHaveBeenCalled();
  });

  it('routes "footer" to setFooterOptions as a bigint', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}footer`, ['8']);

    await fmi.handle(select);

    expect(fmSettingService.setFooterOptions).toHaveBeenCalledWith(7, BigInt(8));
    expect(fmSettingService.setButtons).not.toHaveBeenCalled();
  });

  it('routes "buttons" to setButtons as a bigint', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}buttons`, ['16']);

    await fmi.handle(select);

    expect(fmSettingService.setButtons).toHaveBeenCalledWith(7, BigInt(16));
    expect(fmSettingService.setFooterOptions).not.toHaveBeenCalled();
  });

  it('OR-combines multiple footer values rather than summing them', async () => {
    const { fmi, fmSettingService } = build();
    // 1 | 3 === 3, whereas 1 + 3 === 4. A sum-shaped assertion would not
    // catch a reduce that adds instead of OR-ing the bitmask.
    const select = makeSelect(`${FM_MODE_PREFIX}footer`, ['1', '3']);

    await fmi.handle(select);

    expect(fmSettingService.setFooterOptions).toHaveBeenCalledWith(7, BigInt(3));
  });

  it('OR-combines multiple button values rather than summing them', async () => {
    const { fmi, fmSettingService } = build();
    // 5 | 3 === 7, whereas 5 + 3 === 8.
    const select = makeSelect(`${FM_MODE_PREFIX}buttons`, ['5', '3']);

    await fmi.handle(select);

    expect(fmSettingService.setButtons).toHaveBeenCalledWith(7, BigInt(7));
  });

  it('folds a single footer value to bigint zero', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}footer`, ['0']);

    await fmi.handle(select);

    expect(fmSettingService.setFooterOptions).toHaveBeenCalledWith(7, BigInt(0));
  });

  it('does nothing for an unknown action', async () => {
    const { fmi, fmSettingService } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}bogus`, ['1']);

    await fmi.handle(select);

    expect(fmSettingService.setEmbedType).not.toHaveBeenCalled();
    expect(fmSettingService.setSmallTextType).not.toHaveBeenCalled();
    expect(fmSettingService.setFooterOptions).not.toHaveBeenCalled();
    expect(fmSettingService.setButtons).not.toHaveBeenCalled();
    expect(fmSettingService.getOrCreate).not.toHaveBeenCalled();
    expect(fmModeSpy).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
    expect(select.reply).not.toHaveBeenCalled();
  });

  it('does nothing when the customId carries no fmmode prefix at all', async () => {
    const { fmi, fmSettingService, userService } = build();
    const select = makeSelect('guild-members', ['Crowns']);

    await fmi.handle(select);

    // The user lookup still happens - the prefix is only consulted afterwards.
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
    expect(fmSettingService.getOrCreate).not.toHaveBeenCalled();
    expect(select.update).not.toHaveBeenCalled();
  });

  it('uses the caller userId, not the discord id, for the setter', async () => {
    const { fmi, fmSettingService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => makeUser({ userId: 99, discordUserId: 'caller1' })) },
    });
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['1']);

    await fmi.handle(select);

    expect(fmSettingService.setEmbedType).toHaveBeenCalledWith(99, 1);
  });
});

describe('FmModeInteractions.handle — response', () => {
  it('re-reads the setting after the write and builds from it', async () => {
    const updated = makeSetting({ embedType: 4, footerOptions: BigInt(9) });
    const { fmi, fmSettingService } = build({
      fmSettingService: { getOrCreate: vi.fn(async () => updated) },
    });
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['4']);

    await fmi.handle(select);

    expect(fmSettingService.getOrCreate).toHaveBeenCalledWith(7);
    expect(fmModeSpy).toHaveBeenCalledTimes(1);
    expect(fmModeSpy.mock.calls[0]![0]).toBe(updated);
  });

  it('re-reads the setting only after the setter has run', async () => {
    const order: string[] = [];
    const { fmi } = build({
      fmSettingService: {
        setEmbedType: vi.fn(async () => {
          order.push('set');
          return makeSetting();
        }),
        getOrCreate: vi.fn(async () => {
          order.push('get');
          return makeSetting();
        }),
      },
    });
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['1']);

    await fmi.handle(select);

    expect(order).toEqual(['set', 'get']);
  });

  it('updates with the components v2 container and no mentions', async () => {
    const { fmi } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}type`, ['1']);

    await fmi.handle(select);

    expect(select.update).toHaveBeenCalledTimes(1);
    expect(select.update).toHaveBeenCalledWith({
      components: [CONTAINER],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    expect(select.reply).not.toHaveBeenCalled();
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('does not send embeds when publishing the updated card', async () => {
    const { fmi } = build();
    const select = makeSelect(`${FM_MODE_PREFIX}footer`, ['1']);

    await fmi.handle(select);

    const payload = select.update.mock.calls[0]![0] as { embeds?: unknown };
    expect(payload.embeds).toBeUndefined();
  });
});
