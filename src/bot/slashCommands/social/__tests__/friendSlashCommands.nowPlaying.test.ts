/**
 * `/friends list|add|remove` - the only command here whose entire answer is
 * other people's listening, and therefore the one where a single unreadable
 * source is indistinguishable from a set of real facts about other humans.
 *
 * THE CLASS OF BUG THIS FILE IS ABOUT. The card renders one line per friend,
 * and each line is built from one Last.fm read. There are THREE different
 * states a line can be in, and only one of them is a fact about the friend:
 *
 *   1. they are playing something        - "track by artist <t:...:R>"
 *   2. they have no recent scrobbles      - "*No recent scrobbles*"
 *   3. we could not read their scrobbles  - "*Could not retrieve tracks*"
 *
 * States 2 and 3 are both "no track on this line", and only the bold label
 * separates them. So this file asserts the LABEL, not the absence of a track:
 * a Last.fm outage for one friend must produce state 3 and a genuine empty
 * must produce state 2, and a single unreadable friend must not blank the
 * other friends' lines. Without those three tests a `.catch(() => [])` in the
 * per-friend read passes the whole file.
 *
 * The partial case is the interesting one, and it is per-friend on purpose:
 * `Promise.all` over the visible friends means one raising friend does not
 * discard the rows that DID answer, which is the difference between "one
 * friend is unreadable" and "everyone is offline". The footer total and the
 * friends count must survive too, because a card that lost them would be
 * claiming the caller has no friends.
 *
 * `addFriendAsync` is a WRITE with a source check in front of it, so the pair
 * is: a username Last.fm does not have must produce the "could not find" line
 * and no row; a username it does have must produce the row. And
 * `removeFriendAsync`'s false branch must say "not found on your friends list"
 * rather than claiming a removal that did not happen.
 *
 * The container is POPULATED, never mocked: this module resolves
 * `ArtworkService` and `ColorService` itself (lines 141-142), which is a real
 * code path, and stubbing `container.resolve` would make every accent assertion
 * vacuous.
 *
 * Constructor arity read from `friendSlashCommands.ts`:
 * (userService, friendsService, lastfmRepository). Three positional arguments.
 */
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { FriendSlashCommands } from '@bot/slashCommands/social/friendSlashCommands';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ColorService } from '@bot/services/system/colorService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import { FriendType } from '@domain/enums/friendType';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { FriendsService } from '@bot/services/social/friendsService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';

const CALLER = {
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
};

/**
 * The three per-friend read outcomes, as the CARD renders them. Asserted on the
 * rendered text on purpose: `items` is an implementation detail and a handler
 * that built a correct array and a builder that printed the wrong branch would
 * pass an array-only assertion.
 */
const PLAYING = 'Airbag by Radiohead';
const NOT_PLAYING = 'No recent scrobbles';
const UNREADABLE = 'Could not retrieve tracks';

interface FriendSpec {
  friendId: number;
  lastFmUserName: string;
  friendType?: FriendType;
  /** Present means the friend is also a bot user, so a guild nick can be used. */
  friendUser?: { userNameLastFm: string; discordUserId: string; sessionKey?: string };
}

const friend = (spec: FriendSpec) => ({
  userId: 7,
  lastFmFriend: true,
  friendType: FriendType.VisibleInNowPlaying,
  ...spec,
});

const track = (over: Partial<{ name: string; artistName: string; nowPlaying: boolean; timePlayed: Date }> = {}) => ({
  name: 'Airbag',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: true,
  timePlayed: new Date('2026-03-01T10:00:00Z'),
  ...over,
});

interface CtxSpec {
  /** guild member nicknames, keyed by discord user id. */
  members?: Record<string, string>;
  strings?: Record<string, string | undefined>;
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const members = spec.members ?? {};
  return {
    discordUserId: 'caller1',
    guildId: '222',
    prefix: '.',
    member: { displayName: 'Caller' },
    guild: {
      id: '222',
      name: 'Test Guild',
      members: { cache: { get: (id: string) => (members[id] ? { displayName: members[id] } : undefined) } },
    },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guildId: '222',
      user: { id: 'caller1' },
      options: {
        getString: (name: string) => spec.strings?.[name] ?? null,
      },
    },
  } as unknown as ContextModel;
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface Doubles {
  caller?: unknown;
  friends?: unknown[];
  friendsImpl?: () => Promise<unknown[]>;
  /** Per-username Last.fm answer. A function REJECTS, which is the outage. */
  recent?: Record<string, () => Promise<unknown[]>>;
  userInfo?: unknown;
  addFriendId?: number;
  removeOk?: boolean;
  byDiscordId?: Record<string, unknown>;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id];
      return over.caller === undefined ? CALLER : over.caller;
    }),
  } as unknown as UserService;
  const friendsService = {
    getFriendsByUserId: vi.fn(
      over.friendsImpl ?? (async (..._args: unknown[]) => over.friends ?? []),
    ),
    addFriend: vi.fn(async (..._args: unknown[]) => over.addFriendId ?? 42),
    removeFriendByLfm: vi.fn(async (..._args: unknown[]) =>
      over.removeOk === undefined ? true : over.removeOk,
    ),
  } as unknown as FriendsService;
  // `getUserRecentTracks` answers PER USERNAME, because the whole point of the
  // partial-failure tests is one friend raising while another answers - a
  // single canned value cannot express that. An entry which is a function is
  // called, so a test can make it REJECT; an absent entry is a healthy read.
  const recentByUser = over.recent ?? {};
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async (...args: unknown[]) => {
      const impl = recentByUser[String(args[0])];
      if (impl) return impl();
      return [track()];
    }),
    getUserInfo: vi.fn(async (..._args: unknown[]) =>
      over.userInfo === undefined ? { name: 'Someone' } : over.userInfo,
    ),
  } as unknown as ILastfmRepository;

  const cmd = new FriendSlashCommands(userService, friendsService, lastfmRepository);
  const privates = cmd as unknown as {
    friendsFmAsync(c: ContextModel): Promise<ResponseModel>;
    addFriendAsync(c: ContextModel): Promise<ResponseModel>;
    removeFriendAsync(c: ContextModel): Promise<ResponseModel>;
  };
  return { cmd, privates, userService, friendsService, lastfmRepository };
};

/**
 * The line for one friend, so assertions can be about one row and not the card.
 * Matches on `**[Name]` because the builder renders the display name as a
 * Markdown link - `**[Broken](<https://last.fm/user/Broken>)**` - so a
 * `**Broken**` probe would find nothing and the test would pass for the wrong
 * reason on a card with no rows at all.
 */
const lineFor = (text: string, displayName: string): string =>
  text
    .split('\n')
    .find((line) => line.includes(`**[${displayName}]`)) ?? '';

describe('/friends list: one unreadable friend is not a friendless caller', () => {
  it('says a friend is playing something when Last.fm answers', async () => {
    const { privates } = build({
      friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })],
    });
    const response = await privates.friendsFmAsync(makeContext());

    expect(cardText(response)).toContain(PLAYING);
    expect(cardText(response)).not.toContain(UNREADABLE);
  });

  it('distinguishes "no recent scrobbles" from "could not read their scrobbles"', async () => {
    // THE PAIR. Same friend, same card, two unreadable-ish states that differ
    // only in which read produced them. A `.catch(() => [])` on the per-friend
    // read turns the first test's shape into the second test's line, and the user
    // is told their friend has not listened to anything when the truth is that
    // we could not ask.
    const genuineEmpty = build({
      friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })],
      recent: { Alpha: async () => [] },
    });
    const emptyText = cardText(await genuineEmpty.privates.friendsFmAsync(makeContext()));
    expect(emptyText).toContain(NOT_PLAYING);
    expect(emptyText).not.toContain(UNREADABLE);

    const outage = build({
      friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })],
      recent: {
        Alpha: () => Promise.reject(new Error('Last.fm returned HTTP 500')),
      },
    });
    const outageText = cardText(await outage.privates.friendsFmAsync(makeContext()));
    expect(outageText).toContain(UNREADABLE);
    expect(outageText).not.toContain(NOT_PLAYING);
  });

  it('keeps the other friends\' rows when one of them raises', async () => {
    // The partial case. `Promise.all` over the visible friends means one bad
    // read costs exactly one line. The user must still see the friend who did
    // answer, and the "total friends" footer must still count all of them -
    // a card that dropped the count would be claiming the caller has fewer
    // friends than they added.
    const { privates } = build({
      friends: [
        friend({ friendId: 1, lastFmUserName: 'Broken' }),
        friend({ friendId: 2, lastFmUserName: 'Working' }),
      ],
      recent: {
        Broken: () => Promise.reject(new Error('Last.fm returned HTTP 503')),
      },
    });
    const text = cardText(await privates.friendsFmAsync(makeContext()));

    expect(lineFor(text, 'Broken')).toContain(UNREADABLE);
    expect(lineFor(text, 'Working')).toContain(PLAYING);
    expect(text).toContain('Total friends: 2');
  });

  it('renders the honest empty for a caller who has added no friends at all', async () => {
    // The other end of the range: an empty list must read as an empty list, not
    // as an error, and must not claim there is something to retrieve.
    const { privates, lastfmRepository } = build({ friends: [] });
    const response = await privates.friendsFmAsync(makeContext());

    expect(cardText(response)).toContain('no visible friends yet');
    expect(cardText(response)).not.toContain(UNREADABLE);
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('renders the empty list for friends who are all hidden from now-playing', async () => {
    // `FriendType.Normal` is below the `VisibleInNowPlaying` threshold, so those
    // friends exist but are deliberately not listed here. Rendering them anyway
    // would ignore the user's own privacy choice; rendering the "no visible
    // friends" line is the honest answer.
    const { privates, lastfmRepository } = build({
      friends: [friend({ friendId: 1, lastFmUserName: 'Hidden', friendType: FriendType.Normal })],
    });
    const text = cardText(await privates.friendsFmAsync(makeContext()));

    expect(text).toContain('no visible friends yet');
    expect(text).not.toContain('Hidden');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('tells an unregistered caller to register instead of listing nothing', async () => {
    // A caller with no account has no friends LIST either, so this branch and
    // the empty-list branch must say different things: "you have no friends"
    // would be a claim about a list the bot could not read.
    const { privates, friendsService } = build({ caller: null });
    const response = await privates.friendsFmAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(friendsService.getFriendsByUserId).not.toHaveBeenCalled();
  });

  it('does not read a friend list the database could not answer', async () => {
    // The A1 direction for the LIST itself. `getFriendsByUserId` has no catch,
    // so an outage raises rather than rendering "no visible friends yet" - and
    // that is the claim the empty-list branch would otherwise make for free.
    const { privates } = build({
      friendsImpl: () => Promise.reject(new Error("Can't reach database server")),
    });
    await expect(privates.friendsFmAsync(makeContext())).rejects.toThrow(/database server/i);
  });

  it('prefers a guild nickname over the Last.fm name when the friend is a bot user', async () => {
    const { privates } = build({
      friends: [
        friend({
          friendId: 1,
          lastFmUserName: 'AlphaOnLastfm',
          friendUser: { userNameLastFm: 'AlphaOnLastfm', discordUserId: 'friend1', sessionKey: 'sk' },
        }),
      ],
    });
    const text = cardText(await privates.friendsFmAsync(makeContext({ members: { friend1: 'AlphaInGuild' } })));

    expect(lineFor(text, 'AlphaInGuild')).toContain(PLAYING);
    expect(text).toContain('https://last.fm/user/AlphaOnLastfm');
  });

  it('forwards the friend\'s own session key so a private profile still resolves', async () => {
    // `getUserRecentTracks(userName, count, page, from, sessionKey)`. Dropping
    // the key makes Last.fm answer 403 for a private library, which is a
    // DIFFERENT failure from "not listening", so it has to be pinned: the key
    // arrives from the friend row, not from the caller.
    const { privates, lastfmRepository } = build({
      friends: [
        friend({
          friendId: 1,
          lastFmUserName: 'Alpha',
          friendUser: { userNameLastFm: 'Alpha', discordUserId: 'friend1', sessionKey: 'friend-secret' },
        }),
      ],
    });
    await privates.friendsFmAsync(makeContext());

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith(
      'Alpha',
      1,
      1,
      undefined,
      'friend-secret',
    );
  });

  it('sorts now-playing above everything else, then most-recently-played first', async () => {
    // A card whose order is arbitrary reads as "here is the ranking", and
    // nobody asked for a ranking. The two orderings are separately observable.
    const { privates } = build({
      friends: [
        friend({ friendId: 1, lastFmUserName: 'Recent' }),
        friend({ friendId: 2, lastFmUserName: 'Stale' }),
        friend({ friendId: 3, lastFmUserName: 'Playing' }),
      ],
      recent: {
        Recent: async () => [track({ name: 'RecentSong', nowPlaying: false, timePlayed: new Date('2026-03-02T00:00:00Z') })],
        Stale: async () => [track({ name: 'StaleSong', nowPlaying: false, timePlayed: new Date('2026-01-01T00:00:00Z') })],
        Playing: async () => [track({ name: 'PlayingSong', nowPlaying: true })],
      },
    });
    const text = cardText(await privates.friendsFmAsync(makeContext()));
    const body = text.split('Total scrobbles')[0]!;

    expect(body.indexOf('PlayingSong')).toBeLessThan(body.indexOf('RecentSong'));
    expect(body.indexOf('RecentSong')).toBeLessThan(body.indexOf('StaleSong'));
  });
});

describe('/friends list: the accent colour is decoration and must never cost a row', () => {
  it('refines the accent from the top friend\'s cover, asking for the track BEFORE the artist', async () => {
    // `getTrackCoverUrl(trackName, artistName)`. Swapped arguments mean a
    // provider is asked for a track named after the artist by an artist named
    // after the track: five wasted lookups and the red accent forever, with no
    // error anywhere. So the ARGUMENT ORDER is asserted, not just the call.
    const { privates } = build({
      friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })],
      recent: { Alpha: async () => [track({ name: 'Karma Police', artistName: 'Radiohead' })] },
    });
    const context = makeContext();
    await privates.friendsFmAsync(context);

    const artwork = container.resolve(ArtworkService) as unknown as { getTrackCoverUrl: ReturnType<typeof vi.fn> };
    expect(artwork.getTrackCoverUrl).toHaveBeenCalledWith('Karma Police', 'Radiohead');
    expect(context.accentColor).not.toBe(DiscordConstants.LastFmColorRed);
  });

  it('keeps every row when the cover lookup raises', async () => {
    // The colour read happens AFTER the rows are built and sorted, which is the
    // whole point: a provider outage must cost an accent, not the answer.
    container.registerInstance(ArtworkService, {
      getTrackCoverUrl: vi.fn(() => Promise.reject(new Error('spotify 503'))),
    } as unknown as ArtworkService);
    const { privates } = build({ friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })] });
    const context = makeContext();
    const response = await privates.friendsFmAsync(context);

    expect(cardText(response)).toContain(PLAYING);
    expect(context.accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('keeps the brand red when the cover lookup simply finds nothing', async () => {
    // A null cover is not an error and not a colour: the accent stays red and no
    // sampled-from-nothing colour is invented.
    container.registerInstance(ArtworkService, { getTrackCoverUrl: vi.fn(async () => null) } as unknown as ArtworkService);
    const { privates } = build({ friends: [friend({ friendId: 1, lastFmUserName: 'Alpha' })] });
    const context = makeContext();
    await privates.friendsFmAsync(context);

    expect(context.accentColor).toBe(DiscordConstants.LastFmColorRed);
  });
});

describe('/friends add: a username Last.fm does not have must not become a friend row', () => {
  it('writes the row only after Last.fm confirms the account exists', async () => {
    const { privates, friendsService, lastfmRepository } = build();
    const response = await privates.addFriendAsync(
      makeContext({ strings: { username: '  SomeUser  ' } }),
    );

    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('SomeUser');
    expect(friendsService.addFriend).toHaveBeenCalledWith(
      CALLER,
      'SomeUser',
      null,
      FriendType.VisibleInNowPlaying,
    );
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Added 1 friend');
  });

  it('writes NOTHING and says which name was not found when Last.fm has no such user', async () => {
    // THE A1 TEST. `getUserInfo` returns null for a genuine Last.fm "no such
    // user" and RAISES for everything else, so a null is a real absence. A row
    // pointing at it would make every later friends query report a friend who
    // does not exist.
    const { privates, friendsService } = build({ userInfo: null });
    const response = await privates.addFriendAsync(makeContext({ strings: { username: 'NobodyHere' } }));

    expect(cardText(response)).toContain('Could not find 1 user on Last.fm');
    expect(cardText(response)).toContain('NobodyHere');
    expect(cardText(response)).not.toContain('Added');
    expect(friendsService.addFriend).not.toHaveBeenCalled();
  });

  it('reports an already-added friend without writing a second row', async () => {
    // Case-insensitively, because Last.fm usernames are: `addfriend alpha` after
    // `addfriend Alpha` must not create a parallel row that then shows up twice
    // in the now-playing card.
    const { privates, friendsService, lastfmRepository } = build({
      friends: [friend({ friendId: 5, lastFmUserName: 'Alpha', friendType: FriendType.CloseFriend })],
    });
    const response = await privates.addFriendAsync(makeContext({ strings: { username: 'ALPHA' } }));

    expect(cardText(response)).toContain('Already on your friends list');
    expect(cardText(response)).toContain('Close friend');
    expect(friendsService.addFriend).not.toHaveBeenCalled();
    // No Last.fm lookup either: an existing friend must not cost a round trip to
    // confirm a name we already have on file.
    expect(lastfmRepository.getUserInfo).not.toHaveBeenCalled();
  });

  it('strips the mention syntax, and an UNREGISTERED id stays digits rather than becoming a guess', async () => {
    // 18 digits is a snowflake, so this exercises the id-resolution branch too.
    // With no bot row for that id, the digits are what reach Last.fm - inventing
    // a Last.fm name for an unknown Discord account would be a guess, and a
    // guessed name is the kind of answer that then gets written to the friends
    // table.
    const { privates, lastfmRepository } = build({ byDiscordId: { '123456789012345678': null } });
    await privates.addFriendAsync(makeContext({ strings: { username: '<@123456789012345678>' } }));
    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('123456789012345678');
  });

  it('strips `<@!…>` mention syntax too, because Discord sends both forms', async () => {
    const { privates, lastfmRepository } = build({
      byDiscordId: { '123456789012345678': { userId: 9, userNameLastFm: 'RealName' } },
    });
    await privates.addFriendAsync(makeContext({ strings: { username: '<@!123456789012345678>' } }));
    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('RealName');
  });

  it('resolves a registered snowflake to that user\'s Last.fm name', async () => {
    // The other half: a real bot user must be added under the Last.fm name the
    // bot already knows, not under their Discord id, or their friends card
    // would be keyed on a string Last.fm has never heard of.
    const { privates, lastfmRepository } = build({
      byDiscordId: { '123456789012345678': { userId: 9, userNameLastFm: 'RealName' } },
    });
    await privates.addFriendAsync(makeContext({ strings: { username: '<@123456789012345678>' } }));
    expect(lastfmRepository.getUserInfo).toHaveBeenCalledWith('RealName');
  });

  it('refuses an empty username before any Last.fm read', async () => {
    const { privates, lastfmRepository, friendsService } = build();
    const response = await privates.addFriendAsync(makeContext({ strings: { username: '   ' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Please specify a username');
    expect(lastfmRepository.getUserInfo).not.toHaveBeenCalled();
    expect(friendsService.addFriend).not.toHaveBeenCalled();
  });

  it('tells an unregistered caller to register before reading Last.fm at all', async () => {
    const { privates, lastfmRepository } = build({ caller: null });
    const response = await privates.addFriendAsync(makeContext({ strings: { username: 'SomeUser' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getUserInfo).not.toHaveBeenCalled();
  });
});

describe('/friends remove: a removal that did not happen must not be reported as one', () => {
  it('reports the removal when the row was actually deleted', async () => {
    const { privates, friendsService } = build({ removeOk: true });
    const response = await privates.removeFriendAsync(makeContext({ strings: { username: 'Alpha' } }));

    expect(friendsService.removeFriendByLfm).toHaveBeenCalledWith(7, 'Alpha');
    expect(cardText(response)).toContain('Removed 1 friend');
  });

  it('says the name was not on the list instead of claiming a removal', async () => {
    // The false branch is a genuine absence (the repository found no matching
    // row), and it is the branch that would be a lie if it rendered the removed
    // wording. Both lines are on the same card, so the distinction is the label.
    const { privates } = build({ removeOk: false });
    const text = cardText(await privates.removeFriendAsync(makeContext({ strings: { username: 'Ghost' } })));

    expect(text).toContain('Not found on your friends list');
    expect(text).toContain('Ghost');
    expect(text).not.toContain('Removed');
  });

  it('refuses an empty username and reaches no repository at all', async () => {
    const { privates, friendsService } = build();
    const response = await privates.removeFriendAsync(makeContext({ strings: { username: '' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(friendsService.removeFriendByLfm).not.toHaveBeenCalled();
  });

  it('tells an unregistered caller to register before touching the friends table', async () => {
    const { privates, friendsService } = build({ caller: null });
    const response = await privates.removeFriendAsync(makeContext({ strings: { username: 'Alpha' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(friendsService.removeFriendByLfm).not.toHaveBeenCalled();
  });
});

/**
 * A registered, non-overridden provider for the two container-resolved
 * collaborators. `beforeEach` rather than module scope, so one test's override
 * cannot leak into the next - a shared double that a later test changes is how a
 * file passes vacuously.
 */
beforeEach(() => {
  container.registerInstance(ArtworkService, {
    getTrackCoverUrl: vi.fn(async () => 'https://img.test/cover.jpg'),
    getArtistImageUrl: vi.fn(async () => null),
    getAlbumCoverUrl: vi.fn(async () => null),
  } as unknown as ArtworkService);
  container.registerInstance(ColorService, {
    getColorFromImageUrl: vi.fn(async () => 0x00ff00),
    getAccentColorAsync: vi.fn(async () => 0x00ff00),
  } as unknown as ColorService);
});
