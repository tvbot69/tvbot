import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsSlashCommands } from '../whoKnowsSlashCommands';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import { ArtistTrackService } from '@bot/services/artistTrackService';
import { GenreService } from '@bot/services/genreService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * whoKnowsSlashCommands.guard.test.ts pins the artist handler's guards and
 * fallback chain. This file covers the remaining branches: the track and
 * album handlers (pipe syntax, now-playing fallback, live playcount), the
 * friendswhoknow variants (empty-friends guard, caller injection), and the
 * response-building arguments each handler passes to WhoKnowsBuilders.
 *
 * The slash module has no mention/lfm: grammar - the text twin owns that.
 * User resolution here is always "the caller, by discord id", so that is
 * what these tests pin.
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
  const artworkService = {
    getArtistImageUrl: vi.fn(async () => 'https://img/a.png'),
    getTrackCoverUrl: vi.fn(async () => 'https://img/t.png'),
    getAlbumCoverUrl: vi.fn(async () => 'https://img/al.png'),
    ...(over.artworkService as object),
  };
  const artistsService = {
    getArtistInfo: vi.fn(async () => (over.artistInfo === undefined ? null : over.artistInfo)),
    getArtistAccentColorAsync: vi.fn(async () => undefined),
    ...(over.artistsService as object),
  };
  const albumService = {
    getAlbumInfo: vi.fn(async () => (over.albumInfo === undefined ? null : over.albumInfo)),
    getAlbumAccentColor: vi.fn(async () => undefined),
    ...(over.albumService as object),
  };
  const trackService = {
    getTrackInfo: vi.fn(async () => (over.trackInfo === undefined ? null : over.trackInfo)),
    ...(over.trackService as object),
  };
  const friendsService = {
    getCloseFriendUserIds: vi.fn(async () => []),
    getFriendsByUserId: vi.fn(async () => (over.friends ?? [])),
    ...(over.friendsService as object),
  };
  const whoKnowsArtistService = {
    getFilteredUsersForArtist: vi.fn(async (..._args: unknown[]) => ({
      filteredUsersWithArtist: [], filterStats: { total: 0, eligible: 0, filtered: 0 },
      guildUsers: [], genres: undefined, crownModel: null,
    })),
    getFriendUsersForArtists: vi.fn(async (..._args: unknown[]) => (over.friendUsers ?? [])),
    ...(over.whoKnowsArtistService as object),
  };
  const whoKnowsTrackService = {
    getFilteredUsersForTrack: vi.fn(async (..._args: unknown[]) => ({
      filteredUsersWithTrack: [], filterStats: { total: 0, eligible: 0, filtered: 0 }, guildUsers: [],
    })),
    getFriendUsersForTrack: vi.fn(async (..._args: unknown[]) => (over.friendUsers ?? [])),
    ...(over.whoKnowsTrackService as object),
  };
  const whoKnowsAlbumService = {
    getFilteredUsersForAlbum: vi.fn(async (..._args: unknown[]) => ({
      filteredUsersWithAlbum: [], filterStats: { total: 0, eligible: 0, filtered: 0 }, guildUsers: [],
    })),
    getFriendUsersForAlbum: vi.fn(async (..._args: unknown[]) => (over.friendUsers ?? [])),
    ...(over.whoKnowsAlbumService as object),
  };
  const whoKnowsPlayService = {
    getGuildAlsoPlayingArtist: vi.fn(async () => undefined),
    getGuildAlsoPlayingTrack: vi.fn(async () => undefined),
    getGuildAlsoPlayingAlbum: vi.fn(async () => undefined),
  };
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
  return {
    service, userService, artistsService, albumService, trackService, friendsService,
    whoKnowsArtistService, whoKnowsTrackService, whoKnowsAlbumService, lastfmRepository, artworkService,
  };
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

describe('WhoKnowsSlashCommands user resolution', () => {
  it('resolves the caller by discord id only - the slash module has no mention or lfm: grammar', async () => {
    const { service, userService } = build();
    await call(service, 'whoKnowsArtistAsync', mkContext({ interaction: { options: opts({ artist: 'mond' }) } }));
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('111');
  });

  it('resolves to self for the track handler too', async () => {
    const { service, userService } = build();
    await call(service, 'whoKnowsTrackAsync', mkContext({ interaction: { options: opts({ track: 'a', artist: 'b' }) } }));
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('111');
  });

  it('resolves to self for the album handler too', async () => {
    const { service, userService } = build();
    await call(service, 'whoKnowsAlbumAsync', mkContext({ interaction: { options: opts({ album: 'a', artist: 'b' }) } }));
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('111');
  });
});

describe('WhoKnowsSlashCommands.whoKnowsTrackAsync guards', () => {
  it('refuses outside a guild', async () => {
    const { service } = build();
    const result = await call(service, 'whoKnowsTrackAsync', mkContext({ guild: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('tells an unregistered caller to register', async () => {
    const { service } = build({ user: null });
    const result = await call(service, 'whoKnowsTrackAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no recent tracks rather than querying an empty track', async () => {
    const { service, whoKnowsTrackService } = build({ recent: [] });
    const result = await call(service, 'whoKnowsTrackAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsTrackService.getFilteredUsersForTrack).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsSlashCommands.whoKnowsTrackAsync track resolution', () => {
  it('parses the Artist | Track pipe syntax', async () => {
    const { service, trackService, whoKnowsTrackService } = build();
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'Mitch Murder | Spectral Bloom ' }) } }),
    );
    expect(trackService.getTrackInfo).toHaveBeenCalledWith('Spectral Bloom', 'Mitch Murder', 'DreadRock');
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[3]).toBe('Spectral Bloom');
  });

  it('falls back to the now-playing track when no options are given', async () => {
    const { service, trackService, whoKnowsTrackService } = build({
      recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom' }],
    });
    await call(service, 'whoKnowsTrackAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(trackService.getTrackInfo).toHaveBeenCalledWith('Spectral Bloom', 'Mitch Murder', 'DreadRock');
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[3]).toBe('Spectral Bloom');
  });

  it('prefers the canonical names from the info lookup', async () => {
    const { service, whoKnowsTrackService } = build({
      trackInfo: { name: 'Spectral Bloom (Remastered)', artistName: 'Mitch Murder', userPlayCount: 12 },
    });
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'spectral bloom', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[3]).toBe('Spectral Bloom (Remastered)');
  });

  it('passes the caller live playcount through when the info has one', async () => {
    const { service, whoKnowsTrackService } = build({
      trackInfo: { name: 'Spectral Bloom', artistName: 'Mitch Murder', userPlayCount: 12 },
    });
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'spectral bloom', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[4]).toBe(12);
  });

  it('passes undefined playcount when the info has none', async () => {
    const { service, whoKnowsTrackService } = build();
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'spectral bloom', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('honours the filter_disabled option', async () => {
    const { service, whoKnowsTrackService } = build();
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'a', artist: 'b', filter_disabled: true }) } }),
    );
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[5]).toBe(true);
  });

  it('defaults the filter to enabled', async () => {
    const { service, whoKnowsTrackService } = build();
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'a', artist: 'b' }) } }),
    );
    expect(whoKnowsTrackService.getFilteredUsersForTrack.mock.calls[0]?.[5]).toBe(false);
  });
});

describe('WhoKnowsSlashCommands.whoKnowsTrackAsync response building', () => {
  it('builds a Track response titled with the resolved names and guild', async () => {
    const { service } = build({
      trackInfo: { name: 'Spectral Bloom', artistName: 'Mitch Murder', playCount: 100, listeners: 50 },
    });
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'spectral bloom', artist: 'mitch murder' }) } }),
    );
    expect(WhoKnowsBuilders.buildWhoKnowsResponse).toHaveBeenCalled();
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toBe('Spectral Bloom by Mitch Murder in Test Guild');
    expect(args[11]).toBe('Track');
  });

  it('falls back to the saved mode when no mode option is given', async () => {
    const { service } = build({ user: { userId: 1, userNameLastFm: 'D', whoKnowsMode: WhoKnowsMode.Image } });
    await call(
      service,
      'whoKnowsTrackAsync',
      mkContext({ interaction: { options: opts({ track: 'a', artist: 'b' }) } }),
    );
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[9]).toBe(WhoKnowsMode.Image);
  });
});

describe('WhoKnowsSlashCommands.whoKnowsAlbumAsync guards', () => {
  it('refuses outside a guild', async () => {
    const { service } = build();
    const result = await call(service, 'whoKnowsAlbumAsync', mkContext({ guild: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('tells an unregistered caller to register', async () => {
    const { service } = build({ user: null });
    const result = await call(service, 'whoKnowsAlbumAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no recent tracks rather than querying an empty album', async () => {
    const { service, whoKnowsAlbumService } = build({ recent: [] });
    const result = await call(service, 'whoKnowsAlbumAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum).not.toHaveBeenCalled();
  });

  it('reports a now-playing track that has no album', async () => {
    const { service, whoKnowsAlbumService } = build({
      recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom' }],
    });
    const result = await call(service, 'whoKnowsAlbumAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsSlashCommands.whoKnowsAlbumAsync album resolution', () => {
  it('parses the Artist | Album pipe syntax', async () => {
    const { service, albumService, whoKnowsAlbumService } = build();
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'Mitch Murder | After Hours ' }) } }),
    );
    expect(albumService.getAlbumInfo).toHaveBeenCalledWith('Mitch Murder', 'After Hours', 'DreadRock');
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[3]).toBe('After Hours');
  });

  it('falls back to the now-playing album when no options are given', async () => {
    const { service, albumService, whoKnowsAlbumService } = build({
      recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom', albumName: 'After Hours' }],
    });
    await call(service, 'whoKnowsAlbumAsync', mkContext({ interaction: { options: opts({}) } }));
    expect(albumService.getAlbumInfo).toHaveBeenCalledWith('Mitch Murder', 'After Hours', 'DreadRock');
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[3]).toBe('After Hours');
  });

  it('prefers the canonical names from the info lookup', async () => {
    const { service, whoKnowsAlbumService } = build({
      albumInfo: { name: 'After Hours (Deluxe)', artistName: 'Mitch Murder', userPlayCount: 30 },
    });
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'after hours', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[3]).toBe('After Hours (Deluxe)');
  });

  it('passes the caller live playcount through when the info has one', async () => {
    const { service, whoKnowsAlbumService } = build({
      albumInfo: { name: 'After Hours', artistName: 'Mitch Murder', userPlayCount: 30 },
    });
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'after hours', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[4]).toBe(30);
  });

  it('passes undefined playcount when the info has none', async () => {
    const { service, whoKnowsAlbumService } = build();
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'after hours', artist: 'mitch murder' }) } }),
    );
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('honours the filter_disabled option', async () => {
    const { service, whoKnowsAlbumService } = build();
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'a', artist: 'b', filter_disabled: true }) } }),
    );
    expect(whoKnowsAlbumService.getFilteredUsersForAlbum.mock.calls[0]?.[5]).toBe(true);
  });
});

describe('WhoKnowsSlashCommands.whoKnowsAlbumAsync response building', () => {
  it('builds an Album response titled with the resolved names and guild', async () => {
    const { service } = build({
      albumInfo: { name: 'After Hours', artistName: 'Mitch Murder', playCount: 500, listeners: 200 },
    });
    await call(
      service,
      'whoKnowsAlbumAsync',
      mkContext({ interaction: { options: opts({ album: 'after hours', artist: 'mitch murder' }) } }),
    );
    expect(WhoKnowsBuilders.buildWhoKnowsResponse).toHaveBeenCalled();
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toBe('After Hours by Mitch Murder in Test Guild');
    expect(args[11]).toBe('Album');
  });
});

describe('WhoKnowsSlashCommands.friendsWhoKnowArtistAsync', () => {
  const guildWithMembers = { name: 'Test Guild', members: { cache: new Map() } };

  it('tells an unregistered caller to register', async () => {
    const { service } = build({ user: null });
    const result = await call(service, 'friendsWhoKnowArtistAsync', mkContext({ guild: guildWithMembers }));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('tells a friendless caller to add friends first', async () => {
    const { service, whoKnowsArtistService } = build({ friends: [] });
    const result = await call(
      service,
      'friendsWhoKnowArtistAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ artist: 'mond' }) } }),
    );
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsArtistService.getFriendUsersForArtists).not.toHaveBeenCalled();
  });

  it('builds an Artist response for the friends list', async () => {
    const { service } = build({ friends: [{ userId: 2 }], artistInfo: { name: 'Mond' } });
    await call(
      service,
      'friendsWhoKnowArtistAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ artist: 'mond' }) } }),
    );
    expect(WhoKnowsBuilders.buildWhoKnowsResponse).toHaveBeenCalled();
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toBe('Friends who know Mond');
    expect(args[11]).toBe('Artist');
  });

  it('injects the caller with their live playcount into the friends list', async () => {
    const { service } = build({
      friends: [{ userId: 2 }],
      artistInfo: { name: 'Mond', userPlayCount: 55 },
      user: { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', discordUserId: '111', lastUsed: new Date() },
    });
    await call(
      service,
      'friendsWhoKnowArtistAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ artist: 'mond' }) } }),
    );
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const users = args[4] as Array<{ lastFmUsername: string; playcount: number }>;
    expect(users).toHaveLength(1);
    expect(users[0]!.lastFmUsername).toBe('DreadRock');
    expect(users[0]!.playcount).toBe(55);
  });

  it('falls back to the now-playing artist when the option is absent', async () => {
    const { service, whoKnowsArtistService } = build({
      friends: [{ userId: 2 }],
      recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom' }],
    });
    await call(
      service,
      'friendsWhoKnowArtistAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({}) } }),
    );
    expect(whoKnowsArtistService.getFriendUsersForArtists.mock.calls[0]?.[2]).toBe('Mitch Murder');
  });
});

describe('WhoKnowsSlashCommands.friendsWhoKnowTrackAsync', () => {
  const guildWithMembers = { name: 'Test Guild', members: { cache: new Map() } };

  it('tells a friendless caller to add friends first', async () => {
    const { service, whoKnowsTrackService } = build({ friends: [] });
    const result = await call(
      service,
      'friendsWhoKnowTrackAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ track: 'a', artist: 'b' }) } }),
    );
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsTrackService.getFriendUsersForTrack).not.toHaveBeenCalled();
  });

  it('parses the Artist | Track pipe syntax', async () => {
    const { service, trackService, whoKnowsTrackService } = build({ friends: [{ userId: 2 }] });
    await call(
      service,
      'friendsWhoKnowTrackAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ track: 'Mitch Murder | Spectral Bloom' }) } }),
    );
    expect(trackService.getTrackInfo).toHaveBeenCalledWith('Spectral Bloom', 'Mitch Murder', 'DreadRock');
    expect(whoKnowsTrackService.getFriendUsersForTrack.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsTrackService.getFriendUsersForTrack.mock.calls[0]?.[3]).toBe('Spectral Bloom');
  });

  it('builds a Track response for the friends list', async () => {
    const { service } = build({
      friends: [{ userId: 2 }],
      trackInfo: { name: 'Spectral Bloom', artistName: 'Mitch Murder' },
    });
    await call(
      service,
      'friendsWhoKnowTrackAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ track: 'spectral bloom', artist: 'mitch murder' }) } }),
    );
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toBe('Friends who know Spectral Bloom by Mitch Murder');
    expect(args[11]).toBe('Track');
  });
});

describe('WhoKnowsSlashCommands.friendsWhoKnowAlbumAsync', () => {
  const guildWithMembers = { name: 'Test Guild', members: { cache: new Map() } };

  it('tells a friendless caller to add friends first', async () => {
    const { service, whoKnowsAlbumService } = build({ friends: [] });
    const result = await call(
      service,
      'friendsWhoKnowAlbumAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ album: 'a', artist: 'b' }) } }),
    );
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsAlbumService.getFriendUsersForAlbum).not.toHaveBeenCalled();
  });

  it('reports a now-playing track that has no album', async () => {
    const { service, whoKnowsAlbumService } = build({
      friends: [{ userId: 2 }],
      recent: [{ artistName: 'Mitch Murder', name: 'Spectral Bloom' }],
    });
    const result = await call(
      service,
      'friendsWhoKnowAlbumAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({}) } }),
    );
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(whoKnowsAlbumService.getFriendUsersForAlbum).not.toHaveBeenCalled();
  });

  it('parses the Artist | Album pipe syntax', async () => {
    const { service, albumService, whoKnowsAlbumService } = build({ friends: [{ userId: 2 }] });
    await call(
      service,
      'friendsWhoKnowAlbumAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ album: 'Mitch Murder | After Hours' }) } }),
    );
    expect(albumService.getAlbumInfo).toHaveBeenCalledWith('Mitch Murder', 'After Hours', 'DreadRock');
    expect(whoKnowsAlbumService.getFriendUsersForAlbum.mock.calls[0]?.[2]).toBe('Mitch Murder');
    expect(whoKnowsAlbumService.getFriendUsersForAlbum.mock.calls[0]?.[3]).toBe('After Hours');
  });

  it('builds an Album response for the friends list', async () => {
    const { service } = build({
      friends: [{ userId: 2 }],
      albumInfo: { name: 'After Hours', artistName: 'Mitch Murder' },
    });
    await call(
      service,
      'friendsWhoKnowAlbumAsync',
      mkContext({ guild: guildWithMembers, interaction: { options: opts({ album: 'after hours', artist: 'mitch murder' }) } }),
    );
    const args = (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[1]).toBe('Friends who know After Hours by Mitch Murder');
    expect(args[11]).toBe('Album');
  });
});
