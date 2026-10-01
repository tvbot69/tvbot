/**
 * `.country` — the one country command that answers about an ARTIST rather than
 * a leaderboard, and the only one whose grammar has a two-word ambiguity.
 *
 * The two documented failure modes are already covered by the two sibling files
 * (`countryCommands.lastFmUnavailable.test.ts` and
 * `countryCommands.artistInfoUnavailable.test.ts`): a Last.fm outage must not be
 * laundered into an empty country list, and a Last.fm outage on
 * `getArtistInfo` must not render a card byte-identical to "you have 0 plays".
 * Nothing here repeats either. What is here is what those files cannot reach:
 *
 * **The `parseUserAndQuery` / `resolveUser` grammar.** `.country` does NOT take
 * a user — it always renders the caller's own plays — so `parseUserAndQuery` is
 * used here only for the period. That is worth pinning because the sibling
 * commands DO use it for a target, and a `country` that started honouring an
 * `lfm:` token would answer a different user's playcount. What this file locks
 * down instead is the branch that actually decides the answer:
 *
 *   - the argument is a COUNTRY -> the card is that country's artists, and the
 *     caller's own playcount is never read at all. `getArtistInfo` must not be
 *     called, because a card that mixes "top artists from Japan" with "you have
 *     N plays" is claiming N plays OF the country.
 *   - the argument is an ARTIST -> the card is that artist's country, and the
 *     playcount comes from Last.fm. A country-shaped artist name ("Georgia",
 *     "Turkey", "Chad") takes the FIRST branch, which is the ambiguity, and it is
 *     worth stating which way it resolves rather than leaving it to chance.
 *   - `getArtistInfoWithCountry` answers with NO country -> "Could not find
 *     country of origin", and that is TRUE for an artist MusicBrainz has not
 *     placed. It is also what a failed lookup would produce if the service
 *     swallowed the failure, which is why the throwing service is asserted to
 *     propagate rather than degrade to the not-found card.
 *
 * **The empty-argument pre-fill.** With no argument the command substitutes the
 * caller's most recent scrobble's artist. That is a guess the user never made,
 * so the test asserts the guess rather than accepting it, and asserts that the
 * card it produces is about THAT artist.
 *
 * Constructor arity: (userService, settingService, lastfmRepository,
 * countryService, worldMapGenerator, colorService?) — SIX, the last optional.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CountryCommands } from './countryCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { UserService } from '@bot/services/userService';
import type { SettingService } from '@bot/services/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService, CountryInfo, TopCountryItem } from '@bot/services/countryService';
import type { ColorService } from '@bot/services/colorService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

vi.mock('@bot/interactions/countryInteractions', () => ({
  storeCountryQuery: vi.fn(),
}));

import { storeCountryQuery } from '@bot/interactions/countryInteractions';

/** Every claim the card makes, from whichever shape the builder chose. */
const textOf = (response: ResponseModel): string => {
  const container = response.componentsV2Container?.toJSON() as
    | { components: Array<{ content?: string }> }
    | undefined;
  const fromContainer = container
    ? container.components.map((c) => c.content ?? '').join('\n')
    : '';
  return [fromContainer, response.embed.data.description ?? '', response.content ?? ''].join('\n');
};

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 7,
    discordUserId: 'caller1',
    userNameLastFm: 'DreadRock',
    registeredOn: new Date('2026-01-01T00:00:00Z'),
    totalPlayCount: 500,
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: { id: '900000000000000001', name: 'Test Guild', members: { cache: new Map() } },
    prefix: '!',
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

const JAPAN: CountryInfo = { Name: 'Japan', Code: 'JP', Emoji: ':flag_jp:' };
const UNITED_KINGDOM: CountryInfo = { Name: 'United Kingdom', Code: 'GB', Emoji: ':flag_gb:' };

type Over = {
  caller?: User | null;
  matchCountry?: CountryInfo | undefined;
  /** `null` = MusicBrainz has no country; omit for the default (United Kingdom). */
  artistCountry?: CountryInfo | null;
  artistThrows?: unknown;
  recents?: Array<{ artistName: string }> | null;
  recentsThrow?: unknown;
  artistsForCountry?: Array<{ name: string; playcount: number }>;
  lfmArtistInfo?: unknown;
  countries?: TopCountryItem[];
  timeSettings?: { description?: string };
  byDiscordId?: Record<string, User | null>;
  registeredTarget?: User | null;
};

const build = (over: Over = {}) => {
  const userService = {
    // Narrowed by id where the test says so: a mention target that resolves to
    // the CALLER is exactly what the target grammar has to prevent, and a double
    // that answers for every id makes that unreachable.
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return over.caller === undefined ? caller() : over.caller;
    }),
    getUserByLastFmName: vi.fn(async () => over.registeredTarget ?? null),
  } as unknown as UserService;

  const getTimePeriod = vi.fn(() => ({ description: over.timeSettings?.description ?? 'Alltime' }));
  const settingService = { getTimePeriod } as unknown as SettingService;

  const getUserRecentTracks = vi.fn(async (..._args: unknown[]) => {
    if (over.recentsThrow) throw over.recentsThrow;
    return over.recents === undefined ? [{ artistName: 'Boards of Canada' }] : over.recents;
  });
  const getArtistInfo = vi.fn(async (..._args: unknown[]) =>
    over.lfmArtistInfo === undefined
      ? { name: 'Radiohead', userPlayCount: 4321 }
      : over.lfmArtistInfo,
  );
  const getTopArtists = vi.fn(async () => [{ name: 'Radiohead', playcount: 120 }]);
  const lastfmRepository = {
    getUserRecentTracks,
    getArtistInfo,
    getTopArtists,
  } as unknown as LastFmRepository;

  const getUserArtistsForCountry = vi.fn(async () => over.artistsForCountry ?? []);
  const getUserTopCountriesAllTime = vi.fn(async () => over.countries ?? []);
  const getTopCountriesForTopArtists = vi.fn(async () => over.countries ?? []);
  const getArtistInfoWithCountry = vi.fn(async () => {
    if (over.artistThrows) throw over.artistThrows;
    return {
      // `null` is the explicit "MusicBrainz has no country for this artist";
      // omitting the key would mean "use the default", which would make the
      // not-found card untestable — and that card is the half of the pair that
      // matters, because a failed lookup produces it too if the service degrades.
      country: over.artistCountry === null ? undefined : (over.artistCountry ?? UNITED_KINGDOM),
      spotifyImageUrl: 'https://cdn.example.test/cover.jpg',
    };
  });
  const countryService = {
    searchCountry: vi.fn(() => over.matchCountry),
    getUserArtistsForCountry,
    getArtistInfoWithCountry,
    getUserTopCountriesAllTime,
    getTopCountriesForTopArtists,
  } as unknown as CountryService;

  const generateWorldMap = vi.fn(async () => Buffer.from('fake-png'));
  const worldMapGenerator = { generateWorldMap } as unknown as WorldMapGenerator;

  const getAccentColorAsync = vi.fn(async (..._args: unknown[]) => 0x445566);
  const colorService = { getAccentColorAsync } as unknown as ColorService;

  // The sixth argument is optional. `worldMapGenerator` is never reached by
  // `.country`, so nothing in this file exercises it — it is passed only to fill
  // the positional arity.
  const cmd = new CountryCommands(
    userService,
    settingService,
    lastfmRepository,
    countryService,
    worldMapGenerator,
    colorService,
  );

  return {
    cmd,
    getUserRecentTracks,
    getArtistInfo,
    getUserArtistsForCountry,
    getArtistInfoWithCountry,
    getTimePeriod,
    getUserTopCountriesAllTime,
    getTopCountriesForTopArtists,
    getTopArtists,
    userService: userService as unknown as {
      getUserByDiscordId: ReturnType<typeof vi.fn>;
      getUserByLastFmName: ReturnType<typeof vi.fn>;
    },
    searchCountryOf: countryService.searchCountry as unknown as ReturnType<typeof vi.fn>,
    generateWorldMap,
    getAccentColorAsync,
  };
};

const run = (cmd: CountryCommands, name: string, args: string[], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

// The store is a module-level mock shared across the file, so the call count is
// cumulative without this — and a count of "1" would then pass for the wrong
// test's write.
beforeEach(() => {
  vi.mocked(storeCountryQuery).mockClear();
});

const LFM_DOWN = (method: string) =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 503'));

describe('CountryCommands.topcountries — the target grammar, which `.country` does not have', () => {
  // `.country` always renders the CALLER's own plays. `.topcountries` takes a
  // target, and that is where `parseUserAndQuery` earns its keep: a leading
  // `<@id>` and a leading `lfm:name` each select a DIFFERENT user, and each must
  // then be removed from the string the period is parsed out of. A mention left
  // in the query is not a crash — it is a chart of a search string nobody typed,
  // rendered with total confidence.
  it('names the CALLER by their guild display name when they have one', async () => {
    // The other half of the display-name fallback: the caller is in the guild
    // cache, so the card is titled with the nickname they are known by rather
    // than the Last.fm name they registered.
    const context = ctx();
    (context.guild!.members.cache as unknown as Map<string, { displayName: string }>).set('caller1', {
      displayName: 'Dread In Server',
    });
    const built = build({ matchCountry: undefined, timeSettings: { description: 'Weekly' } });

    const response = await run(built.cmd, 'topcountries', [], context);

    expect(textOf(response)).toContain('for Dread In Server');
  });

  it('answers for the caller when no target is named', async () => {
    const built = build({ matchCountry: undefined, timeSettings: { description: 'Weekly' } });
    const response = await run(built.cmd, 'topcountries', [], ctx());
    const text = textOf(response);

    expect(text).toContain('Top Weekly countries for DreadRock');
  });

  it('routes a mention to that user and strips it from the period string', async () => {
    const built = build({
      matchCountry: undefined,
      timeSettings: { description: 'Weekly' },
      byDiscordId: { '900000000000000042': { userId: 42, userNameLastFm: 'SomeoneElse' } as User },
    });
    const response = await run(built.cmd, 'topcountries', ['<@900000000000000042>', 'weekly']);

    expect(textOf(response)).toContain('for SomeoneElse');
    // The mention must be GONE, or `getTimePeriod` sees `<@id> weekly` and
    // the period never parses.
    expect(built.getTimePeriod).toHaveBeenCalledWith('weekly');
  });

  it('routes an `lfm:` target by Last.fm name and strips the prefix', async () => {
    const built = build({
      matchCountry: undefined,
      timeSettings: { description: 'Weekly' },
      registeredTarget: { userId: 42, userNameLastFm: 'lfmtyped' } as User,
    });
    const response = await run(built.cmd, 'topcountries', ['lfm:lfmtyped', 'weekly']);

    expect(textOf(response)).toContain('for lfmtyped');
    expect(built.getTimePeriod).toHaveBeenCalledWith('weekly');
  });

  it('does NOT take the `lfm:` path when the token is the word `lfm` on its own', async () => {
    // `startsWith('lfm:')` includes the colon. A bare `lfm` is an artist name
    // and must stay in the query.
    const built = build({ matchCountry: undefined, timeSettings: { description: 'Weekly' } });
    await run(built.cmd, 'topcountries', ['lfm', 'weekly']);

    expect(built.userService.getUserByLastFmName).not.toHaveBeenCalled();
    expect(built.getTimePeriod).toHaveBeenCalledWith('lfm weekly');
  });

  it('names a mentioned user by their guild display name when they have one', async () => {
    // `member?.displayName ?? u.userNameLastFm` — the fallback is the registered
    // Last.fm name, and a member whose nickname differs from it would otherwise
    // be charted under a name nobody in the server recognises.
    const context = ctx();
    (context.guild!.members.cache as unknown as Map<string, { displayName: string }>).set(
      '900000000000000042',
      { displayName: 'Someone In Server' },
    );
    const built = build({
      matchCountry: undefined,
      timeSettings: { description: 'Weekly' },
      byDiscordId: { '900000000000000042': { userId: 42, userNameLastFm: 'lfmname' } as User },
    });

    const response = await run(built.cmd, 'topcountries', ['<@900000000000000042>'], context);

    expect(textOf(response)).toContain('for Someone In Server');
    expect(textOf(response)).not.toContain('for lfmname');
  });

  it('falls back to the registered Last.fm name when the mentioned user is not in the guild cache', async () => {
    const built = build({
      matchCountry: undefined,
      timeSettings: { description: 'Weekly' },
      byDiscordId: { '900000000000000042': { userId: 42, userNameLastFm: 'lfmname' } as User },
    });

    const response = await run(built.cmd, 'topcountries', ['<@900000000000000042>']);

    expect(textOf(response)).toContain('for lfmname');
  });

  it('refuses a mention of somebody who is not registered here', async () => {
    const built = build({ matchCountry: undefined, byDiscordId: { '900000000000000042': null } });
    const response = await run(built.cmd, 'topcountries', ['<@900000000000000042>']);

    // Naming them as unregistered is the answer. Falling back to the CALLER
    // would render the caller's own countries as if they were the other
    // person's, which is the exact failure the target grammar exists to stop.
    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('is not registered');
  });

  it('refuses an unconnected caller rather than charting an empty profile', async () => {
    const built = build({ caller: null, matchCountry: undefined });
    const response = await run(built.cmd, 'topcountries', []);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('`!register`');
    expect(built.getUserTopCountriesAllTime).not.toHaveBeenCalled();
  });
});

describe('CountryCommands.country — a caller with no account is refused, not guessed at', () => {
  it('refuses an unconnected caller and reads nothing from Last.fm', async () => {
    const built = build({ caller: null });
    const response = await run(built.cmd, 'country', ['Japan']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    // `!register`, not `.register`: the prefix comes from the context, and a
    // hardcoded one sends the user to a command that does not exist here.
    expect(textOf(response)).toContain('`!register`');
    expect(built.getUserArtistsForCountry).not.toHaveBeenCalled();
    expect(built.getArtistInfo).not.toHaveBeenCalled();
  });
});

describe('CountryCommands.country — the COUNTRY branch', () => {
  it('lists the caller\'s artists for that country and reads NO playcount', async () => {
    const built = build({
      matchCountry: JAPAN,
      artistsForCountry: [
        { name: 'Radiohead', playcount: 120 },
        { name: 'Bjork', playcount: 30 },
      ],
    });
    const response = await run(built.cmd, 'country', ['Japan']);
    const text = textOf(response);

    expect(text).toContain('Top Japan artists for DreadRock');
    expect(text).toContain('Radiohead');
    expect(text).toContain('Bjork');
    // The playcount on this card is per-artist, from our own index. Reading
    // `getArtistInfo` would put a "you have N plays" figure on a card about a
    // COUNTRY, which is a claim about something else entirely.
    expect(built.getArtistInfo).not.toHaveBeenCalled();
    expect(built.getUserArtistsForCountry).toHaveBeenCalledWith(7, 'JP');
  });

  it('says so plainly when the caller has no artists from that country', async () => {
    // The genuine empty. A failed index read would produce this same sentence.
    const built = build({ matchCountry: JAPAN, artistsForCountry: [] });
    const response = await run(built.cmd, 'country', ['Japan']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('no registered artists found from **Japan**');
  });

  it('renders the country artists card with no guild and no colour service', async () => {
    // Both are optional on this branch: `context.guild?.id && this.colorService`
    // is an `&&` chain, so a DM takes the `: null` arm of the accent ternary
    // AND the guild-name fallback. A double supplying a guild would leave the
    // DM arm of that chain unreached.
    const built = build({ matchCountry: JAPAN, artistsForCountry: [{ name: 'Radiohead', playcount: 12 }] });
    const response = await run(
      built.cmd,
      'country',
      ['Japan'],
      ctx({ guildId: undefined, guild: null }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('Top Japan artists for DreadRock');
    expect(built.getAccentColorAsync).not.toHaveBeenCalled();
  });

  it('does not render a country artists list with a page that does not exist', async () => {
    // Three artists at ten per page is one page. "Page 1/2" would offer a Next
    // button that lands on nothing.
    const built = build({
      matchCountry: JAPAN,
      artistsForCountry: [{ name: 'A', playcount: 3 }, { name: 'B', playcount: 2 }, { name: 'C', playcount: 1 }],
    });
    const response = await run(built.cmd, 'country', ['Japan']);

    expect(textOf(response)).not.toContain('Page 2/');
    expect(textOf(response)).toContain('3 artists');
  });

  it('stores the country and its code, so page two re-renders the same country', async () => {
    const built = build({ matchCountry: JAPAN, artistsForCountry: [{ name: 'A', playcount: 3 }] });
    await run(built.cmd, 'country', ['Japan']);

    expect(storeCountryQuery).toHaveBeenCalledTimes(1);
    const [, stored] = vi.mocked(storeCountryQuery).mock.calls[0]!;
    expect(stored).toMatchObject({ type: 'info', country: JAPAN, isServerView: false });
  });
});

describe('CountryCommands.country — the ARTIST branch', () => {
  it('renders the artist\'s country with the caller\'s playcount', async () => {
    const built = build({ matchCountry: undefined, artistCountry: UNITED_KINGDOM });
    const response = await run(built.cmd, 'country', ['Radiohead']);
    const text = textOf(response);

    expect(text).toContain('From **United Kingdom**');
    expect(text).toContain('You have **4,321** plays for this artist');
    // And no country artists list, because the argument was not a country.
    expect(built.getUserArtistsForCountry).not.toHaveBeenCalled();
  });

  it('says so plainly when MusicBrainz has no country for the artist', async () => {
    // The genuine empty, and the reason the throwing service must NOT degrade
    // into this card: "Could not find country of origin for X" reads as a fact
    // about MusicBrainz's coverage when it may be a failed lookup.
    const built = build({ matchCountry: undefined, artistCountry: null });
    const response = await run(built.cmd, 'country', ['Obscure Band']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('Could not find country of origin for **Obscure Band**');
    expect(textOf(response)).toContain('sourced from MusicBrainz');
  });

  it('propagates a country lookup that cannot be read instead of claiming no country exists', async () => {
    const built = build({
      matchCountry: undefined,
      artistThrows: LFM_DOWN('mbz.artist'),
    });

    await expect(run(built.cmd, 'country', ['Radiohead'])).rejects.toBeDefined();
  });

  it('resolves a country-shaped ARTIST name as a country, and says which one', async () => {
    // The two-word ambiguity, stated rather than left to chance: `Georgia` and
    // `Turkey` are both countries and both artist names, and `searchCountry` is
    // asked FIRST. A user typing an artist called Turkey gets the country's
    // artists with no indication that the artist reading was not attempted.
    const GEORGIA: CountryInfo = { Name: 'Georgia', Code: 'GE', Emoji: ':flag_ge:' };
    const built = build({ matchCountry: GEORGIA, artistsForCountry: [{ name: 'Some Band', playcount: 9 }] });
    const response = await run(built.cmd, 'country', ['Georgia']);

    expect(textOf(response)).toContain('Top Georgia artists');
    expect(built.getArtistInfoWithCountry).not.toHaveBeenCalled();
  });

  it('does not read the caller\'s playcount for the artist when Last.fm has none', async () => {
    const built = build({ matchCountry: undefined, lfmArtistInfo: { name: 'Radiohead' } });
    const response = await run(built.cmd, 'country', ['Radiohead']);

    // `typeof userPlayCount === 'number'` is the gate. An absent field must leave
    // the clause off, not render "0 plays".
    expect(textOf(response)).toContain('From **United Kingdom**');
    expect(textOf(response)).not.toContain('You have');
  });

  it('uses the singular for exactly one play', async () => {
    const built = build({ matchCountry: undefined, lfmArtistInfo: { name: 'Radiohead', userPlayCount: 1 } });
    expect(textOf(await run(built.cmd, 'country', ['Radiohead']))).toContain('You have **1** play for this artist');
  });
});

describe('CountryCommands.country — the empty-argument pre-fill', () => {
  it('answers about the caller\'s most recent scrobble when nothing is named', async () => {
    const built = build({ matchCountry: undefined });
    const response = await run(built.cmd, 'country', []);
    const text = textOf(response);

    expect(built.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
    expect(text).toContain('Boards of Canada');
    expect(text).toContain('From **United Kingdom**');
  });

  it('asks for a name when there is no scrobble to guess from', async () => {
    const built = build({ matchCountry: undefined, recents: [] });
    const response = await run(built.cmd, 'country', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('Please specify a country or artist name');
    // The examples carry the server's real prefix.
    expect(textOf(response)).toContain('`!country Japan`');
  });

  it('still asks for a name when the scrobble read itself failed', async () => {
    // `catch { /* ignore */ }` here, and the consequence is that an outage and
    // an empty history are indistinguishable. That is TOLERABLE for this branch
    // specifically, because the reply is a question, not a claim: it says no
    // target was supplied and none could be derived, and it is true either way.
    // Pinned so the tolerance is deliberate rather than accidental.
    const built = build({ matchCountry: undefined, recentsThrow: LFM_DOWN('user.getrecenttracks') });
    const response = await run(built.cmd, 'country', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('Please specify a country or artist name');
    // And crucially: it does NOT go on to invent an artist to answer about.
    expect(built.getArtistInfoWithCountry).not.toHaveBeenCalled();
  });

  it('ignores a scrobble with no artist name rather than searching for an empty one', async () => {
    const built = build({ matchCountry: undefined, recents: [{ artistName: '' }] });
    const response = await run(built.cmd, 'country', []);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(built.getArtistInfoWithCountry).not.toHaveBeenCalled();
  });

  it('trims the argument, so a trailing space is not part of the name', async () => {
    const built = build({ matchCountry: undefined });
    await run(built.cmd, 'country', ['   Radiohead   ']);

    expect(built.getArtistInfoWithCountry).toHaveBeenCalledWith('Radiohead');
  });

  it('joins a multi-token artist name back into one', async () => {
    // The dispatcher hands `args: string[]`, and this is a hand-written grammar,
    // so the join is load-bearing: without it the card is about `Godspeed`.
    const built = build({ matchCountry: undefined });
    await run(built.cmd, 'country', ['Godspeed', 'You!', 'Black', 'Emperor']);

    expect(built.getArtistInfoWithCountry).toHaveBeenCalledWith('Godspeed You! Black Emperor');
  });
});
