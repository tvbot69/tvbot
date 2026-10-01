/**
 * `.addfriends a b c` - the loop that a previous commit deliberately made
 * per-argument, and the residual bug that fix left behind.
 *
 * Commit 6ed0793 caught the throw so an outage could not abort the loop AFTER
 * earlier arguments were already written to the database. That part was right
 * and is preserved here. But the catch pushed the name into `notFound`, and
 * `FriendBuilders.buildAddFriendsResultResponse` renders that list under the
 * heading "**Could not find N users on Last.fm:**". So a Last.fm outage made
 * the bot state, in a first-person voice, that real people do not exist - and
 * not add them either. Nobody had asked Last.fm anything about them; the
 * network was down. That is the exact claim `user.getinfo` was converted to
 * RAISE `LastFmUnavailableError` for, re-laundered one layer up.
 *
 * Note this is a DIFFERENT bug from the abort. Re-throwing alone would restore
 * the abort, and a blanket "per-argument stays as it is" leaves the lie. The
 * fix keeps the loop running to completion and files the failure under its own
 * heading, so both properties hold at once.
 *
 * The two halves that must be told apart, because they were identical before:
 *   - `getUserInfo` RAISES  -> Last.fm did not answer -> not "not found"
 *   - `getUserInfo` returns null -> Last.fm answered "no such user" -> notFound
 *
 * Everything is a fresh plain object per test, handed to the constructor. No
 * `vi.spyOn` on the object under test, on `FriendBuilders`, or on `container`
 * (which `friendsFmAsync` resolves through) - a `mockRestore` on a live shared
 * client leaves an own property set to `undefined` and every later test in the
 * file dies silently.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { FriendsCommands } from '@bot/textCommands/lastfm/friendsCommands';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import { CommandResponse } from '@domain/enums/commandResponse';
import { FriendType } from '@domain/enums/friendType';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/user/userService';
import type { FriendsService } from '@bot/services/social/friendsService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';

const LFM_DOWN = () =>
  new LastFmUnavailableError('user.getinfo', new Error('Last.fm returned HTTP 503'));

const CALLER = { userId: 7, userNameLastFm: 'DreadRock', discordUserId: 'caller1' };

const makeContext = (): ContextModel =>
  ({ discordUserId: 'caller1', prefix: '.', accentColor: 0xba0009 }) as unknown as ContextModel;

/**
 * Constructor arity, read from `friendsCommands.ts`: (userService, friendsService,
 * lastfmRepository). Three, in that order - a swapped stub compiles clean and
 * then fails inside the service, indistinguishable from "this user has no
 * friends".
 */
const build = (
  getUserInfo: (name: string) => Promise<unknown>,
  existing: Array<Record<string, unknown>> = [],
) => {
  const addFriend = vi.fn(async () => 42);
  const friendsService = {
    getFriendsByUserId: vi.fn(async () => existing),
    addFriend,
  } as unknown as FriendsService;
  const userService = {
    getUserByDiscordId: vi.fn(async () => CALLER),
  } as unknown as UserService;
  const lastfmRepository = { getUserInfo: vi.fn(getUserInfo) } as unknown as ILastfmRepository;
  const cmd = new FriendsCommands(userService, friendsService, lastfmRepository);
  return { cmd, addFriend, friendsService };
};

/** `addFriendsAsync` is private; the registry entry is the public door to it. */
const addFriendsOf = (cmd: FriendsCommands) =>
  cmd.commands.find((c) => c.name === 'addfriends')!;

/**
 * Everything the user would read. Two shapes are possible and both are real
 * responses this command returns: the Components V2 add-result card, and the
 * plain error embed used when every argument was unreachable (the add-result
 * builder cannot be handed three empty lists - it joins them to `''`, which
 * `TextDisplayBuilder.setContent` rejects). Reading only one of them would let
 * the other go untested.
 */
const responseText = (response: ResponseModel): string => {
  const container = response.componentsV2Container?.toJSON() as
    | { components: Array<{ content?: string }> }
    | undefined;
  const fromContainer = container
    ? container.components.map((c) => c.content ?? '').join('\n')
    : '';
  return [
    fromContainer,
    response.embed.data.description ?? '',
    response.content ?? '',
  ].join('\n');
};

describe('FriendsCommands.addfriends: an unreachable Last.fm is not "no such user"', () => {
  it('never tells the user a person could not be found on Last.fm during an outage', async () => {
    // The user-visible half, and the one the old code failed. Asserted on the
    // rendered text, not on an internal list, because the list was correct and
    // the HEADING over it was the lie.
    const { cmd, addFriend } = build(() => Promise.reject(LFM_DOWN()));
    const text = responseText(await addFriendsOf(cmd).executeAsync(makeContext(), ['alice']));
    expect(text).not.toContain('Could not find');
    expect(addFriend).not.toHaveBeenCalled();
  });

  it('names the unchecked arguments instead of dropping them', async () => {
    // The other direction. Silence is not honesty either: "nothing happened"
    // for two arguments the user typed is its own lie. The name has to appear,
    // under a heading that says unreachable rather than missing.
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['alice', 'bob']);
    const text = responseText(response);
    expect(text).toContain('Could not check 2 users on Last.fm');
    expect(text).toContain('`alice`');
    expect(text).toContain('`bob`');
    expect(text).toContain('unreachable');
    expect(response.commandResponse).toBe(CommandResponse.Error);
  });

  it('separates the two failures when one argument is missing and one is unreachable', async () => {
    // The worst version of the old behaviour, and the reason the fix cannot
    // just relabel the existing list. Under one outage, `ghost` and `alice` sat
    // in the same array and were announced together as "Could not find 2 users
    // on Last.fm" - a claim about `ghost` (who does not exist) and about
    // `alice` (who does) rendered as one confident sentence.
    const { cmd, addFriend } = build(async (name: string) => {
      if (name === 'ghost') return null;
      if (name === 'alice') throw LFM_DOWN();
      return { name, playCount: 1 };
    });
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['ghost', 'alice', 'carol']);
    const text = responseText(response);
    // Missing: exactly the one that really is missing, and only it. The two
    // sections are separate text displays, so the not-found section is
    // everything BEFORE the unreachable heading - and `alice` must not be in
    // it, because that block is the one that says "does not exist".
    expect(text).toContain('Could not find 1 user on Last.fm');
    expect(text).toContain('1 user could not be checked');
    const missingBlock = text.slice(0, text.indexOf('could not be checked'));
    expect(missingBlock).toContain('`ghost`');
    expect(missingBlock).not.toContain('`alice`');
    // Unreachable: named separately, and explicitly not called missing.
    expect(text).toContain('`alice`');
    expect(text).toContain('This is not a "no such user" answer');
    // And the healthy argument still went through - the loop keeps running.
    expect(addFriend).toHaveBeenCalledTimes(1);
    expect(addFriend).toHaveBeenCalledWith(CALLER, 'carol', null, FriendType.VisibleInNowPlaying);
  });

  it('still says "Could not find" when Last.fm ANSWERS that the user does not exist', async () => {
    // The genuine empty, and the half the fix must not disturb. `orUnavailable`
    // returns null for Last.fm's code 6, which really is "no such user".
    const { cmd, addFriend } = build(() => Promise.resolve(null));
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['ghost']);
    expect(responseText(response)).toContain('Could not find 1 user on Last.fm');
    expect(responseText(response)).toContain('`ghost`');
    expect(responseText(response)).not.toContain('unreachable');
    expect(addFriend).not.toHaveBeenCalled();
  });

  it('still says "Could not find" on a NON-source lookup failure', async () => {
    // The other half of the pair. The narrowing must not have turned an
    // ordinary driver error into the "Last.fm is down" banner.
    const { cmd } = build(() => Promise.reject(new Error('socket hang up')));
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['alice']);
    expect(responseText(response)).toContain('Could not find 1 user on Last.fm');
    expect(responseText(response)).not.toContain('unreachable');
  });

  it('adds everyone when Last.fm answers, and does not add anyone twice', async () => {
    // The ordinary path, so "always report an outage" cannot pass.
    const { cmd, addFriend } = build(
      async (name: string) => ({ name, playCount: 1 }),
      [{ lastFmUserName: 'bob', friendId: 3, friendType: FriendType.VisibleInNowPlaying }],
    );
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['alice', 'bob']);
    const text = responseText(response);
    expect(addFriend).toHaveBeenCalledTimes(1);
    expect(text).toContain('Added 1 friend');
    expect(text).toContain('Already on your friends list');
    expect(text).not.toContain('unreachable');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('still finishes the multi-add when the first argument is unreachable', async () => {
    // The property commit 6ed0793 introduced, preserved. A blanket re-throw
    // would fail this: 'alice' never written, 'carol' never attempted, and the
    // user told only that something went wrong.
    const { cmd, addFriend } = build(async (name: string) => {
      if (name === 'alice') throw LFM_DOWN();
      return { name, playCount: 1 };
    });
    const response = await addFriendsOf(cmd).executeAsync(makeContext(), ['alice', 'carol']);
    expect(addFriend).toHaveBeenCalledTimes(1);
    expect(addFriend).toHaveBeenCalledWith(CALLER, 'carol', null, FriendType.VisibleInNowPlaying);
    const text = responseText(response);
    expect(text).toContain('Added 1 friend');
    expect(text).toContain('1 user could not be checked');
    expect(text).not.toContain('Could not find');
  });
});
