import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ComponentType } from 'discord.js';
import { FriendBuilders, type FriendNowPlayingItem } from '@bot/builders/social/friendBuilders';
import { FriendType } from '@domain/enums/friendType';
import { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { Friend, User } from '@persistence/models/user';
import type { Message } from 'discord.js';
/**
 * The caller row the builders take. Only `userNameLastFm` is read, and it is the
 * header fallback when there is no cached Discord member - so an empty object
 * would render a blank header rather than exercising the fallback.
 */
const CALLER = { userNameLastFm: 'moha_lfm' } as unknown as User;

/**
 * `FriendBuilders` — the three response factories nobody was pinning, and the
 * one honest-empty gap in them.
 *
 * WHAT A CARD FOR FRIENDS HAS TO GET RIGHT
 * ----------------------------------------
 * This card is the most personal surface in the bot: it names real people and
 * their real listening. Three claims carry it, and each has an honest-empty
 * direction and a real-zero direction that are OPPOSITES and both need a test:
 *
 *  1. A friend with no readable now-playing is "No recent scrobbles". It must
 *     NOT become "0 plays" or "unknown artist", because both are claims about a
 *     person we could not read.
 *  2. The scrobble total is a SUM of what the caller read. A supplied 0 must
 *     still be summed (it is a real 0), and an absent `playCount` must leave
 *     the sum alone rather than becoming a 0 that looks measured.
 *  3. The page footer claims how many pages exist. A page index past the end,
 *     or before the first, must render the real clamped page - never "Page 5/2".
 *
 * PAGINATION IS THE PART THAT WAS FIXED ELSEWHERE AND NOT HERE
 * ----------------------------------------------------------
 * `buildManageFriendsResponse` clamps with
 * `safePage = max(0, min(pageIndex, totalPages - 1))`, the same repair
 * `overviewBuilders`, `artistBuilders` and `artistTrackBuilders` received earlier
 * this session. That clamp is pinned below from both directions, because a clamp
 * is asymmetric: it is easy to write and easy to break on one side only.
 *
 * COMPONENTS V2 TRAPS, AVOIDED ON PURPOSE
 * --------------------------------------
 * Assertions run against `toJSON()`, never against the builder object: the
 * serialised tree uses `custom_id` (not `customId`) and carries no `data`
 * wrapper. And `SectionBuilder` with no accessory THROWS on serialisation - so
 * the manage-card assertions go through `toJSON()` on purpose. A builder object
 * can hold a card that cannot be sent.
 */

/** A `Friend` row. Only the four fields the builder reads are given real values. */
const friend = (
  friendId: number,
  lastFmUserName: string,
  friendType: FriendType = FriendType.VisibleInNowPlaying,
  linked?: string,
): Friend =>
  ({
    friendId,
    friendUserId: friendId,
    lastFmUserName,
    friendType,
    friendUser: linked === undefined ? null : { userNameLastFm: linked },
  }) as unknown as Friend;

const listener = (
  user: Friend,
  displayName: string,
  over: Partial<FriendNowPlayingItem> = {},
): FriendNowPlayingItem => ({ friend: user, displayName, ...over });

/**
 * A real ContextModel with a `message` double.
 *
 * `ContextModel.member` and `.guild` are GETTERS derived from `interaction` or
 * `message`, so they cannot be assigned. `message` is a plain public field, and
 * putting an own `member` property on the double is enough for the getter to
 * find it.
 */
const ctx = (over: { accentColor?: number; prefix?: string; displayName?: string } = {}): ContextModel => {
  const context = new ContextModel();
  context.discordUserId = 'd-1';
  context.guildId = 'g-1';
  context.accentColor = over.accentColor ?? 0x00ff00;
  if (over.prefix !== undefined) context.prefix = over.prefix;
  context.message = {
    member: { displayName: over.displayName ?? 'Moha' },
    guild: { name: 'The Listening Room' },
  } as unknown as Message;
  return context;
};

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  accessory?: Cv2Component;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
}

/** The serialised tree. Serialisation itself is part of what is under test. */
const json = (response: ResponseModel): { components?: Cv2Component[] } =>
  response.componentsV2Container!.toJSON() as unknown as { components?: Cv2Component[] };

/**
 * Every text-display string in the card, joined.
 *
 * Recursive on purpose: the manage card puts each friend row inside a `Section`
 * component, so a top-level-only walk would return just the header and the
 * footer and every row assertion would pass vacuously.
 */
const body = (response: ResponseModel): string => {
  const walk = (components: Cv2Component[] | undefined): string[] =>
    (components ?? []).flatMap((c) => [
      ...(c.type === ComponentType.TextDisplay ? [c.content ?? ''] : []),
      ...walk(c.components),
    ]);
  return walk(json(response).components).join('\n');
};

const buttons = (response: ResponseModel): Cv2Component[] =>
  (json(response).components ?? [])
    .filter((c) => c.type === ComponentType.ActionRow)
    .flatMap((c) => c.components ?? []);

const byId = (response: ResponseModel): Map<string, Cv2Component | undefined> =>
  new Map(buttons(response).map((b) => [b.custom_id ?? '', b]));

/**
 * The per-row Edit buttons, which live on each Section's accessory rather than
 * in an ActionRow. `buttons()` cannot see them, so a test that asserted on
 * `byId` alone would find nothing and pass for the wrong reason.
 */
const editButtons = (response: ResponseModel): Cv2Component[] =>
  (json(response).components ?? [])
    .filter((c) => c.type === ComponentType.Section)
    .map((c) => c.accessory)
    .filter((a): a is Cv2Component => a !== undefined);

describe('buildFriendsNowPlayingResponse: a friend we could not read is not a zero', () => {
  it('says no recent scrobbles for a friend with no track, rather than inventing one', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice'), 'Alice')],
      1,
    );

    expect(body(response)).toContain('No recent scrobbles');
    expect(body(response)).not.toContain('0 plays');
  });

  it('says no recent scrobbles when only the artist is missing, not " by undefined"', () => {
    // A half-read row is the common real shape: the track title arrived and the
    // artist did not. Printing "Creep by undefined" would be worse than saying
    // nothing was readable.
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice'), 'Alice', { trackName: 'Creep' })],
      1,
    );

    expect(body(response)).toContain('No recent scrobbles');
    expect(body(response)).not.toContain('undefined');
  });

  it('names the real track when both halves are readable', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice'), 'Alice', { trackName: 'Creep', artistName: 'Radiohead' })],
      1,
    );

    expect(body(response)).toContain('Creep by Radiohead');
  });

  it('marks a live listen with the music note and no timestamp', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [
        listener(friend(1, 'alice'), 'Alice', {
          trackName: 'Creep',
          artistName: 'Radiohead',
          nowPlaying: true,
          timePlayed: new Date('2026-01-01T00:00:00Z'),
        }),
      ],
      1,
    );

    const text = body(response);
    expect(text).toContain('🎶');
    // Both at once would be contradictory: a live listen has no "3 hours ago".
    expect(text).not.toContain('<t:');
  });

  it('renders a finished listen as a relative Discord timestamp, not a wall clock', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice'), 'Alice', { trackName: 'Creep', artistName: 'Radiohead', timePlayed: at })],
      1,
    );

    expect(body(response)).toContain(`<t:${Math.floor(at.getTime() / 1000)}:R>`);
    expect(body(response)).not.toContain('🎶');
  });

  it('shows the error a friend lookup produced instead of a silent blank row', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice'), 'Alice', { error: 'Last.fm unavailable' })],
      1,
    );

    const text = body(response);
    expect(text).toContain('Last.fm unavailable');
    expect(text).not.toContain('No recent scrobbles');
  });

  it('links each row to the Last.fm username the LINKED account has, not the typed one', () => {
    // A friend row can carry a stale `lastFmUserName` and a live `friendUser`
    // whose username the user has since changed. The link has to be the live
    // one or it 404s.
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice_old', FriendType.Normal, 'alice_new'), 'Alice')],
      1,
    );

    expect(body(response)).toContain('https://last.fm/user/alice_new');
  });

  it('falls back to the typed username when the link row is missing', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [listener(friend(1, 'alice_old'), 'Alice')],
      1,
    );

    expect(body(response)).toContain('https://last.fm/user/alice_old');
  });
});

describe('buildFriendsNowPlayingResponse: the scrobble total', () => {
  const build = (items: FriendNowPlayingItem[], totalFriends = 3): ResponseModel =>
    FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      items,
      totalFriends,
    );

  it('sums only the play counts it was actually given', () => {
    const response = build([
      listener(friend(1, 'alice'), 'Alice', { trackName: 'A', artistName: 'B', playCount: 10 }),
      listener(friend(2, 'bob'), 'Bob', { trackName: 'C', artistName: 'D', playCount: 5 }),
      listener(friend(3, 'carol'), 'Carol', { trackName: 'E', artistName: 'F' }),
    ]);

    expect(body(response)).toContain('Total scrobbles: 15');
  });

  it('renders a genuine total of zero as zero, because zero was measured', () => {
    // The opposite direction, and the one a naive `|| 'unknown'` would lose. A
    // caller that read Last.fm and got nothing played is a real answer.
    const response = build([listener(friend(1, 'alice'), 'Alice', { playCount: 0 })]);
    expect(body(response)).toContain('Total scrobbles: 0');
  });

  it('formats a large total with separators, because 1,234,567 reads as a number', () => {
    const response = build([listener(friend(1, 'alice'), 'Alice', { playCount: 1234567 })]);
    expect(body(response)).toContain('Total scrobbles: 1,234,567');
  });

  it('reports the friend count the caller gave, separately from the scrobble total', () => {
    // Two different figures from two different sources. Merging them would be a
    // number about nobody.
    const response = build([listener(friend(1, 'alice'), 'Alice', { playCount: 10 })], 7);
    expect(body(response)).toContain('Total friends: 7');
  });

  it('titles the card for the caller when there is nobody else to play for', () => {
    const response = build([listener(friend(1, 'alice'), 'Alice', { playCount: 1 })]);
    expect(body(response)).toContain('### Now playing for friends of Moha');
  });

  it('falls back to the Last.fm name when there is no Discord member at all', () => {
    // A DM has no cached member, so `context.member` is null and the `??` does
    // its job. The Last.fm name is a real stored name, so the header is honest
    // rather than blank.
    //
    // NOTE the limit of that `??`: it is nullish, so an EMPTY `displayName`
    // would render as `friends of ` with nothing after it. Discord will not give
    // a member an empty nickname, so this is not reachable today, and it is
    // recorded here rather than asserted - a test for it would pin a blank
    // header as correct.
    const context = new ContextModel();
    context.discordUserId = 'd-1';
    context.accentColor = 0x00ff00;

    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      context,
      CALLER,
      [listener(friend(1, 'alice'), 'Alice', { playCount: 1 })],
      1,
    );

    expect(body(response)).toContain('friends of moha_lfm');
  });
});

describe('buildFriendsNowPlayingResponse: no friends at all', () => {
  it('offers the add-friend command with the real prefix rather than a zero list', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx({ prefix: '!' }),
      CALLER,
      [],
      0,
    );

    const text = body(response);
    expect(text).toContain('You have no visible friends yet');
    expect(text).toContain('!addfriend');
    // No totals at all: there is no listening history to total.
    expect(text).not.toContain('Total scrobbles');
    expect(text).not.toContain('Total friends');
  });

  it('keeps the manage button, so the card is still actionable', () => {
    const response = FriendBuilders.buildFriendsNowPlayingResponse(
      ctx(),
      CALLER,
      [],
      0,
    );

    expect(byId(response).get('friends:overview:0')).toBeDefined();
  });

  it('never asks a caller for a row it did not get: one empty item list is one message', () => {
    expect(() =>
      FriendBuilders.buildFriendsNowPlayingResponse(
        ctx(),
        CALLER,
        [],
        0,
      ),
    ).not.toThrow();
  });
});

describe('buildManageFriendsResponse: pagination bounds', () => {
  const nine = (): Friend[] => Array.from({ length: 9 }, (_, i) => friend(i + 1, `user_${i + 1}`));

  it('splits nine friends over two pages of eight and claims the real count', () => {
    const page0 = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 0);
    expect(body(page0)).toContain('-# Page 1/2');
    expect(body(page0)).toContain('Total friends: 9');

    const page1 = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 1);
    expect(body(page1)).toContain('-# Page 2/2');
    expect(body(page1)).toContain('Total friends: 9');
  });

  it('puts eight friends on page one and the ninth alone on page two', () => {
    const page0 = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 0);
    const page1 = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 1);

    expect(body(page0)).toContain('user_8');
    expect(body(page0)).not.toContain('user_9');
    expect(body(page1)).toContain('user_9');
    expect(body(page1)).not.toContain('user_1');
  });

  it('clamps a page index past the end to the last page, and says so', () => {
    // THE invariant. `slice(5*8, 6*8)` on a two-page list is empty, and the naive
    // rendering is "Page 6/2" over a card with no friend on it.
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 5);

    expect(body(response)).toContain('-# Page 2/2');
    expect(body(response)).toContain('user_9');
    expect(body(response)).not.toContain('Page 6');
  });

  it('clamps a page index before the first to page one, and says so', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), -3);

    expect(body(response)).toContain('-# Page 1/2');
    expect(body(response)).toContain('user_1');
    expect(body(response)).not.toContain('Page -2');
  });

  it('points the edit buttons at the clamped page, not the requested one', () => {
    // The customId carries the page index, so an unclamped one would send the
    // next edit to a page that does not exist.
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 99);
    // Page 99 clamps to page 1, which of nine friends holds exactly one row.
    const ids = editButtons(response).map((b) => b.custom_id ?? '');

    expect(ids).toEqual(['friends:manage:9:1']);
  });

  it('renders an empty list as one page of one, not zero pages', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [], 0);

    expect(body(response)).toContain('-# Page 1/1');
    expect(body(response)).toContain('Total friends: 0');
  });

  it('shows no direction buttons when there is one page, because there is nowhere to go', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [friend(1, 'solo')], 0);
    expect(buttons(response)).toHaveLength(0);
  });

  it('disables previous on the first page and next on the last, and nothing else', () => {
    // The two buttons carry the TARGET page in their customId, so the ids on
    // page 0 are `friends:overview:-1` (disabled) and `friends:overview:1` (live),
    // and on the last page `friends:overview:0` (live) and `friends:overview:2`
    // (disabled). A `-1` id is odd but unreachable: the button it names is the
    // disabled one.
    const first = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 0);
    expect(byId(first).get('friends:overview:-1')?.disabled).toBe(true);
    expect(byId(first).get('friends:overview:1')?.disabled).toBe(false);

    const last = FriendBuilders.buildManageFriendsResponse(ctx(), nine(), 1);
    expect(byId(last).get('friends:overview:2')?.disabled).toBe(true);
    expect(byId(last).get('friends:overview:0')?.disabled).toBe(false);
  });

  it('never points a live button at a page outside the list', () => {
    // A live button whose target page does not exist is a dead control the user
    // can press. Checked from both ends of the range, including clamped indices.
    for (const page of [-4, 0, 1, 42]) {
      const live = [...byId(FriendBuilders.buildManageFriendsResponse(ctx(), nine(), page)).entries()]
        .filter(([, b]) => b?.disabled !== true)
        .map(([id]) => id);
      const targets = live.map((id) => Number(id.split(':')[2]));
      for (const target of targets) {
        expect(target).toBeGreaterThanOrEqual(0);
        expect(target).toBeLessThan(2);
      }
    }
  });

  it('survives an empty list on any page index without throwing', () => {
    for (const page of [-1, 0, 1, 7]) {
      expect(() => FriendBuilders.buildManageFriendsResponse(ctx(), [], page)).not.toThrow();
    }
  });
});

describe('buildManageFriendsResponse: the rows themselves', () => {
  it('labels each friend with the type it actually has', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [
      friend(1, 'alice', FriendType.Normal),
      friend(2, 'bob', FriendType.CloseFriend),
      friend(3, 'carol', FriendType.VisibleInNowPlaying),
    ]);

    // The names carry their own emoji, so the assertion is on the label text
    // rather than the whole string - `FriendTypeNames` is the one source and a
    // duplicate here would let the two drift apart silently.
    const text = body(response);
    expect(text).toContain('Normal');
    expect(text).toContain('Close friend');
    expect(text).toContain('Visible everywhere');
  });

it('falls back to a neutral label for a type the enum does not name', () => {
    // An unrecognised stored type must not render as "undefined".
    //
    // `FriendType` is a NUMERIC enum and `friendsRepository` reads the column as
    // an int, so the realistic unrecognised value is a number the enum does not
    // declare — not a string. `FriendTypeNames[friendType] ?? '?? Normal'`
    // (friendBuilders.ts:143) is the guard being exercised, and it guards a
    // number lookup.
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [
      friend(1, 'alice', 99 as FriendType),
    ]);

    expect(body(response)).not.toContain('undefined');
  });

  it('links to the linked account username where there is one', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [
      friend(1, 'alice_old', FriendType.Normal, 'alice_new'),
    ]);
    expect(body(response)).toContain('https://last.fm/user/alice_new');
  });

  it('offers the add-friend command with the real prefix on an empty list', () => {
    const response = FriendBuilders.buildManageFriendsResponse(ctx({ prefix: '$' }), []);
    expect(body(response)).toContain('$addfriend');
  });

  it('serialises a section with an accessory, because one without cannot be sent', () => {
    // The Components V2 trap, asserted as a guard rather than a claim: a
    // `SectionBuilder` carrying only text throws on `toJSON()`, so a card built
    // from it would fail at the send. `json()` serialises, so this test would
    // fail rather than pass if the accessory were ever dropped.
    const response = FriendBuilders.buildManageFriendsResponse(ctx(), [friend(1, 'alice')]);
    const sections = (json(response).components ?? []).filter(
      (c) => c.type === ComponentType.Section,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.accessory).toBeDefined();
  });
});

describe('buildRemoveFriendsResultResponse: the two outcomes', () => {
  it('names what it removed, pluralised from the count', () => {
    const response = FriendBuilders.buildRemoveFriendsResultResponse(['alice', 'bob'], []);
    expect(body(response)).toContain('Removed 2 friends');
  });

  it('uses the singular for exactly one', () => {
    const response = FriendBuilders.buildRemoveFriendsResultResponse(['alice'], []);
    expect(body(response)).toContain('Removed 1 friend');
    expect(body(response)).not.toContain('1 friends');
  });

  it('says not-found plainly, and does not claim anything was removed', () => {
    const response = FriendBuilders.buildRemoveFriendsResultResponse([], ['ghost']);
    const text = body(response);
    expect(text).toContain('Not found on your friends list');
    expect(text).toContain('ghost');
    expect(text).not.toContain('Removed');
  });

  it('reports both outcomes together when a batch produced both', () => {
    const response = FriendBuilders.buildRemoveFriendsResultResponse(['alice'], ['ghost']);
    const text = body(response);
    expect(text).toContain('Removed 1 friend');
    expect(text).toContain('ghost');
  });

  it('keeps the manage button so the user can see the new list', () => {
    expect(byId(FriendBuilders.buildRemoveFriendsResultResponse(['alice'], [])).get('friends:overview:0')).toBeDefined();
  });

/*
   * THE EMPTY OUTCOME IS NOT A CRASH.
   *
   * `buildRemoveFriendsResultResponse` used to end with an UNGUARDED
   * `new TextDisplayBuilder().setContent(bodyLines.join('\n'))`. Handed two empty
   * lists that is `setContent('')`, and discord.js throws "Invalid string
   * length" - the exact defect `friendBuilders.emptyOutcome.test.ts` fixed on
   * `buildAddFriendsResultResponse` one screen up in this same file, and which
   * still had no matching guard here.
   *
   * It was LATENT, not live. Every production caller files each argument into
   * exactly one of the two buckets: `friendsCommands.ts:315` (every arg becomes
   * either a removed or a notFound) and `friendSlashCommands.ts:233/235` (one
   * or the other, never neither). "The caller guarantees it" is an argument, not
   * a guarantee, and it is the argument that was wrong everywhere else today.
   */
  it('does not throw when neither list has anything in it', () => {
    expect(() => FriendBuilders.buildRemoveFriendsResultResponse([], [])).not.toThrow();
  });

  it('produces no text-display body in that case, rather than an empty one', () => {
    // Asserted on the SERIALISED tree, so it fails both if the raise comes back
    // and if the card were built but unsendable.
    expect(body(FriendBuilders.buildRemoveFriendsResultResponse([], []))).toBe('');
  });

  it('still shows the manage button, because a card with no body is not a card with no way out', () => {
    // The other repair - skipping the whole response - would produce nothing at
    // all. The guard on the add builder skips ONE line and keeps the action row.
    expect(byId(FriendBuilders.buildRemoveFriendsResultResponse([], [])).get('friends:overview:0'))
      .toBeDefined();
  });

  it('is reached with at least one populated list in every real outcome', () => {
    // The counterpart to the two above: the guard must not have swallowed the
    // directions that have something to report.
    const removed = FriendBuilders.buildRemoveFriendsResultResponse(['alice'], []);
    const notFound = FriendBuilders.buildRemoveFriendsResultResponse([], ['ghost']);

    expect(body(removed)).not.toBe('');
    expect(body(notFound)).not.toBe('');
  });
});