/**
 * `/country info <artist>` - the artist branch, and the third catch in this file
 * that converted a deliberate `LastFmUnavailableError` back into a default.
 *
 * The two handlers already fixed in this file (`handleTopCountriesSlash`,
 * `handleCountryChartSlash`) read `getTopArtists` and lost the WHOLE answer when
 * it failed, so the laundering was obvious: an empty country list rendered as
 * real data. This one is worse and quieter, because it is the partial-success
 * shape the plan calls out as the insidious case.
 *
 * WHAT THE USER SAW. `/country info Radiohead` runs two independent reads:
 * `countryService.getArtistInfoWithCountry` (MusicBrainz + our own database) for
 * the country, flag and artwork, and `lastfmRepository.getArtistInfo(target,
 * userName)` for the caller's own playcount. Only the second one is Last.fm.
 * `catch { }` dropped just that one field, and
 * `buildArtistCountryInfoResponse` only prints the playcount clause when
 * `userPlaycount > 0`. So an outage produced a card with a correct flag, a
 * correct country, real artwork and no playcount line - BYTE-IDENTICAL to the
 * card for a user who has genuinely never played the artist. Every populated
 * column was true. The only column that was not there was the one that failed,
 * and nothing on the card said so. That is a plausible wrong answer, not an
 * honest empty.
 *
 * BOTH DIRECTIONS, because a test that only asserts the raise passes just as
 * happily against a `catch` that re-throws everything - which would break a
 * genuine query failure. And a test that only asserts the render passes against
 * the bug, which is what the old code did. So: the deliberate signal is
 * re-thrown; a NON-source failure still degrades to the no-playcount card; a
 * Last.fm that answered with no playcount for this user still renders that
 * card; and a real playcount still renders its clause. That last one matters -
 * without it, "always omit the playcount line" would pass everything.
 *
 * Doubles are plain objects built fresh per test and handed to the
 * constructor. No `vi.spyOn` on the object under test, on a builder, or on any
 * shared client, so there is no `mockRestore` own-property hazard here.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CountrySlashCommands } from '@bot/slashCommands/countrySlashCommands';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/user/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService } from '@bot/services/library/countryService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

/** The real transport failure, built the way `lastfmApi` builds it. */
const LFM_DOWN = () =>
  new LastFmUnavailableError('artist.getinfo', new Error('Last.fm returned HTTP 500'));

const CALLER = { userId: 7, userNameLastFm: 'DreadRock' };

/** "Radiohead" is not a country, so `searchCountry` returns undefined. */
const RADIOHEAD_COUNTRY = { Name: 'United Kingdom', Code: 'GB', Emoji: ':flag_gb:' };

const makeContext = (): ContextModel =>
  ({
    discordUserId: 'caller1',
    interaction: { options: { getString: () => '' } },
  }) as unknown as ContextModel;

/**
 * Constructor arity, read from `countrySlashCommands.ts`:
 * (userService, settingService, lastfmRepository, countryService,
 *  worldMapGenerator, colorService?). The sixth is left undefined so the handler
 * skips the accent-colour read; the context has no `guild` either, so that
 * branch is unreachable regardless.
 */
const build = (getArtistInfo: () => Promise<unknown>) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => CALLER),
    getUserByLastFmName: vi.fn(async () => CALLER),
  } as unknown as UserService;
  const settingService = {
    getTimePeriod: vi.fn(() => ({ description: 'all time' })),
  } as unknown as SettingService;
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async () => []),
    getArtistInfo: vi.fn(getArtistInfo),
  } as unknown as LastFmRepository;
  const countryService = {
    // Must be undefined so control reaches the artist branch.
    searchCountry: vi.fn(() => undefined),
    getArtistInfoWithCountry: vi.fn(async () => ({
      country: RADIOHEAD_COUNTRY,
      spotifyImageUrl: 'https://example.test/radiohead.jpg',
    })),
  } as unknown as CountryService;
  const cmd = new CountrySlashCommands(
    userService,
    settingService,
    lastfmRepository,
    countryService,
    {} as WorldMapGenerator,
  );
  return { cmd, lastfmRepository, countryService };
};

type Handlers = { handleCountryInfoSlash(c: ContextModel, search: string): Promise<ResponseModel> };
const handlersOf = (cmd: CountrySlashCommands): Handlers => cmd as unknown as Handlers;

/** Every text line the user would actually read on the card. */
const cardText = (response: ResponseModel): string =>
  (response.componentsV2Container?.toJSON() as { components: Array<{ content?: string }> })
    .components.map((c) => c.content ?? '')
    .join('\n');

describe('CountrySlashCommands.handleCountryInfoSlash: a Last.fm outage is not a user with zero plays', () => {
  it('re-throws the deliberate signal instead of rendering a confident playcount-less card', async () => {
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    await expect(handlersOf(cmd).handleCountryInfoSlash(makeContext(), 'Radiohead')).rejects.toBeInstanceOf(
      LastFmUnavailableError,
    );
  });

  it('never renders a card at all for an outage (the user-visible half)', async () => {
    // The laundering version returns a ResponseModel here, and that ResponseModel
    // contains a correct country and no playcount - indistinguishable from a
    // real zero. Asserted on what came back rather than on the thrown type, so
    // it fails for the right reason if the catch is ever widened back out.
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    const settled = await handlersOf(cmd)
      .handleCountryInfoSlash(makeContext(), 'Radiohead')
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect((settled.e as Error).message).toMatch(/artist\.getinfo/);
  });

  it('still renders the card when a NON-source failure hits the Last.fm read', async () => {
    // The other half of the pair. Narrowing to `isSourceUnavailable` must not
    // have turned an ordinary driver error into a raised one: the country, the
    // flag and the artwork all came back fine, and throwing them away over a
    // secondary playcount lookup would be a worse regression than the original.
    const { cmd } = build(() => Promise.reject(new Error('socket hang up')));
    const response = await handlersOf(cmd).handleCountryInfoSlash(makeContext(), 'Radiohead');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('United Kingdom');
  });

  it('renders the same playcount-less card when Last.fm ANSWERS with no playcount', async () => {
    // The genuine empty, and the half the fix must not disturb. `getArtistInfo`
    // returning null is a real "no userplaycount for this user" from
    // `orUnavailable`'s not-found branch, and it must keep rendering the card
    // with the playcount clause absent.
    const { cmd } = build(() => Promise.resolve(null));
    const response = await handlersOf(cmd).handleCountryInfoSlash(makeContext(), 'Radiohead');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('United Kingdom');
    expect(text).not.toContain('You have');
  });

  it('still renders the playcount clause when Last.fm answers with one', async () => {
    // Without this, "always omit the playcount line" passes the whole file.
    // Asserted on the rendered card because that is what the user reads.
    const { cmd } = build(() => Promise.resolve({ name: 'Radiohead', userPlayCount: 4321 }));
    const text = cardText(
      await handlersOf(cmd).handleCountryInfoSlash(makeContext(), 'Radiohead'),
    );
    expect(text).toContain('You have **4,321** plays for this artist.');
  });
});
