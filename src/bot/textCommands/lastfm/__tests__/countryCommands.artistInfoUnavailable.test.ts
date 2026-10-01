/**
 * The text-command twin of `countrySlashCommands.artistInfoUnavailable.test.ts`,
 * kept as its own file because the repo puts a test next to the module it
 * exercises and these are two modules with two separate copies of this handler.
 *
 * `.country <artist>` has the same partial-success hole: the country, flag and
 * artwork come from `countryService.getArtistInfoWithCountry` (MusicBrainz plus
 * our own database) and render fine, and only the caller's own playcount comes
 * from Last.fm. `catch { }` dropped just that field, and
 * `buildArtistCountryInfoResponse` prints the playcount clause only when
 * `userPlaycount > 0` - so a Last.fm outage rendered a card byte-identical to
 * the card for someone who has genuinely never played the artist.
 *
 * Both directions are asserted, plus the ordinary path, so "always omit the
 * playcount line" cannot pass. The sixth positional constructor argument
 * (`colorService?`) is left undefined.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CountryCommands } from '@bot/textCommands/lastfm/countryCommands';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ResponseModel } from '@bot/models/responseModel';
import type { ContextModel } from '@bot/models/contextModel';
import type { UserService } from '@bot/services/user/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService } from '@bot/services/library/countryService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

const LFM_DOWN = () =>
  new LastFmUnavailableError('artist.getinfo', new Error('Last.fm returned HTTP 500'));

const CALLER = { userId: 7, userNameLastFm: 'DreadRock' };
const RADIOHEAD_COUNTRY = { Name: 'United Kingdom', Code: 'GB', Emoji: ':flag_gb:' };

/** No `interaction`: the text handler reads its argument, not slash options. */
const makeContext = (): ContextModel =>
  ({ discordUserId: 'caller1', prefix: '.' }) as unknown as ContextModel;

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
    searchCountry: vi.fn(() => undefined),
    getArtistInfoWithCountry: vi.fn(async () => ({
      country: RADIOHEAD_COUNTRY,
      spotifyImageUrl: 'https://example.test/radiohead.jpg',
    })),
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

const cardText = (response: ResponseModel): string =>
  (response.componentsV2Container?.toJSON() as { components: Array<{ content?: string }> })
    .components.map((c) => c.content ?? '')
    .join('\n');

describe('CountryCommands.countryInfoAsync: a Last.fm outage is not a user with zero plays', () => {
  it('re-throws the deliberate signal instead of rendering a confident playcount-less card', async () => {
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    await expect(cmd.countryInfoAsync(makeContext(), 'Radiohead')).rejects.toBeInstanceOf(
      LastFmUnavailableError,
    );
  });

  it('never renders a card at all for an outage (the user-visible half)', async () => {
    const { cmd } = build(() => Promise.reject(LFM_DOWN()));
    const settled = await cmd
      .countryInfoAsync(makeContext(), 'Radiohead')
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect((settled.e as Error).message).toMatch(/artist\.getinfo/);
  });

  it('still renders the card when a NON-source failure hits the Last.fm read', async () => {
    const { cmd } = build(() => Promise.reject(new Error('socket hang up')));
    const response = await cmd.countryInfoAsync(makeContext(), 'Radiohead');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('United Kingdom');
  });

  it('renders the same playcount-less card when Last.fm ANSWERS with no playcount', async () => {
    const { cmd } = build(() => Promise.resolve(null));
    const response = await cmd.countryInfoAsync(makeContext(), 'Radiohead');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    const text = cardText(response);
    expect(text).toContain('United Kingdom');
    expect(text).not.toContain('You have');
  });

  it('still renders the playcount clause when Last.fm answers with one', async () => {
    const { cmd } = build(() => Promise.resolve({ name: 'Radiohead', userPlayCount: 4321 }));
    const text = cardText(await cmd.countryInfoAsync(makeContext(), 'Radiohead'));
    expect(text).toContain('You have **4,321** plays for this artist.');
  });
});
