/**
 * `.botscrobbling` / `.bottrack` / `.featured` / `.featuredlog` / `.rateyourmusic`
 * / `.youtube` / `.shortcuts` — the user-hub half of the command surface, and
 * the only place a *personal* claim is rendered from a source that can fail.
 *
 * Two shapes of wrong answer live here, and they are different from each other.
 *
 * **1. An unreadable source rendered as a personal fact.** `.featured` with no
 * featured user and `.featuredlog` with an empty log both render a confident
 * "nobody right now" — which is TRUE, and also what a broken read produces. So
 * the tests here go the other way: they pin that a *thrown* read is not
 * swallowed into the empty card, and separately that a genuine empty renders
 * the empty card. Asserting only the empty case would pass on a
 * `.catch(() => null)` implementation.
 *
 * `.rateyourmusic` and `.youtube` have the subtler version of the same thing,
 * and it is the one worth reading twice. With no argument they substitute the
 * caller's most recent scrobble as the query. `getUserRecentTracks(...).catch(
 * () => [])` means a Last.fm OUTAGE becomes "no recent tracks", which for
 * `.youtube` would otherwise be a search for an empty string — and an empty
 * search returns something unrelated with total confidence. The code escapes
 * that only because the empty array leaves `query` empty and the WrongInput
 * branch fires. Both halves are pinned: an outage must produce the ask-for-input
 * card and must NOT produce a link, and a user who genuinely has no scrobbles
 * must produce that same card rather than a search for a blank.
 *
 * **2. The shortcut grammar.** `shortcut add <name> <command>` re-joins
 * everything from the third token, so `.shortcut add mytop top artists 1m` has
 * to keep the inner spaces. A parser that took only `args[2]` would store
 * `top` and render a shortcut that silently discards two tokens — a working
 * feature that does the wrong thing. And `shortcut remove` must distinguish
 * "no such shortcut" from "removed one", because `removeShortcut` returns a
 * boolean and a blanket success message would be a lie.
 *
 * Constructor arity, read from `userHubCommands.ts`:
 * (userService, botScrobblingService, featuredService, shortcutService,
 *  prefixService, lastFmRepository, colorService?) — SEVEN, and the seventh is
 * optional, so tests are built both with and without it. Nothing here uses
 * `vi.spyOn`, `container`, or a shared client.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';

import { UserHubCommands } from '@bot/textCommands/user/userHubCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import type { UserService } from '@bot/services/user/userService';
import type { BotScrobblingService, PlayingVoiceTrack } from '@bot/services/music/botScrobblingService';
import type { FeaturedService, FeaturedEntry } from '@bot/services/library/featuredService';
import type { ShortcutService } from '@bot/services/user/shortcutService';
import type { PrefixService } from '@bot/services/user/prefixService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { ColorService } from '@bot/services/system/colorService';

/** Everything the user reads, from whichever of the two shapes was chosen. */
const textOf = (response: ResponseModel): string => {
  const container = response.componentsV2Container?.toJSON() as
    | { components: Array<{ content?: string }> }
    | undefined;
  const fromContainer = container
    ? container.components.map((c) => c.content ?? '').join('\n')
    : '';
  return [fromContainer, response.embed.data.description ?? '', response.content ?? ''].join('\n');
};

/**
 * The link a card offers, which is the half the user actually clicks.
 *
 * These commands put the URL on a Link button, NOT in any text component, so a
 * test that only reads text would never see the destination. That is precisely
 * why "must not render a link for a blank query" needs the button: a card whose
 * prose says "please specify" while its button searches for `searchterm=` is
 * the exact failure this file is about.
 */
const linksOf = (response: ResponseModel): string[] => {
  const container = response.componentsV2Container?.toJSON() as
    | { components?: Array<{ url?: string; components?: Array<{ url?: string }> }> }
    | undefined;
  const urls: string[] = [];
  for (const component of container?.components ?? []) {
    if (typeof component.url === 'string') urls.push(component.url);
    for (const nested of component.components ?? []) {
      if (typeof nested.url === 'string') urls.push(nested.url);
    }
  }
  return urls;
};

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 7,
    discordUserId: 'caller1',
    userNameLastFm: 'DreadRock',
    sessionKey: 'sk',
    registeredOn: new Date('2026-01-01T00:00:00Z'),
    totalPlayCount: 400,
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: { id: '900000000000000001', name: 'Test Guild', members: { cache: new Map() } },
    prefix: '.',
    discordDisplayName: 'Dread',
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

const track = (over: Partial<RecentTrack> = {}): RecentTrack => ({
  name: 'Paranoid Android',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  nowPlaying: false,
  ...over,
});

const voiceTrack: PlayingVoiceTrack = {
  guildId: '900000000000000001',
  voiceChannelId: '900000000000000002',
  title: 'Paranoid Android',
  artist: 'Radiohead',
  durationMs: 380000,
  startedAt: Date.now() - 4000,
};

const featuredEntry = (over: Partial<FeaturedEntry> = {}): FeaturedEntry => ({
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  playcount: 412,
  featuredAt: new Date('2026-09-30T12:00:00Z'),
  ...over,
});

type Over = {
  caller?: User | null;
  recents?: RecentTrack[] | null;
  recentsThrow?: unknown;
  featured?: FeaturedEntry | null;
  featuredThrow?: unknown;
  log?: FeaturedEntry[];
  optedIn?: boolean;
  nowPlaying?: PlayingVoiceTrack | undefined;
  withColorService?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? caller() : over.caller)),
  } as unknown as UserService;

  let optedIn = over.optedIn === true;
  const toggleUserOptIn = vi.fn((_discordUserId: string, enable?: boolean) => {
    optedIn = enable === undefined ? !optedIn : enable;
    return optedIn;
  });
  const botScrobblingService = {
    toggleUserOptIn,
    isUserOptedIn: vi.fn(() => optedIn),
    getNowPlaying: vi.fn(() => over.nowPlaying),
  } as unknown as BotScrobblingService;

  const featuredService = {
    getFeatured: vi.fn(async () => {
      if (over.featuredThrow) throw over.featuredThrow;
      return over.featured === undefined ? featuredEntry() : over.featured;
    }),
    getFeaturedLog: vi.fn(() => over.log ?? []),
  } as unknown as FeaturedService;

  const setShortcut = vi.fn();
  const removeShortcut = vi.fn(() => false);
  const getShortcuts = vi.fn(() => [] as Array<{ name: string; command: string }>);
  const shortcutService = { setShortcut, removeShortcut, getShortcuts } as unknown as ShortcutService;

  const getPrefix = vi.fn(async () => '!');
  const prefixService = { getPrefix } as unknown as PrefixService;

  const getUserRecentTracks = vi.fn(async (..._args: unknown[]) => {
    if (over.recentsThrow) throw over.recentsThrow;
    return over.recents === undefined ? [track()] : over.recents;
  });
  const lastFmRepository = { getUserRecentTracks } as unknown as ILastfmRepository;

  const getAccentColorAsync = vi.fn(async () => 0x445566);
  const colorService = { getAccentColorAsync } as unknown as ColorService;

  const cmd = new UserHubCommands(
    userService,
    botScrobblingService,
    featuredService,
    shortcutService,
    prefixService,
    lastFmRepository,
    over.withColorService === false ? undefined : colorService,
  );

  return {
    cmd,
    userService,
    toggleUserOptIn,
    botScrobblingService,
    featuredService,
    setShortcut,
    removeShortcut,
    getShortcuts,
    getPrefix,
    getUserRecentTracks,
    getAccentColorAsync,
  };
};

const run = (cmd: UserHubCommands, name: string, args: string[] = [], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

describe('UserHubCommands.botscrobbling — an unreadable opt-in store is not "opted out"', () => {
  it.each(['enable', 'on', 'true', 'ENABLE', 'True'])('turns scrobbling ON for `%s`', async (arg) => {
    const built = build();
    const response = await run(built.cmd, 'botscrobbling', [arg]);

    expect(built.toggleUserOptIn).toHaveBeenCalledWith('caller1', true);
    expect(textOf(response)).toContain('Enabled');
  });

  it.each(['disable', 'off', 'false', 'OFF'])('turns scrobbling OFF for `%s`', async (arg) => {
    const built = build({ optedIn: true });
    const response = await run(built.cmd, 'botscrobbling', [arg]);

    expect(built.toggleUserOptIn).toHaveBeenCalledWith('caller1', false);
    expect(textOf(response)).toContain('Disabled');
  });

  it('changes nothing when the argument is not a known verb', async () => {
    // The card is a status card as well as a toggle, so `.botscrobbling please`
    // must report the state and not flip it. A parser that treated any argument
    // as "enable" would silently opt a user in.
    const built = build();
    await run(built.cmd, 'botscrobbling', ['please']);

    expect(built.toggleUserOptIn).not.toHaveBeenCalled();
    expect(textOf(await run(built.cmd, 'botscrobbling'))).toContain('Disabled');
  });

  it('reports the state it actually holds, not the one it was asked for', async () => {
    // The toggle write and the rendered status are two reads. If the card
    // rendered the ARGUMENT instead of `isUserOptedIn`, a failed or
    // out-of-order write would produce a card contradicting the store.
    const built = build();
    built.toggleUserOptIn.mockImplementationOnce(() => false);

    const response = await run(built.cmd, 'botscrobbling', ['enable']);

    expect(textOf(response)).toContain('Disabled');
  });

  it('tells an unconnected caller to connect, with the server\'s real prefix', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'botscrobbling', ['enable']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    // `!register`, not `.register`: the prefix is read from the server, and a hardcoded
    // one sends the user to a command that does not exist here.
    expect(textOf(response)).toContain('`!register`');
    // And no write happened on an account that does not exist.
    expect(built.toggleUserOptIn).not.toHaveBeenCalled();
  });

  it('omits the now-playing line in a DM rather than reaching for a guild', async () => {
    const built = build();
    const response = await run(
      built.cmd,
      'botscrobbling',
      [],
      ctx({ guildId: undefined, guild: null }),
    );

    expect(built.botScrobblingService.getNowPlaying).not.toHaveBeenCalled();
    expect(textOf(response)).not.toContain('Currently Playing in Voice');
  });

  it('renders the voice track when the guild has one', async () => {
    const built = build({ nowPlaying: voiceTrack });
    const response = await run(built.cmd, 'botscrobbling', []);

    expect(textOf(response)).toContain('Paranoid Android');
    expect(textOf(response)).toContain('Radiohead');
  });
});

describe('UserHubCommands.bottrack — the voice card, both ways round', () => {
  it('says plainly that nothing is playing', async () => {
    const built = build();
    const response = await run(built.cmd, 'bottrack', []);

    expect(textOf(response)).toContain('No music is currently playing');
  });

  it('reports the elapsed time rather than the whole duration', async () => {
    // The card's `elapsed / total` is derived from `startedAt`, and reading the
    // wrong end of it produces a progress bar that has run backwards.
    const built = build({ nowPlaying: { ...voiceTrack, durationMs: 380000, startedAt: Date.now() - 190000 } });
    const text = textOf(await run(built.cmd, 'bottrack', []));

    expect(text).toMatch(/\`1?\d\ds \/ 380s\`/);
    expect(text).not.toContain('380s / 380s');
  });

  it('does not reach for a voice channel in a DM', async () => {
    // `context.guildId ? … : undefined` — the guard is on the GUILD, not on the
    // service. Reading a guild-scoped track in a DM would be a lookup with no
    // guild to look in.
    const built = build({ nowPlaying: voiceTrack });
    const response = await run(
      built.cmd,
      'bottrack',
      [],
      ctx({ guildId: undefined, guild: null }),
    );

    expect(built.botScrobblingService.getNowPlaying).not.toHaveBeenCalled();
    expect(textOf(response)).toContain('No music is currently playing');
  });

  it('needs no account at all, because nothing on it is personal', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'bottrack', []);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(built.userService.getUserByDiscordId).not.toHaveBeenCalled();
  });

  it('works with no colour service injected', async () => {
    // The seventh constructor argument is optional, and the handlers guard on it
    // with a ternary. A handler that dereferenced it unconditionally would throw
    // rather than fall back to the default accent.
    const built = build({ withColorService: false });
    const response = await run(built.cmd, 'bottrack', []);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('No music is currently playing');
  });
});

describe('UserHubCommands.featured — nobody featured is a real answer, an unreadable store is not', () => {
  it('renders the featured listener by their registered name and weekly playcount', async () => {
    const built = build();
    const response = await run(built.cmd, 'featured', []);

    expect(textOf(response)).toContain('DreadRock');
    expect(textOf(response)).toContain('412');
    // The footer names the history command with the server's real prefix.
    expect(textOf(response)).toContain('`!featuredlog`');
  });

  it('says so plainly when nobody is featured', async () => {
    // The genuine empty, and the half a blanket "always report a failure" test
    // would break.
    const built = build({ featured: null });
    const response = await run(built.cmd, 'featured', []);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('No featured user is currently available');
  });

  it('propagates a featured store that cannot be read, instead of claiming nobody is featured', async () => {
    // THE CLAIM. "No featured user is currently available. Please try again
    // soon!" is exactly what a database outage produces if the read is caught,
    // and it reads as a fact about the community. The card has no second shape
    // to offer, so the rejection is the signal.
    const built = build({ featuredThrow: new Error('P1001: Cannot reach database server') });

    await expect(run(built.cmd, 'featured', [])).rejects.toThrow(/Cannot reach database server/);
  });

  it('renders a track item as a track, not as an album', async () => {
    const built = build({ featured: featuredEntry({ albumName: undefined, trackName: 'Weird Fishes' }) });
    const text = textOf(await run(built.cmd, 'featured', []));

    expect(text).toContain('Track: **Weird Fishes**');
    expect(text).not.toContain('Album:');
  });
});

describe('UserHubCommands.featuredlog — the history card and its empty state', () => {
  it('counts the entries it was handed, not a stored total', async () => {
    const built = build({
      log: [
        featuredEntry({ userNameLastFm: 'alpha', featuredAt: new Date('2026-09-30T10:00:00Z') }),
        featuredEntry({ userNameLastFm: 'beta', featuredAt: new Date('2026-09-30T11:00:00Z') }),
      ],
    });

    const text = textOf(await run(built.cmd, 'featuredlog', []));

    expect(text).toContain('(2 entries)');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  it('says the log is empty for a genuine empty, and does not throw on it', async () => {
    const built = build({ log: [] });
    const response = await run(built.cmd, 'featuredlog', []);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('(0 entries)');
    expect(textOf(response)).toContain('No featured users logged yet today');
  });

  it('prefers an album name when the entry has one', async () => {
    const built = build({ log: [featuredEntry({ albumName: 'Kid A' })] });
    expect(textOf(await run(built.cmd, 'featuredlog', []))).toContain('Kid A');
  });

  it('never reads an account, so it works for an unconnected caller', async () => {
    const built = build({ caller: null });
    await run(built.cmd, 'featuredlog', []);

    expect(built.userService.getUserByDiscordId).not.toHaveBeenCalled();
  });
});

describe('UserHubCommands.rateyourmusic — a failed scrobble read is not an empty search', () => {
  it('asks the user for a query rather than searching for a blank', async () => {
    const built = build({ recentsThrow: LFM_DOWN() });
    const response = await run(built.cmd, 'rateyourmusic', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('Please specify an artist, album, or track');
    // The half that matters: no link at all. `searchterm=&searchtype=` would
    // search for the empty string and come back with something unrelated,
    // confidently.
    expect(linksOf(response)).toEqual([]);
    expect(textOf(response)).not.toContain('rateyourmusic.com');
  });

  it('produces the same ask when the caller genuinely has no scrobbles', async () => {
    // The other direction, and the reason the two must be asserted together: an
    // outage and an empty account are indistinguishable here BY DESIGN, because
    // neither is evidence of a search the user asked for.
    const built = build({ recents: [] });
    const response = await run(built.cmd, 'rateyourmusic', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('Please specify an artist, album, or track');
  });

  it('substitutes the caller\'s most recent scrobble when there is no argument', async () => {
    const built = build();
    const response = await run(built.cmd, 'rateyourmusic', []);

    expect(textOf(response)).toContain('Radiohead Paranoid Android');
    expect(linksOf(response)).toEqual([
      'https://rateyourmusic.com/search?searchterm=Radiohead%20Paranoid%20Android&searchtype=',
    ]);
  });

  it('asks for a query when the caller is not connected at all', async () => {
    // No account means no scrobble to fall back on. It must NOT reach Last.fm
    // asking about an empty username.
    const built = build({ caller: null });
    const response = await run(built.cmd, 'rateyourmusic', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('uses the typed argument verbatim and reads nothing from Last.fm', async () => {
    // A provider lookup the user did not ask for can only degrade the answer.
    const built = build({ recentsThrow: LFM_DOWN() });
    const response = await run(built.cmd, 'rateyourmusic', ['Burial', 'Untrue']);

    expect(textOf(response)).toContain('Burial Untrue');
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('degrades a partial scrobble to the artist rather than searching for a dangling space', async () => {
    const built = build({ recents: [track({ name: '', artistName: 'Boards of Canada' })] });
    const response = await run(built.cmd, 'rateyourmusic', []);

    // A trailing space in a search term returns something unrelated, so the
    // query is built from the fields that exist.
    expect(textOf(response)).toContain('Boards of Canada');
    expect(textOf(response)).not.toContain('Boards%20Canada%20');
  });
});

describe('UserHubCommands.youtube — the same substitution, on a provider that answers anything', () => {
  it('asks for a song when the scrobble read failed', async () => {
    const built = build({ recentsThrow: LFM_DOWN() });
    const response = await run(built.cmd, 'youtube', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('Please specify a song title or artist');
    // YouTube answers an empty search with the home page. The link must not
    // exist at all.
    expect(linksOf(response)).toEqual([]);
    expect(textOf(response)).not.toContain('youtube.com/results');
  });

    it('searches for the caller\'s most recent track when there is no argument', async () => {
      const built = build();

      expect(linksOf(await run(built.cmd, 'youtube', []))).toEqual([
      'https://www.youtube.com/results?search_query=Radiohead%20Paranoid%20Android',
    ]);
  });

  it('uses the typed argument and reads nothing from Last.fm', async () => {
    const built = build();
    const response = await run(built.cmd, 'youtube', ['aphex twin', 'xtal']);

    expect(linksOf(response)).toEqual([
      'https://www.youtube.com/results?search_query=aphex%20twin%20xtal',
    ]);
    expect(built.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('asks for a song when the caller is not connected', async () => {
    const built = build({ caller: null });
    expect((await run(built.cmd, 'youtube', [])).commandResponse).toBe(CommandResponse.WrongInput);
  });
});

describe('UserHubCommands.shortcuts — the add grammar keeps the whole target command', () => {
  it('stores every token after the name, spaces included', async () => {
    const built = build();
    const response = await run(built.cmd, 'shortcuts', ['add', 'mytop', 'top', 'artists', '1m']);

    // `.slice(2).join(' ')` is load-bearing. Storing only `args[2]` would produce
    // a shortcut that runs `top` — a working feature doing the wrong thing.
    expect(built.setShortcut).toHaveBeenCalledWith('caller1', 'mytop', 'top artists 1m');
    expect(textOf(response)).toContain('`!mytop` ➔ `!top artists 1m`');
  });

  it('accepts `set` as a spelling of `add`, and lowercases the name', async () => {
    const built = build();
    await run(built.cmd, 'shortcuts', ['SET', 'MyTop', 'fm', '@user']);

    expect(built.setShortcut).toHaveBeenCalledWith('caller1', 'mytop', 'fm @user');
  });

  it('explains itself instead of storing an empty shortcut when the target is missing', async () => {
    const built = build();
    const response = await run(built.cmd, 'shortcuts', ['add', 'mytop']);

    expect(built.setShortcut).not.toHaveBeenCalled();
    expect(textOf(response)).toContain('`!shortcut add <name> <command>`');
  });

  it('explains itself instead of storing a nameless shortcut', async () => {
    const built = build();
    await run(built.cmd, 'shortcuts', ['add']);

    expect(built.setShortcut).not.toHaveBeenCalled();
  });

  it.each(['remove', 'del', 'delete'])('removes via `%s`, and says which one', async (verb) => {
    const built = build();
    built.removeShortcut.mockReturnValue(true);
    const response = await run(built.cmd, 'shortcuts', [verb, 'MyTop']);

    expect(built.removeShortcut).toHaveBeenCalledWith('caller1', 'mytop');
    expect(textOf(response)).toContain('Successfully deleted shortcut `!mytop`');
  });

  it('does not claim a deletion that did not happen', async () => {
    // `removeShortcut` returns a boolean precisely because "not on your list" and
    // "removed" are different answers, and a blanket success message here would
    // tell a user their shortcut is gone when it is still there.
    const built = build();
    built.removeShortcut.mockReturnValue(false);
    const response = await run(built.cmd, 'shortcuts', ['remove', 'ghost']);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('No shortcut found with name `ghost`');
    expect(textOf(response)).not.toContain('Successfully deleted');
  });

  it('explains itself when `remove` is given no name', async () => {
    const built = build();
    const response = await run(built.cmd, 'shortcuts', ['remove']);

    expect(built.removeShortcut).not.toHaveBeenCalled();
    expect(textOf(response)).toContain('`!shortcut remove <name>`');
  });

  it('lists the stored shortcuts, naming the reader', async () => {
    const built = build();
    built.getShortcuts.mockReturnValue([{ name: 'mytop', command: 'top artists 1m' }]);
    const response = await run(built.cmd, 'shortcuts', []);

    expect(textOf(response)).toContain('Custom Shortcuts for **Dread**');
    expect(textOf(response)).toContain('`!mytop` ➔ `!top artists 1m`');
  });

  it('teaches the syntax to a user with no shortcuts yet', async () => {
    const built = build();
    const response = await run(built.cmd, 'shortcuts', []);

    expect(textOf(response)).toContain("don't have any custom command shortcuts");
    expect(textOf(response)).toContain('`!shortcut add mytop top artists 1m`');
  });

  it('lists shortcuts with no colour service injected', async () => {
    // The same optional seventh argument, on the one path that also uses the
    // guild prefix — so a handler that read both eagerly would be covered here
    // and not on the simpler ones.
    const built = build({ withColorService: false });
    const response = await run(built.cmd, 'shortcuts', ['add', 'mytop', 'fm']);

    expect(textOf(response)).toContain('`!mytop` ➔ `!fm`');
  });

  it.each([
    ['botscrobbling', [], 'Status:'],
    ['bottrack', [], 'No music is currently playing'],
    ['featured', [], 'DreadRock'],
    ['featuredlog', [], 'entries'],
    ['shortcuts', [], 'shortcuts'],
  ] as const)('.%s renders with no colour service injected', async (name, args, expected) => {
    // Every handler carries the same
    // `this.colorService ? await … : undefined` ternary, and every one of them
    // would throw on an absent service without it. Asserted across all five so
    // a copy that lost the guard is caught on its own card.
    const built = build({ withColorService: false });
    const response = await run(built.cmd, name, [...args]);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain(expected);
    expect(built.getAccentColorAsync).not.toHaveBeenCalled();
  });

  it('searches with no colour service injected, on both search commands', async () => {
    const built = build({ withColorService: false });

    expect((await run(built.cmd, 'rateyourmusic', ['burial'])).commandResponse).toBe(CommandResponse.Ok);
    expect((await run(built.cmd, 'youtube', ['burial'])).commandResponse).toBe(CommandResponse.Ok);
    expect(built.getAccentColorAsync).not.toHaveBeenCalled();
  });

  it('asks for the guild prefix even on the paths that never use it', async () => {
    // `getPrefix` is read once at the top of every branch, so every rendered
    // sentence above carries the server's real prefix. If it were read only on
    // the list path, the add/remove replies would silently hardcode one.
    const built = build();
    await run(built.cmd, 'shortcuts', ['add', 'mytop', 'fm']);
    expect(built.getPrefix).toHaveBeenCalledWith('900000000000000001');
  });

  it('does not treat an unknown subcommand as a name to look up', async () => {
    const built = build();
    await run(built.cmd, 'shortcuts', ['mytop']);

    expect(built.removeShortcut).not.toHaveBeenCalled();
    expect(built.setShortcut).not.toHaveBeenCalled();
    expect(built.getShortcuts).toHaveBeenCalled();
  });
});

describe('UserHubCommands — the registry surface', () => {
  it('exposes the seven hub commands with the aliases that have always pointed here', () => {
    const built = build();
    const byName = new Map(built.cmd.commands.map((c) => [c.name, c.aliases ?? []]));

    expect([...byName.keys()]).toEqual([
      'botscrobbling',
      'bottrack',
      'featured',
      'featuredlog',
      'rateyourmusic',
      'youtube',
      'shortcuts',
    ]);
    // `yt`/`y` on youtube and `sc` on shortcuts: moving one of these would change
    // the rendered answer for a user who typed nothing new.
    expect(byName.get('youtube')).toEqual(['yt', 'y', 'youtubesearch', 'ytsearch', 'yts']);
    expect(byName.get('shortcuts')).toEqual(['shortcut', 'sc', 'scs']);
    expect(byName.get('rateyourmusic')).toEqual(['rym']);
  });
});

/** The real transport failure, built the way `lastfmApi` builds it. */
const LFM_DOWN = () =>
  new LastFmUnavailableError('user.getrecenttracks', new Error('Last.fm returned HTTP 503'));