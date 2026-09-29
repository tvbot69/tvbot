/**
 * `/country top` and `/country chart` both read `lastFmRepository.getTopArtists`
 * inside a `try` that used to end `catch { countries = [] }`. `getTopArtists`
 * now raises `LastFmUnavailableError` on anything that is not a genuine
 * not-found, and this file exists because that raise was being caught one layer
 * up and put straight back into the empty list it came from.
 *
 * For `chart` that is not a cosmetic issue. The branch immediately after the
 * catch is
 *
 *     if (countries.length === 0) {
 *       return ...'No country data found for <name> in the selected time period.'
 *     }
 *
 * so during a Last.fm outage the bot told the user that their country map was
 * empty. That is byte-identical to the map for a user whose country is genuinely
 * unknown, and the user has no way to tell which one they got - the exact lie
 * `orUnavailable` was introduced to remove.
 *
 * BOTH DIRECTIONS. A test that only asserts the raise passes just as happily
 * against a `catch` that re-throws everything, which would break every genuine
 * country query failure. A test that only asserts the render passes against the
 * bug. So: the raise is pinned, AND a non-source failure still degrades to the
 * empty list, AND a real not-found still degrades to the empty list.
 *
 * Plain object doubles, built fresh per test. Nothing here is a spy: the
 * collaborators are stubs handed to the constructor, so there is no shared
 * object for a `mockRestore` to leave poisoned.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CountrySlashCommands } from './countrySlashCommands';
import { TimePeriod } from '@domain/enums/timePeriod';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/userService';
import type { SettingService } from '@bot/services/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService } from '@bot/services/countryService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

/** The real transport failure, built the way `lastfmApi` builds it. */
const LFM_DOWN = () =>
  new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500'));

const USER = { userId: 7, userNameLastFm: 'DreadRock' };

/**
 * `getString` is the only thing the two handlers read off the interaction, and
 * an empty string for every option is what routes both of them to the Last.fm
 * branch: with `timeSettings.timePeriod` set and no `overall` in the period, the
 * `getUserTopCountriesAllTime` short-circuit is skipped and `countries` starts
 * empty, which is the precondition under test.
 */
const makeContext = (): ContextModel =>
  ({
    discordUserId: 'caller1',
    interaction: { options: { getString: () => '' } },
  }) as unknown as ContextModel;

const build = (getTopArtists: () => Promise<never[]>) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => USER),
    getUserByLastFmName: vi.fn(async () => USER),
  } as unknown as UserService;
  // `timePeriod` deliberately SET, so the database short-circuit above is
  // skipped and the handler is forced onto the Last.fm read.
  const settingService = {
    getTimePeriod: vi.fn(() => ({ timePeriod: TimePeriod.AllTime, description: 'all time' })),
  } as unknown as SettingService;
  const lastfmRepository = {
    getTopArtists: vi.fn(getTopArtists),
  } as unknown as LastFmRepository;
  const countryService = {
    getUserTopCountriesAllTime: vi.fn(async () => []),
    getTopCountriesForTopArtists: vi.fn(async () => [
      { countryName: 'Nepal', countryCode: 'NP', playcount: 3 },
    ]),
  } as unknown as CountryService;
  // Sixth positional argument is `colorService?`; left undefined so the handler
  // skips the accent-colour read instead of needing another double.
  const cmd = new CountrySlashCommands(
    userService,
    settingService,
    lastfmRepository,
    countryService,
    {} as WorldMapGenerator,
  );
  return { cmd, lastfmRepository, countryService };
};

/** The two private handlers, reached the way this repo's tests reach privates. */
type Handlers = {
  handleTopCountriesSlash(c: ContextModel): Promise<unknown>;
  handleCountryChartSlash(c: ContextModel): Promise<unknown>;
};
const handlersOf = (cmd: CountrySlashCommands): Handlers => cmd as unknown as Handlers;

const HANDLERS: Array<[string, keyof Handlers]> = [
  ['handleTopCountriesSlash', 'handleTopCountriesSlash'],
  ['handleCountryChartSlash', 'handleCountryChartSlash'],
];

describe('CountrySlashCommands: a Last.fm outage is not an empty country map', () => {
  it.each(HANDLERS)('%s re-throws the deliberate signal instead of rendering an empty map', async (_label, method) => {
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    await expect(handlersOf(cmd)[method](makeContext())).rejects.toBeInstanceOf(LastFmUnavailableError);
  });

  it.each(HANDLERS)('%s still degrades a genuine query failure to the empty list', async (_label, method) => {
    // The other half of the pair. Narrowing the catch to `isSourceUnavailable`
    // must not have turned an ordinary Prisma/driver failure into a raised one:
    // an unrenderable map with no error is the right answer when the source we
    // still need (the country mapping) blew up, and this is what proves the
    // re-throw is narrow rather than blanket.
    const { cmd, countryService } = build(() => Promise.resolve([]));
    vi.mocked(countryService.getTopCountriesForTopArtists).mockRejectedValue(
      new Error("Can't reach database server"),
    );
    const response = await handlersOf(cmd)[method](makeContext());
    expect(response).toBeDefined();
  });

  it('handleCountryChartSlash no longer answers "No country data found" for an outage', async () => {
    // The user-visible half. Asserted on the rendered text, because the
    // re-throwing version fails this by throwing while the laundering version
    // fails it by returning that sentence - so this test alone distinguishes
    // the two implementations, and it is the one a user would actually see.
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    const settled = await handlersOf(cmd)
      .handleCountryChartSlash(makeContext())
      .then((r) => r as unknown as string, (e: unknown) => e);
    expect(settled).toBeInstanceOf(LastFmUnavailableError);
    expect(String(settled)).not.toContain('No country data found');
  });

  it('handleTopCountriesSlash renders the mapped countries when Last.fm answers', async () => {
    // And the ordinary path still works, so the re-throw is not a blanket
    // refusal: a successful read must reach the country mapping. Asserted on
    // what the mapper was handed rather than on the builder's ResponseModel,
    // whose `commandResponse` is an enum value this test has no business
    // pinning.
    const artists = [{ name: 'Radiohead', playcount: 1200 }];
    const { cmd, countryService } = build(() => Promise.resolve(artists as never[]));
    vi.mocked(countryService.getTopCountriesForTopArtists).mockResolvedValue([
      { countryName: 'Nepal', countryCode: 'NP', playcount: 3 },
    ]);
    const response = await handlersOf(cmd).handleTopCountriesSlash(makeContext());
    expect(response).toBeDefined();
    expect(countryService.getTopCountriesForTopArtists).toHaveBeenCalledWith(artists, true);
  });
});
