/**
 * `/botscrobbling`, `/featured`, `/featuredlog`, `/rateyourmusic`, `/youtube`,
 * `/shortcuts` - the six small hub commands, and the pair that makes this file
 * worth writing.
 *
 * THE PAIR IS THE SEARCH-PREFILL. `/rateyourmusic` and `/youtube` both take an
 * OPTIONAL query, and when it is absent both read the caller's last scrobble to
 * pre-fill it. That read is a convenience, not the answer, and the file says so
 * - but the convenience is also where a plausible wrong answer hides, so the
 * three outcomes are pinned separately:
 *
 *   1. the read succeeds      -> the derived "artist track" is searched for
 *   2. the read returns []    -> "Please specify ..." - TRUE, no query was given
 *   3. the read RAISES        -> "Please specify ..." as well, and nothing more
 *
 * (2) and (3) produce the same sentence, and that is correct - in both cases no
 * query was supplied and none could be derived. What must NOT happen is the
 * derived query being something OTHER than the caller's last scrobble, or an
 * error message leaking a provider's name to the user for a field they simply
 * left blank. So: the failure has to stay invisible AND stay honest, and the
 * genuine-empty path has to keep working after it.
 *
 * The other direction worth pinning is the opposite mistake: refusing to derive
 * a query at all. Without the prefill, `/youtube` with no argument would be dead
 * for most users, which is the "half-built feature that presents itself as
 * working" failure. So the derived query is asserted too.
 *
 * `/botscrobbling` is a WRITE (an opt-in toggle), so its branch structure is
 * asserted as a write: an unregistered caller changes nothing, and a caller who
 * typed no action changes nothing while still being told their current state.
 *
 * Constructor arity read from `userHubSlashCommands.ts`:
 * (userService, botScrobblingService, featuredService, shortcutService,
 *  prefixService, lastFmRepository, colorService?). Seven, all `@inject`ed. All
 * seven are supplied positionally, so `colorService` is present and the optional
 * branch is not the one under test.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UserHubSlashCommands } from '@bot/slashCommands/user/userHubSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { PrefixService } from '@bot/services/user/prefixService';
import type { ShortcutService } from '@bot/services/user/shortcutService';
import type { FeaturedService } from '@bot/services/library/featuredService';
import type { ColorService } from '@bot/services/system/colorService';
import type { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';

const CALLER = {
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  sessionKey: 'sk',
};

const FEATURED = {
  discordUserId: 'other1',
  userNameLastFm: 'SomeUser',
  artistName: 'Radiohead',
  albumName: 'OK Computer',
  trackName: 'Airbag',
  playcount: 42,
  imageUrl: 'https://img.test/a.jpg',
  featuredAt: new Date('2026-03-01T00:00:00Z'),
};

interface CtxSpec {
  inGuild?: boolean;
  strings?: Record<string, string | undefined>;
  displayName?: string;
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    guild: inGuild ? { id: '222', name: 'Test Guild', members: { cache: { get: () => undefined } } } : null,
    prefix: '.',
    discordDisplayName: spec.displayName ?? 'Caller',
    member: { displayName: spec.displayName ?? 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guildId: inGuild ? '222' : undefined,
      user: { id: 'caller1' },
      options: { getString: (name: string) => spec.strings?.[name] ?? null },
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

/** Every URL the card puts in front of the user, which is the actual answer. */
const linksOf = (response: ResponseModel): string => JSON.stringify(response.toMessagePayload());

interface Doubles {
  caller?: unknown;
  optedIn?: boolean;
  nowPlaying?: { title: string; artist: string; guildId: string; startedAt: number; durationMs: number };
  featured?: unknown;
  featuredLog?: unknown[];
  shortcuts?: Array<{ name: string; command: string }>;
  recent?: () => Promise<unknown[]>;
  prefix?: string;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? CALLER : over.caller)),
  };
  let optedIn = over.optedIn ?? false;
  const botScrobblingService = {
    isUserOptedIn: vi.fn(() => optedIn),
    toggleUserOptIn: vi.fn((_id: string, enable?: boolean) => {
      optedIn = enable ?? !optedIn;
      return optedIn;
    }),
    getNowPlaying: vi.fn(() => over.nowPlaying),
  };
  const featuredService = {
    getFeatured: vi.fn(async () => (over.featured === undefined ? FEATURED : over.featured)),
    getFeaturedLog: vi.fn(() => over.featuredLog ?? []),
  };
  const shortcutService = {
    getShortcuts: vi.fn(() => over.shortcuts ?? []),
  };
  const prefixService = {
    getPrefix: vi.fn(async () => over.prefix ?? '.'),
  };
  const lastFmRepository = {
    getUserRecentTracks: vi.fn(over.recent ?? (async () => [])),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0x445566),
    getColorFromImageUrl: vi.fn(async () => 0x445566),
  };

  const cmd = new UserHubSlashCommands(
    userService as unknown as UserService,
    botScrobblingService as unknown as BotScrobblingService,
    featuredService as unknown as FeaturedService,
    shortcutService as unknown as ShortcutService,
    prefixService as unknown as PrefixService,
    lastFmRepository as unknown as ILastfmRepository,
    colorService as unknown as ColorService,
  );
  const privates = cmd as unknown as {
    botScrobblingSlashAsync(c: ContextModel): Promise<ResponseModel>;
    featuredSlashAsync(c: ContextModel): Promise<ResponseModel>;
    featuredLogSlashAsync(c: ContextModel): Promise<ResponseModel>;
    rateYourMusicSlashAsync(c: ContextModel): Promise<ResponseModel>;
    youtubeSlashAsync(c: ContextModel): Promise<ResponseModel>;
    shortcutsSlashAsync(c: ContextModel): Promise<ResponseModel>;
  };
  return {
    cmd,
    privates,
    userService,
    botScrobblingService,
    featuredService,
    shortcutService,
    prefixService,
    lastFmRepository,
    colorService,
  };
};

const RECENT = [{ artistName: 'Mitch Murder', name: 'Spectral Bloom', albumName: 'After Hours', nowPlaying: true }];

describe('/botscrobbling: an opt-in toggle that must not toggle what nobody asked to toggle', () => {
  it('enables, and says enabled', async () => {
    const { privates, botScrobblingService } = build({ optedIn: false });
    const response = await privates.botScrobblingSlashAsync(
      makeContext({ strings: { action: 'enable' } }),
    );

    expect(botScrobblingService.toggleUserOptIn).toHaveBeenCalledWith('caller1', true);
    expect(cardText(response)).toContain('Enabled');
  });

  it('disables, and says disabled', async () => {
    const { privates, botScrobblingService } = build({ optedIn: true });
    const response = await privates.botScrobblingSlashAsync(
      makeContext({ strings: { action: 'disable' } }),
    );

    expect(botScrobblingService.toggleUserOptIn).toHaveBeenCalledWith('caller1', false);
    expect(cardText(response)).toContain('Disabled');
  });

  it('changes NOTHING when no action was given, and reports the state it found', async () => {
    // The branch that needs no third outcome: `action` is optional, so "no option"
    // is a legitimate invocation and it must behave like a status read. A handler
    // that defaulted the missing action to a toggle would flip the user's opt-in
    // every time they opened the page to look at it.
    const { privates, botScrobblingService } = build({ optedIn: true });
    const response = await privates.botScrobblingSlashAsync(makeContext());

    expect(botScrobblingService.toggleUserOptIn).not.toHaveBeenCalled();
    expect(cardText(response)).toContain('Enabled');
  });

  it('refuses an unregistered caller and writes nothing', async () => {
    // A WRITE behind a guard. Slash commands use the canonical `/register`
    // message, never a prefix.
    const { privates, botScrobblingService } = build({ caller: null, prefix: '!' });
    const response = await privates.botScrobblingSlashAsync(
      makeContext({ strings: { action: 'enable' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Use `/register` first');
    expect(botScrobblingService.toggleUserOptIn).not.toHaveBeenCalled();
  });

  it('shows the voice track when the server has one, and says nothing about it when it has none', async () => {
    // Both branches on one card. A now-playing block that appears when there is no
    // track would be the worst kind of wrong: a claim about a room the caller is
    // sitting in.
    const withTrack = build({
      optedIn: true,
      nowPlaying: { title: 'Spectral Bloom', artist: 'Mitch Murder', guildId: '222', startedAt: 1, durationMs: 1000 },
    });
    const text = cardText(await withTrack.privates.botScrobblingSlashAsync(makeContext()));
    expect(text).toContain('Currently Playing in Voice');
    expect(text).toContain('Spectral Bloom');

    const without = build({ optedIn: true });
    const quiet = cardText(await without.privates.botScrobblingSlashAsync(makeContext()));
    expect(quiet).not.toContain('Currently Playing in Voice');
  });

  it('does not ask the server for a now-playing track outside a server', async () => {
    const { privates, botScrobblingService } = build({ optedIn: true });
    await privates.botScrobblingSlashAsync(makeContext({ inGuild: false }));
    expect(botScrobblingService.getNowPlaying).not.toHaveBeenCalled();
  });

  it('disables the button for the state the caller is already in', async () => {
    // The card is its own control surface, so the two buttons have to disagree -
    // both enabled means a second press flips a setting the user did not mean to
    // change.
    const { privates } = build({ optedIn: true });
    const payload = linksOf(await privates.botScrobblingSlashAsync(makeContext()));
    // The Enable button carries `disabled: true` when opted in; the JSON order is
    // discord.js', so assert on the pair of customIds rather than on positions.
    expect(payload).toContain('userhub:botscrobble:enable');
    expect(payload).toContain('userhub:botscrobble:disable');
    const enableAt = payload.indexOf('userhub:botscrobble:enable');
    const disableAt = payload.indexOf('userhub:botscrobble:disable');
    expect(payload.slice(enableAt, disableAt)).toContain('"disabled":true');
    expect(payload.slice(disableAt)).toContain('"disabled":false');
  });
});

describe('/featured: the card is about ONE person, and an absent one is not an error', () => {
  it('renders the featured listener and their release', async () => {
    const { privates } = build({ featured: FEATURED });
    const text = cardText(await privates.featuredSlashAsync(makeContext()));

    expect(text).toContain('SomeUser');
    expect(text).toContain('Radiohead');
    expect(text).toContain('OK Computer');
    expect(text).toContain('42 plays');
  });

  it('prefers the ALBUM over the track when the entry has both', async () => {
    // Both fields are populated in the service's shape, so a card printing
    // "Airbag" while the release is "OK Computer" is a wrong answer about what the
    // bot chose to feature.
    const { privates } = build({ featured: FEATURED });
    const text = cardText(await privates.featuredSlashAsync(makeContext()));
    expect(text).toContain('Album: **OK Computer**');
    expect(text).not.toContain('Track: **Airbag**');
  });

  it('falls back to the TRACK label when the entry has no album', async () => {
    const { privates } = build({ featured: { ...FEATURED, albumName: undefined } });
    const text = cardText(await privates.featuredSlashAsync(makeContext()));
    expect(text).toContain('Track: **Airbag**');
  });

  it('says plainly that nobody is featured right now, without an error tone', async () => {
    // `getFeatured` returning null is a real "the hourly pick has not run", not a
    // failure - so this is Info, not Error, and it must not ask the user to do
    // anything about it.
    const { privates } = build({ featured: null });
    const response = await privates.featuredSlashAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No featured user is currently available');
  });

  it('puts the guild prefix on the "previous featured users" hint', async () => {
    const { privates } = build({ prefix: '!' });
    expect(cardText(await privates.featuredSlashAsync(makeContext()))).toContain('`!featuredlog`');
  });

  it('shows the release artwork only when the entry carries one', async () => {
    const withArt = build({ featured: FEATURED });
    expect(linksOf(await withArt.privates.featuredSlashAsync(makeContext()))).toContain(
      'https://img.test/a.jpg',
    );

    const withoutArt = build({ featured: { ...FEATURED, imageUrl: null } });
    expect(linksOf(await withoutArt.privates.featuredSlashAsync(makeContext()))).not.toContain(
      'https://img.test/a.jpg',
    );
  });
});

describe('/featuredlog: history is allowed to be empty, and says so in its own words', () => {
  it('renders the honest empty, distinct from /featured\'s "none right now"', async () => {
    // Two different absences sharing one sentence would leave the user unsure
    // whether the bot has forgotten to pick anyone. "logged yet today" is
    // different information from "not currently available".
    const { privates } = build({ featuredLog: [] });
    const response = await privates.featuredLogSlashAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No featured users logged yet today');
    expect(cardText(response)).toContain('0 entries');
  });

  it('counts the entries and names each of them with its timestamp', async () => {
    const { privates } = build({ featuredLog: [FEATURED] });
    const text = cardText(await privates.featuredLogSlashAsync(makeContext()));

    expect(text).toContain('1 entry');
    expect(text).toContain('SomeUser');
    expect(text).toMatch(/<t:\d+:R>/);
  });

  it('needs no caller at all, because the log is not about them', async () => {
    // `/featured` resolves nobody either, and `/featuredlog` resolves nobody even
    // to build a message. There is no account lookup on this path, so there is
    // nothing for an unregistered caller to be refused by.
    const built = build({ caller: null, featuredLog: [FEATURED] });
    const response = await built.privates.featuredLogSlashAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('SomeUser');
    expect(built.userService.getUserByDiscordId).not.toHaveBeenCalled();
  });
});

describe('/rateyourmusic and /youtube: the prefill, in all three of its outcomes', () => {
  const SEARCHES: Array<{
    label: string;
    method: 'rateYourMusicSlashAsync' | 'youtubeSlashAsync';
    noQuery: string;
  }> = [
    { label: '/rateyourmusic', method: 'rateYourMusicSlashAsync', noQuery: 'Please specify an artist or album name.' },
    { label: '/youtube', method: 'youtubeSlashAsync', noQuery: 'Please specify a song or artist to search.' },
  ];

  it.each(SEARCHES)('$label searches the query the user typed, verbatim', async ({ method, noQuery }) => {
    const { privates, lastFmRepository } = build();
    const response = await privates[method](makeContext({ strings: { query: '  boards of canada  ' } }));

    expect(cardText(response)).toContain('boards of canada');
    // The convenience must not run when a query was given - an extra Last.fm
    // round trip per invocation is a rate-limit cost for nothing.
    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).not.toContain(noQuery);
  });

  it.each(SEARCHES)('$label falls back to the caller\'s last scrobble when no query is given', async ({ method }) => {
    // The refusal half. Without the prefill, both commands are dead for the
    // majority of users who type no argument, which is the "half-built feature
    // that presents itself as working" failure.
    const { privates, lastFmRepository } = build({ recent: async () => RECENT });
    const response = await privates[method](makeContext());

    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
    expect(cardText(response)).toContain('Mitch Murder Spectral Bloom');
  });

  it.each(SEARCHES)('$label asks for a query when the prefill read comes back empty', async ({ method, noQuery }) => {
    // THE GENUINE EMPTY. The caller has a Last.fm account with nothing scrobbled,
    // so no query can be derived - and "please specify one" is TRUE.
    const { privates, lastFmRepository } = build({ recent: async () => [] });
    const response = await privates[method](makeContext());

    expect(lastFmRepository.getUserRecentTracks).toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain(noQuery);
  });

  it.each(SEARCHES)('$label asks for a query when the prefill read RAISES, and leaks nothing', async ({ method, noQuery }) => {
    // THE A1 TEST, and the reason this file exists. `getUserRecentTracks` raises
    // `LastFmUnavailableError` on an outage. `.catch(() => [])` turns that into
    // the "no query" branch, which is the correct sentence here - and that is
    // exactly why the user cannot tell an outage from a blank field, and why
    // nothing may be rendered that suggests a search happened or a result exists.
    const { privates } = build({
      recent: () => Promise.reject(new Error('Last.fm returned HTTP 500')),
    });
    const response = await privates[method](makeContext());

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    const text = cardText(response);
    expect(text).toContain(noQuery);
    // The three things that would make it a lie: a fabricated suggestion, a
    // search URL, or the provider's name in an error card.
    expect(text).not.toContain('http');
    expect(text).not.toMatch(/last\.fm/i);
  });

  it.each(SEARCHES)('$label does not read Last.fm at all for a caller who has no account', async ({ method, noQuery }) => {
    // The guard comes first, so the convenience never runs for someone it could
    // not work for anyway.
    const { privates, lastFmRepository } = build({ caller: null });
    const response = await privates[method](makeContext());

    expect(lastFmRepository.getUserRecentTracks).not.toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain(noQuery);
  });

  it('builds a real RateYourMusic search URL from the query', async () => {
    const { privates } = build();
    const payload = linksOf(await privates.rateYourMusicSlashAsync(makeContext({ strings: { query: 'Boards of Canada' } })));
    expect(payload).toContain('rateyourmusic.com/search?searchterm=Boards%20of%20Canada');
  });

  it('builds a real YouTube search URL from the query', async () => {
    const { privates } = build();
    const payload = linksOf(await privates.youtubeSlashAsync(makeContext({ strings: { query: 'Mitch Murder' } })));
    expect(payload).toContain('youtube.com/results?search_query=Mitch%20Murder');
  });

  it('URL-encodes a query with characters a link cannot carry raw', async () => {
    // A `&` in a query splits the URL: the user would be sent to a search for the
    // part before the ampersand, silently. Encoding is the difference between
    // searching "Earth, Wind & Fire" and searching "Earth, Wind".
    const { privates } = build();
    const payload = linksOf(await privates.youtubeSlashAsync(makeContext({ strings: { query: 'Earth, Wind & Fire' } })));
    expect(payload).toContain('search_query=Earth%2C%20Wind%20%26%20Fire');
    expect(payload).not.toContain('search_query=Earth, Wind & Fire');
  });
});

describe('/shortcuts: the caller\'s own macros, or the honest empty with instructions', () => {
  it('lists each shortcut with the guild prefix on both sides', async () => {
    // Both sides matter. The left is what the user types; the right is what the
    // bot runs. Printing the raw command without a prefix makes the shortcut look
    // like a text command in a server that has renamed its prefix.
    const { privates, shortcutService } = build({
      shortcuts: [{ name: 'mytop', command: 'top artists 1m' }],
      prefix: '!',
    });
    const text = cardText(await privates.shortcutsSlashAsync(makeContext({ displayName: 'Caller' })));

    expect(shortcutService.getShortcuts).toHaveBeenCalledWith('caller1');
    expect(text).toContain('Custom Shortcuts for **Caller**');
    expect(text).toContain('`!mytop`');
    expect(text).toContain('`!top artists 1m`');
  });

  it('renders the instructions, including the guild prefix, for a caller with none', async () => {
    const { privates } = build({ shortcuts: [], prefix: '!' });
    const text = cardText(await privates.shortcutsSlashAsync(makeContext()));

    expect(text).toContain("don't have any custom command shortcuts");
    expect(text).toContain('`!shortcut add <name> <command>`');
    expect(text).toContain('`!shortcut remove <name>`');
  });

  it('needs no Last.fm account, because shortcuts are not Last.fm data', async () => {
    const { privates, userService } = build({ caller: null });
    const response = await privates.shortcutsSlashAsync(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
  });
});
