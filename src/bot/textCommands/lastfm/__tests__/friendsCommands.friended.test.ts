/**
 * `.friended` — "who added me" — and the name each row is rendered under.
 *
 * The command renders `f.friendUser?.userNameLastFm ?? f.lastFmUserName`,
 * which is only a correct answer if the repository puts the OTHER PARTY in
 * `friendUser` for this direction. It does: `friendsRepository.getFriended`
 * filters on `friendUserId`, so on every row the caller is the ADDED and the
 * counterpart is the ADDER — fetched there as `Friend.user`. See
 * `friendsRepository.includeMismatch.test.ts` for why `include: { friendUser:
 * true }` would have been the wrong repair.
 *
 * The fallback is worth stating too, because on this path `lastFmUserName` is
 * the name the ADDER typed for the ADDED — i.e. the caller's own name, or a
 * stale spelling of it. So the fallback is not a safe answer, and a repository
 * that silently stops populating the counterpart turns this command into a list
 * of the reader's own name. This file pins the caller's half of that contract:
 * counterpart wins, and the absence of one is visible as the row's own string.
 *
 * Plain objects, constructed positionally, no `vi.spyOn` on the object under
 * test or on `container` — see `friendsCommands.lastFmUnavailable.test.ts` for
 * why a `mockRestore` on a live shared client poisons every later test.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { FriendsCommands } from '@bot/textCommands/lastfm/friendsCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { Friend } from '@persistence/models/user';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/user/userService';
import type { FriendsService } from '@bot/services/social/friendsService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

const CALLER = { userId: 2, userNameLastFm: 'DreadRock', discordUserId: 'caller1' };

const makeContext = (): ContextModel =>
  ({ discordUserId: 'caller1', prefix: '.', accentColor: 0xba0009 }) as unknown as ContextModel;

/**
 * Constructor arity, read from `friendsCommands.ts`: (userService,
 * friendsService, lastfmRepository).
 */
const build = (friended: Friend[]) => {
  const friendsService = {
    getFriended: vi.fn(async () => friended),
  } as unknown as FriendsService;
  const userService = {
    getUserByDiscordId: vi.fn(async () => CALLER),
  } as unknown as UserService;
  const lastfmRepository = {} as unknown as ILastfmRepository;
  const cmd = new FriendsCommands(userService, friendsService, lastfmRepository);
  return { cmd, friendsService };
};

/** `friendedAsync` is private; the registry entry is the public door to it. */
const friendedOf = (cmd: FriendsCommands) =>
  cmd.commands.find((c) => c.name === 'friended')!;

const textOf = (response: ResponseModel): string =>
  [response.embed.data.description ?? '', response.content ?? ''].join('\n');

/**
 * One row as `getFriended` returns it. `friendUserId` is the caller (`2`), so
 * `userId` is the adder and `lastFmUserName` is the name the adder typed FOR
 * THE CALLER. `counterpartName` and `typedName` differ deliberately: with them
 * equal, the assertion below could not tell which branch produced the output.
 *
 * `created` is a parameter because the relative timestamp is the row's only
 * statement about WHEN, and the tests below pin both directions of it: a real
 * date renders, a missing or unparseable one is omitted rather than invented.
 */
const adderRow = (
  friendId: number,
  counterpartName: string,
  typedName: string,
  counterpart: boolean,
  created: Date | undefined = new Date('2026-02-02T00:00:00Z'),
): Friend =>
  ({
    friendId,
    userId: 99,
    lastFmUserName: typedName,
    friendUserId: 2,
    lastFmFriend: false,
    friendType: 1,
    ...(created === undefined ? {} : { created }),
    friendUser: counterpart
      ? { userId: 99, userNameLastFm: counterpartName, discordUserId: 'adder1' }
      : undefined,
  }) as unknown as Friend;

describe('FriendsCommands.friended: whose name each row shows', () => {
  it('names the ADDER by their registered name, not the name typed on the row', async () => {
    const { cmd } = build([
      adderRow(10, 'adderregistered', 'addertyped', true),
      adderRow(11, 'otheradder', 'othertyped', true),
    ]);

    const response = await friendedOf(cmd).executeAsync(makeContext(), []);
    const text = textOf(response);

    expect(text).toContain('adderregistered');
    expect(text).not.toContain('addertyped');
    expect(text).toContain('otheradder');
    expect(text).not.toContain('othertyped');
    // The count is the number of rows, not the number of distinct names — the
    // same person added twice is two lines.
    expect(text).toContain('2 users have added you as a friend');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('falls back to the name on the row when there is no counterpart to read', async () => {
    const { cmd } = build([adderRow(10, 'unused', 'typedonly', false)]);

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    expect(text).toContain('typedonly');
  });

  it('does not claim the reader added themselves when nobody has', async () => {
    // The genuine empty. A failure that produced [] instead would render this
    // sentence to a user whose friends list is merely unreachable.
    const { cmd } = build([]);

    const response = await friendedOf(cmd).executeAsync(makeContext(), []);

    expect(textOf(response)).toContain('Nobody has added you');
  });

  it('OMITS the timestamp entirely for a row with no created date', async () => {
    // THE FIX. This test used to pass only because a timestamp WAS rendered for
    // every row: `f.created ?? new Date()` makes the missing value the last
    // second the row could have been written, so the card said a friendship was
    // added "in a moment" for a moment nobody recorded. Omitting the clause is
    // the same approach `updateBuilders:38-44` takes for an unparseable
    // last-scrobble date — the row still says who added you, and says nothing
    // about when.
    //
    // `created` genuinely absent, not `undefined` via a spread: the point is the
    // missing-key arm, so the key must not be there at all.
    const { cmd } = build([
      (() => {
        const row = adderRow(10, 'adderregistered', 'typedonly', true) as unknown as Record<string, unknown>;
        delete row.created;
        return row;
      })() as unknown as Friend,
    ]);

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    // No relative timestamp of any kind, and certainly not one about the future.
    expect(text).not.toContain('<t:');
    expect(text).not.toContain('NaN');
    // And the row is still there — omitting the clause is not omitting the
    // friendship, and a card that quietly dropped it would be its own lie. The
    // row line is asserted in full, because "no `<t:`" is also what a dropped
    // row looks like.
    expect(text).toContain('- **adderregistered**');
    expect(text).toMatch(/1 user[^\n]*added you as a friend/);
  });

  it('still renders the real timestamp for a row that HAS one', async () => {
    // The other half of the pair, and what stops the fix becoming a shredder. A
    // guard with no positive direction is a `catch { return null }` waiting to
    // happen, and the relative timestamp is the only thing on the row that tells
    // a user how long ago somebody added them.
    const created = new Date('2026-02-02T00:00:00Z');
    const { cmd } = build([adderRow(10, 'adderregistered', 'typedonly', true, created)]);

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    expect(text).toContain(`<t:${Math.floor(created.getTime() / 1000)}:R>`);
  });

  it('omits the clause for an UNPARSEABLE created date rather than printing NaN', async () => {
    // `toDate` accepts a string, and a repository that hands one back is a
    // different claim from a row with no value at all. `NaN` in a `<t:…:R>` is
    // the failure this replaces, so it is pinned rather than assumed.
    const { cmd } = build([
      adderRow(10, 'adderregistered', 'typedonly', true, 'not-a-date' as unknown as Date),
    ]);

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    expect(text).not.toContain('<t:');
    expect(text).not.toContain('NaN');
    expect(text).toContain('adderregistered');
  });

  it('mixes dated and undated rows without losing either', async () => {
    // The shape a real repository produces: one friend row written by an old
    // migration and one by today's. A fix that keyed off the FIRST row would
    // render a fabricated time for the rest.
    const created = new Date('2026-02-02T00:00:00Z');
    const { cmd } = build([
      (() => {
        const row = adderRow(10, 'firstadder', 'typedonly', true) as unknown as Record<string, unknown>;
        delete row.created;
        return row;
      })() as unknown as Friend,
      adderRow(11, 'secondadder', 'typedonly', true, created),
    ]);

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    expect(text).toContain('- **firstadder**');
    expect(text).toContain(`- **secondadder** (<t:${Math.floor(created.getTime() / 1000)}:R>)`);
    expect(text.match(/<t:/g)).toHaveLength(1);
  });

  it('asks the repository for the caller, not for someone else', async () => {
    // `getFriended` is filtered on `friendUserId`, so passing the wrong id
    // returns the wrong people while looking perfectly correct in the embed.
    const { cmd, friendsService } = build([]);

    await friendedOf(cmd).executeAsync(makeContext(), []);

    expect(friendsService.getFriended).toHaveBeenCalledWith(CALLER.userId);
  });

  it('refuses an unregistered caller instead of listing an empty social graph', async () => {
    const friendsService = {
      getFriended: vi.fn(async () => []),
    } as unknown as FriendsService;
    const userService = {
      getUserByDiscordId: vi.fn(async () => null),
    } as unknown as UserService;
    const cmd = new FriendsCommands(
      userService,
      friendsService,
      {} as unknown as ILastfmRepository,
    );

    const text = textOf(await friendedOf(cmd).executeAsync(makeContext(), []));

    expect(text).toContain('Last.fm username');
    expect(friendsService.getFriended).not.toHaveBeenCalled();
  });
});
