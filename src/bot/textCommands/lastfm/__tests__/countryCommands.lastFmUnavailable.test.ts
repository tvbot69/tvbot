/**
 * The text-command half of the same hole as
 * `countrySlashCommands.lastFmUnavailable.test.ts`, kept as its own file
 * because the repo puts a test next to the module it exercises and these are
 * two modules.
 *
 * `.topcountries` and `.countrychart` read `lastFmRepository.getTopArtists`
 * inside `try { ... } catch { countries = [] }`, which laundered the
 * `LastFmUnavailableError` that `getTopArtists` now raises straight back into
 * the empty list. For `.countrychart` the next branch renders
 * "No country data found for <name>", so an outage told the user their map was
 * empty - indistinguishable from a user whose country genuinely is unknown.
 *
 * Both directions are asserted, and the doubles are plain constructor stubs
 * built fresh per test. No `vi.spyOn`: nothing here shares an object with
 * another test, so there is no `mockRestore` hazard to reason about.
 *
 * The sixth positional constructor argument (`colorService?`) is deliberately
 * left undefined so both handlers skip the accent-colour read.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CountryCommands } from '@bot/textCommands/lastfm/countryCommands';
import { TimePeriod } from '@domain/enums/timePeriod';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/user/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService } from '@bot/services/library/countryService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

/** The real transport failure, built the way `lastfmApi` builds it. */
const LFM_DOWN = () =>
  new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500'));

const USER = { userId: 7, userNameLastFm: 'DreadRock' };

/** No `interaction`: the text handlers read the query string, not options. */
const makeContext = (): ContextModel =>
  ({ discordUserId: 'caller1' }) as unknown as ContextModel;

const build = (getTopArtists: () => Promise<never[]>) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => USER),
    getUserByLastFmName: vi.fn(async () => USER),
  } as unknown as UserService;
  // `timePeriod` deliberately SET, so the `getUserTopCountriesAllTime`
  // short-circuit is skipped and the handler is forced onto the Last.fm read.
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
  const cmd = new CountryCommands(
    userService,
    settingService,
    lastfmRepository,
    countryService,
    {} as WorldMapGenerator,
  );
  return { cmd, lastfmRepository, countryService };
};

/** Both methods under test are public; only the argument shape is uniform. */
const HANDLERS: Array<[string, (c: CountryCommands, ctx: ContextModel) => Promise<unknown>]> = [
  ['topCountriesAsync', (c, ctx) => c.topCountriesAsync(ctx, '')],
  ['countryChartAsync', (c, ctx) => c.countryChartAsync(ctx, '')],
];

describe('CountryCommands: a Last.fm outage is not an empty country map', () => {
  it.each(HANDLERS)('%s re-throws the deliberate signal instead of rendering an empty map', async (_label, invoke) => {
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    await expect(invoke(cmd, makeContext())).rejects.toBeInstanceOf(LastFmUnavailableError);
  });

  it.each(HANDLERS)('%s still degrades a genuine query failure to the empty list', async (_label, invoke) => {
    // The other half of the pair: narrowing the catch to `isSourceUnavailable`
    // must not have turned an ordinary database failure into a raised one.
    const { cmd, countryService } = build(() => Promise.resolve([]));
    vi.mocked(countryService.getTopCountriesForTopArtists).mockRejectedValue(
      new Error("Can't reach database server"),
    );
    await expect(invoke(cmd, makeContext())).resolves.toBeDefined();
  });

  it('countryChartAsync no longer answers "No country data found" for an outage', async () => {
    // The user-visible half, and the one a user would actually see. The
    // re-throwing version fails it by throwing; the laundering version fails it
    // by returning that sentence.
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    const settled = await cmd
      .countryChartAsync(makeContext(), '')
      .then((r) => r as unknown as string, (e: unknown) => e);
    expect(settled).toBeInstanceOf(LastFmUnavailableError);
    expect(String(settled)).not.toContain('No country data found');
  });

  it('topCountriesAsync maps the artists Last.fm returned', async () => {
    // The ordinary path still works, so the re-throw is not a blanket refusal.
    const artists = [{ name: 'Radiohead', playcount: 1200 }];
    const { cmd, countryService } = build(() => Promise.resolve(artists as never[]));
    await cmd.topCountriesAsync(makeContext(), '');
    expect(countryService.getTopCountriesForTopArtists).toHaveBeenCalledWith(artists, true);
  });
});
