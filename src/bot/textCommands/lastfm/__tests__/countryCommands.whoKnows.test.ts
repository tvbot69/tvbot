/**
 * `.whoknowscountry` — the guild-only "who listens to this country" list, and
 * `.countrychart` — the rendered world map.
 *
 * The `.addfriends` outage work and the two `.country` outage siblings already
 * live in their own files. Nothing here repeats them. What is here is the pair
 * those files could not reach, and it is the most dangerous shape in this
 * module: **a claim about every member of a guild.**
 *
 * `.whoknowscountry` with `items: []` renders "Nobody in **Test Guild** has
 * listened to artists from **Japan** yet!" That sentence is TRUE, and it is also
 * exactly what a failed guild-scoped aggregate produces if the failure is
 * laundered. The user cannot tell the two apart, and they have no reason to
 * doubt the bot. So:
 *
 *   - `getGuildUsersForCountry` THROWS -> the rejection must reach the command
 *     boundary. `.wkc` has no second card to offer, and "nobody" is worse than
 *     an error.
 *   - `getGuildUsersForCountry` returns `[]` -> the not-found card, honestly.
 *
 * Both are asserted, because a test that only pinned the throw would pass
 * against a `.catch(() => [])`, and one that only pinned the empty would pass
 * against a blanket refusal.
 *
 * **The country-name grammar** is the second axis. `searchCountry` matches a
 * code, a full name, an emoji and any alias, and `.wkc UK` is the documented
 * spelling. An unmatched input must be refused with the input named, not treated
 * as an artist and not silently matched to nothing.
 *
 * **`.countrychart` has a theme token in the same option string as the period**,
 * which is precisely the `.fm` layout-token shape from the sibling family: the
 * theme is read by a regex over the WHOLE string and then removed with
 * `.replace(themeMatch[0], '')`. Both halves are pinned, because the trap is
 * that a theme word inside a real search value would be eaten. There is no
 * search value on this command — only a period — so what is pinned is the
 * removal actually happening (the period still parses afterwards) and the theme
 * word NOT surviving into the period string.
 *
 * Constructor arity: (userService, settingService, lastfmRepository,
 * countryService, worldMapGenerator, colorService?).
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CountryCommands } from '../countryCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { CountryChartTheme } from '@images/generators/worldMapGenerator';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import type { UserService } from '@bot/services/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type {
  CountryService,
  CountryInfo,
  TopCountryItem,
  WhoKnowsCountryItem,
} from '@bot/services/countryService';
import type { ColorService } from '@bot/services/system/colorService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

vi.mock('@bot/interactions/countryInteractions', () => ({
  storeCountryQuery: vi.fn(),
}));

import { storeCountryQuery } from '@bot/interactions/countryInteractions';

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

const dmCtx = (): ContextModel => ctx({ guildId: undefined, guild: null });

const JAPAN: CountryInfo = { Name: 'Japan', Code: 'JP', Emoji: ':flag_jp:' };

type Over = {
  caller?: User | null;
  /** `null` = the service found no such country; omit for the default (Japan). */
  matchCountry?: CountryInfo | null;
  guildUsers?: WhoKnowsCountryItem[] | null;
  guildUsersThrow?: unknown;
  countries?: TopCountryItem[] | null;
  countriesThrow?: unknown;
  timeSettings?: Partial<TimeSettingsModel>;
  /** What `getUserByLastFmName` answers for an `lfm:` target. `null` by default. */
  registeredTarget?: User | null;
  byDiscordId?: Record<string, User | null>;
  withColorService?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      // Narrowed by id where the test says so, because a mention target that
      // resolves to the CALLER is the failure mode this grammar has to avoid.
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return over.caller === undefined ? caller() : over.caller;
    }),
    // `null` by default: an `lfm:` target is only registered if the repository
    // says so, and a double that answers for every name makes the
    // "no database id" path unreachable.
    getUserByLastFmName: vi.fn(async () => over.registeredTarget ?? null),
  } as unknown as UserService;

  const timeSettings: TimeSettingsModel = {
    timePeriod: undefined,
    description: 'Weekly',
    searchValue: '',
    ...over.timeSettings,
  } as TimeSettingsModel;
  const getTimePeriod = vi.fn(() => timeSettings);
  const settingService = { getTimePeriod } as unknown as SettingService;

  const getTopArtists = vi.fn(async (..._args: unknown[]) => {
    if (over.countriesThrow) throw over.countriesThrow;
    return [{ name: 'Radiohead', playcount: 120 }];
  });
  const lastfmRepository = { getTopArtists } as unknown as LastFmRepository;

  const getGuildUsersForCountry = vi.fn(async () => {
    if (over.guildUsersThrow) throw over.guildUsersThrow;
    return over.guildUsers ?? [];
  });
  // The indexed read returns the SAME rows as the Last.fm path by default, so
  // "took the index" and "fell back to Last.fm" produce the same card and only
  // the spy distinguishes them. With an empty index the fallback always runs.
  const getUserTopCountriesAllTime = vi.fn(async () => over.countries ?? []);
  const getTopCountriesForTopArtists = vi.fn(async () => over.countries ?? []);
  const countryService = {
    searchCountry: vi.fn(() => (over.matchCountry === null ? undefined : (over.matchCountry ?? JAPAN))),
    getGuildUsersForCountry,
    getUserTopCountriesAllTime,
    getTopCountriesForTopArtists,
  } as unknown as CountryService;

  const generateWorldMap = vi.fn(async (..._args: unknown[]) => Buffer.from('fake-png-bytes'));
  const worldMapGenerator = { generateWorldMap } as unknown as WorldMapGenerator;

  const getAccentColorAsync = vi.fn(async (..._args: unknown[]) => 0x445566);
  const colorService = { getAccentColorAsync } as unknown as ColorService;

  // The sixth argument is OPTIONAL. Passing `undefined` is the only way to reach
  // the `: null` arm of the accent ternaries, which are guarded on the service as
  // well as on the guild.
  const cmd = new CountryCommands(
    userService,
    settingService,
    lastfmRepository,
    countryService,
    worldMapGenerator,
    over.withColorService === false ? undefined : colorService,
  );

  return {
    cmd,
    getGuildUsersForCountry,
    getUserTopCountriesAllTime,
    getTopCountriesForTopArtists,
    getTopArtists,
    getTimePeriod,
    generateWorldMap,
    getAccentColorAsync,
    userService: userService as unknown as {
      getUserByDiscordId: ReturnType<typeof vi.fn>;
      getUserByLastFmName: ReturnType<typeof vi.fn>;
    },
  };
};

const run = (cmd: CountryCommands, name: string, args: string[], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

const listener = (name: string, playcount: number): WhoKnowsCountryItem => ({
  userId: 9,
  discordUserId: `discord-${name}`,
  userNameLastFm: name,
  playcount,
});

beforeEach(() => {
  vi.mocked(storeCountryQuery).mockClear();
});

describe('whoknowscountry — a claim about every member of the guild', () => {
  it('is refused in a DM before any guild read', async () => {
    const built = build();
    const response = await run(built.cmd, 'whoknowscountry', ['Japan'], dmCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(built.getGuildUsersForCountry).not.toHaveBeenCalled();
  });

  it('propagates a guild aggregate that cannot be read, instead of claiming nobody listens', async () => {
    // THE CLAIM. "Nobody in Test Guild has listened to artists from Japan yet!"
    // is a statement about every member, and it is what a database outage
    // produces if the failure is swallowed. There is no second card here, so the
    // rejection is the signal.
    const built = build({ guildUsersThrow: new Error('P1001: Cannot reach database server') });

    await expect(run(built.cmd, 'whoknowscountry', ['Japan'])).rejects.toThrow(
      /Cannot reach database server/,
    );
  });

  it('renders that sentence only for a GENUINE empty guild', async () => {
    // The other half of the pair. Without this a blanket refusal would pass the
    // test above and break real guilds.
    const built = build({ guildUsers: [] });
    const response = await run(built.cmd, 'whoknowscountry', ['Japan']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('Nobody in **Test Guild** has listened to artists from **Japan** yet');
  });

  it('lists the listeners with their playcounts and totals', async () => {
    const built = build({
      guildUsers: [listener('alpha', 120), listener('beta', 30)],
    });
    const response = await run(built.cmd, 'whoknowscountry', ['Japan']);
    const text = textOf(response);

    expect(text).toContain('alpha');
    expect(text).toContain('120');
    expect(text).toContain('2 listeners');
    expect(text).toContain('150 total scrobbles');
  });

  it('renders with no colour service injected, the sixth argument being optional', async () => {
    // `context.guild.id && this.colorService ? … : null` — the second half of
    // the `&&` is only reached when the service is absent, which is the optional
    // constructor argument. A card that threw here would lose the whole
    // who-knows list over a colour.
    const built = build({ matchCountry: JAPAN, guildUsers: [listener('alpha', 1)], withColorService: false });
    const response = await run(built.cmd, 'whoknowscountry', ['Japan']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('alpha');
    expect(built.getAccentColorAsync).not.toHaveBeenCalled();
  });

  it('reads the accent for the guild it is reporting on, not the caller\'s channel', async () => {
    // `context.guild.id` is the argument, and the card is titled with the guild
    // NAME from the same object. Reading a different guild's accent would tint a
    // card about this one with another server's branding.
    const built = build({ matchCountry: JAPAN, guildUsers: [listener('alpha', 1)] });
    await run(built.cmd, 'whoknowscountry', ['Japan']);

    expect(built.getAccentColorAsync).toHaveBeenCalledWith('900000000000000001');
  });

  it('asks for a country rather than guessing one', async () => {
    const built = build();
    const response = await run(built.cmd, 'whoknowscountry', ['   ']);

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(textOf(response)).toContain('`!whoknowscountry Japan`');
    expect(built.getGuildUsersForCountry).not.toHaveBeenCalled();
  });

  it('names the unmatched input instead of silently matching nothing', async () => {
    // An unmatched country must not fall through to "nobody has listened" — the
    // user typed a typo and would be told a fact about their guild instead.
    const built = build({ matchCountry: null });
    const response = await run(built.cmd, 'whoknowscountry', ['Jpan']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('Could not find a country matching **Jpan**');
    expect(built.getGuildUsersForCountry).not.toHaveBeenCalled();
  });

  it('asks the guild aggregate by CODE, not by the spelling the user typed', async () => {
    // `.wkc UK` must query `GB`. Querying by the typed alias would silently
    // return nothing for every user who used the short spelling.
    const built = build({ matchCountry: JAPAN, guildUsers: [listener('alpha', 1)] });
    await run(built.cmd, 'whoknowscountry', ['japan']);

    expect(built.getGuildUsersForCountry).toHaveBeenCalledWith('900000000000000001', 'JP');
  });

  it('does not offer a second page when every listener fits on one', async () => {
    const built = build({ guildUsers: [listener('alpha', 1)] });
    const response = await run(built.cmd, 'whoknowscountry', ['Japan']);

    // "Page 1/2" with one listener is a Next button leading nowhere.
    expect(textOf(response)).not.toContain('Page 1/2');
    expect(textOf(response)).toContain('1 listener');
  });

  it('counts one listener as one, not as a plural', async () => {
    const built = build({ guildUsers: [listener('solo', 5)] });
    // `buildWhoKnowsCountryResponse` used to render `${items.length} listeners`
    // with the plural HARDCODED, so a guild with exactly one listener was told
    // "1 listeners" while the row two lines above it correctly said "1 play".
    // The card contradicted itself about the same list. Fixed in
    // `countryBuilders.ts` — `whoKnowsBuilders` already had the same rule for
    // the same quantity.
    const text = textOf(await run(built.cmd, 'whoknowscountry', ['Japan']));
    expect(text).toContain('1 listener ·');
    expect(text).not.toContain('1 listeners');
  });

  it('stores the country so page two renders the same one', async () => {
    const built = build({ matchCountry: JAPAN, guildUsers: [listener('alpha', 1)] });
    await run(built.cmd, 'whoknowscountry', ['Japan']);

    expect(storeCountryQuery).toHaveBeenCalledTimes(1);
    const [, stored] = vi.mocked(storeCountryQuery).mock.calls[0]!;
    expect(stored).toMatchObject({
      type: 'wkc',
      country: JAPAN,
      serverName: 'Test Guild',
      guildId: '900000000000000001',
    });
  });
});

describe('countrychart — the short-circuit on the indexed all-time read', () => {
  const countries: TopCountryItem[] = [{ countryName: 'Japan', countryCode: 'JP', playcount: 300 }];

  it('uses the index for an all-time chart and never touches Last.fm', async () => {
    // `timePeriod === undefined` is the signal, and it is only reachable when
    // the option string names NO period. The Last.fm read is the slow path with
    // a 1000-artist page, so taking the index here is the whole point of the
    // branch — and if it were taken for a weekly chart, the map would show
    // all-time data under a weekly title.
    const built = build({ countries, timeSettings: { description: 'Alltime', timePeriod: undefined } });
    await run(built.cmd, 'countrychart', []);

    expect(built.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
    expect(built.getTopArtists).not.toHaveBeenCalled();
  });

  it('takes the index when the user typed `alltime` explicitly', async () => {
    const built = build({
      countries,
      timeSettings: { description: 'Alltime', timePeriod: TimePeriod.AllTime },
    });
    await run(built.cmd, 'countrychart', ['alltime']);

    // `cleanQuery.includes('alltime')` is checked alongside the period, because
    // `getTimePeriod` normalises the token away before the branch reads it.
    expect(built.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
    expect(built.getTopArtists).not.toHaveBeenCalled();
  });

  it('takes the index for `overall` too, the other spelling', async () => {
    const built = build({
      countries,
      timeSettings: { description: 'Alltime', timePeriod: TimePeriod.AllTime },
    });
    await run(built.cmd, 'countrychart', ['overall']);

    expect(built.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
  });

  it('does not take the index for a caller with no database id', async () => {
    // The `lfm:` path can resolve a Last.fm name with no registered user, and
    // then there is no id to query the index by. Falling back to Last.fm is
    // correct; skipping straight to the chart would render "no country data".
    const built = build({ countries, timeSettings: { description: 'Alltime' } });
    const context = ctx();
    built.cmd.commands.find((c) => c.name === 'countrychart')!;

    // Drive the no-id path through the `lfm:` target: `getUserByLastFmName`
    // returns null, so `userId` is undefined.
    await run(built.cmd, 'countrychart', ['lfm:someone-unregistered', 'alltime'], context);

    expect(built.getUserTopCountriesAllTime).not.toHaveBeenCalled();
  });

  it('still renders when both the index and Last.fm come back empty', async () => {
    const built = build({ countries: [], timeSettings: { description: 'Weekly', timePeriod: TimePeriod.Weekly } });
    const response = await run(built.cmd, 'countrychart', ['weekly']);

    // The genuine empty, and it is a refusal rather than a blank map — which is
    // the distinction the outage tests above exist to protect.
    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('No country data found for **DreadRock**');
    expect(built.generateWorldMap).not.toHaveBeenCalled();
  });
});

describe('countrychart — the theme token and the period token share one string', () => {
  const countries: TopCountryItem[] = [
    { countryName: 'Japan', countryCode: 'JP', playcount: 300 },
    { countryName: 'United Kingdom', countryCode: 'GB', playcount: 100 },
  ];

  it('renders the map with the default theme when no theme is named', async () => {
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    const response = await run(built.cmd, 'countrychart', ['weekly']);

    expect(built.generateWorldMap).toHaveBeenCalledWith(countries, CountryChartTheme.Dark);
    expect(response.hasFile()).toBe(true);
    expect(response.fileName).toBe('artist-map.png');
  });

  it.each([
    ['light', CountryChartTheme.Light],
    ['ocean', CountryChartTheme.Ocean],
    ['synthwave', CountryChartTheme.Synthwave],
    ['sunset', CountryChartTheme.Sunset],
    ['forest', CountryChartTheme.Forest],
    ['dark', CountryChartTheme.Dark],
  ])('reads `%s` as a theme, case-insensitively', async (token, theme) => {
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    await run(built.cmd, 'countrychart', [token, 'weekly']);

    expect(built.generateWorldMap).toHaveBeenCalledWith(countries, theme);
  });

  it('strips the theme token so the PERIOD still parses', async () => {
    // The `.fm` layout-token shape exactly: the token is removed from the same
    // string the period is parsed out of, so a removal that did not happen would
    // leave `ocean` in the period string and quietly widen the query.
    const built = build({ countries, timeSettings: { description: 'Monthly' } });
    await run(built.cmd, 'countrychart', ['ocean', 'monthly']);

    expect(built.getTimePeriod).toHaveBeenCalledWith('monthly');
  });

  it('reads the theme from the TAIL as well as the head', async () => {
    // `.cc monthly ocean` must be identical to `.cc ocean monthly`, or the same
    // request in a different order would render a different map.
    const built = build({ countries, timeSettings: { description: 'Monthly' } });
    await run(built.cmd, 'countrychart', ['monthly', 'ocean']);

    expect(built.generateWorldMap).toHaveBeenCalledWith(countries, CountryChartTheme.Ocean);
    expect(built.getTimePeriod).toHaveBeenCalledWith('monthly');
  });

  it('does not treat a theme word inside a longer word as a theme', async () => {
    // `\b(light|...)\b` is the guard. Without the word boundary, `highlight`
    // would set the theme and leave the period string mangled.
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    await run(built.cmd, 'countrychart', ['highlight', 'weekly']);

    expect(built.generateWorldMap).toHaveBeenCalledWith(countries, CountryChartTheme.Dark);
    expect(built.getTimePeriod).toHaveBeenCalledWith('highlight weekly');
  });

  it('picks the all-time index only when the caller has a user id and no period', async () => {
    const built = build({ countries });
    await run(built.cmd, 'countrychart', []);

    expect(built.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
  });

  it('falls back to Last.fm top artists when the index returned nothing', async () => {
    // `timePeriod` SET, which is what skips the all-time index short-circuit and
    // forces the handler onto the Last.fm read. Leaving it `undefined` would
    // take the index path and this test would assert nothing about the fallback.
    const built = build({ countries, timeSettings: { description: 'Weekly', timePeriod: TimePeriod.Weekly } });
    await run(built.cmd, 'countrychart', ['weekly']);

    expect(built.getUserTopCountriesAllTime).not.toHaveBeenCalled();
    expect(built.getTopArtists).toHaveBeenCalledWith('DreadRock', TimePeriod.Weekly, 1000);
    expect(built.getTopCountriesForTopArtists).toHaveBeenCalled();
  });

  it('renders the map as a file rather than an image URL', async () => {
    // The card references `attachment://artist-map.png`, so a missing file would
    // render a gallery item pointing at nothing.
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    const response = await run(built.cmd, 'countrychart', ['weekly']);

    expect(response.fileName).toBe('artist-map.png');
    expect(response.hasFile()).toBe(true);
    expect(response.fileDescription).toBe('World artist map for DreadRock');
    // The gallery references the attachment BY NAME, so the attached filename
    // and the referenced filename have to agree or the map renders as a hole.
    // `media.url`, not `url` — `MediaGalleryItemBuilder.toJSON()` nests the
    // field, and a probe reading the wrong level finds `undefined` and passes
    // for the wrong reason.
    const gallery = (response.componentsV2Container?.toJSON() as {
      components: Array<{ items?: Array<{ media?: { url?: string } }> }>;
    }).components.find((c) => c.items);
    expect(gallery?.items?.map((i) => i.media?.url)).toEqual(['attachment://artist-map.png']);
  });

  it('names the caller and their library in the link, for the period asked for', async () => {
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    const response = await run(built.cmd, 'countrychart', ['weekly']);

    expect(textOf(response)).toContain('DreadRock');
    expect(textOf(response)).toContain('last.fm/user/DreadRock/library/artists');
  });

  it('stores the resolved theme so the selector re-renders the same map', async () => {
    const built = build({ countries, timeSettings: { description: 'Weekly' } });
    await run(built.cmd, 'countrychart', ['synthwave', 'weekly']);

    const [, stored] = vi.mocked(storeCountryQuery).mock.calls[0]!;
    expect(stored).toMatchObject({ type: 'chart', currentTheme: CountryChartTheme.Synthwave });
  });

  it('refuses an unregistered caller instead of charting nobody', async () => {
    const built = build({ caller: null, countries });
    const response = await run(built.cmd, 'countrychart', ['weekly']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('`!register`');
    expect(built.generateWorldMap).not.toHaveBeenCalled();
  });
});
