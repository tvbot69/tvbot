import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { MessageFlags, PermissionsBitField } from 'discord.js';
import { SettingsInteractions, buildSettingsPage, SETTINGS_BUTTON_PREFIX } from './settingsInteractions';
import { tryHandleModal } from './index';
import { ContextModel } from '@bot/models/contextModel';
import { FmEmbedType, FmEmbedTypeNames } from '@domain/enums/fmEmbedType';
import { UserRepository } from '@persistence/repositories/userRepository';
import { FmSettingService } from '@bot/services/fmSettingService';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';

/** Not exported by the module; this is the literal the constructor registers. */
const PREFIX_MODAL_ID = 'settings-modal-prefix';

const NO_PERMS = new PermissionsBitField(0n);
const ADMIN_PERMS = new PermissionsBitField(PermissionsBitField.Flags.Administrator);
const MANAGE_GUILD_PERMS = new PermissionsBitField(PermissionsBitField.Flags.ManageGuild);

/**
 * The prefix mock is deliberately SHARED by every instance rather than freshly
 * built per `build()`.
 *
 * `SettingsInteractions`'s constructor calls the real `registerModalHandler`,
 * which pushes onto a module-level array in `./index`, and `tryHandleModal`
 * resolves with `handlers.find(...)` - i.e. the FIRST registration wins for the
 * lifetime of the test file. A per-test mock would therefore never be the one
 * the modal lookup finds. Sharing one object makes every instance's captured
 * dependency the same spy, so the real registration path is exercised and the
 * assertions still land on a mock this file controls.
 */
const prefixService = {
  getPrefix: vi.fn(async (_guildId?: string | null) => '!'),
  setPrefix: vi.fn(async (_guildId: string, _prefix: string) => undefined),
  getDefaultPrefix: vi.fn(() => '!'),
};

const build = (over: Record<string, unknown> = {}) => {
  Object.assign(prefixService, over);
  return new SettingsInteractions(prefixService as never);
};

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'caller1', displayName: 'Caller' },
    guild: { id: 'g1', name: 'TestGuild', ownerId: 'owner1', members: { cache: new Map() } },
    inGuild: vi.fn(() => true),
    memberPermissions: NO_PERMS,
    member: null,
    reply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
    inGuild: ReturnType<typeof vi.fn>;
  };

const mkModal = (customId: string, value: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    channelId: 'c1',
    user: { id: 'caller1', displayName: 'Caller' },
    guild: { id: 'g1', name: 'TestGuild', ownerId: 'owner1', members: { cache: new Map() } },
    inGuild: vi.fn(() => true),
    memberPermissions: NO_PERMS,
    member: null,
    fields: { getTextInputValue: vi.fn(() => value) },
    reply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ModalSubmitInteraction & {
    reply: ReturnType<typeof vi.fn>;
    fields: { getTextInputValue: ReturnType<typeof vi.fn> };
  };

const mkContext = (over: Partial<ContextModel> = {}): ContextModel => {
  const ctx = new ContextModel();
  ctx.discordUserId = 'caller1';
  ctx.guildId = 'g1';
  Object.assign(ctx, over);
  return ctx;
};

type ContainerComponentJson = {
  type: number;
  content?: string;
  components?: ContainerComponentJson[];
  accessory?: { custom_id: string; label: string; disabled?: boolean };
};

const containerJson = (response: Awaited<ReturnType<typeof buildSettingsPage>>) =>
  response.componentsV2Container!.toJSON() as unknown as { components: ContainerComponentJson[] };

/**
 * Every text display in the container, at any depth.
 *
 * `addTextDisplayComponents` on a *Container* is a direct child, but the same
 * call on a *Section* nests the text inside `section.components`. Three of the
 * four settings lines are inside sections, so a flat scan finds only the title.
 */
const textContents = (response: Awaited<ReturnType<typeof buildSettingsPage>>): string[] => {
  const out: string[] = [];
  const walk = (components: ContainerComponentJson[] = []) => {
    for (const c of components) {
      if (c.content !== undefined) out.push(c.content);
      if (c.components) walk(c.components);
    }
  };
  walk(containerJson(response).components);
  return out;
};

const accessoriesOf = (response: Awaited<ReturnType<typeof buildSettingsPage>>) =>
  containerJson(response).components
    .map((c) => c.accessory)
    .filter((a): a is { custom_id: string; label: string; disabled?: boolean } => Boolean(a));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsInteractions.handleSettingsButton — permission gate', () => {
  it('refuses with an ephemeral reply when the interaction is not in a guild', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, { inGuild: vi.fn(() => false) });

    await si.handleSettingsButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You need the `Manage Server` permission to change bot settings.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.showModal).not.toHaveBeenCalled();
  });

  it('allows the guild owner through', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, {
      guild: { id: 'g1', name: 'TestGuild', ownerId: 'caller1', members: { cache: new Map() } },
    });

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('allows a member with Administrator via memberPermissions', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, { memberPermissions: ADMIN_PERMS });

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
  });

  it('allows a member with ManageGuild via memberPermissions', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, { memberPermissions: MANAGE_GUILD_PERMS });

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
  });

  it('refuses a member with no permissions at all', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, { memberPermissions: NO_PERMS });

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
  });

  it('falls through to the raw member permissions when memberPermissions is absent', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, {
      memberPermissions: null,
      member: { permissions: MANAGE_GUILD_PERMS },
    });

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
  });

  it('accepts a raw member Administrator bitfield', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, {
      memberPermissions: null,
      member: { permissions: ADMIN_PERMS },
    });

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
  });

  it('refuses when the raw member permissions cannot be parsed', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, {
      memberPermissions: null,
      // `new PermissionsBitField('not-a-permission')` throws DiscordjsRangeError,
      // which is what the `catch` in isStaff exists to absorb.
      member: { permissions: 'not-a-permission' },
    });

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
  });

  it('refuses when there is no member and no memberPermissions', async () => {
    const si = build();
    const press = mkButton(`${SETTINGS_BUTTON_PREFIX}prefix`, { memberPermissions: null, member: null });

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsInteractions.handleSettingsButton — actions', () => {
  const staffButton = (customId: string, over: Record<string, unknown> = {}) =>
    mkButton(customId, { memberPermissions: MANAGE_GUILD_PERMS, ...over });

  it('opens the prefix modal for the "prefix" action', async () => {
    const si = build();
    const press = staffButton(`${SETTINGS_BUTTON_PREFIX}prefix`);

    await si.handleSettingsButton(press);

    expect(press.showModal).toHaveBeenCalledTimes(1);
    const modal = press.showModal.mock.calls[0]![0] as { toJSON: () => unknown };
    const json = modal.toJSON() as { custom_id: string; title: string; components: Array<{ components: Array<{ custom_id: string; max_length?: number; required?: boolean }> }> };
    expect(json.custom_id).toBe(PREFIX_MODAL_ID);
    expect(json.title).toBe('Change command prefix');
    const input = json.components[0]!.components[0]!;
    expect(input.custom_id).toBe('prefix');
    expect(input.max_length).toBe(10);
    expect(input.required).toBe(true);
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('points the user at /fmmode for the "fmmode" action', async () => {
    const si = build();
    const press = staffButton(`${SETTINGS_BUTTON_PREFIX}fmmode`);

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toContain('/fmmode');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('points the user at /servermode for the "serverfm" action', async () => {
    const si = build();
    const press = staffButton(`${SETTINGS_BUTTON_PREFIX}serverfm`);

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toContain('/servermode');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('does nothing for an unrecognised action', async () => {
    const si = build();
    const press = staffButton(`${SETTINGS_BUTTON_PREFIX}something-else`);

    await si.handleSettingsButton(press);

    expect(press.showModal).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });
});

describe('SettingsInteractions — prefix modal handler', () => {
  it('is not reachable for an unrelated modal customId', async () => {
    build();
    const modal = mkModal('some-other-modal', '?');

    const handled = await tryHandleModal(modal);

    expect(handled).toBe(false);
    expect(prefixService.setPrefix).not.toHaveBeenCalled();
  });

  it('refuses a non-staff submitter without touching the prefix', async () => {
    build();
    const modal = mkModal(PREFIX_MODAL_ID, '?', { inGuild: vi.fn(() => false) });

    const handled = await tryHandleModal(modal);

    expect(handled).toBe(true);
    expect(prefixService.setPrefix).not.toHaveBeenCalled();
    const payload = modal.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('You need the `Manage Server` permission to change bot settings.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('refuses a whitespace-only prefix', async () => {
    build();
    const modal = mkModal(PREFIX_MODAL_ID, '   ', { memberPermissions: MANAGE_GUILD_PERMS });

    const handled = await tryHandleModal(modal);

    expect(handled).toBe(true);
    expect(prefixService.setPrefix).not.toHaveBeenCalled();
    const payload = modal.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Prefix cannot be empty.');
  });

  it('saves a trimmed prefix and confirms it', async () => {
    build();
    const modal = mkModal(PREFIX_MODAL_ID, '  !  ', { memberPermissions: MANAGE_GUILD_PERMS });

    const handled = await tryHandleModal(modal);

    expect(handled).toBe(true);
    expect(prefixService.setPrefix).toHaveBeenCalledWith('g1', '!');
    const payload = modal.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('Command prefix set to `!`');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('truncates the prefix to 10 characters', async () => {
    build();
    const modal = mkModal(PREFIX_MODAL_ID, 'abcdefghijklmnop', { memberPermissions: MANAGE_GUILD_PERMS });

    await tryHandleModal(modal);

    expect(prefixService.setPrefix).toHaveBeenCalledWith('g1', 'abcdefghij');
  });

  it('reads the value from the "prefix" text input', async () => {
    build();
    const modal = mkModal(PREFIX_MODAL_ID, '?', { memberPermissions: MANAGE_GUILD_PERMS });

    await tryHandleModal(modal);

    expect(modal.fields.getTextInputValue).toHaveBeenCalledWith('prefix');
  });
});

describe('buildSettingsPage', () => {
  /**
   * `buildSettingsPage` resolves `UserRepository` and `FmSettingService` through
   * a dynamic `await import('tsyringe')` + `container.resolve(...)` INSIDE the
   * function body, not through the constructor. There are therefore two
   * distinct behaviours worth pinning:
   *
   *  - no registration  -> `container.resolve` throws, the `catch` swallows it,
   *    and the FM line falls back to the 'Embed Mini' default;
   *  - registered mock   -> the real name from `FmEmbedTypeNames` is rendered.
   *
   * Both are asserted, because the fallback is the path production takes for
   * any guild whose user has no stored FM setting - it is behaviour, not a stub.
   */
  it('renders the prefix from PrefixService and the default FM name when DI lookup fails', async () => {
    const ctx = mkContext();
    const ps = { getPrefix: vi.fn(async () => '~') };

    const response = await buildSettingsPage(ctx, ps as never);

    expect(ps.getPrefix).toHaveBeenCalledWith('g1');
    const texts = textContents(response);
    expect(texts.some((t) => t.includes('`~`') && t.includes('`~fm`'))).toBe(true);
    expect(texts.some((t) => t.includes(FmEmbedTypeNames[FmEmbedType.EmbedMini]))).toBe(true);
  });

  it('renders the registered FM embed name when the container resolves', async () => {
    const userRepo = { getUserByDiscordUserId: vi.fn(async () => ({ userId: 7 })) };
    const fmSettingService = { get: vi.fn(async () => ({ embedType: FmEmbedType.TextOneLine })) };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) => {
      if (token === UserRepository) return userRepo;
      if (token === FmSettingService) return fmSettingService;
      return {} as never;
    }) as never);

    const response = await buildSettingsPage(mkContext(), { getPrefix: vi.fn(async () => '!') } as never);

    expect(userRepo.getUserByDiscordUserId).toHaveBeenCalledWith('caller1');
    expect(fmSettingService.get).toHaveBeenCalledWith(7);
    const texts = textContents(response);
    expect(texts.some((t) => t.includes(FmEmbedTypeNames[FmEmbedType.TextOneLine]))).toBe(true);
  });

  it('keeps the default FM name when the user has no stored setting', async () => {
    const userRepo = { getUserByDiscordUserId: vi.fn(async () => null) };
    const fmSettingService = { get: vi.fn(async () => null) };
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) => {
      if (token === UserRepository) return userRepo;
      if (token === FmSettingService) return fmSettingService;
      return {} as never;
    }) as never);

    const response = await buildSettingsPage(mkContext(), { getPrefix: vi.fn(async () => '!') } as never);

    expect(fmSettingService.get).not.toHaveBeenCalled();
    const texts = textContents(response);
    expect(texts.some((t) => t.includes(FmEmbedTypeNames[FmEmbedType.EmbedMini]))).toBe(true);
  });

  it('emits the three settings buttons with the documented custom ids', async () => {
    const response = await buildSettingsPage(mkContext(), { getPrefix: vi.fn(async () => '!') } as never);

    const accessories = accessoriesOf(response);
    expect(accessories.map((a) => a.custom_id)).toEqual([
      `${SETTINGS_BUTTON_PREFIX}prefix`,
      `${SETTINGS_BUTTON_PREFIX}fmmode`,
      `${SETTINGS_BUTTON_PREFIX}serverfm`,
    ]);
    expect(accessories.map((a) => a.label)).toEqual(['Edit prefix', 'FM Mode', 'Server FM']);
  });

  it('enables the privileged buttons for a guild admin', async () => {
    const ctx = mkContext();
    ctx.componentInteraction = mkButton('x', { memberPermissions: MANAGE_GUILD_PERMS }) as never;

    const response = await buildSettingsPage(ctx, { getPrefix: vi.fn(async () => '!') } as never);

    const accessories = accessoriesOf(response);
    expect(accessories.find((a) => a.custom_id === `${SETTINGS_BUTTON_PREFIX}prefix`)!.disabled).toBe(false);
    expect(accessories.find((a) => a.custom_id === `${SETTINGS_BUTTON_PREFIX}serverfm`)!.disabled).toBe(false);
  });

  it('disables the privileged buttons for a non-admin', async () => {
    const ctx = mkContext();
    ctx.componentInteraction = mkButton('x', { memberPermissions: NO_PERMS }) as never;

    const response = await buildSettingsPage(ctx, { getPrefix: vi.fn(async () => '!') } as never);

    const accessories = accessoriesOf(response);
    expect(accessories.find((a) => a.custom_id === `${SETTINGS_BUTTON_PREFIX}prefix`)!.disabled).toBe(true);
    expect(accessories.find((a) => a.custom_id === `${SETTINGS_BUTTON_PREFIX}serverfm`)!.disabled).toBe(true);
    // The FM Mode button is never passed to setDisabled at all, so the key is
    // absent from the payload rather than present-and-false. Asserting `false`
    // here would be a test of discord.js' builder, not of this module.
    expect(accessories.find((a) => a.custom_id === `${SETTINGS_BUTTON_PREFIX}fmmode`)!.disabled).toBeUndefined();
  });

  it('returns a ComponentsV2 response', async () => {
    const response = await buildSettingsPage(mkContext(), { getPrefix: vi.fn(async () => '!') } as never);

    expect(response.isComponentsV2).toBe(true);
    expect(response.componentsV2Container).toBeDefined();
  });

  it('propagates a PrefixService failure rather than defaulting the prefix', async () => {
    // Only the FM-name lookup is wrapped in a try/catch. The prefix read sits
    // outside it, so this pins the asymmetry instead of implying resilience.
    // A broken prefix is a real fault; silently rendering `!` would hide it.
    const ps = {
      getPrefix: vi.fn(async () => {
        throw new Error('db down');
      }),
    };

    await expect(buildSettingsPage(mkContext(), ps as never)).rejects.toThrow('db down');
  });
});
