/**
 * `FriendInteractions` is the one place in this cluster where the swallowed
 * failure was a WRITE, not a read.
 *
 * `handleSelectType` and `handleDelete` both `deferUpdate()` and then call
 * `friendsService.setFriendType` / `removeFriend`. The catch above them was
 * gated on
 *
 *     interaction.isRepliable() && !interaction.replied && !interaction.deferred
 *
 * and `deferUpdate` is precisely what sets `interaction.deferred`. So the
 * state the handler puts the interaction into in order to survive a slow
 * database is the state that suppresses the answer when the database is slow.
 * A write that threw produced no message at all: the friend card stayed on
 * screen with the old type, and the user's only signal was that the
 * interaction felt inert.
 *
 * `handleDelete` already knew the difference and made it explicitly, in a
 * comment at its own `if (!removed)` branch: "A failed delete must not look
 * like a successful one." That comment was true for a `false` return and false
 * for a throw, one branch away.
 *
 * BOTH DIRECTIONS: a handler that answers everything is not the fix either. A
 * write that SUCCEEDS must still re-render the card and say nothing, and the
 * "not repliable" silence is a real, separate case - an interaction Discord
 * will not accept cannot be answered by anybody.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { FriendInteractions } from './friendInteractions';
import { FriendBuilders } from '@bot/builders/friendBuilders';
import { FriendType } from '@domain/enums/friendType';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { Friend } from '@persistence/domain/models/user';

const CALLER_ID = 'caller1';
const OWNER_USER_ID = 1;
const AVATAR_URL = 'https://cdn.discordapp.com/avatars/1/avatar.png';

const DB_DOWN = (method: string): SourceUnavailableError =>
  new SourceUnavailableError(method, new Error('connect ECONNREFUSED'), 'Database unavailable');

const makeUser = () =>
  ({ userId: OWNER_USER_ID, userNameLastFm: 'lfmuser', discordUserId: CALLER_ID, totalPlayCount: 10 }) as never;

const makeFriend = (): Friend =>
  ({
    friendId: 7,
    userId: OWNER_USER_ID,
    lastFmUserName: 'alice',
    lastFmFriend: false,
    friendType: FriendType.Normal,
  }) as Friend;

const BUILT = { isComponentsV2: true, componentsV2Container: { id: 99 } } as never;

const GENERIC = { content: 'Something went wrong processing this interaction.', flags: MessageFlags.Ephemeral };

const user = {
  id: CALLER_ID,
  username: 'Caller',
  displayName: 'CoolCaller',
  displayAvatarURL: vi.fn(() => AVATAR_URL),
};

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user,
    isRepliable: vi.fn(() => true),
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    isRepliable: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const mkSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    values,
    user,
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
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const friendsService = {
    getFriendsByUserId: vi.fn(async () => [makeFriend()]),
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
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    getColorFromImageUrl: vi.fn(async () => 0x00ff00),
    ...(over.colorService as object),
  };
  const fi = new FriendInteractions(friendsService as never, userService as never, colorService as never);
  return { fi, friendsService, userService, colorService };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(FriendBuilders, 'buildManageFriendsResponse').mockReturnValue(BUILT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FriendInteractions — a failed WRITE is reported, not swallowed by the defer', () => {
  it('reports a failed setFriendType through followUp', async () => {
    const { fi } = build({
      friendsService: { setFriendType: vi.fn(async () => { throw DB_DOWN('friendsRepository.setFriendType'); }) },
    });
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.CloseFriend)], { deferred: true });

    await expect(fi.handleSelectMenu(press)).resolves.toBeUndefined();

    expect(press.followUp).toHaveBeenCalledWith(GENERIC);
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('reports a failed removeFriend through followUp', async () => {
    const { fi } = build({
      friendsService: { removeFriend: vi.fn(async () => { throw DB_DOWN('friendsRepository.removeFriend'); }) },
    });
    const press = mkButton('friends:delete:7:0', { deferred: true });

    await expect(fi.handleButton(press)).resolves.toBeUndefined();

    expect(press.followUp).toHaveBeenCalledWith(GENERIC);
  });

  it('reports a failed friends list read on the overview button', async () => {
    const { fi } = build({
      friendsService: { getFriendsByUserId: vi.fn(async () => { throw DB_DOWN('friendsRepository.getFriendsByUserId'); }) },
    });
    const press = mkButton('friends:overview:0', { deferred: true });

    await expect(fi.handleButton(press)).resolves.toBeUndefined();

    expect(press.followUp).toHaveBeenCalledWith(GENERIC);
  });

  it('does not re-render the friend list from a read that failed', async () => {
    const { fi } = build({
      friendsService: { getFriendsByUserId: vi.fn(async () => { throw DB_DOWN('friendsRepository.getFriendsByUserId'); }) },
    });
    const press = mkButton('friends:overview:0', { deferred: true });

    await fi.handleButton(press);

    expect(FriendBuilders.buildManageFriendsResponse).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
  });

  it('answers with a plain reply when the ack guard has not deferred yet', async () => {
    // The 2.5s ack guard in interactionHandler races this handler, so the same
    // failure can arrive with the interaction still unacknowledged. `reply` is
    // the only verb Discord accepts then.
    const { fi } = build({
      friendsService: { removeFriend: vi.fn(async () => { throw new Error('driver reset'); }) },
    });
    const press = mkButton('friends:delete:7:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith(GENERIC);
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('uses followUp when the interaction was already answered rather than deferred', async () => {
    const { fi } = build({
      friendsService: { removeFriend: vi.fn(async () => { throw new Error('driver reset'); }) },
    });
    const press = mkButton('friends:delete:7:0', { replied: true });

    await fi.handleButton(press);

    expect(press.followUp).toHaveBeenCalledWith(GENERIC);
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('says nothing at all to an interaction Discord will not accept', async () => {
    const { fi } = build({
      friendsService: { removeFriend: vi.fn(async () => { throw new Error('driver reset'); }) },
    });
    const press = mkButton('friends:delete:7:0', { deferred: true, isRepliable: vi.fn(() => false) });

    await expect(fi.handleButton(press)).resolves.toBeUndefined();

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.followUp).not.toHaveBeenCalled();
  });
});

describe('FriendInteractions — a write that WORKED still renders, and the honest false stays distinct', () => {
  it('a successful setFriendType re-renders the card and reports nothing', async () => {
    const { fi, friendsService } = build();
    const press = mkSelect('friends:selecttype:7:0', [String(FriendType.CloseFriend)], { deferred: true });

    await fi.handleSelectMenu(press);

    expect(friendsService.setFriendType).toHaveBeenCalledWith(7, FriendType.CloseFriend);
    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.followUp).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('a successful removeFriend re-renders the card and reports nothing', async () => {
    const { fi, friendsService } = build();
    const press = mkButton('friends:delete:7:0', { deferred: true });

    await fi.handleButton(press);

    expect(friendsService.removeFriend).toHaveBeenCalledWith(7);
    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('a removeFriend that returns false keeps its own, more specific message', async () => {
    // The pre-existing honest branch, pinned so the new catch cannot swallow it
    // or blur it into the generic one. "Could not remove that friend" tells the
    // user the row is still there; "something went wrong" does not.
    const { fi } = build({ friendsService: { removeFriend: vi.fn(async () => false) } });
    const press = mkButton('friends:delete:7:0', { deferred: true });

    await fi.handleButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: 'Could not remove that friend. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.followUp).not.toHaveBeenCalledWith(GENERIC);
  });

  it('an empty friend list still renders the empty card rather than an error', async () => {
    // The honest empty. `[]` is a real answer - this user has no friends - and
    // reporting it as a failure would be the exact inversion this whole change
    // is about.
    const { fi } = build({ friendsService: { getFriendsByUserId: vi.fn(async () => []) } });
    const press = mkButton('friends:overview:0');

    await fi.handleButton(press);

    expect(FriendBuilders.buildManageFriendsResponse).toHaveBeenCalledTimes(1);
    expect(press.editReply).toHaveBeenCalledTimes(1);
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('an unregistered user still gets the registration message, before any defer', async () => {
    const { fi } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    const press = mkButton('friends:overview:0');

    await fi.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'You have not registered your Last.fm username yet.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});
