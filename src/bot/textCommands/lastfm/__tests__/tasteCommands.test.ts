import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { TasteCommands } from '@bot/textCommands/lastfm/tasteCommands';
import { TasteBuilders } from '@bot/builders/library/tasteBuilders';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ColorService } from '@bot/services/system/colorService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import type { TasteData } from '@bot/services/library/tasteService';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';

/**
 * `.taste` command body, and specifically what it does with a raise.
 *
 * `TasteService.getTasteData` deliberately raises when a source fails, because
 * an empty comparison is indistinguishable from "you two share nothing" and is
 * a real answer that must stay one. That decision is only safe if the command
 * boundary does something better than swallow it: `commandHandler` hands the
 * throw to `CommandDispatcher.handleCommandException`, which logs a ref and
 * answers with a generic failure that names neither the cause nor the fact that
 * a retry will work. So the raise is turned into a specific, visible error here.
 *
 * The paired failure is the one that matters most: an unrelated `TypeError`
 * re-thrown instead of caught. Dressing a defect up as a transient outage tells
 * the user to retry a request that can never succeed, and hides the bug from
 * the log.
 */

const mkUser = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const mkTasteData = (over: Partial<TasteData> = {}): TasteData =>
  ({
    cacheKey: 'abc123',
    user1DiscordId: '111',
    user2DiscordId: '222',
    user1DisplayName: 'Caller',
    user2DisplayName: 'Beta',
    user1UserNameLastFm: 'Alpha',
    user2UserNameLastFm: 'Beta',
    url: 'https://last.fm/user/Beta/library/artists',
    timePeriodDescription: 'two-year',
    amount: 14,
    artists: { items: [{ name: 'Radiohead', ownPlaycount: 10, otherPlaycount: 4 }], totalCount: 50 },
    genres: { items: [], totalCount: 1 },
    countries: { items: [], totalCount: 1 },
    ...over,
  }) as TasteData;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '333',
    prefix: '.',
    message: { member: { displayName: 'Caller' }, guild: { members: { fetch: vi.fn(async () => null) } } },
    ...over,
  }) as unknown as ContextModel;

const artworkService = { getArtistImageUrl: vi.fn(async () => null) };
const colorService = { getColorFromImageUrl: vi.fn(async () => 0xff0000) };

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => (id === '111' ? mkUser() : null)),
    getUserByLastFmName: vi.fn(async () => null),
    ...(over.userService as object),
  };
  const tasteService = {
    getTasteData: vi.fn(async () => mkTasteData()),
    ...(over.tasteService as object),
  };
  const lastfmRepo = { getUserInfo: vi.fn(async () => null), ...(over.lastfmRepo as object) };
  const updateService = {
    updateUser: vi.fn(async () => undefined),
    ...(over.updateService as object),
  };
  const service = new TasteCommands(
    userService as never,
    tasteService as never,
    lastfmRepo as never,
    updateService as never,
  );
  return { service, userService, tasteService, lastfmRepo, updateService };
};

type Handled = { commandResponse: CommandResponse; embed: { toJSON: () => { description?: string } } };

const call = (service: TasteCommands) =>
  (service as unknown as Record<string, (...a: unknown[]) => Promise<Handled>>)
    ['tasteAsync']!.bind(service)(mkContext(), ['Beta']);

const descriptionOf = (r: Handled): string => r.embed.toJSON().description ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(TasteBuilders, 'buildTasteResponse').mockReturnValue({ content: 'taste' } as never);
  vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) => {
    if (token === ArtworkService) return artworkService as never;
    if (token === ColorService) return colorService as never;
    throw new Error(`unexpected container token: ${String(token)}`);
  }) as never);
});

describe('TasteCommands.tasteAsync — happy path', () => {
  it('builds the taste card from the service payload', async () => {
    const { service, tasteService } = build();

    await call(service);

    expect(tasteService.getTasteData).toHaveBeenCalledTimes(1);
    expect(TasteBuilders.buildTasteResponse).toHaveBeenCalledWith(
      await vi.mocked(tasteService.getTasteData).mock.results[0]!.value,
      0,
      14,
      0xff0000,
    );
  });
});

describe('TasteCommands.tasteAsync — a failed read is visible, not an empty table', () => {
  const lastfmDown = () => new LastFmUnavailableError('user.gettopartists', new Error('Last.fm 5xx'));
  const databaseDown = () =>
    new SourceUnavailableError('countryService.getTopCountries', new Error('connect ECONNREFUSED'), 'Database unavailable');

  it('reports a Last.fm outage as an error naming the compared user', async () => {
    const { service } = build({ tasteService: { getTasteData: vi.fn(async () => { throw lastfmDown(); }) } });

    const result = await call(service);

    // NotFound would be the lie: it is what "these two share nothing" renders as.
    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(descriptionOf(result)).toContain('Beta');
    expect(descriptionOf(result)).toContain('Last.fm');
  });

  it('says the database rather than Last.fm when that is what failed', async () => {
    // `getTasteData` also calls genreService and countryService, which raise a
    // plain SourceUnavailableError. Reporting those as a Last.fm outage sends
    // the operator to the wrong status page.
    const { service } = build({ tasteService: { getTasteData: vi.fn(async () => { throw databaseDown(); }) } });

    const result = await call(service);

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(descriptionOf(result)).toContain('the database');
    expect(descriptionOf(result)).not.toContain('Last.fm');
  });

  it('never builds a taste card from a failed read', async () => {
    const { service } = build({ tasteService: { getTasteData: vi.fn(async () => { throw lastfmDown(); }) } });

    await call(service);

    // A card built from nothing is a card of zeros - the artefact this exists to
    // prevent.
    expect(TasteBuilders.buildTasteResponse).not.toHaveBeenCalled();
  });

  it('re-throws an unrelated defect rather than reporting a transient outage', async () => {
    const { service } = build({
      tasteService: { getTasteData: vi.fn(async () => { throw new TypeError('x is not a function'); }) },
    });

    await expect(call(service)).rejects.toBeInstanceOf(TypeError);
  });
});
