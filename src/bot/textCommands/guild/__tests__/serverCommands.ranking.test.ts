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

import { ServerCommands } from '@bot/textCommands/guild/serverCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { OrderType, parseGuildRankingSettings } from '@bot/services/guild/guildRankingService';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { GuildRankingItem, GuildRankingSettings } from '@bot/services/guild/guildRankingService';
import type { GuildRankingService } from '@bot/services/guild/guildRankingService';
import type { ColorService } from '@bot/services/system/colorService';

vi.mock('@bot/interactions/serverInteractions', () => ({
  storeServerRankingQuery: vi.fn(),
}));

// Imported after the mock so the binding is the mocked one.
import { storeServerRankingQuery } from '@bot/interactions/serverInteractions';
import { DiscordConstants } from '@bot/resources/discordConstants';

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

  it('renders the ranking when the accent colour could not be read', async () => {
    // The accent is DECORATION. A guild icon that will not decode — a corrupt
    // PNG, a sharp build without the codec, a CDN timeout — must cost the
    // accent and nothing else. This used to take the whole command down,
    // including the ranking rows, which were correct and would otherwise have
    // rendered: the user got an error for a request the database answered.
    // Root AGENTS.md §3.6 is the same rule as for chapters.
    //
    // The paired test further down is the other half: a RANKING failure must
    // still propagate, or this guard is a blanket catch and an outage would read
    // as "this server has no listeners".
    const built = build();
    built.getColorFromImageUrl.mockRejectedValue(new Error('sharp failed on a corrupt icon'));

    const response = await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctxWithIcon(), ['alltime']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(built.getGuildTopArtists).toHaveBeenCalled();
    expect(textOf(response)).toContain('Radiohead');
  });

  it('still falls back to the brand red when the accent read fails, rather than dropping the accent', async () => {
    // `undefined` would drop the container's accent entirely, which is a
    // different-looking card. Falling back to the Last.fm red is what
    // `friendsCommands.ts:141-159` does, and this is the same decoration path.
    const built = build();
    built.getColorFromImageUrl.mockRejectedValue(new Error('sharp failed on a corrupt icon'));

    const response = await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(ctxWithIcon(), ['alltime']);

    expect(JSON.stringify(response.componentsV2Container?.toJSON())).toContain(
      String(DiscordConstants.LastFmColorRed),
    );
  });

  it('still refuses in a DM when the accent read would fail, having queried nothing', async () => {
    // The guard must not turn the DM refusal into an answer. There is no icon
    // and no accent to read, so the refusal is the whole content of the card.
    const built = build();
    built.getColorFromImageUrl.mockRejectedValue(new Error('sharp failed on a corrupt icon'));

    const response = await built.cmd.commands
      .find((c) => c.name === 'serverartists')!
      .executeAsync(dmCtx(), []);

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(built.getGuildTopArtists).not.toHaveBeenCalled();
    expect(built.getColorFromImageUrl).not.toHaveBeenCalled();
  });

  it('still propagates a RANKING failure, so the accent guard is not a blanket catch', async () => {
    // The other half of the pair. If the whole handler had been wrapped in the
    // try/catch instead of just the decoration read, this would pass and a user
    // would be told their server has no listeners during a database outage.
    const built = build();
    built.getColorFromImageUrl.mockRejectedValue(new Error('sharp failed on a corrupt icon'));
    vi.mocked(built.getGuildTopArtists).mockRejectedValue(new Error('P1001: Cannot reach database server'));

    await expect(
      built.cmd.commands.find((c) => c.name === 'serverartists')!.executeAsync(ctxWithIcon(), ['alltime']),
    ).rejects.toThrow(/Cannot reach database server/);
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

  it('reads a name that CONTAINS a time keyword as a NAME, because a keyword is a keyword only in POSITION', async () => {
    // THE BUG THIS INVERTS. The parser used to split on whitespace and consume
    // any token it recognised, appending the rest to `newSearchValue`. So
    // `.serveralbums All Together Now` lost `All` to the all-time keyword list
    // and became an ALL-TIME, WHOLE-SERVER album chart filtered to `Together
    // Now` — a complete, plausible, confident card for a valid request, with no
    // error anywhere, and a filter matching no artist.
    //
    // `guildRankingService.parseGuildRankingSettings` is now POSITIONAL: a token
    // is consumed only at the head or the tail of the argument run, so a word in
    // the middle belongs to the artist. The knife is cut at ONE leading keyword
    // — `All Together Now` is a name, not all-time-plus-`Together Now` — because
    // the wrong string that reaches the card is the one the user can SEE: the
    // filter is printed on it. That is the whole design rule, and it is the same
    // one the `.fm <@123> mini` layout token fix used.
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), [
      'All Together Now',
    ]);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.newSearchValue).toBe('All Together Now');
    expect(built.getGuildTopAlbums.mock.calls[0]![2]).toBe('All Together Now');
    // And NOT all-time: the keyword was part of the name, so the default period
    // stands. Asserting this is what stops a "fix" that merely stopped deleting
    // the word while leaving the period moved.
    expect(settings.chartTimePeriod).not.toBe('alltime');
  });

  it('still reads a SINGLE leading keyword before a one-word filter as an option', async () => {
    // The deliberate other side of the cut, and it has to stay or the fix above
    // is just "never parse an option": `monthly plays Radiohead` is exactly
    // what `ServerSlashCommands:176-187` composes from its typed options, so
    // refusing it would drop a period the user picked from a menu.
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), [
      'monthly',
      'Radiohead',
    ]);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.chartTimePeriod).toBe('monthly');
    expect(settings.newSearchValue).toBe('Radiohead');
  });

  it('reads a name BEGINNING with a period keyword as a name', async () => {
    // `M83` — the boundary case the cut was designed around. A rule that ate
    // leading tokens would turn this into a monthly chart filtered to `83`,
    // which is a confident wrong answer for a one-token request.
    const built = build();
    await built.cmd.commands.find((c) => c.name === 'serveralbums')!.executeAsync(ctx(), ['M83']);

    const settings = built.getGuildTopAlbums.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.newSearchValue).toBe('M83');
    expect(settings.chartTimePeriod).not.toBe('monthly');
  });

  it('records the irreducible ambiguity: a single-token name that IS a keyword', async () => {
    // `.serveralbums M` cannot be both "monthly" and "the artist M", and the
    // two spellings are the same input shape: `parseGuildRankingSettings('M')`
    // and `('monthly')` see identical structure. So this stays monthly.
    //
    // This is a VOCABULARY problem, not a grammar one. The fix is to remove the
    // single-letter aliases (`m`, `w`, `y`, `d`, `a`, `o`, `l`, `p`) from all
    // five keyword sets — and `serverBuilders.test.ts:29` pins `'p'` as
    // Playcount, so that is a decision about the command's vocabulary, not a bug
    // fix, and it is not this file's to make.
    //
    // Pinned in BOTH directions so the ambiguity is visible rather than
    // discovered: the next person to add a single-letter alias sees here that it
    // costs a real artist.
    const built = build();
    const response = await built.cmd.commands
      .find((c) => c.name === 'servertracks')!
      .executeAsync(ctx(), ['M']);

    const settings = built.getGuildTopTracks.mock.calls[0]![1] as GuildRankingSettings;
    expect(settings.chartTimePeriod).toBe('monthly');
    expect(settings.newSearchValue).toBeNull();
    // The card therefore describes a chart of EVERY track on the server.
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
