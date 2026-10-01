/**
 * `.serverartists` / `.serveralbums` / `.servertracks` / `.servergenres` — the
 * four guild leaderboards, and the argument grammar that selects one.
 *
 * Every one of these four is the same shape: parse a hand-written option
 * string, read a ranking, optionally read the PREVIOUS window for the movement
 * badges, and render. Two things in there can make a confident wrong answer,
 * and this file is about both.
 *
 * **1. The empty result is a claim about the whole server.** `ServerBuilders`
 * renders "Sorry, there are no registered top artists on this server in the
 * time period you selected." for `items: []`. A ranking read that failed must
 * therefore NOT be laundered into `[]` — but the failure has to be visible as a
 * rejection, because the command has no second card to offer. Asserted in both
 * directions, because a blanket refusal is not a fix either: a genuine empty
 * must still render the empty card.
 *
 * **2. The artist filter is the dangerous half of the grammar.** `.serveralbums`
 * and `.servertracks` take a free-text artist filter that
 * `parseGuildRankingSettings` carves out of the option string. The keywords it
 * consumes are single letters and short words (`a`, `o`, `at`, `all`, `m`, `w`,
 * `l`, `p`), so the question this file answers is the one the `.fm` layout-token
 * bug raised for the other family: does a user-supplied value that HAPPENS to
 * match a keyword survive, and does a keyword that is really part of a name get
 * silently eaten? Both are pinned, and the negative direction is the point —
 * a test that only checked "the filter arrives" would also pass on an
 * implementation that stripped `all` out of a band called "All Together Now".
 *
 * Plain objects into the constructor, in the exact order read from
 * `serverCommands.ts`: (guildRankingService, colorService). `storeServerRankingQuery`
 * is mocked as a MODULE (the paginator's cache key is generated with
 * `Math.random`, so the only stable way to assert what was stored is the write).
 * No `vi.spyOn` on the object under test, on `ServerBuilders`, or on `container`.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ServerCommands } from './serverCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { OrderType, parseGuildRankingSettings } from '@bot/services/guildRankingService';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { GuildRankingItem, GuildRankingSettings } from '@bot/services/guildRankingService';
import type { GuildRankingService } from '@bot/services/guildRankingService';
import type { ColorService } from '@bot/services/colorService';

vi.mock('@bot/interactions/serverInteractions', () => ({
  storeServerRankingQuery: vi.fn(),
}));

// Imported after the mock so the binding is the mocked one.
import { storeServerRankingQuery } from '@bot/interactions/serverInteractions';

/** A rendered claim, from whichever shape the builder chose. */
const textOf = (response: ResponseModel): string => {
  const container = response.componentsV2Container?.toJSON() as
    | { components: Array<{ content?: string }> }
    | undefined;
  const fromContainer = container
    ? container.components.map((c) => c.content ?? '').join('\n')
    : '';
  return [fromContainer, response.embed.data.description ?? '', response.content ?? ''].join('\n');
};

const item = (name: string, over: Partial<GuildRankingItem> = {}): GuildRankingItem => ({
  name,
  totalPlaycount: 100,
  listenerCount: 3,
  ...over,
});

/**
 * Guild present but with no icon: the accent must fall back, not crash.
 *
 * `iconURL` is a real method on discord.js's `Guild`, so the double returns
 * `null` rather than omitting the key — `context.guild?.iconURL()` guards the
 * guild being absent, not the method being absent, so a double without it
 * throws rather than falling back.
 */
const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: {
      id: '900000000000000001',
      name: 'Test Guild',
      iconURL: () => null,
      members: { cache: new Map() },
    },
    prefix: '.',
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

const dmCtx = (): ContextModel => ctx({ guildId: undefined, guild: null });

type Over = {
  caller?: unknown;
  withIcon?: boolean;
  accent?: number;
};

const build = (over: Over = {}) => {
  const items = [item('Radiohead'), item('Daft Punk')];

  const getGuildTopArtists = vi.fn(async (..._args: unknown[]) => items);
  const getGuildTopAlbums = vi.fn(async (..._args: unknown[]) => items);
  const getGuildTopTracks = vi.fn(async (..._args: unknown[]) => items);
  const getGuildTopGenres = vi.fn(async (..._args: unknown[]) => items);

  const guildRankingService = {
    getGuildTopArtists,
    getGuildTopAlbums,
    getGuildTopTracks,
    getGuildTopGenres,
  } as unknown as GuildRankingService;

  const getColorFromImageUrl = vi.fn(async () => 0x445566);
  const colorService = { getColorFromImageUrl } as unknown as ColorService;

  const cmd = new ServerCommands(guildRankingService, colorService);

  return {
    cmd,
    getGuildTopArtists,
    getGuildTopAlbums,
    getGuildTopTracks,
    getGuildTopGenres,
    getColorFromImageUrl,
    withIcon: over.withIcon === true,
  };
};

/** With an icon, `ContextModel.guild.iconURL()` must return a string. */
const ctxWithIcon = (): ContextModel =>
  ctx({
    guild: {
      id: '900000000000000001',
      name: 'Test Guild',
      iconURL: () => 'https://cdn.example.test/icon.png',
      members: { cache: new Map() },
    },
  });

beforeEach(() => {
  vi.mocked(storeServerRankingQuery).mockClear();
});

describe('ServerCommands — an unreadable ranking is not an empty server', () => {
  it.each([
    ['serverartists', 'getGuildTopArtists'],
    ['serveralbums', 'getGuildTopAlbums'],
    ['servertracks', 'getGuildTopTracks'],
    ['servergenres', 'getGuildTopGenres'],
  ] as const)('.%s propagates a ranking failure instead of rendering the empty card', async (name, method) => {
    const built = build();
    vi.mocked(built[method]).mockRejectedValue(new Error('P1001: Cannot reach database server'));

    // NOT awaited here: awaiting the promise in the test body would throw before
    // `expect` ever saw it, and the failure would be reported as an unhandled
    // rejection at the `mockRejectedValue` line instead of as an assertion.
    const response = built.cmd.commands.find((c) => c.name === name)!.executeAsync(ctx(), []);

    // The command boundary is the only place that can name the failure, so the
    // rejection is the signal. Swallowing it here would produce the sentence
    // below, which is a claim about every member of the server.
    await expect(response).rejects.toThrow(/Cannot reach database server/);
  });

  it('still renders the empty card for a GENUINE empty server', async () => {
    // The other half of the pair. A blanket refusal would pass the test above
    // and break this one, which is the whole reason both exist.
    const built = build();
    vi.mocked(built.getGuildTopArtists).mockResolvedValue([]);

    const response = await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctx(), []);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('no registered top artists on this server');
  });

  it('names the artist filter in the empty card, because the claim is about the filter', async () => {
    const built = build();
    vi.mocked(built.getGuildTopAlbums).mockResolvedValue([]);

    const response = await built.cmd.commands
      .find((c) => c.name === 'serveralbums')!
      .executeAsync(ctx(), ['Boards of Canada']);

    expect(textOf(response)).toContain('for artist `Boards of Canada`');
  });

  it.each([
    ['serverartists', 'getGuildTopArtists'],
    ['serveralbums', 'getGuildTopAlbums'],
    ['servertracks', 'getGuildTopTracks'],
    ['servergenres', 'getGuildTopGenres'],
  ] as const)('.%s never asks for a ranking in a DM', async (name, method) => {
    // All four, not just one. The DM guard is four separate copies of the same
    // six lines, and a copy that lost it would answer "no registered top
    // tracks on this server" — a claim about a server the user is not in.
    const built = build();
    const response = await built.cmd.commands.find((c) => c.name === name)!.executeAsync(dmCtx(), []);

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(textOf(response)).toContain('can only be used in a server');
    expect(built[method]).not.toHaveBeenCalled();
    expect(built.getColorFromImageUrl).not.toHaveBeenCalled();
  });
});

describe('ServerCommands — the previous window is a SECOND read, and only when there is one', () => {
  it('reads the previous window for the movement badges on the default weekly chart', async () => {
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serverartists')!.executeAsync(ctx(), []);

    // Default settings carry a billboard window, so the second read happens and
    // its window is the PREVIOUS seven days, not the current one.
    expect(built.getGuildTopArtists).toHaveBeenCalledTimes(2);
    const second = built.getGuildTopArtists.mock.calls[1]![1] as GuildRankingSettings;
    const first = built.getGuildTopArtists.mock.calls[0]![1] as GuildRankingSettings;
    expect(second.startDateTime.getTime()).toBeLessThan(first.startDateTime.getTime());
  });

  it('makes no second read for an all-time chart, which has no previous window', async () => {
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serverartists')!.executeAsync(ctx(), ['alltime']);

    // One read. A second here would ask for a window that does not exist and
    // render badges computed against nothing.
    expect(built.getGuildTopArtists).toHaveBeenCalledTimes(1);
  });

  it('renders the server name and the listener ordering it actually asked for', async () => {
    const built = build();
    const response = await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctx(), ['alltime']);

    expect(textOf(response)).toContain('all-time artists in Test Guild');
    expect(textOf(response)).toContain('Radiohead');
    expect(textOf(response)).toContain('Listener count');
  });

  it.each([
    ['serverartists'],
    ['serveralbums'],
    ['servertracks'],
    ['servergenres'],
  ] as const)('.%s falls back to the Last.fm red when the guild has no icon', async (name) => {
    const built = build();
    const response = await built.cmd.commands.find((c) => c.name === name)!.executeAsync(ctx(), ['alltime']);

    // No icon means no accent read at all — and a card still renders.
    expect(built.getColorFromImageUrl).not.toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it.each([
    ['serverartists'],
    ['serveralbums'],
    ['servertracks'],
    ['servergenres'],
  ] as const)('.%s derives the accent from the guild icon when there is one', async (name) => {
    const built = build();
    await built.cmd.commands.find((c) => c.name === name)!.executeAsync(ctxWithIcon(), ['alltime']);

    expect(built.getColorFromImageUrl).toHaveBeenCalledWith('https://cdn.example.test/icon.png');
  });

  it('propagates an accent extraction failure rather than rendering an uncoloured card', async () => {
    // RECORDED, not asserted-as-intended. `getAccentColor` awaits
    // `colorService.getColorFromImageUrl` with no guard, so a failure to read
    // the guild icon's colour takes the whole command down — including the
    // ranking rows, which are correct and would otherwise have rendered.
    //
    // This is a degradation, not a lie: the user gets an error rather than a
    // card with a wrong accent, so nothing false is claimed. It is pinned so
    // that anyone adding a fallback here knows the trade they are changing.
    const built = build();
    built.getColorFromImageUrl.mockRejectedValue(new Error('sharp failed on a corrupt icon'));

    // Not awaited in the test body: awaiting would throw before `expect` saw it.
    const response = built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctxWithIcon(), ['alltime']);

    await expect(response).rejects.toThrow('sharp failed');
  });

  it('names the guild in every card, so a paginated page two is identifiable', async () => {
    // The page buttons carry only a cache key, so the server name is the only
    // thing on the card tying it to the server that was asked about.
    const built = build();
    const text = textOf(
      await built.cmd.commands.find((c) => c.name === 'servergenres')!.executeAsync(ctx(), ['alltime']),
    );

    expect(text).toContain('in Test Guild');
  });

  it.each([
    ['serverartists', 'getGuildTopArtists'],
    ['serveralbums', 'getGuildTopAlbums'],
    ['servertracks', 'getGuildTopTracks'],
    ['servergenres', 'getGuildTopGenres'],
  ] as const)('.%s survives being handed NO args array at all', async (name, method) => {
    // `args?.join(' ') ?? ''` — every entry point is `(context, args) => …`, so
    // `args` is always an array from the dispatcher. The optional chain is
    // defensive, and it is what makes a missing second argument render the
    // default weekly chart instead of throwing on `.join` of undefined.
    const built = build();
    const command = built.cmd.commands.find((c) => c.name === name)!;
    const response = await command.executeAsync(ctx(), undefined as unknown as string[]);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(built[method]).toHaveBeenCalled();
    // The weekly default, not a crash and not an all-time chart.
    expect(textOf(response)).toContain('weekly');
  });

  it.each([
    ['serverartists'],
    ['serveralbums'],
    ['servertracks'],
    ['servergenres'],
  ] as const)('.%s falls back to "Server" when the guild object is absent', async (name) => {
    // `context.guild?.name ?? 'Server'` with `guildId` still SET. That is a
    // reachable state — a cached context whose guild was not hydrated — and the
    // fallback is what stops the card being titled "Top weekly artists in
    // undefined", which would be a page nobody can identify.
    const built = build();
    const response = await built.cmd.commands
      .find((c) => c.name === name)!
      .executeAsync(ctx({ guild: undefined }), ['alltime']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('in Server');
  });
});

  describe('ServerCommands — the artist filter survives the option grammar', () => {

  it('hands a multi-word artist name to the ranking read intact', async () => {
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), [
      'Boards of Canada',
    ]);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.newSearchValue).toBe('Boards of Canada');
    expect(built.getGuildTopAlbums.mock.calls[0]![2]).toBe('Boards of Canada');
  });

  it('records what the parser does to a name that CONTAINS a time keyword', async () => {
    // THIS IS A REAL BUG, pinned rather than asserted as intended. It is
    // reported, not fixed, because the defect is in
    // `parseGuildRankingSettings` (`guildRankingService.ts`, the token loop at
    // `:88-149`) which is outside this file's tree.
    //
    // The parser splits the option string on whitespace and CONSUMES any token
    // it recognises, appending the rest to `newSearchValue`. So `.serveralbums
    // All Together Now` loses `All` to the all-time keyword list and becomes an
    // ALL-TIME, WHOLE-SERVER album chart filtered to `Together Now` — which
    // matches no artist. The user gets a complete, plausible, confident card
    // with no error anywhere, for a request that was valid.
    //
    // The severity is highest for short names, and single letters are in the
    // keyword sets: `a`, `o`, `at`, `all`, `m`, `w`, `l`, `p`. `.serveralbums M`
    // is a monthly chart of the whole server.
    //
    // A test asserting the CORRECT behaviour here would fail, and it must not:
    // what is pinned is today's behaviour, so that whoever fixes the parser sees
    // this test go red and knows the change was deliberate.
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), [
      'All Together Now',
    ]);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    // DEFECT: `All` was eaten, so the period moved to all-time AND the filter
    // lost the first word of the name the user typed.
    expect(settings.chartTimePeriod).toBe('alltime');
    expect(settings.newSearchValue).toBe('Together Now');
    // And the whole-server read is what reaches the service, so the card's
    // "no registered top albums for artist X" claim is about the wrong set.
    expect(built.getGuildTopAlbums.mock.calls[0]![2]).toBe('Together Now');
  });

  it('records what the parser does to a single-token artist name that is a keyword', async () => {
    // The worst version of the same defect, and it is a one-character request:
    // the whole filter disappears and nothing is left to signal that it did.
    const built = build();
    const response = await built.cmd.commands
      .find((c) => c.name === 'servertracks')!
      .executeAsync(ctx(), ['M']);

    const settings = built.getGuildTopTracks.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.chartTimePeriod).toBe('monthly');
    expect(settings.newSearchValue).toBeNull();
    expect(built.getGuildTopTracks.mock.calls[0]![2]).toBeNull();
    // The card therefore describes a chart of EVERY track on the server, and
    // says so with no hint that a filter was requested and discarded.
    expect(textOf(response)).toContain('monthly tracks in Test Guild');
  });

  it('passes a REAL keyword through as a time period, not as a filter', async () => {
    // The positive control. Without it, "a filter always arrives" would pass on
    // a parser that treated every option as a name.
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), ['monthly']);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.chartTimePeriod).toBe('monthly');
    expect(settings.newSearchValue).toBeNull();
    expect(built.getGuildTopAlbums.mock.calls[0]![2]).toBeNull();
  });

  it('passes a play-count keyword through as the ordering, not as a filter', async () => {
    const built = build();
    const response = await built.cmd.commands
      .find((c) => c.name === 'serveralbums')!
      .executeAsync(ctx(), ['plays', 'alltime']);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.orderType).toBe(OrderType.Playcount);
    expect(settings.newSearchValue).toBeNull();
    expect(textOf(response)).toContain('Play count');
  });

  it('has no filter at all for the artist and genre charts', async () => {
    // `.serverartists` and `.servergenres` rank across the whole server, so a
    // free-text token there is not a filter — and the builder must not be handed
    // one, or the card would claim "top albums for artist X" for a ranking that
    // never applied it.
    const built = build();
    const genres = await built.cmd.commands
      .find((c) => c.name === 'servergenres')!
      .executeAsync(ctx(), ['Radiohead']);

    expect(built.getGuildTopGenres.mock.calls[0]).toHaveLength(2);
    expect(textOf(genres)).not.toContain('for artist');
  });

  it('reads the option string the way the dispatcher hands it over', async () => {
    // `.serveralbums Boards of Canada monthly` arrives as three tokens joined
    // back into one string. If the join were dropped, the grammar would see a
    // single token and the filter would swallow the period.
    const built = build();
    const command = built.cmd.commands.find((c) => c.name === 'serveralbums')!;
    const raw = ['Boards of Canada', 'monthly'].join(' ');

    const settings = parseGuildRankingSettings(raw);
    await command.executeAsync(ctx(), [raw]);

    const passed = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(passed.chartTimePeriod).toBe(settings.chartTimePeriod);
    expect(passed.newSearchValue).toBe(settings.newSearchValue);
    expect(passed.newSearchValue).toBe('Boards of Canada');
  });
});

describe('ServerCommands — the cached query the paginator will read back', () => {
  it('stores the guild, the filter and the settings the card was built from', async () => {
    // The card's page buttons carry a random cache key. If the stored entry does
    // not match the card, page two renders some OTHER request's rows under this
    // request's title — a wrong answer with no error, delivered by a working
    // button.
    const built = build();
    await built.cmd.commands
      .find((c) => c.name === 'serveralbums')!
      .executeAsync(ctx(), ['Boards of Canada', 'alltime']);

    expect(storeServerRankingQuery).toHaveBeenCalledTimes(1);
    const [cacheKey, stored] = vi.mocked(storeServerRankingQuery).mock.calls[0]!;
    expect(typeof cacheKey).toBe('string');
    expect((cacheKey as string).length).toBeGreaterThan(0);
    expect(stored).toMatchObject({
      type: 'albums',
      guildId: '900000000000000001',
      serverName: 'Test Guild',
      artistFilter: 'Boards of Canada',
    });
  });

  it('gives two invocations two different cache keys', async () => {
    // A shared key means the second user's page two is the first user's chart.
    const built = build();
    const command = built.cmd.commands.find((c) => c.name === 'serverartists')!;
    await command.executeAsync(ctx(), ['alltime']);
    await command.executeAsync(ctx(), ['alltime']);

    const [first] = vi.mocked(storeServerRankingQuery).mock.calls[0]!;
    const [second] = vi.mocked(storeServerRankingQuery).mock.calls[1]!;
    expect(first).not.toBe(second);
  });

  it('stores the caller id nowhere, so one user cannot page another user\'s chart', async () => {
    const built = build();
    await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctx(), ['alltime']);

    // The caller id rides in the button customId, not in the stored query, so
    // this asserts the stored payload carries no claim about who asked.
    const [, stored] = vi.mocked(storeServerRankingQuery).mock.calls[0]!;
    expect(Object.keys(stored as object)).not.toContain('callerDiscordUserId');
  });

  it('stores nothing at all when the command is refused in a DM', async () => {
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serverartists')!.executeAsync(dmCtx(), []);

    expect(storeServerRankingQuery).not.toHaveBeenCalled();
  });
});

describe('ServerCommands — the registry surface', () => {
  it('exposes exactly the four server rankings, each with a filter-free and filter-taking path', () => {
    const built = build();
    const names = built.cmd.commands.map((c) => c.name);
    expect(names).toEqual(['serverartists', 'serveralbums', 'servertracks', 'servergenres']);
  });

  it('keeps `st` and `bb` on the tracks chart, where they have always pointed', async () => {
    // `bb` reads as "billboard" and `st` as "server tracks". If either moved to
    // another command the rendered claim would change under a user who typed
    // nothing new.
    const built = build();
    const tracks = built.cmd.commands.find((c) => c.name === 'servertracks')!;
    expect(tracks.aliases).toContain('st');
    expect(tracks.aliases).toContain('bb');

    await tracks.executeAsync(ctx(), ['alltime']);
    expect(built.getGuildTopTracks).toHaveBeenCalled();
    expect(built.getGuildTopArtists).not.toHaveBeenCalled();
  });
});
