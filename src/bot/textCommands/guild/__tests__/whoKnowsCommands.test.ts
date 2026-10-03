import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { SettingService } from '@bot/services/system/settingService';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';
import { WhoKnowsBuilders } from '@bot/builders/whoknows/whoKnowsBuilders';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';

/**
 * Main-path coverage for the who-knows text commands: the track, album and
 * friends variants, user resolution, sync triggering, and the arguments
 * handed to WhoKnowsBuilders.
 *
 * The module resolves the caller exclusively through
 * `userService.getUserByDiscordId(context.discordUserId)` — mention and
 * `lfm:` parsing happen upstream in the command framework before dispatch,
 * so "default to self" is the only user-resolution branch this file owns.
 *
 * Same construction pattern as whoKnowsCommands.guard.test.ts: collaborators
 * are built by NAME from a record and spread positionally, so a swap is
 * caught by the assertions rather than by the compiler.
 */

const user = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'DreadRock',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    // The friends paths read guild.members.cache, so the stub carries one.
    guild: { name: 'Test Guild', members: { cache: { get: () => undefined } } },
    prefix: '.',
    args: [],
    ...over,
  }) as unknown as ContextModel;

const filterStats = { startCount: 0, endCount: 0 };

let sampleTrack: string | undefined;
let genres: string[] | undefined;

const build = (opts: {
  registered?: User | null;
  artistResult?: Record<string, unknown> | null;
  trackResult?: Record<string, unknown> | null;
  albumResult?: Record<string, unknown> | null;
} = {}) => {
  const caller = opts.registered === undefined ? user() : opts.registered;
  const artistResult = opts.artistResult === undefined
    ? {
        filteredUsersWithArtist: [],
        filterStats,
        guildUsers: [],
        genres: undefined as string[] | undefined,
        crownModel: null,
      }
    : opts.artistResult;
  const trackResult = opts.trackResult === undefined
    ? { filteredUsersWithTrack: [], filterStats, guildUsers: [] }
    : opts.trackResult;
  const albumResult = opts.albumResult === undefined
    ? { filteredUsersWithAlbum: [], filterStats, guildUsers: [] }
    : opts.albumResult;
  const deps: Record<string, unknown> = {
    userService: { getUserByDiscordId: vi.fn(async () => caller) },
    settingService: new SettingService(),
    artworkService: {
      getArtistImageUrl: vi.fn(async () => undefined),
      getTrackCoverUrl: vi.fn(async () => undefined),
      getAlbumCoverUrl: vi.fn(async () => undefined),
    },
    artistsService: {
      getArtistInfo: vi.fn(async () => null),
      getArtistAccentColorAsync: vi.fn(async () => undefined),
    },
    albumService: {
      getAlbumInfo: vi.fn(async () => null),
      getAlbumAccentColor: vi.fn(async () => undefined),
    },
    trackService: { getTrackInfo: vi.fn(async () => null) },
    friendsService: {
      getFriendsByUserId: vi.fn(async () => []),
      getCloseFriendUserIds: vi.fn(async () => new Set<number>()),
    },
    whoKnowsArtistService: {
      getFilteredUsersForArtist: vi.fn(async () => artistResult),
      getFriendUsersForArtists: vi.fn(async () => []),
      getGuildHiddenUserIds: vi.fn(async () => new Set<number>()),
    },
    whoKnowsTrackService: {
      getFilteredUsersForTrack: vi.fn(async () => trackResult),
      getFriendUsersForTrack: vi.fn(async () => []),
      getGuildHiddenUserIds: vi.fn(async () => new Set<number>()),
    },
    whoKnowsAlbumService: {
      getFilteredUsersForAlbum: vi.fn(async () => albumResult),
      getFriendUsersForAlbum: vi.fn(async () => []),
      getGuildHiddenUserIds: vi.fn(async () => new Set<number>()),
    },
    whoKnowsPlayService: {
      getGuildAlsoPlayingArtist: vi.fn(async () => undefined),
      getGuildAlsoPlayingTrack: vi.fn(async () => undefined),
      getGuildAlsoPlayingAlbum: vi.fn(async () => undefined),
    },
    lastfmRepository: { getUserRecentTracks: vi.fn(async () => []) },
    updateService: { updateUser: vi.fn(async () => undefined) },
  };
  const args = [
    deps.userService, deps.settingService, deps.artworkService, deps.artistsService,
    deps.albumService, deps.trackService, deps.friendsService, deps.whoKnowsArtistService,
    deps.whoKnowsTrackService, deps.whoKnowsAlbumService, deps.whoKnowsPlayService,
    deps.lastfmRepository, deps.updateService,
  ] as const;
  const commands = new WhoKnowsCommands(...(args as unknown as ConstructorParameters<typeof WhoKnowsCommands>));
  return { commands, deps, artistResult, trackResult, albumResult };
};

const builderArgs = () =>
  (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;

/** The track/album/friends handlers are private; reach them the same way the guard test reaches splitArtistTitle. */
const privates = (commands: WhoKnowsCommands) =>
  commands as unknown as {
    whoKnowsTrackAsync: (c: ContextModel, args: string) => Promise<ResponseModel>;
    whoKnowsAlbumAsync: (c: ContextModel, args: string) => Promise<ResponseModel>;
    friendsWhoKnowArtistAsync: (c: ContextModel, args: string) => Promise<ResponseModel>;
    friendsWhoKnowTrackAsync: (c: ContextModel, args: string) => Promise<ResponseModel>;
    friendsWhoKnowAlbumAsync: (c: ContextModel, args: string) => Promise<ResponseModel>;
  };

beforeEach(() => {
  sampleTrack = undefined;
  genres = undefined;
  vi.restoreAllMocks();
  container.registerInstance(ArtistTrackService, {
    getSampleTrackForArtist: vi.fn(async () => sampleTrack),
  } as never);
  container.registerInstance(GenreService, {
    getGenresForArtist: vi.fn(async () => genres),
  } as never);
  vi.spyOn(WhoKnowsBuilders, 'buildWhoKnowsResponse').mockResolvedValue({} as never);
});

describe('WhoKnowsCommands user resolution', () => {
  it('resolves the caller by their own discord id, defaulting to self', async () => {
    const { commands, deps } = build();
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const getUser = (deps.userService as { getUserByDiscordId: ReturnType<typeof vi.fn> })
      .getUserByDiscordId;
    expect(getUser).toHaveBeenCalledWith('111');
  });

  it('tells an unregistered caller to register on the track command too', async () => {
    const { commands } = build({ registered: null });
    const result = await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('tells an unregistered caller to register on the album command too', async () => {
    const { commands } = build({ registered: null });
    const result = await privates(commands).whoKnowsAlbumAsync(ctx(), 'Radiohead | OK Computer');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('WhoKnowsCommands checkSync', () => {
  it('triggers a delta sync when the callers scrobbles are stale', async () => {
    const stale = user({ lastUpdate: new Date(Date.now() - 10 * 60 * 1000) });
    const { commands, deps } = build({ registered: stale });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const updateUser = (deps.updateService as { updateUser: ReturnType<typeof vi.fn> }).updateUser;
    expect(updateUser).toHaveBeenCalledWith(stale.userId, { accurateTotal: true });
  });

  it('skips the sync when the callers scrobbles are fresh', async () => {
    const { commands, deps } = build({ registered: user({ lastUpdate: new Date() }) });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    const updateUser = (deps.updateService as { updateUser: ReturnType<typeof vi.fn> }).updateUser;
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsCommands.whoKnowsTrackAsync', () => {
  it('splits a pipe-form query into artist and track', async () => {
    const { commands, deps } = build();
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('Creep');
  });

  it('splits a "Track by Artist" query', async () => {
    const { commands, deps } = build();
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Creep by Radiohead');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('Creep');
  });

  it('rejects a query with no separator', async () => {
    const { commands } = build();
    const result = await privates(commands).whoKnowsTrackAsync(ctx(), 'Creep');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('falls back to the callers now-playing track when no query is given', async () => {
    const { commands, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Spectral Bloom', artistName: 'Mitch Murder' }]);
    await privates(commands).whoKnowsTrackAsync(ctx(), '');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(call.mock.calls[0]?.[3]).toBe('Spectral Bloom');
  });

  it('reports no recent tracks rather than resolving an empty query', async () => {
    const { commands } = build();
    const result = await privates(commands).whoKnowsTrackAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('prefers the resolved names from the track info lookup', async () => {
    const { commands, deps } = build();
    (deps.trackService as { getTrackInfo: ReturnType<typeof vi.fn> })
      .getTrackInfo.mockResolvedValue({ name: 'Creep (Remastered)', artistName: 'Radiohead' });
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('Creep (Remastered)');
  });

  it('falls back to the typed names when the info lookup returns nothing', async () => {
    const { commands, deps } = build();
    (deps.trackService as { getTrackInfo: ReturnType<typeof vi.fn> }).getTrackInfo.mockResolvedValue(null);
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('Creep');
  });

  it('passes the callers live playcount through to the service', async () => {
    const { commands, deps } = build();
    (deps.trackService as { getTrackInfo: ReturnType<typeof vi.fn> })
      .getTrackInfo.mockResolvedValue({ userPlayCount: 5 });
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[4]).toBe(5);
  });

  it('passes the nf flag through as a disabled quality filter', async () => {
    const { commands, deps } = build();
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep nf');
    const call = (deps.whoKnowsTrackService as { getFilteredUsersForTrack: ReturnType<typeof vi.fn> })
      .getFilteredUsersForTrack;
    expect(call.mock.calls[0]?.[5]).toBe(true);
  });

  it('builds the track response with title, url, media type and album metadata', async () => {
    const { commands, deps } = build();
    (deps.trackService as { getTrackInfo: ReturnType<typeof vi.fn> })
      .getTrackInfo.mockResolvedValue({
        name: 'Creep',
        artistName: 'Radiohead',
        playCount: 1000,
        listeners: 500,
        albumName: 'Pablo Honey',
      });
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    const args = builderArgs();
    expect(args[1]).toBe('Creep by Radiohead in Test Guild');
    expect(args[2]).toBe('https://www.last.fm/music/Radiohead/_/Creep');
    expect(args[11]).toBe('Track');
    expect(args[13]).toEqual({
      globalPlays: 1000,
      globalListeners: 500,
      topItemLabel: 'Album',
      topItemValue: 'Pablo Honey',
    });
  });
});

describe('WhoKnowsCommands.whoKnowsAlbumAsync', () => {
  it('splits a pipe-form query into artist and album', async () => {
    const { commands, deps } = build();
    await privates(commands).whoKnowsAlbumAsync(ctx(), 'Radiohead | OK Computer');
    const call = (deps.whoKnowsAlbumService as { getFilteredUsersForAlbum: ReturnType<typeof vi.fn> })
      .getFilteredUsersForAlbum;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('OK Computer');
  });

  it('splits an "Album by Artist" query', async () => {
    const { commands, deps } = build();
    await privates(commands).whoKnowsAlbumAsync(ctx(), 'OK Computer by Radiohead');
    const call = (deps.whoKnowsAlbumService as { getFilteredUsersForAlbum: ReturnType<typeof vi.fn> })
      .getFilteredUsersForAlbum;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('OK Computer');
  });

  it('rejects a query with no separator', async () => {
    const { commands } = build();
    const result = await privates(commands).whoKnowsAlbumAsync(ctx(), 'OK Computer');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('falls back to the callers now-playing album when no query is given', async () => {
    const { commands, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Creep', artistName: 'Radiohead', albumName: 'Pablo Honey' }]);
    await privates(commands).whoKnowsAlbumAsync(ctx(), '');
    const call = (deps.whoKnowsAlbumService as { getFilteredUsersForAlbum: ReturnType<typeof vi.fn> })
      .getFilteredUsersForAlbum;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('Pablo Honey');
  });

  it('reports no recent tracks when the profile has none', async () => {
    const { commands } = build();
    const result = await privates(commands).whoKnowsAlbumAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports a missing album when the current track has none', async () => {
    const { commands, deps } = build();
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Creep', artistName: 'Radiohead', albumName: undefined }]);
    const result = await privates(commands).whoKnowsAlbumAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('prefers the resolved names from the album info lookup', async () => {
    const { commands, deps } = build();
    (deps.albumService as { getAlbumInfo: ReturnType<typeof vi.fn> })
      .getAlbumInfo.mockResolvedValue({ name: 'OK Computer OKNOTOK', artistName: 'Radiohead' });
    await privates(commands).whoKnowsAlbumAsync(ctx(), 'Radiohead | OK Computer');
    const call = (deps.whoKnowsAlbumService as { getFilteredUsersForAlbum: ReturnType<typeof vi.fn> })
      .getFilteredUsersForAlbum;
    expect(call.mock.calls[0]?.[2]).toBe('Radiohead');
    expect(call.mock.calls[0]?.[3]).toBe('OK Computer OKNOTOK');
  });

  it('builds the album response with title, url, media type and top-track metadata', async () => {
    const { commands, deps } = build();
    (deps.albumService as { getAlbumInfo: ReturnType<typeof vi.fn> })
      .getAlbumInfo.mockResolvedValue({
        name: 'OK Computer',
        artistName: 'Radiohead',
        playCount: 2000,
        listeners: 800,
        tracks: [{ name: 'Airbag' }, { name: 'Paranoid Android' }, { name: 'Subterranean Homesick Alien' }, { name: 'Exit Music' }],
      });
    await privates(commands).whoKnowsAlbumAsync(ctx(), 'Radiohead | OK Computer');
    const args = builderArgs();
    expect(args[1]).toBe('OK Computer by Radiohead in Test Guild');
    expect(args[2]).toBe('https://www.last.fm/music/Radiohead/OK+Computer');
    expect(args[11]).toBe('Album');
    expect(args[13]).toEqual({
      globalPlays: 2000,
      globalListeners: 800,
      topItemLabel: 'Top Track',
      topItemValue: 'Airbag',
      topItemExtra: '4 tracks',
      topTracks: ['Airbag', 'Paranoid Android', 'Subterranean Homesick Alien'],
    });
  });
});

describe('WhoKnowsCommands.friendsWhoKnowArtistAsync', () => {
  it('tells a caller with no friends how to add some', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([]);
    const result = await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'mond');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('falls back to the callers now-playing artist when no name is given', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Spectral Bloom', artistName: 'Mitch Murder' }]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), '');
    const call = (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists;
    expect(call.mock.calls[0]?.[2]).toBe('Mitch Murder');
  });

  it('reports no recent tracks when the profile has none', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    const result = await privates(commands).friendsWhoKnowArtistAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the friends artist response without filter stats or metadata', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists.mockResolvedValue([{ userId: 2, playcount: 10, lastFmUsername: 'friend1' }]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'Mond');
    const args = builderArgs();
    expect(args[1]).toBe('Friends who know Mond');
    expect(args[2]).toBe('https://www.last.fm/music/Mond');
    expect(args[5]).toBeUndefined();
    expect(args[10]).toBe('Friends who know for DreadRock');
    expect(args[11]).toBe('Artist');
    expect(args[13]).toBeUndefined();
  });

  it('uses the callers display name in the footer when the context carries one', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx({ member: { displayName: 'Alice' } }), 'Mond');
    expect(builderArgs()[10]).toBe('Friends who know for Alice');
  });
});

describe('WhoKnowsCommands.friendsWhoKnowTrackAsync', () => {
  it('tells a caller with no friends how to add some', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([]);
    const result = await privates(commands).friendsWhoKnowTrackAsync(ctx(), 'Radiohead | Creep');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('rejects a query with no separator', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    const result = await privates(commands).friendsWhoKnowTrackAsync(ctx(), 'Creep');
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('builds the friends track response', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    (deps.whoKnowsTrackService as { getFriendUsersForTrack: ReturnType<typeof vi.fn> })
      .getFriendUsersForTrack.mockResolvedValue([{ userId: 2, playcount: 10, lastFmUsername: 'friend1' }]);
    await privates(commands).friendsWhoKnowTrackAsync(ctx(), 'Radiohead | Creep');
    const args = builderArgs();
    expect(args[1]).toBe('Friends who know Creep by Radiohead');
    expect(args[2]).toBe('https://www.last.fm/music/Radiohead/_/Creep');
    expect(args[11]).toBe('Track');
  });
});

describe('WhoKnowsCommands.friendsWhoKnowAlbumAsync', () => {
  it('tells a caller with no friends how to add some', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([]);
    const result = await privates(commands).friendsWhoKnowAlbumAsync(ctx(), 'Radiohead | OK Computer');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports a missing album when the current track has none', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    (deps.lastfmRepository as { getUserRecentTracks: ReturnType<typeof vi.fn> })
      .getUserRecentTracks.mockResolvedValue([{ name: 'Creep', artistName: 'Radiohead', albumName: undefined }]);
    const result = await privates(commands).friendsWhoKnowAlbumAsync(ctx(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the friends album response', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    (deps.whoKnowsAlbumService as { getFriendUsersForAlbum: ReturnType<typeof vi.fn> })
      .getFriendUsersForAlbum.mockResolvedValue([{ userId: 2, playcount: 10, lastFmUsername: 'friend1' }]);
    await privates(commands).friendsWhoKnowAlbumAsync(ctx(), 'Radiohead | OK Computer');
    const args = builderArgs();
    expect(args[1]).toBe('Friends who know OK Computer by Radiohead');
    expect(args[2]).toBe('https://www.last.fm/music/Radiohead/OK+Computer');
    expect(args[11]).toBe('Album');
  });
});

describe('WhoKnowsCommands artist crown message', () => {
  it('passes the crown result through when the crown was claimed', async () => {
    const { commands } = build({
      artistResult: {
        filteredUsersWithArtist: [],
        filterStats,
        guildUsers: [],
        genres: undefined,
        crownModel: { claimed: true, stolen: false, crownResult: 'Crown claimed by Alice' },
      },
    });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(builderArgs()[10]).toBe('Crown claimed by Alice');
  });

  it('passes the crown result through when the crown was stolen', async () => {
    const { commands } = build({
      artistResult: {
        filteredUsersWithArtist: [],
        filterStats,
        guildUsers: [],
        genres: undefined,
        crownModel: { claimed: false, stolen: true, crownResult: 'Crown stolen by Bob' },
      },
    });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(builderArgs()[10]).toBe('Crown stolen by Bob');
  });

  it('passes no crown message when the crown is unclaimed', async () => {
    const { commands } = build({
      artistResult: {
        filteredUsersWithArtist: [],
        filterStats,
        guildUsers: [],
        genres: undefined,
        crownModel: { claimed: false, stolen: false, crownResult: 'must not appear' },
      },
    });
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(builderArgs()[10]).toBeUndefined();
  });
});

describe('WhoKnowsCommands artist genre anchoring', () => {
  it('anchors genres on the top listeners scrobble when the caller has none', async () => {
    const { commands } = build({
      artistResult: {
        filteredUsersWithArtist: [{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }],
        filterStats,
        guildUsers: [],
        genres: undefined,
        crownModel: null,
      },
    });
    const sampleTrackMock = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('Sample Track');
    container.registerInstance(ArtistTrackService, {
      getSampleTrackForArtist: sampleTrackMock,
    } as never);
    genres = ['synthwave', 'electronic'];
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(sampleTrackMock).toHaveBeenNthCalledWith(2, 42, 'mond');
    expect(builderArgs()[7]).toEqual(['synthwave', 'electronic']);
  });

  it('keeps the callers own genres when a sample track exists for them', async () => {
    const { commands } = build({
      artistResult: {
        filteredUsersWithArtist: [{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }],
        filterStats,
        guildUsers: [],
        genres: ['darkwave'],
        crownModel: null,
      },
    });
    sampleTrack = 'Callers Track';
    await commands.whoKnowsArtistAsync(ctx(), 'mond');
    expect(builderArgs()[7]).toEqual(['darkwave']);
  });
});

describe('WhoKnowsCommands friends privacy filtering', () => {
  const guildWithId = (id = '222'): ContextModel =>
    ctx({ guild: { name: 'Test Guild', id, members: { cache: { get: () => undefined } } } });

  it('never names a Hide friend from the friends list, but keeps visible friends', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> }).getFriendsByUserId.mockResolvedValue([
      { userId: 1, friendUserId: 2, friendUser: { userId: 2, privacyLevel: 'Hide' } },
      { userId: 1, friendUserId: 3, friendUser: { userId: 3, privacyLevel: 'Default' } },
    ]);
    (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists.mockResolvedValue([
        { userId: 2, playcount: 50, lastFmUsername: 'hidden_friend' },
        { userId: 3, playcount: 10, lastFmUsername: 'visible_friend' },
      ]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'Mond');
    const users = builderArgs()[4] as Array<{ userId: number }>;
    expect(users.map((u) => u.userId)).not.toContain(2);
    expect(users.map((u) => u.userId)).toContain(3);
  });

  it('excludes a self-blocked friend via the guild users map', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> }).getFriendsByUserId.mockResolvedValue([
      { userId: 1, friendUserId: 2 },
      { userId: 1, friendUserId: 3 },
    ]);
    (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists.mockResolvedValue([
        { userId: 2, playcount: 50, lastFmUsername: 'blocked_friend' },
        { userId: 3, playcount: 10, lastFmUsername: 'visible_friend' },
      ]);
    // The guild-user read lives in the entity service (already-injected
    // repository), never resolved out of the container from a command module.
    (deps.whoKnowsArtistService as { getGuildHiddenUserIds: ReturnType<typeof vi.fn> })
      .getGuildHiddenUserIds.mockResolvedValue(new Set([2]));
    await privates(commands).friendsWhoKnowArtistAsync(guildWithId(), 'Mond');
    const users = builderArgs()[4] as Array<{ userId: number }>;
    expect(users.map((u) => u.userId)).not.toContain(2);
    expect(users.map((u) => u.userId)).toContain(3);
  });

  it('excludes a Hide caller from their own friends list', async () => {
    const { commands, deps } = build({
      registered: user({ privacyLevel: 'Hide' as never }),
    });
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> }).getFriendsByUserId.mockResolvedValue([
      { userId: 1, friendUserId: 3 },
    ]);
    (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists.mockResolvedValue([
        { userId: 3, playcount: 10, lastFmUsername: 'visible_friend' },
      ]);
    (deps.artistsService as { getArtistInfo: ReturnType<typeof vi.fn> }).getArtistInfo.mockResolvedValue({
      name: 'Mond',
      userPlayCount: 5,
    });
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'Mond');
    const users = builderArgs()[4] as Array<{ userId: number }>;
    expect(users.map((u) => u.userId)).not.toContain(1);
    expect(users.map((u) => u.userId)).toContain(3);
  });

  it('CONTROL: visible friends are still listed, so the filter cannot hide everyone', async () => {
    const { commands, deps } = build();
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> }).getFriendsByUserId.mockResolvedValue([
      { userId: 1, friendUserId: 2, friendUser: { userId: 2, privacyLevel: 'Default' } },
    ]);
    (deps.whoKnowsArtistService as { getFriendUsersForArtists: ReturnType<typeof vi.fn> })
      .getFriendUsersForArtists.mockResolvedValue([
        { userId: 2, playcount: 10, lastFmUsername: 'visible_friend' },
      ]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'Mond');
    const users = builderArgs()[4] as Array<{ userId: number }>;
    expect(users.map((u) => u.userId)).toContain(2);
  });
});

describe('WhoKnowsCommands saved mode propagation', () => {
  it('passes the callers saved mode through on the track command', async () => {
    const { commands } = build({ registered: user({ whoKnowsMode: WhoKnowsMode.Pagination }) });
    await privates(commands).whoKnowsTrackAsync(ctx(), 'Radiohead | Creep');
    expect(builderArgs()[9]).toBe(WhoKnowsMode.Pagination);
  });

  it('passes the callers saved mode through on the album command', async () => {
    const { commands } = build({ registered: user({ whoKnowsMode: WhoKnowsMode.Image }) });
    await privates(commands).whoKnowsAlbumAsync(ctx(), 'Radiohead | OK Computer');
    expect(builderArgs()[9]).toBe(WhoKnowsMode.Image);
  });

  it('passes the callers saved mode through on the friends artist command', async () => {
    const { commands, deps } = build({ registered: user({ whoKnowsMode: WhoKnowsMode.Pagination }) });
    (deps.friendsService as { getFriendsByUserId: ReturnType<typeof vi.fn> })
      .getFriendsByUserId.mockResolvedValue([{ userId: 2, lastFmUsername: 'friend1' }]);
    await privates(commands).friendsWhoKnowArtistAsync(ctx(), 'mond');
    expect(builderArgs()[9]).toBe(WhoKnowsMode.Pagination);
  });
});
