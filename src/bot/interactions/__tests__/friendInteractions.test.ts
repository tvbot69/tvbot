import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { FriendInteractions, FRIEND_BUTTON_PREFIXES } from '@bot/interactions/friendInteractions';
import { FriendBuilders } from '@bot/builders/friendBuilders';
import { FriendType } from '@domain/enums/friendType';
import type { Friend } from '@persistence/models/user';

const GUILD_ID = 'g1';
const CALLER_ID = 'caller1';
const OWNER_USER_ID = 1;
const AVATAR_URL = 'https://cdn.discordapp.com/avatars/1/avatar.png';

const makeUser = (over: Record<string, unknown> = {}) =>
  ({
    userId: OWNER_USER_ID,
    userNameLastFm: 'lfmuser',
    discordUserId: CALLER_ID,
    totalPlayCount: 10,
    ...over,
  }) as never;

const makeFriend = (over: Partial<Friend> = {}): Friend =>
  ({
    friendId: 7,
    userId: OWNER_USER_ID,
    lastFmUserName: 'friend_lfm',
    lastFmFriend: false,
    friendType: FriendType.Normal,
    ...over,
  }) as Friend;

const makeFriends = (): Friend[] => [
  makeFriend({ friendId: 7, lastFmUserName: 'alice' }),
  makeFriend({ friendId: 8, lastFmUserName: 'bob', friendType: FriendType.CloseFriend }),
];

const makeContainerResponse = (commandResponse = 'Ok') =>
  ({
    commandResponse,
    isComponentsV2: true,
    componentsV2Container: { id: 99, toJSON: () => ({ type: 17, id: 99 }) },
  }) as never;

type SelectOptionJson = { label: string; value: string; description: string; default?: boolean };

type ChildComponentJson = {
  type: number;
  content?: string;
  custom_id?: string;
  label?: string;
  style?: number;
  placeholder?: string;
  options?: SelectOptionJson[];
};

type ContainerJson = {
  type: number;
  accent_color?: number;
  components: Array<
    ChildComponentJson & {
      components?: ChildComponentJson[];
    }
  >;
};

const editPayload = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls[0]![0] as {
    components: Array<{ toJSON: () => ContainerJson }>;
    flags: number;
  };

const containerOf = (mock: ReturnType<typeof vi.fn>): ContainerJson =>
  editPayload(mock).components[0]!.toJSON();

const selectRow = (json: ContainerJson) =>
  json.components.find((c) => c.type === 1 && c.components?.[0]?.type === 3);

const buttonRow = (json: ContainerJson) =>
  json.components.find((c) => c.type === 1 && c.components?.[0]?.type === 2);

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: GUILD_ID,
    user: {
      id: CALLER_ID,
      username: 'Caller',
      displayName: 'CoolCaller',
      displayAvatarURL: vi.fn(() => AVATAR_URL),
    },
    isRepliable: vi.fn(() => true),
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    isRepliable: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };

const mkSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: GUILD_ID,
    values,
    user: {
      id: CALLER_ID,
      username: 'Caller',
      displayName: 'CoolCaller',
      displayAvatarURL: vi.fn(() => AVATAR_URL),
    },
    isRepliable: vi.fn(() => true),
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as StringSelectMenuInteraction & {
    isRepliable: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const friendsService = {
    getFriendsByUserId: vi.fn(async () => makeFriends()),
    getFriend: vi.fn(async () => makeFriend()),
    setFriendType: vi.fn(async () => undefined),
    removeFriend: vi.fn(async () => true),
    ...(over.friendsService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => makeUser()),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0x00ff00),
    getColorFromImageUrl: vi.fn(async () => 0x00ff00),
    ...(over.colorService as object),
  };
  const fi = new FriendInteractions(friendsService as never, userService as never, colorService as never);
  return { fi, friendsService, userService, colorService };
};

const spyBuilder = (over: Record<string, unknown> = {}) =>
  vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue(
    makeContainerResponse(over.commandResponse as never),
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FriendInteractions.handleButton — customId routing', () => {
  it('routes friends:overview to the overview handler', async () => {
    const { fi, friendsService } = build();
    const spy = spyBuilder();
    const press = mkButton('friends:overview:0');

    await fi.handleButton(press);

    expect(friendsService.getFriendsByUserId).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('routes friends:manage: to the manage handler', async () => {
    const { fi, friendsService } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(friendsService.getFriend).toHaveBeenCalledWith(7);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('routes friends:delete: to the delete handler', async () => {
    const { fi, friendsService } = build();
    const spy = spyBuilder();
    const press = mkButton('friends:delete:7:0');

    await fi.handleButton(press);

    expect(friendsService.removeFriend).toHaveBeenCalledWith(7);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('ignores friends:settype on a button — only the select menu handles it', async () => {
    const { fi, friendsService, userService } = build();
    spyBuilder();
    const press = mkButton('friends:settype:7:0');

    await fi.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(friendsService.setFriendType).not.toHaveBeenCalled();
    expect(friendsService.getFriendsByUserId).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('ignores friends:selecttype on a button', async () => {
    const { fi, friendsService } = build();
    spyBuilder();
    const press = mkButton('friends:selecttype:7:0');

    await fi.handleButton(press);

    expect(friendsService.setFriendType).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('does nothing for a completely unrelated customId', async () => {
    const { fi, userService } = build();
    spyBuilder();
    const press = mkButton('chart-edit:creator1:a:3x3');

    await fi.handleButton(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('exports the four documented button prefixes', () => {
    expect(FRIEND_BUTTON_PREFIXES).toEqual([
      'friends:overview',
      'friends:manage',
      'friends:settype',
      'friends:delete',
    ]);
  });
});

describe('FriendInteractions.handleSelectMenu — customId routing', () => {
  it('routes friends:selecttype: to the select type handler', async () => {
    const { fi, friendsService } = build();
    const spy = spyBuilder();
    const press = mkSelect('friends:selecttype:7:2', [String(FriendType.CloseFriend)]);

    await fi.handleSelectMenu(press);

    expect(friendsService.setFriendType).toHaveBeenCalledWith(7, FriendType.CloseFriend);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a button customId reaching the select handler', async () => {
    const { fi, friendsService } = build();
    spyBuilder();
    const press = mkSelect('friends:overview:0', []);

    await fi.handleSelectMenu(press);

    expect(friendsService.setFriendType).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown select customId', async () => {
    const { fi, userService } = build();
    spyBuilder();
    const press = mkSelect('guild-members', ['Crowns']);

    await fi.handleSelectMenu(press);

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });
});

describe('FriendInteractions — unregistered user paths', () => {
  const unregistered = { userService: { getUserByDiscordId: vi.fn(async () => null) } };

  it('replies ephemeral on friends:overview', async () => {
    const { fi, friendsService } = build(unregistered);
    const press = mkButton('friends:overview:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You have not registered your Last.fm username yet.',
      flags: MessageFlags.Ephemeral,
    });
    expect(friendsService.getFriendsByUserId).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral on friends:manage:', async () => {
    const { fi, friendsService } = build(unregistered);
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You have not registered your Last.fm username yet.',
      flags: MessageFlags.Ephemeral,
    });
    expect(friendsService.getFriend).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral on friends:delete:', async () => {
    const { fi, friendsService } = build(unregistered);
    const press = mkButton('friends:delete:7:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You have not registered your Last.fm username yet.',
      flags: MessageFlags.Ephemeral,
    });
    expect(friendsService.removeFriend).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral on friends:selecttype:', async () => {
    const { fi, friendsService } = build(unregistered);
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)]);

    await fi.handleSelectMenu(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You have not registered your Last.fm username yet.',
      flags: MessageFlags.Ephemeral,
    });
    expect(friendsService.setFriendType).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });
});

describe('FriendInteractions.handleManageMenu — friend ownership', () => {
  it('replies ephemeral when the friend record does not exist', async () => {
    const { fi } = build({ friendsService: { getFriend: vi.fn(async () => null) } });
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Friend record not found or you do not have permission.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('replies ephemeral when the friend belongs to a different user', async () => {
    const { fi } = build({
      friendsService: { getFriend: vi.fn(async () => makeFriend({ userId: 999 })) },
    });
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Friend record not found or you do not have permission.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('proceeds when the friend belongs to the caller', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });
});

describe('FriendInteractions.handleManageMenu — response building', () => {
  it('edits with a Components V2 container', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    const payload = editPayload(press.editReply);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
  });

  it('defers the update before building the container', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('uses the accent colour from getAccentColorAsync for the container', async () => {
    const { fi, colorService } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith(CALLER_ID);
    expect(containerOf(press.editReply).accent_color).toBe(0x00ff00);
  });

  it('prefers the linked friend user name over the raw Last.fm name', async () => {
    const { fi } = build({
      friendsService: {
        getFriend: vi.fn(async () =>
          makeFriend({ friendUser: { userNameLastFm: 'linked_name' } as never }),
        ),
      },
    });
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(containerOf(press.editReply).components[0]!.content).toContain('**linked_name**');
  });

  it('falls back to the raw Last.fm name when there is no linked user', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(containerOf(press.editReply).components[0]!.content).toContain('**friend_lfm**');
  });

  it('shows the current friend type in the header', async () => {
    const { fi } = build({
      friendsService: {
        getFriend: vi.fn(async () => makeFriend({ friendType: FriendType.CloseFriend })),
      },
    });
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    expect(containerOf(press.editReply).components[0]!.content).toContain(
      'Current type: **⭐ Close friend**',
    );
  });

  it('carries the friend id and page into the select menu custom id', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:3');

    await fi.handleButton(press);

    expect(selectRow(containerOf(press.editReply))?.components?.[0]?.custom_id).toBe(
      'friends:selecttype:7:3',
    );
  });

  it('defaults the page segment to 0', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7');

    await fi.handleButton(press);

    const json = containerOf(press.editReply);
    expect(selectRow(json)?.components?.[0]?.custom_id).toBe('friends:selecttype:7:0');
    expect(buttonRow(json)?.components?.[0]?.custom_id).toBe('friends:overview:0');
  });

  it('marks the current friend type as the default select option', async () => {
    const { fi } = build({
      friendsService: {
        getFriend: vi.fn(async () => makeFriend({ friendType: FriendType.VisibleInNowPlaying })),
      },
    });
    const press = mkButton('friends:manage:7:0');

    await fi.handleButton(press);

    const options = selectRow(containerOf(press.editReply))?.components?.[0]?.options ?? [];
    expect(options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(options.find((o) => o.default)?.value).toBe('2');
  });

  it('offers a Back button and a Remove friend button wired to the friend and page', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:2');

    await fi.handleButton(press);

    const buttons = buttonRow(containerOf(press.editReply))?.components ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.custom_id).toBe('friends:overview:2');
    expect(buttons[0]!.label).toBe('Back');
    expect(buttons[1]!.custom_id).toBe('friends:delete:7:2');
    expect(buttons[1]!.label).toBe('Remove friend');
  });

  it('continues when deferUpdate rejects', async () => {
    const { fi } = build();
    const press = mkButton('friends:manage:7:0', {
      deferUpdate: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await fi.handleButton(press);

    expect(press.editReply).toHaveBeenCalledTimes(1);
  });
});

describe('FriendInteractions — context building', () => {
  it('resolves the accent colour from the avatar image url', async () => {
    const { fi, colorService } = build();
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)]);
    const ctxSpy = spyBuilder();

    await fi.handleSelectMenu(press);

    expect(press.user.displayAvatarURL).toHaveBeenCalledWith({ size: 256 });
    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith(AVATAR_URL);
    const context = ctxSpy.mock.calls[0]![0] as {
      discordUserId: string;
      guildId: string;
      prefix: string;
      accentColor?: number;
    };
    expect(context.discordUserId).toBe(CALLER_ID);
    expect(context.guildId).toBe(GUILD_ID);
    expect(context.prefix).toBe('.');
    expect(context.accentColor).toBe(0x00ff00);
  });

  it('leaves the accent colour undefined when there is no avatar url', async () => {
    const { fi, colorService } = build();
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)], {
      user: {
        id: CALLER_ID,
        username: 'Caller',
        displayName: 'CoolCaller',
        displayAvatarURL: vi.fn(() => ''),
      },
    });
    const ctxSpy = spyBuilder();

    await fi.handleSelectMenu(press);

    expect(colorService.getColorFromImageUrl).not.toHaveBeenCalled();
    expect((ctxSpy.mock.calls[0]![0] as { accentColor?: number }).accentColor).toBeUndefined();
  });
});

describe('FriendInteractions — response building for the builder-backed branches', () => {
  it('passes the caller, the friend list and page 0 to the builder on overview', async () => {
    const { fi } = build();
    const spy = spyBuilder();
    const press = mkButton('friends:overview');

    await fi.handleButton(press);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ discordUserId: CALLER_ID }),
      expect.arrayContaining([expect.objectContaining({ friendId: 7 })]),
      0,
    );
  });

  it('passes the requested page to the builder on overview', async () => {
    const { fi } = build();
    const spy = spyBuilder();
    const press = mkButton('friends:overview:2');

    await fi.handleButton(press);

    expect(spy.mock.calls[0]![2]).toBe(2);
  });

  it('refetches the friend list after a type change and rebuilds the page', async () => {
    const { fi, friendsService } = build();
    const spy = spyBuilder();
    const press = mkSelect('friends:selecttype:7:4', [String(FriendType.CloseFriend)]);

    await fi.handleSelectMenu(press);

    expect(friendsService.setFriendType).toHaveBeenCalledWith(7, FriendType.CloseFriend);
    expect(friendsService.getFriendsByUserId).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(spy.mock.calls[0]![2]).toBe(4);
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('refetches the friend list after a delete and rebuilds the page', async () => {
    const { fi, friendsService } = build();
    const spy = spyBuilder();
    const press = mkButton('friends:delete:7:1');

    await fi.handleButton(press);

    expect(friendsService.removeFriend).toHaveBeenCalledWith(7);
    expect(friendsService.getFriendsByUserId).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(spy.mock.calls[0]![2]).toBe(1);
  });

  it('tells the user when a delete failed, instead of silently re-rendering the list', async () => {
    // The delete returning false is the ONLY signal that the row is still
    // there. Re-rendering the list alone shows the friend back with no
    // indication anything went wrong, so the failure has to be explicit.
    const { fi } = build({
      friendsService: { removeFriend: vi.fn(async () => false) },
    });
    const spy = spyBuilder();
    const press = mkButton('friends:delete:7:1');

    await fi.handleButton(press);

    expect(press.followUp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(press.followUp).mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining('Could not remove'),
    });
    // No rebuild: the list is unchanged and showing it implies success.
    expect(spy).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('propagates a selected type of NaN when the select value is not numeric', async () => {
    const { fi, friendsService } = build();
    spyBuilder();
    const press = mkSelect('friends:selecttype:7:0', ['not-a-number']);

    await fi.handleSelectMenu(press);

    expect(friendsService.setFriendType).toHaveBeenCalledWith(7, Number.NaN);
  });

  it('skips the edit when the builder returns no container', async () => {
    const { fi } = build();
    vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue({
      isComponentsV2: false,
      buildEmbed: () => ['embed'],
      buildComponents: () => ['row'],
    } as never);
    const press = mkButton('friends:overview:0');

    await fi.handleButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('skips the edit when the select-type branch returns no container', async () => {
    const { fi } = build();
    vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue({
      isComponentsV2: false,
      buildEmbed: () => ['embed'],
      buildComponents: () => ['row'],
    } as never);
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)]);

    await fi.handleSelectMenu(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('skips the edit when the delete branch returns no container', async () => {
    const { fi } = build();
    vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue({} as never);
    const press = mkButton('friends:delete:7:0');

    await fi.handleButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('still removes the friend even when the rebuilt response has no container', async () => {
    const { fi, friendsService } = build();
    vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue({} as never);
    const press = mkButton('friends:delete:7:0');

    await fi.handleButton(press);

    expect(friendsService.removeFriend).toHaveBeenCalledWith(7);
  });
});

describe('FriendInteractions.handleButton — error path', () => {
  it('replies ephemeral with a generic message when the handler throws', async () => {
    const { fi } = build({
      userService: {
        getUserByDiscordId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton('friends:overview:0');

    await expect(fi.handleButton(press)).resolves.toBeUndefined();

    expect(press.isRepliable).toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not reply when the interaction is not repliable', async () => {
    const { fi } = build({
      friendsService: {
        getFriendsByUserId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton('friends:overview:0', { isRepliable: vi.fn(() => false) });

    await fi.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
  });

  it('uses followUp when the interaction was already answered rather than deferred', async () => {
    // Same intent, corrected: `reply` is the wrong verb once the interaction
    // has been answered, but not answering it at all is worse still.
    const { fi } = build({
      friendsService: {
        getFriendsByUserId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton('friends:overview:0', { replied: true });

    await fi.handleButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('reports a post-defer failure with followUp instead of going silent', async () => {
    // REPLACED. This used to read `does not reply when the interaction was
    // already deferred` and asserted only that `reply` was not called - which is
    // satisfied by silence as well as by a followUp, so it pinned the bug
    // instead of the behaviour. The state it constructed (`deferred: true`) is
    // exactly the state `handleOverview` puts the interaction in before it
    // reads, so the old assertion was describing "a read that failed produces
    // no message at all" and calling it correct.
    const { fi } = build({
      friendsService: {
        getFriendsByUserId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton('friends:overview:0', { deferred: true });

    await fi.handleButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('swallows an error raised by the ephemeral fallback reply itself', async () => {
    const { fi } = build({
      userService: {
        getUserByDiscordId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkButton('friends:overview:0', {
      reply: vi.fn(async () => {
        throw new Error('Missing Access');
      }),
    });

    await expect(fi.handleButton(press)).resolves.toBeUndefined();
    expect(press.reply).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a second ack when a post-defer failure occurs', async () => {
    const { fi } = build();
    spyBuilder();
    const press = mkButton('friends:overview:0', {
      deferred: true,
      editReply: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(fi.handleButton(press)).resolves.toBeUndefined();

    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
  });
});

describe('FriendInteractions.handleSelectMenu — error path', () => {
  it('replies ephemeral with a generic message when the handler throws', async () => {
    const { fi } = build({
      userService: {
        getUserByDiscordId: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)]);

    await expect(fi.handleSelectMenu(press)).resolves.toBeUndefined();

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('does not reply when the select interaction is not repliable', async () => {
    const { fi } = build({
      friendsService: {
        setFriendType: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)], {
      isRepliable: vi.fn(() => false),
    });

    await fi.handleSelectMenu(press);

    expect(press.reply).not.toHaveBeenCalled();
  });

  it('reports a post-defer WRITE failure with followUp instead of going silent', async () => {
    // REPLACED, same reason as the button path above. This one is worse: the
    // failure is in `setFriendType`, a write, so the user had a selection they
    // were told nothing about and a card that still showed the old type.
    const { fi } = build({
      friendsService: {
        setFriendType: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)], {
      deferred: true,
    });

    await fi.handleSelectMenu(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong processing this interaction.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('swallows an error raised by the ephemeral fallback reply itself', async () => {
    const { fi } = build({
      friendsService: {
        setFriendType: vi.fn(async () => {
          throw new Error('db exploded');
        }),
      },
    });
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.Normal)], {
      reply: vi.fn(async () => {
        throw new Error('Missing Access');
      }),
    });

    await expect(fi.handleSelectMenu(press)).resolves.toBeUndefined();
    expect(press.reply).toHaveBeenCalledTimes(1);
  });
});
