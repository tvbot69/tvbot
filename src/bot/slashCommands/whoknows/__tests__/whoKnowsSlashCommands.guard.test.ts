import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoknows/whoKnowsSlashCommands';
import { WhoKnowsBuilders } from '@bot/builders/whoknows/whoKnowsBuilders';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * whoKnowsSlashCommands was 28.29% with 451 uncovered lines.
 *
 * The slash entry point differs from its text twin in one way that matters:
 * the artist arrives as a TYPED Discord option, so there is no grammar to
 * parse. What is worth pinning is the fallback chain instead - artist option,
 * then the caller's now-playing, then the resolved canonical name - and the
 * guild guard, because a who-knows with no guild has nothing to rank.
 *
 * The two container.resolve calls are method-level and lazy by design (3.3 in
 * PLAN_PROGRESS), so they are bound here rather than at construction.
 */

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { name: 'Test Guild' },
    prefix: '/',
    ...over,
  }) as unknown as ContextModel;

const opts = (o: Record<string, string | number | boolean | null> = {}) => ({
  getString: (n: string) => (typeof o[n] === 'string' ? (o[n] as string) : null),
  getInteger: (n: string) => (typeof o[n] === 'number' ? (o[n] as number) : null),
  getBoolean: (n: string) => (typeof o[n] === 'boolean' ? (o[n] as boolean) : null),
});

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.user ?? { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK' })),
    ...(over.userService as object),
  };
  const artworkService = { getArtistImageUrl: vi.fn(async () => 'https://img/a.png'), ...(over.artworkService as object) };
  const artistsService = {
    getArtistInfo: vi.fn(async () => (over.artistInfo === undefined ? null : over.artistInfo)),
    getArtistAccentColorAsync: vi.fn(async () => undefined),
    ...(over.artistsService as object),
  };
  const albumService = {};
  const trackService = {};
  const friendsService = { getCloseFriendUserIds: vi.fn(async () => []) };
  const whoKnowsArtistService = {
    getFilteredUsersForArtist: vi.fn(async (..._args: unknown[]) => ({
      filteredUsersWithArtist: [], filterStats: { total: 0, eligible: 0, filtered: 0 },
      guildUsers: [], genres: undefined, crownModel: null,
    })),
    ...(over.whoKnowsArtistService as object),
  };
  const whoKnowsTrackService = {};
  const whoKnowsAlbumService = {};
  const whoKnowsPlayService = { getGuildAlsoPlayingArtist: vi.fn(async () => undefined) };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(async () => (over.recent ?? [])),
    ...(over.lastfmRepository as object),
  };
  const updateService = { updateUser: vi.fn(async () => undefined) };
  const service = new WhoKnowsSlashCommands(
    userService as never, artworkService as never,
    artistsService as never, albumService as never, trackService as never,
    friendsService as never, whoKnowsArtistService as never, whoKnowsTrackService as never,
    whoKnowsAlbumService as never, whoKnowsPlayService as never, lastfmRepository as never,
    updateService as never,
  );
  return { service, userService, artistsService, whoKnowsArtistService, lastfmRepository, artworkService };
};

const call = (service: WhoKnowsSlashCommands, name: string, ...args: unknown[]) => {
  const h = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  return h[name]!.bind(service)(...args);
};

let sampleTrack: unknown;

beforeEach(() => {
  sampleTrack = undefined;
  vi.restoreAllMocks();
  vi.spyOn(WhoKnowsBuilders, 'buildWhoKnowsResponse').mockResolvedValue({ embed: {} } as never);
  container.registerInstance(ArtistTrackService, {
    getSampleTrackForArtist: vi.fn(async () => sampleTrack),
  } as never);
  container.registerInstance(GenreService, {
    getGenresForArtist: vi.fn(async () => ['ambient']),
  } as never);
});

describe('WhoKnowsSlashCommands.whoKnowsArtistAsync guards', () => {
  it('refuses outside a guild, because there is nothing to rank', async () => {
    const { service } = build();
    const result = await call(service, 'whoKnowsArtistAsync', mkContext({ guild: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('tells an unregistered caller to register', async () => {
    const { service } = build({ user: null });
    const result = await call(service, 'whoKnowsArtistAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no recent tracks rather than querying an empty artist', async () => {
    const { service, whoKnowsArtistService } = build({ recent: [] });
    const result = await call(service, 'whoKnowsArtistAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsArtistService.getFilteredUsersForArtist).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsSlashCommands.whoKnowsArtistAsync artist resolution', () => {
  it('uses the typed artist option verbatim', async () => {
    const { service, whoKnowsArtistService } = build();
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: ' Mond ' }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[2]).toBe('Mond');
  });

  it('falls back to the now-playing artist when the option is absent', async () => {
    const { service, whoKnowsArtistService } = build({ recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom' }] });
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[2]).toBe('Mitch Murder');
  });

  it('prefers the canonical name from the info lookup', async () => {
    // Two artists can share a name; the canonical one keeps artwork and
    // genre lookups pointed at the right catalogue entry.
    const { service, whoKnowsArtistService } = build({ artistInfo: { name: 'Mond (Band)', userPlayCount: 7 } });
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[2]).toBe('Mond (Band)');
  });

  it('passes the caller live playcount through when the info has one', async () => {
    const { service, whoKnowsArtistService } = build({ artistInfo: { name: 'Mond', userPlayCount: 42 } });
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[3]).toBe(42);
  });

  it('passes undefined playcount when the info has none', async () => {
    const { service, whoKnowsArtistService } = build();
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[3]).toBeUndefined();
  });
});

describe('WhoKnowsSlashCommands.whoKnowsArtistAsync options', () => {
  it('honours the filter_disabled option', async () => {
    const { service, whoKnowsArtistService } = build();
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond', filter_disabled: true }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[4]).toBe(true);
  });

  it('defaults the filter to enabled', async () => {
    const { service, whoKnowsArtistService } = build();
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(whoKnowsArtistService.getFilteredUsersForArtist.mock.calls[0]?.[4]).toBe(false);
  });

  it('prefers an explicit mode option over the saved one', async () => {
    const { service, userService } = build({ user: { userId: 1, userNameLastFm: 'D', whoKnowsMode: WhoKnowsMode.Image } });
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond', mode: WhoKnowsMode.Pagination }) } }));
    expect(WhoKnowsBuilders.buildWhoKnowsResponse).toHaveBeenCalled();
    expect(userService.getUserByDiscordId).toHaveBeenCalled();
  });

  it('still builds a response when the artwork lookup returns nothing', async () => {
    const { service, artworkService } = build();
    (artworkService.getArtistImageUrl as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(WhoKnowsBuilders.buildWhoKnowsResponse).toHaveBeenCalled();
  });
});

describe('WhoKnowsSlashCommands command table', () => {
  it('gives every command a unique name', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
