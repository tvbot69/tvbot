/**
 * `.friendsfm` / `.removefriends` / `.removeallfriends` / `.managefriends`
 * — the friend commands that are NOT `.addfriends` and NOT `.friended`.
 *
 * Those two have their own files: `friendsCommands.lastFmUnavailable.test.ts`
 * owns the per-argument lookup-failure taxonomy, and
 * `friendsCommands.friended.test.ts` owns whose name each row shows on
 * `.friended`. Nothing here repeats either.
 *
 * **`.friendsfm` is the interesting one, and it is a claim about OTHER people.**
 * Every row is somebody's listening activity, fetched with a per-friend
 * `getUserRecentTracks` inside a `Promise.all`. A friend's read that FAILS
 * produces an item with `error: 'Could not retrieve tracks'`, and a friend's
 * read that returns `[]` produces an item with no track at all — which the
 * builder renders as "*No recent scrobbles*". Those two sentences are very
 * different claims about a real person, and the branch that separates them is
 * four lines. So both directions are asserted, on the rendered row:
 *
 *   - read throws -> the row says the read failed, and does NOT say
 *     "No recent scrobbles" (which would tell the reader this person has
 *     listened to nothing, having asked nobody)
 *   - read returns [] -> the row says "No recent scrobbles", and does NOT carry
 *     the error string (which would tell them we could not check, having checked)
 *
 * **The sort is a published order**, so it is pinned as behaviour: now-playing
 * first, then most recent scrobble, then display name. And the accent colour
 * read is asserted with the ARGUMENTS IN ORDER, because
 * `getTrackCoverUrl(trackName, artistName)` was once called swapped — the lookup
 * searched for a track named after the artist by an artist named after the track,
 * never matched, and every card fell back to the red.
 *
 * **The visibility filter is a privacy control.** `friendType >=
 * VisibleInNowPlaying` decides whose listening is broadcast. A friend the caller
 * marked private must not appear, and the "Total friends" count on the card must
 * still be the WHOLE list, or hiding someone silently changes a number the user
 * can see. A private-only list renders the empty state, which is the honest
 * answer: nobody visible is playing, not "nobody is playing".
 *
 * Constructor arity: (userService, friendsService, lastfmRepository) — THREE,
 * all required. No `vi.spyOn` anywhere; `ArtworkService` and `ColorService` are
 * reached through `container.resolve`, so they are REGISTERED as instances and
 * cleared in `afterEach` rather than spied on.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { container } from 'tsyringe';

import { FriendsCommands } from './friendsCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { FriendType } from '@domain/enums/friendType';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { ArtworkService } from '@bot/services/artworkService';
import { ColorService } from '@bot/services/colorService';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { Friend } from '@persistence/domain/models/user';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { UserService } from '@bot/services/userService';
import type { FriendsService } from '@bot/services/friendsService';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';

const textOf = (response: ResponseModel): string => {
  const containerJson = response.componentsV2Container?.toJSON() as
    | { components: Array<{ content?: string }> }
    | undefined;
  const fromContainer = containerJson
    ? containerJson.components.map((c) => c.content ?? '').join('\n')
    : '';
  return [fromContainer, response.embed.data.description ?? '', response.content ?? ''].join('\n');
};

const CALLER = { userId: 7, userNameLastFm: 'DreadRock', discordUserId: 'caller1' } as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: { id: '900000000000000001', name: 'Test Guild', members: { cache: new Map() } },
    prefix: '!',
    member: { displayName: 'Dread' },
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

const track = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Paranoid Android',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  timePlayed: new Date('2026-09-30T10:00:00Z'),
  ...over,
});

/**
 * One friend row. `friendType` is the privacy control; `friendUser` is set so
 * the row has a registered counterpart (and therefore a session key), which is
 * the realistic shape.
 */
const friend = (
  friendId: number,
  name: string,
  over: Partial<Friend> = {},
): Friend =>
  ({
    friendId,
    userId: 100 + friendId,
    lastFmUserName: name,
    friendUserId: 7,
    lastFmFriend: false,
    friendType: FriendType.VisibleInNowPlaying,
    created: new Date('2026-01-01T00:00:00Z'),
    // `sessionKey: sk-<name>` on purpose: the friendsfm path passes
    // `friend.friendUser?.sessionKey` to Last.fm, and a single shared key would
    // make every row look identical to a test that does not check the argument.
    friendUser: {
      userId: 100 + friendId,
      userNameLastFm: name,
      discordUserId: `discord-${name}`,
      sessionKey: `sk-${name}`,
    },
    ...over,
  }) as unknown as Friend;

type Over = {
  caller?: User | null;
  /**
   * Discord-id lookups by argument. Defaults to "the caller, for any id", which
   * is the SHAPE of the real double that makes the mention tests wrong if it is
   * not narrowed: `removeFriendsAsync` treats a 17-20 digit argument as a
   * mention and substitutes whatever `getUserByDiscordId` returns, so a double
   * that answers for every id makes every mention resolve to the caller.
   */
  byDiscordId?: Record<string, User | null>;
  friends?: Friend[];
  recents?: (name: string, sessionKey?: string) => Promise<RecentTrack[]>;
  getUserInfo?: (name: string) => Promise<unknown>;
  coverUrl?: string | null;
  coverThrows?: unknown;
  colorThrows?: unknown;
};

const build = (over: Over = {}) => {
  // Mutable so a test can register or un-register a mention target after the
  // double is built, which is the only way to reach the `/^\d{17,20}$/` branch
  // on the add path: the branch needs a snowflake-shaped ARGUMENT.
  const userServiceById: Record<string, User | null> = {};

  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (id in userServiceById) return userServiceById[id]!;
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return over.caller === undefined ? CALLER : over.caller;
    }),
  } as unknown as UserService;

  const friendsService = {
    getFriendsByUserId: vi.fn(async () => over.friends ?? []),
    removeFriendByLfm: vi.fn(async () => true),
    removeAllFriends: vi.fn(async () => 3),
    addFriend: vi.fn(async () => 42),
  } as unknown as FriendsService;

  const getUserRecentTracks = vi.fn(
    async (name: string, _count?: number, _page?: number, _from?: number, sessionKey?: string) =>
      over.recents ? over.recents(name, sessionKey) : [track()],
  );
  const getUserInfo = vi.fn(async (name: string) =>
    over.getUserInfo ? over.getUserInfo(name) : { name, playCount: 1 },
  );
  const lastfmRepository = { getUserRecentTracks, getUserInfo } as unknown as ILastfmRepository;

  // Registered, never spied on: `vi.spyOn(container, 'resolve')` plus
  // `mockRestore` leaves an own property set to `undefined` on a live shared
  // client and every later test in the file dies silently.
  const getTrackCoverUrl = vi.fn(async (..._args: unknown[]) => {
    if (over.coverThrows) throw over.coverThrows;
    return over.coverUrl === undefined ? 'https://cdn.example.test/cover.jpg' : over.coverUrl;
  });
  // Real prototypes with one method replaced, so each token accepts its own
  // instance without a cast — `as never` here would let the test assert against
  // a shape the production type does not have.
  container.registerInstance(
    ArtworkService,
    Object.assign(Object.create(ArtworkService.prototype) as ArtworkService, { getTrackCoverUrl }),
  );
  const getColorFromImageUrl = vi.fn(async (..._args: unknown[]) => {
    if (over.colorThrows) throw over.colorThrows;
    return 0x445566;
  });
  container.registerInstance(
    ColorService,
    Object.assign(Object.create(ColorService.prototype) as ColorService, { getColorFromImageUrl }),
  );

  const cmd = new FriendsCommands(userService, friendsService, lastfmRepository);

  return {
    cmd,
    getUserRecentTracks,
    getUserInfo,
    getTrackCoverUrl,
    getColorFromImageUrl,
    userServiceById,
    friendsService: friendsService as unknown as {
      getFriendsByUserId: ReturnType<typeof vi.fn>;
      removeFriendByLfm: ReturnType<typeof vi.fn>;
      removeAllFriends: ReturnType<typeof vi.fn>;
      addFriend: ReturnType<typeof vi.fn>;
    },
  };
};

const run = (cmd: FriendsCommands, name: string, args: string[] = [], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

afterEach(() => {
  container.clearInstances();
});

describe('friendsfm — one row per visible friend, and what each row claims', () => {
  it('says the read FAILED for a friend whose Last.fm read threw', async () => {
    const built = build({
      friends: [friend(1, 'alice')],
      recents: async () => {
        throw new LastFmUnavailableError('user.getrecenttracks', new Error('Last.fm 503'));
      },
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('Could not retrieve tracks');
    // The other sentence is a claim about a real person having listened to
    // nothing, and we did not ask.
    expect(text).not.toContain('No recent scrobbles');
  });

  it('says NO RECENT SCROBBLES for a friend who genuinely has none', async () => {
    // The other half of the pair, and the reason the first test alone is not
    // enough: a blanket "always report the error" would tell a friend they are
    // unreachable when their account is simply quiet.
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [] });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('No recent scrobbles');
    expect(text).not.toContain('Could not retrieve tracks');
  });

  it('renders a friend with no counterpart under the name they were added as', async () => {
    // `friend.friendUser?.userNameLastFm ?? friend.lastFmUserName` — a friend
    // typed by name rather than linked has no counterpart row. On THIS card the
    // fallback is the name the CALLER typed, which is at least the string the
    // caller recognises; on `.friended` the same expression means something else
    // entirely and is covered in that file.
    const built = build({
      friends: [friend(1, 'alice', { friendUser: undefined })],
      recents: async () => [track()],
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('alice');
    // No counterpart means no session key, so the read runs unauthenticated —
    // which for a private friend means no scrobbles, and that is a property of
    // the LINK, not of the listener.
    expect(built.getUserRecentTracks.mock.calls[0]![4]).toBeUndefined();
  });

  it('tells the two apart within ONE card', async () => {
    // One outage, two friends, and the card has to distinguish them: the friend
    // who is quiet from the friend we could not check.
    const built = build({
      friends: [friend(1, 'alice'), friend(2, 'bob')],
      recents: async (name) => {
        if (name === 'alice') throw new LastFmUnavailableError('user.getrecenttracks', new Error('503'));
        return [];
      },
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('Could not retrieve tracks');
    expect(text).toContain('No recent scrobbles');
    // And each name sits beside its own row, not beside the other's.
    const lines = text.split('\n');
    const aliceRow = lines.find((l) => l.includes('alice'))!;
    const bobRow = lines.find((l) => l.includes('bob'))!;
    expect(aliceRow).toContain('Could not retrieve tracks');
    expect(bobRow).toContain('No recent scrobbles');
  });

  it('passes each friend\'s OWN session key, so private scrobbles resolve for them', async () => {
    // One shared key would make a private friend look like they have never
    // scrobbled, on a card that looks identical to the real answer.
    const built = build({
      friends: [friend(1, 'alice'), friend(2, 'bob')],
      recents: async () => [],
    });
    await run(built.cmd, 'friendsfm');

    const keys = built.getUserRecentTracks.mock.calls.map((c) => c[4]);
    expect(keys).toEqual(['sk-alice', 'sk-bob']);
  });

  it('renders the friend\'s guild display name when they have one', async () => {
    const context = ctx();
    (context.guild!.members.cache as unknown as Map<string, { displayName: string }>).set(
      'discord-alice',
      { displayName: 'Alice In Server' },
    );
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [] });

    expect(textOf(await run(built.cmd, 'friendsfm', [], context))).toContain('Alice In Server');
  });
});

describe('friendsfm — the published order of the rows', () => {
  const at = (iso: string) => new Date(iso);

  it('puts the now-playing friend first, whatever their timestamps', async () => {
    const built = build({
      friends: [friend(1, 'quiet'), friend(2, 'loud')],
      recents: async (name) =>
        name === 'loud'
          ? [track({ nowPlaying: true, timePlayed: at('2020-01-01T00:00:00Z') })]
          : [track({ name: 'Older', nowPlaying: false, timePlayed: at('2026-09-30T10:00:00Z') })],
    });
    const lines = textOf(await run(built.cmd, 'friendsfm')).split('\n');
    const rows = lines.filter((l) => l.includes('last.fm/user/'));

    expect(rows[0]).toContain('loud');
    expect(rows[1]).toContain('quiet');
  });

  it('then orders by recency, most recent first', async () => {
    const built = build({
      friends: [friend(1, 'older'), friend(2, 'newer')],
      recents: async (name) => [
        track({
          name: name === 'older' ? 'Song A' : 'Song B',
          nowPlaying: false,
          timePlayed: name === 'older' ? at('2026-01-01T00:00:00Z') : at('2026-09-30T10:00:00Z'),
        }),
      ],
    });
    const rows = textOf(await run(built.cmd, 'friendsfm'))
      .split('\n')
      .filter((l) => l.includes('last.fm/user/'));

    expect(rows[0]).toContain('Song B');
    expect(rows[1]).toContain('Song A');
  });

  it('sorts a track with NO timestamp against one that has a real timestamp', async () => {
    // `a.timePlayed?.getTime() ?? 0` — Last.fm omits `timePlayed` for a
    // currently-playing scrobble, and an absent date read as `NaN` would make
    // every comparison false and leave the order up to the sort's stability.
    // Zero is the correct floor: it is older than any real scrobble.
    const built = build({
      friends: [friend(1, 'undated'), friend(2, 'dated')],
      recents: async (name) =>
        name === 'undated'
          ? [track({ nowPlaying: true, timePlayed: undefined })]
          : [track({ name: 'Older Song', nowPlaying: false, timePlayed: at('2020-01-01T00:00:00Z') })],
    });
    const rows = textOf(await run(built.cmd, 'friendsfm'))
      .split('\n')
      .filter((l) => l.includes('last.fm/user/'));

    expect(rows[0]).toContain('undated');
    expect(rows[1]).toContain('dated');
    // And the undated row renders no timestamp at all, rather than
    // `(<t:NaN:R>)`.
    expect(rows[0]).not.toContain('NaN');
  });

  it('leaves two now-playing friends in tie-break order rather than reversing them', async () => {
    // The second comparator arm (`!a.nowPlaying && b.nowPlaying`) only fires
    // when the first has ALREADY been compared. Two friends both now-playing
    // must fall through to the timestamp comparison, not to `return 1` on every
    // pair — which would reverse the list.
    const built = build({
      friends: [friend(1, 'alpha'), friend(2, 'bravo'), friend(3, 'charlie')],
      recents: async (name) => [
        track({
          nowPlaying: true,
          timePlayed:
            name === 'alpha'
              ? at('2026-09-30T10:00:00Z')
              : name === 'bravo'
                ? at('2026-09-30T09:00:00Z')
                : at('2026-09-30T08:00:00Z'),
        }),
      ],
    });
    const rows = textOf(await run(built.cmd, 'friendsfm'))
      .split('\n')
      .filter((l) => l.includes('last.fm/user/'));

    expect(rows[0]).toContain('alpha');
    expect(rows[1]).toContain('bravo');
    expect(rows[2]).toContain('charlie');
  });

  it('falls back to alphabetical order when two friends played at the same moment', async () => {
    const sameInstant = at('2026-09-30T10:00:00Z');
    const built = build({
      friends: [friend(1, 'zoe'), friend(2, 'adam')],
      recents: async () => [track({ nowPlaying: false, timePlayed: sameInstant })],
    });
    const rows = textOf(await run(built.cmd, 'friendsfm'))
      .split('\n')
      .filter((l) => l.includes('last.fm/user/'));

    expect(rows[0]).toContain('adam');
    expect(rows[1]).toContain('zoe');
  });

  it('renders the scrobble timestamp as a Discord relative time, not raw text', async () => {
    // A raw ISO string would read as noise; `<t:...:R>` is what Discord renders
    // as "2 hours ago" in the reader's own timezone.
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [track()] });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toMatch(/\(<t:\d+:R>\)/);
    expect(text).not.toContain('2026-09-30T10:00:00');
  });
});

describe('friendsfm — the visibility filter is a privacy control', () => {
  it('omits a friend the caller marked private from the broadcast', async () => {
    const built = build({
      friends: [friend(1, 'alice', { friendType: FriendType.Normal }), friend(2, 'bob')],
      recents: async () => [track()],
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).not.toContain('alice');
    expect(text).toContain('bob');
    // And private friends are not even FETCHED, so their listening is not read
    // at all on a path whose whole purpose is broadcasting it.
    expect(built.getUserRecentTracks).toHaveBeenCalledTimes(1);
  });

  it('keeps the TOTAL friends count at the whole list, even when some are hidden', async () => {
    const built = build({
      friends: [
        friend(1, 'alice', { friendType: FriendType.Normal }),
        friend(2, 'bob'),
        friend(3, 'carol', { friendType: FriendType.Normal }),
      ],
      recents: async () => [track()],
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    // "Total friends: 3" with one row rendered. If the count were the VISIBLE
    // list it would read 1, and hiding someone would silently change a number
    // the user can see.
    expect(text).toContain('Total friends: 3');
  });

  it('renders the empty state when every friend is private, without claiming they are idle', async () => {
    const built = build({
      friends: [friend(1, 'alice', { friendType: FriendType.Normal })],
      recents: async () => [track()],
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    // "No visible friends yet" is TRUE and is not "nobody is playing" — the
    // difference is the word visible, and it is load-bearing.
    expect(text).toContain('no visible friends yet');
    expect(text).not.toContain('Total friends');
  });

  it('renders the empty state for a caller with no friends at all', async () => {
    const built = build({ friends: [] });
    const response = await run(built.cmd, 'friendsfm');

    expect(textOf(response)).toContain('no visible friends yet');
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller on `.addfriends`, before any Last.fm lookup', async () => {
    // The lookup taxonomy in `friendsCommands.lastFmUnavailable.test.ts` is only
    // reachable for a REGISTERED caller, so this is the gate in front of it: an
    // anonymous user must not be able to make the bot probe Last.fm for names.
    const built = build({ caller: null });
    const response = await run(built.cmd, 'addfriends', ['alice']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('Last.fm username');
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller instead of listing an empty social graph', async () => {
    const built = build({ caller: null, friends: [friend(1, 'alice')] });
    const response = await run(built.cmd, 'friendsfm');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('Last.fm username');
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });
});

describe('friendsfm — the cover lookup is argument-ordered', () => {
  it('asks for the cover by TRACK then ARTIST', async () => {
    // These were swapped: the lookup searched for a track named after the artist
    // by an artist named after the track, never matched, burned five provider
    // calls, and every card fell back to the red.
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [track()] });
    await run(built.cmd, 'friendsfm');

    expect(built.getTrackCoverUrl).toHaveBeenCalledWith('Paranoid Android', 'Radiohead');
  });

  it('derives the accent from the cover it actually found', async () => {
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [track()] });
    const response = await run(built.cmd, 'friendsfm');

    expect(built.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.example.test/cover.jpg');
    // The card takes the colour onto the CONTEXT, which is where the publisher
    // reads it from — so this is the assertion that matters, not the return.
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('still renders every row when the cover lookup fails', async () => {
    // Decoration cannot make a number wrong: the accent falls back to the
    // Last.fm red and the friend rows are unaffected.
    const built = build({
      friends: [friend(1, 'alice')],
      recents: async () => [track()],
      coverThrows: new Error('artwork service is down'),
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('Paranoid Android by Radiohead');
    expect(built.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('does not ask for a cover at all when there is no track to look up', async () => {
    const built = build({ friends: [friend(1, 'alice')], recents: async () => [] });
    await run(built.cmd, 'friendsfm');

    // `items[0]?.artistName && items[0]?.trackName` is the gate. Without it the
    // lookup would be handed undefined and would search for the string
    // "undefined".
    expect(built.getTrackCoverUrl).not.toHaveBeenCalled();
  });

  it('does not ask for a colour when the cover lookup found nothing', async () => {
    const built = build({ friends: [friend(1, 'alice')], coverUrl: null });
    await run(built.cmd, 'friendsfm');

    expect(built.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('still renders the rows when the colour extraction fails', async () => {
    const built = build({
      friends: [friend(1, 'alice')],
      colorThrows: new Error('sharp failed'),
    });
    const text = textOf(await run(built.cmd, 'friendsfm'));

    expect(text).toContain('Paranoid Android by Radiohead');
  });
});

describe('removefriends — the two outcomes are different answers', () => {
  it('names each friend it removed and each one it did not', async () => {
    const built = build();
    built.friendsService.removeFriendByLfm.mockImplementation(async (_id: number, name: string) =>
      name === 'alice',
    );
    const response = await run(built.cmd, 'removefriends', ['alice', 'ghost']);
    const text = textOf(response);

    expect(text).toContain('Removed 1 friend');
    expect(text).toContain('`alice`');
    // "Not found on your friends list" is a claim about the LIST, which the
    // repository can answer. It is not the same as a Last.fm outage.
    expect(text).toContain('Not found on your friends list');
    expect(text).toContain('`ghost`');
  });

  it('resolves a mention to that user\'s Last.fm name before looking them up', async () => {
    // The same `/^\d{17,20}$/` branch as `removefriends`, on the WRITE path.
    // Without it, `.addfriend <@id>` asks Last.fm about a username made of
    // eighteen digits, Last.fm answers "no such user", and the card claims a
    // person does not exist — about someone who is sitting in the channel.
    const built = build();
    built.userServiceById['900000000000000009'] = { userId: 9, userNameLastFm: 'alice' } as User;
    const getUserInfo = built.getUserInfo;

    await run(built.cmd, 'addfriends', ['<@!900000000000000009>']);

    expect(getUserInfo).toHaveBeenCalledWith('alice');
  });

  it('uses the raw digits when the mentioned id is not registered here', async () => {
    // The degenerate half. It produces "Could not find 900000000000000009 on
    // Last.fm", which is a true statement about Last.fm and a misleading one
    // about the person — but the alternative, refusing to try, would be worse.
    const built = build();
    built.userServiceById['900000000000000009'] = null;

    await run(built.cmd, 'addfriends', ['<@!900000000000000009>']);

    expect(built.getUserInfo).toHaveBeenCalledWith('900000000000000009');
  });

  it('asks for a username rather than adding nothing', async () => {
    // `.addfriends` with no argument. The registry entry takes `args`, so this
    // path is reachable, and the reply has to name the syntax rather than
    // reporting "Added 0 friends".
    const built = build();
    const response = await run(built.cmd, 'addfriends', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('`!addfriend <username>`');
    expect(built.friendsService.getFriendsByUserId).not.toHaveBeenCalled();
  });

  it('asks for a username rather than removing nothing', async () => {
    const built = build();
    const response = await run(built.cmd, 'removefriends', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('`!removefriend <username>`');
    expect(built.friendsService.removeFriendByLfm).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'removefriends', ['alice']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(built.friendsService.removeFriendByLfm).not.toHaveBeenCalled();
  });

  it('resolves a mention to that user\'s Last.fm name, not to the digits', async () => {
    // The point of the `/^\d{17,20}$/` branch: a friend added by mention can be
    // removed by mention. Passing the raw digits through would ask the
    // repository to remove a friend whose NAME is a snowflake, which is not a
    // mistake the user could see — the card would just say "Not found".
    const built = build({
      byDiscordId: { '900000000000000009': { userId: 9, userNameLastFm: 'alice' } as User },
    });
    await run(built.cmd, 'removefriends', ['<@!900000000000000009>']);

    expect(built.friendsService.removeFriendByLfm).toHaveBeenCalledWith(7, 'alice');
  });

  it('uses the raw digits when the mentioned id is not registered', async () => {
    // The degenerate half, pinned because it is what the mention test above
    // would silently pass over: `targetUser` is falsy, so the digits survive.
    const built = build({ byDiscordId: { '900000000000000009': null } });
    await run(built.cmd, 'removefriends', ['<@!900000000000000009>']);

    expect(built.friendsService.removeFriendByLfm).toHaveBeenCalledWith(7, '900000000000000009');
  });

  it('leaves an ordinary username alone, including a short numeric one', async () => {
    // The guard is 17-20 digits. A Last.fm username can be short and numeric
    // (`1999`), and rewriting it through a Discord lookup would delete the
    // wrong friend.
    const built = build();
    await run(built.cmd, 'removefriends', ['1999']);

    expect(built.friendsService.removeFriendByLfm).toHaveBeenCalledWith(7, '1999');
  });

  it('uses the singular for ONE unreachable name in the appended notice', async () => {
    // The unreachable block is APPENDED to a card that already has sections, so
    // this test needs one healthy argument alongside the failing one — with all
    // of them unreachable the command takes the plain error embed instead
    // (covered in `friendsCommands.lastFmUnavailable.test.ts`). A plural bug in
    // the appended heading would read "1 users could not be checked" on a card
    // that is otherwise correctly worded.
    const built = build();
    built.getUserInfo.mockImplementation(async (name: string) => {
      if (name === 'alice') throw new LastFmUnavailableError('user.getinfo', new Error('Last.fm 503'));
      return { name, playCount: 1 };
    });

    const text = textOf(await run(built.cmd, 'addfriends', ['alice', 'carol']));

    expect(text).toContain('1 user could not be checked');
    expect(text).not.toContain('1 users');
  });

  it('uses the plural for TWO unreachable names', async () => {
    const built = build();
    built.getUserInfo.mockImplementation(async (name: string) => {
      if (name === 'alice' || name === 'bob') {
        throw new LastFmUnavailableError('user.getinfo', new Error('Last.fm 503'));
      }
      return { name, playCount: 1 };
    });

    expect(textOf(await run(built.cmd, 'addfriends', ['alice', 'bob', 'carol']))).toContain(
      '2 users could not be checked',
    );
  });

  it('uses the singular for exactly one removal', async () => {
    const built = build();
    built.friendsService.removeFriendByLfm.mockResolvedValue(true);
    const text = textOf(await run(built.cmd, 'removefriends', ['alice']));

    expect(text).toContain('Removed 1 friend:');
    expect(text).not.toContain('Removed 1 friends');
  });

  it('uses the plural for two', async () => {
    const built = build();
    built.friendsService.removeFriendByLfm.mockResolvedValue(true);
    expect(textOf(await run(built.cmd, 'removefriends', ['alice', 'bob']))).toContain('Removed 2 friends');
  });
});

describe('removeallfriends — the count is the number, not a boast', () => {
  it('reports exactly what the repository removed', async () => {
    const built = build();
    built.friendsService.removeAllFriends.mockResolvedValue(5);
    const text = textOf(await run(built.cmd, 'removeallfriends'));

    expect(text).toContain('Removed **5** friends');
  });

  it('uses the singular for exactly one, and does not imply success at zero', async () => {
    const built = build();
    built.friendsService.removeAllFriends.mockResolvedValue(1);
    expect(textOf(await run(built.cmd, 'removeallfriends'))).toContain('Removed **1** friend from');

    built.friendsService.removeAllFriends.mockResolvedValue(0);
    expect(textOf(await run(built.cmd, 'removeallfriends'))).toContain('Removed **0** friends');
  });

  it('refuses an unregistered caller without touching the list', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'removeallfriends');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(built.friendsService.removeAllFriends).not.toHaveBeenCalled();
  });

  it('declares no args parameter, so there is no grammar to get wrong', () => {
    // Worth stating: the registry entry is `(context) => …`, arity 1. A user
    // typing `.removeallfriends alice` removes EVERYONE, and the only thing
    // making that explicit is that the entry ignores its second argument.
    const built = build();
    expect(built.cmd.commands.find((c) => c.name === 'removeallfriends')!.executeAsync.length).toBe(1);
  });
});

describe('managefriends — the list and its page arithmetic', () => {
  it('says plainly that there are none, rather than rendering an empty page', async () => {
    const built = build({ friends: [] });
    const response = await run(built.cmd, 'managefriends');
    const text = textOf(response);

    expect(text).toContain('You have not added any friends yet');
    // A footer claiming "Total friends: 0" on top of that sentence is fine; an
    // EMPTY page body is not, because it reads as a broken card.
    expect(text).toContain('Total friends: 0');
    expect(text).toContain('Page 1/1');
  });

  it('does not offer a Next button when everything fits on one page', async () => {
    const built = build({ friends: [friend(1, 'alice'), friend(2, 'bob')] });
    const response = await run(built.cmd, 'managefriends');
    const container = response.componentsV2Container?.toJSON() as {
      components: Array<{ components?: Array<{ custom_id?: string }> }>;
    };
    const buttonIds = container.components.flatMap((row) =>
      (row.components ?? []).map((b) => b.custom_id ?? ''),
    );

    expect(textOf(response)).toContain('Page 1/1');
    expect(buttonIds.filter((id) => id.startsWith('friends:overview:'))).toHaveLength(0);
  });

  it('offers paging at nine friends and names the real total', async () => {
    // Eight per page. Nine is two pages, and a card claiming one would hide a
    // friend the user can see the rest of.
    const built = build({
      friends: Array.from({ length: 9 }, (_v, i) => friend(i + 1, `friend${i}`)),
    });
    const response = await run(built.cmd, 'managefriends');

    expect(textOf(response)).toContain('Page 1/2');
    expect(textOf(response)).toContain('Total friends: 9');
  });

  it('starts on page one always — the buttons own the paging', async () => {
    const built = build({
      friends: Array.from({ length: 20 }, (_v, i) => friend(i + 1, `friend${i}`)),
    });
    const text = textOf(await run(built.cmd, 'managefriends'));

    expect(text).toContain('Page 1/3');
    // Page one is rows 1..8, so friend9 must NOT be on it.
    expect(text).not.toContain('friend8');
  });

  it('refuses an unregistered caller rather than showing an empty roster', async () => {
    const built = build({ caller: null, friends: [friend(1, 'alice')] });
    const response = await run(built.cmd, 'managefriends');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(built.friendsService.getFriendsByUserId).not.toHaveBeenCalled();
  });

  it('does not leak a friend\'s session key into the card', async () => {
    const withKey = friend(1, 'alice', {
      friendUser: {
        userId: 101,
        userNameLastFm: 'alice',
        discordUserId: 'discord-alice',
        sessionKey: 'sk-alice',
      },
    } as Partial<Friend>);
    const built = build({ friends: [withKey] });
    const text = textOf(await run(built.cmd, 'managefriends'));

    expect(text).not.toContain('sk-alice');
  });
});

describe('FriendsCommands — the registry surface', () => {
  it('exposes the six friend commands with their established aliases', () => {
    const built = build();
    expect(built.cmd.commands.map((c) => c.name)).toEqual([
      'friendsfm',
      'addfriends',
      'removefriends',
      'removeallfriends',
      'managefriends',
      'friended',
    ]);
    // `friends` on friendsfm and `friend`/`add` on addfriends: these read like
    // they could belong to each other, and moving one changes the answer.
    expect(built.cmd.commands[0]!.aliases).toEqual(['ffm', 'friends']);
    expect(built.cmd.commands[1]!.aliases).toEqual(['addfriend', 'friend', 'add']);
    expect(built.cmd.commands[2]!.aliases).toEqual(['removefriend', 'unfriend']);
  });

  it('declares an args parameter ONLY on the four commands that take one', () => {
    const built = build();
    const arityOf = (name: string) =>
      built.cmd.commands.find((c) => c.name === name)!.executeAsync.length;

    // Every one of the no-arg commands is a fixed view over the caller's own
    // data. A grammar there would let a user "filter" a list that is not
    // filterable, and the filter would either be ignored or change the meaning
    // of the card. Arity 1 is the shape that says "no args".
    expect(arityOf('friendsfm')).toBe(1);
    expect(arityOf('removeallfriends')).toBe(1);
    expect(arityOf('managefriends')).toBe(1);
    expect(arityOf('friended')).toBe(1);
    // The two that DO parse arguments, arity 2.
    expect(arityOf('addfriends')).toBe(2);
    expect(arityOf('removefriends')).toBe(2);
  });
});
