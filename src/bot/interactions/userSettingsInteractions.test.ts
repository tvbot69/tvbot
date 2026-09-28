import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MessageFlags,
  PermissionsBitField,
  ContainerBuilder,
  TextDisplayBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type Interaction,
} from 'discord.js';
import { UserSettingsInteractions, USER_SETTINGS_PREFIX } from './userSettingsInteractions';
import { UserSettingsBuilders } from '@bot/builders/userSettingsBuilders';
import { PlayBuilders } from '@bot/builders/playBuilders';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { ResponseMode } from '@domain/enums/responseMode';
import { CoverType } from '@domain/enums/coverType';
import { UserType, DataSource, type User } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import { ResponseModel } from '@bot/models/responseModel';

const NO_PERMS = new PermissionsBitField(0n);
const MANAGE_GUILD_PERMS = new PermissionsBitField(PermissionsBitField.Flags.ManageGuild);

const makeUser = (over: Partial<User> = {}): User => ({
  userId: 7,
  userNameLastFm: 'user1',
  discordUserId: 'caller1',
  registeredOn: new Date('2024-01-01'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

/** Minimal ComponentsV2 response, enough for the `componentsV2Container ? [..] : []` branch. */
const makeResponse = (): ResponseModel =>
  new ResponseModel().setComponentsV2Container(
    new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('ok')),
  );

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    setWhoKnowsMode: vi.fn(async () => WhoKnowsMode.Default),
    setResponseMode: vi.fn(async () => ResponseMode.Embed),
    setCoverType: vi.fn(async () => CoverType.Motion),
    ...(over.userService as object),
  };
  const fmSettingService = {
    get: vi.fn(async () => null),
    ...(over.fmSettingService as object),
  };
  const prefixService = {
    getPrefix: vi.fn(async () => '!'),
    setPrefix: vi.fn(async () => undefined),
    ...(over.prefixService as object),
  };
  const usi = new UserSettingsInteractions(
    userService as never,
    fmSettingService as never,
    prefixService as never,
  );
  return { usi, userService, fmSettingService, prefixService };
};

const selectBase = (customId: string, values: string[], over: Record<string, unknown> = {}) => ({
  customId,
  values,
  guildId: 'g1',
  channelId: 'c1',
  user: { id: 'caller1', displayName: 'Caller' },
  guild: { id: 'g1', name: 'TestGuild', ownerId: 'owner1', members: { cache: new Map() } },
  memberPermissions: NO_PERMS,
  member: null,
  isStringSelectMenu: () => true,
  isButton: () => false,
  reply: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  ...over,
});

const mkSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  selectBase(customId, values, over) as unknown as StringSelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    isStringSelectMenu: () => boolean;
    isButton: () => boolean;
  };

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  selectBase(customId, [], { ...over, isStringSelectMenu: () => false, isButton: () => true }) as unknown as
    ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      isStringSelectMenu: () => boolean;
      isButton: () => boolean;
    };

const replyContent = (mock: ReturnType<typeof vi.fn>): string =>
  (mock.mock.calls[0]![0] as { content: string }).content;

const replyFlags = (mock: ReturnType<typeof vi.fn>): number =>
  (mock.mock.calls[0]![0] as { flags: number }).flags;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserSettingsInteractions.asUserSettingsInteraction', () => {
  it('claims a button whose customId carries the user-settings prefix', () => {
    const { usi } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:user`);

    expect(usi.asUserSettingsInteraction(press as unknown as Interaction)).toBe(press);
  });

  it('claims a select menu carrying the prefix', () => {
    const { usi } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}select`, ['us-view-WkMode']);

    expect(usi.asUserSettingsInteraction(select as unknown as Interaction)).toBe(select);
  });

  it('claims the bare response-mode-pick and cover-type-pick custom ids', () => {
    const { usi } = build();

    expect(usi.asUserSettingsInteraction(mkButton('response-mode-pick') as unknown as Interaction)).not.toBeNull();
    expect(usi.asUserSettingsInteraction(mkButton('cover-type-pick') as unknown as Interaction)).not.toBeNull();
  });

  it('declines a button belonging to another module', () => {
    const { usi } = build();
    const press = mkButton('profile:view:target1:caller1:user1');

    expect(usi.asUserSettingsInteraction(press as unknown as Interaction)).toBeNull();
  });

  it('declines an interaction that is neither a button nor a string select', () => {
    const { usi } = build();
    const other = {
      customId: `${USER_SETTINGS_PREFIX}select`,
      isButton: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction;

    expect(usi.asUserSettingsInteraction(other)).toBeNull();
  });
});

describe('UserSettingsInteractions.handle — unregistered user', () => {
  it('replies ephemeral and stops when no Last.fm account is linked', async () => {
    const { usi, userService } = build({
      userService: { getUserByDiscordId: vi.fn(async () => null) },
    });
    const select = mkSelect(`${USER_SETTINGS_PREFIX}select`, ['us-view-WkMode']);

    await usi.handle(select);

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('caller1');
    expect(replyContent(select.reply)).toContain('/login');
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral);
    expect(select.update).not.toHaveBeenCalled();
  });
});

describe('UserSettingsInteractions.handle — "user-settings:select" routing', () => {
  const selectSetting = (value: string) => mkSelect(`${USER_SETTINGS_PREFIX}select`, [value]);

  it('builds the FM mode response from a stored setting', async () => {
    const { usi, fmSettingService } = build({
      fmSettingService: {
        get: vi.fn(async () => ({ embedType: 4, footerOptions: 16n, buttons: 1n, smallTextType: null })),
      },
    });
    const spy = vi.spyOn(PlayBuilders, 'buildFmModeResponse');
    const select = selectSetting('us-view-FmMode');

    await usi.handle(select);

    expect(fmSettingService.get).toHaveBeenCalledWith(7);
    expect(spy).toHaveBeenCalledWith(
      { embedType: 4, footerOptions: 16n, buttons: 1n, smallTextType: null },
      undefined,
    );
    // `ContextModel.fromComponentInteraction` never populates accentColor, so
    // every builder in this class receives undefined here. Pinned so a future
    // change to the factory shows up as a diff rather than as a silent accent.
    expect(spy.mock.calls[0]![1]).toBeUndefined();
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('falls back to the default FM setting when none is stored', async () => {
    const { usi, fmSettingService } = build();
    const spy = vi.spyOn(PlayBuilders, 'buildFmModeResponse');
    const select = selectSetting('us-view-FmMode');

    await usi.handle(select);

    expect(fmSettingService.get).toHaveBeenCalledWith(7);
    expect(spy).toHaveBeenCalledWith(
      { embedType: 0, footerOptions: 16n, buttons: 0n, smallTextType: null },
      undefined,
    );
  });

  it('routes WkMode to buildResponseModeResponse', async () => {
    const { usi } = build();
    const spy = vi.spyOn(UserSettingsBuilders, 'buildResponseModeResponse');
    const select = selectSetting('us-view-WkMode');

    await usi.handle(select);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeInstanceOf(Object);
    expect(spy.mock.calls[0]![1]).toMatchObject({ userId: 7, userNameLastFm: 'user1' });
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('routes CoverType to buildCoverModeResponse', async () => {
    const { usi } = build();
    const spy = vi.spyOn(UserSettingsBuilders, 'buildCoverModeResponse');
    const select = selectSetting('us-view-CoverType');

    await usi.handle(select);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('routes Localization to buildLocalizationResponse', async () => {
    const { usi } = build();
    const spy = vi.spyOn(UserSettingsBuilders, 'buildLocalizationResponse');
    const select = selectSetting('us-view-Localization');

    await usi.handle(select);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it.each([
    ['us-view-BotScrobbling', '.botscrobbling'],
    ['us-view-CommandShortcuts', '.shortcuts'],
    ['us-view-SpotifyImport', '.spotifyimport'],
  ])('answers %s with a pointer to %s', async (value, expected) => {
    const { usi } = build();
    const select = selectSetting(value);

    await usi.handle(select);

    expect(replyContent(select.reply)).toContain(expected);
    expect(replyFlags(select.reply)).toBe(MessageFlags.Ephemeral);
  });

  it('links the Last.fm applications page for OutOfSync', async () => {
    const { usi } = build();
    const select = selectSetting('us-view-OutOfSync');

    await usi.handle(select);

    expect(replyContent(select.reply)).toContain('https://www.last.fm/settings/applications');
  });

  it('points DeleteAccount at .deleteaccount', async () => {
    const { usi } = build();
    const select = selectSetting('us-view-DeleteAccount');

    await usi.handle(select);

    expect(replyContent(select.reply)).toContain('.deleteaccount');
  });

  it('rejects an unrecognised setting', async () => {
    const { usi } = build();
    const select = selectSetting('us-view-SomethingElse');

    await usi.handle(select);

    expect(replyContent(select.reply)).toBe('Unknown setting selected.');
  });

  it('rejects an empty selection as unknown rather than crashing', async () => {
    const { usi } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}select`, []);

    await usi.handle(select);

    expect(replyContent(select.reply)).toBe('Unknown setting selected.');
  });
});

describe('UserSettingsInteractions.handle — setting writers', () => {
  it.each([
    [String(WhoKnowsMode.Image), WhoKnowsMode.Image, 'Image'],
    [String(WhoKnowsMode.Pagination), WhoKnowsMode.Pagination, 'Pagination'],
    [String(WhoKnowsMode.Default), WhoKnowsMode.Default, 'Default'],
  ])('persists WhoKnows mode %s', async (value, expected, expectedName) => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:wkmode`, [value]);

    await usi.handle(select);

    expect(userService.setWhoKnowsMode).toHaveBeenCalledWith(7, expected);
    expect(replyContent(select.reply)).toBe(`Your default WhoKnows mode has been set to **${expectedName}**.`);
  });

  it('defaults an unparseable WhoKnows mode to Default', async () => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:wkmode`, ['not-a-number']);

    await usi.handle(select);

    expect(userService.setWhoKnowsMode).toHaveBeenCalledWith(7, WhoKnowsMode.Default);
    expect(replyContent(select.reply)).toContain('**Default**');
  });

  it('treats mode 0 as unset and falls back to Default', async () => {
    // `Number('0') || Default` is a truthiness check, not a null check: 0 is
    // swallowed. WhoKnowsMode has no 0 member, so nothing is lost — but the
    // behaviour is deliberate-looking and worth pinning.
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:wkmode`, ['0']);

    await usi.handle(select);

    expect(userService.setWhoKnowsMode).toHaveBeenCalledWith(7, WhoKnowsMode.Default);
  });

  it.each([
    [String(ResponseMode.Image), ResponseMode.Image, 'Image'],
    [String(ResponseMode.Embed), ResponseMode.Embed, 'Embed'],
  ])('persists Top list mode %s', async (value, expected, expectedName) => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:topmode`, [value]);

    await usi.handle(select);

    expect(userService.setResponseMode).toHaveBeenCalledWith(7, expected);
    expect(replyContent(select.reply)).toBe(`Your default Top list mode has been set to **${expectedName}**.`);
  });

  it('defaults an unparseable Top list mode to Embed', async () => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:topmode`, ['nope']);

    await usi.handle(select);

    expect(userService.setResponseMode).toHaveBeenCalledWith(7, ResponseMode.Embed);
  });

  it.each([
    [String(CoverType.Still), CoverType.Still, 'Still'],
    [String(CoverType.Motion), CoverType.Motion, 'Motion'],
  ])('persists cover type %s', async (value, expected, expectedName) => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:covertype`, [value]);

    await usi.handle(select);

    expect(userService.setCoverType).toHaveBeenCalledWith(7, expected);
    expect(replyContent(select.reply)).toBe(
      `Your default album cover type has been set to **${expectedName}**.`,
    );
  });

  it('defaults an unparseable cover type to Motion', async () => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:covertype`, ['zzz']);

    await usi.handle(select);

    expect(userService.setCoverType).toHaveBeenCalledWith(7, CoverType.Motion);
  });

  it('does nothing for an unknown user-settings: set target', async () => {
    const { usi, userService } = build();
    const select = mkSelect(`${USER_SETTINGS_PREFIX}set:unknown`, ['1']);

    await usi.handle(select);

    expect(userService.setWhoKnowsMode).not.toHaveBeenCalled();
    expect(userService.setResponseMode).not.toHaveBeenCalled();
    expect(userService.setCoverType).not.toHaveBeenCalled();
    expect(select.reply).not.toHaveBeenCalled();
  });
});

describe('UserSettingsInteractions.handle — buttons', () => {
  it('opens FM mode from the button with the stored setting', async () => {
    const { usi, fmSettingService } = build({
      fmSettingService: {
        get: vi.fn(async () => ({ embedType: 2, footerOptions: 1n, buttons: 2n, smallTextType: 3 })),
      },
    });
    const spy = vi.spyOn(PlayBuilders, 'buildFmModeResponse');
    const press = mkButton(`${USER_SETTINGS_PREFIX}open:fmmode`);

    await usi.handle(press);

    expect(fmSettingService.get).toHaveBeenCalledWith(7);
    expect(spy).toHaveBeenCalledWith({ embedType: 2, footerOptions: 1n, buttons: 2n, smallTextType: 3 }, undefined);
    expect(replyFlags(press.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('falls back to the default FM setting on the button path too', async () => {
    const { usi } = build();
    const spy = vi.spyOn(PlayBuilders, 'buildFmModeResponse');
    const press = mkButton(`${USER_SETTINGS_PREFIX}open:fmmode`);

    await usi.handle(press);

    expect(spy).toHaveBeenCalledWith(
      { embedType: 0, footerOptions: 16n, buttons: 0n, smallTextType: null },
      undefined,
    );
  });

  it.each([
    [`${USER_SETTINGS_PREFIX}open:responsemode`, 'buildResponseModeResponse'],
    ['response-mode-pick', 'buildResponseModeResponse'],
    [`${USER_SETTINGS_PREFIX}open:covermode`, 'buildCoverModeResponse'],
    ['cover-type-pick', 'buildCoverModeResponse'],
  ])('routes %s to %s', async (customId, method) => {
    const { usi } = build();
    const spy =
      method === 'buildResponseModeResponse'
        ? vi.spyOn(UserSettingsBuilders, 'buildResponseModeResponse')
        : vi.spyOn(UserSettingsBuilders, 'buildCoverModeResponse');
    const press = mkButton(customId);

    await usi.handle(press);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(replyFlags(press.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it('renders the user tab with the admin flag from the context', async () => {
    const { usi } = build();
    const spy = vi.spyOn(UserSettingsBuilders, 'buildUserSettingsResponse');
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:user`, {
      memberPermissions: MANAGE_GUILD_PERMS,
    });

    await usi.handle(press);

    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 7 }), true, 'user');
    expect(press.update).toHaveBeenCalledTimes(1);
    expect(replyFlags(press.update as unknown as ReturnType<typeof vi.fn>)).toBe(MessageFlags.IsComponentsV2);
  });

  it('renders the user tab with admin=false for a plain member', async () => {
    const { usi } = build();
    const spy = vi.spyOn(UserSettingsBuilders, 'buildUserSettingsResponse');
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:user`);

    await usi.handle(press);

    expect(spy.mock.calls[0]![2]).toBe(false);
  });

  it('updates rather than replies for the user tab', async () => {
    const { usi } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:user`);

    await usi.handle(press);

    expect(press.reply).not.toHaveBeenCalled();
  });

  it('renders the server tab for an admin using the injected PrefixService', async () => {
    const { usi, prefixService } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:server`, { memberPermissions: MANAGE_GUILD_PERMS });

    await usi.handle(press);

    expect(prefixService.getPrefix).toHaveBeenCalledWith('g1');
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('refuses the server tab for a non-admin without building the page', async () => {
    const { usi, prefixService } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:server`);

    await usi.handle(press);

    expect(prefixService.getPrefix).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(replyContent(press.reply)).toContain('Manage Server');
  });

  it('swallows a rejected permission reply on the server tab', async () => {
    const { usi } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}tab:server`, {
      reply: vi.fn(async () => {
        throw new Error('already acknowledged');
      }),
    });

    await expect(usi.handle(press)).resolves.toBeUndefined();
  });

  it('does nothing for an unknown user-settings button', async () => {
    const { usi } = build();
    const press = mkButton(`${USER_SETTINGS_PREFIX}open:unknown`);

    await usi.handle(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('UserSettingsInteractions.handle — builder response payloads', () => {
  it('sends the container when the builder produced one', async () => {
    const { usi } = build();
    const response = makeResponse();
    vi.spyOn(UserSettingsBuilders, 'buildResponseModeResponse').mockReturnValue(response);
    const press = mkButton('response-mode-pick');

    await usi.handle(press);

    const payload = press.reply.mock.calls[0]![0] as { components: unknown[] };
    expect(payload.components).toEqual([response.componentsV2Container]);
  });

  it('sends an empty component array rather than [undefined]', async () => {
    const { usi } = build();
    // A ResponseModel with no container: the `res.componentsV2Container ? [..] : []`
    // ternary must degrade to `[]` rather than putting `undefined` in components.
    vi.spyOn(UserSettingsBuilders, 'buildResponseModeResponse').mockReturnValue(new ResponseModel());
    const press = mkButton('response-mode-pick');

    await usi.handle(press);

    const payload = press.reply.mock.calls[0]![0] as { components: unknown[] };
    expect(payload.components).toEqual([]);
    expect(replyFlags(press.reply)).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });
});
