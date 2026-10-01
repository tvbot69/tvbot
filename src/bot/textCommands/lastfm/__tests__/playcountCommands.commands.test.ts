import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountCommands } from '@bot/textCommands/lastfm/playcountCommands';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { SettingService } from '@bot/services/system/settingService';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The command bodies of the playcount family, which sat entirely untested.
 *
 * The value is in the guard ORDER rather than the happy path. Each command
 * resolves a target, then fetches the user, then fetches the specific data,
 * and each of those can legitimately come back empty. A test that only covers
 * the success path would not notice if the not-found for the USER were
 * reported as "could not find milestone #500", which sends a user hunting for
 * a milestone that never existed.
 */

const mkUser = (over: Partial<User> = {}): User =>
  ({ userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', ...over }) as User;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({ discordUserId: '111', guildId: '222', prefix: '.', member: { displayName: 'Caller' }, ...over }) as unknown as ContextModel;

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => mkUser()),
    getUserByLastFmName: vi.fn(async () => null),
    ...(over.userService as object),
  };
  const settingService = {
    getTimePeriod: vi.fn(() => ({ timePeriod: TimePeriod.AllTime, description: 'Alltime', searchValue: '' })),
    ...(over.settingService as object),
  };
  const playHistoryService = {
    getScrobbleCountFromDate: vi.fn(async () => 10),
    getMilestoneScrobble: vi.fn(async () => null),
    getDiscoveryDates: vi.fn(async () => ({ artistFirstPlay: null, albumFirstPlayDate: null, trackFirstPlayDate: null })),
    getLastListenedDates: vi.fn(async () => ({ artistLastPlay: null, albumLastPlayDate: null, trackLastPlayDate: null })),
    getArtistTotalPlays: vi.fn(async () => 0),
    getArtistPlaycountForDays: vi.fn(async () => 3),
    ...(over.playHistoryService as object),
  };
  const artistsService = { searchArtist: vi.fn(async () => null), ...(over.artistsService as object) };
  const albumService = {};
  const trackService = { searchTrack: vi.fn(async () => null), ...(over.trackService as object) };
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async () => 'https://img/album.png'),
    getTrackCoverUrl: vi.fn(async () => 'https://img/track.png'),
    getArtistImageUrl: vi.fn(async () => 'https://img/artist.png'),
    ...(over.artworkService as object),
  };
  const lastfmRepository = {
    getUserInfo: vi.fn(async () => ({ userNameLastFm: 'DreadRock', playCount: 1000, registeredAt: new Date('2010-01-01') })),
    ...(over.lastfmRepository as object),
  };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x00ff00) };
  const deps = { userService, settingService, playHistoryService, artistsService, albumService, trackService, artworkService, lastfmRepository, colorService };
  const service = new PlaycountCommands(
    userService as never, settingService as never, playHistoryService as never,
    artistsService as never, albumService as never, trackService as never,
    artworkService as never, lastfmRepository as never, colorService as never, undefined,
  );
  return { service, ...deps };
};

const call = (service: PlaycountCommands, name: string, ...args: unknown[]) => {
  const h = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  return h[name]!.bind(service)(...args);
};

beforeEach(() => {
  vi.restoreAllMocks();
  for (const n of ['buildPaceResponse', 'buildMilestoneResponse', 'buildDiscoveryDateResponse', 'buildLastListenedDateResponse', 'buildArtistPaceResponse', 'buildYearOverviewResponse']) {
    vi.spyOn(PlaycountBuilders, n as never).mockReturnValue({ embed: {} } as never);
  }
});

describe('PlaycountCommands.paceAsync', () => {
  it('reports a missing Last.fm user, not a missing goal', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'paceAsync', mkContext(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports no plays in the period rather than dividing by zero', async () => {
    const { service, playHistoryService, settingService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const result = await call(service, 'paceAsync', mkContext(), 'weekly');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the pace response for an all-time query', async () => {
    const { service } = build();
    await call(service, 'paceAsync', mkContext(), '');
    expect(PlaycountBuilders.buildPaceResponse).toHaveBeenCalled();
  });

  it('counts within the period for a non-all-time query', async () => {
    const { service, playHistoryService, settingService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
      startDateTime: new Date('2024-01-01'),
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    await call(service, 'paceAsync', mkContext(), 'weekly');
    expect(playHistoryService.getScrobbleCountFromDate).toHaveBeenCalled();
  });

  it('treats a null scrobble count as zero rather than dividing by it', async () => {
    const { service, playHistoryService, settingService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'paceAsync', mkContext(), 'weekly');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('PlaycountCommands.milestoneAsync', () => {
  const milestone = {
    name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer', timePlayed: new Date('1997-01-01'),
  };

  it('reports a missing Last.fm user', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'milestoneAsync', mkContext(), '');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports a milestone that could not be found', async () => {
    const { service } = build();
    const result = await call(service, 'milestoneAsync', mkContext(), '500');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the response when the milestone is found', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue(milestone);
    await call(service, 'milestoneAsync', mkContext(), '500');
    expect(PlaycountBuilders.buildMilestoneResponse).toHaveBeenCalled();
  });

  it('prefers the album cover and falls back to the track cover', async () => {
    const { service, playHistoryService, artworkService } = build();
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue(milestone);
    (artworkService.getAlbumCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await call(service, 'milestoneAsync', mkContext(), '500');
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalled();
  });

  it('skips the album lookup entirely for a milestone with no album', async () => {
    const { service, playHistoryService, artworkService } = build();
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue({ ...milestone, albumName: null });
    await call(service, 'milestoneAsync', mkContext(), '500');
    expect(artworkService.getAlbumCoverUrl).not.toHaveBeenCalled();
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalled();
  });
});

describe('PlaycountCommands.discoveryDateAsync', () => {
  const found = { trackName: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' };

  it('reports no track to check', async () => {
    const { service } = build();
    const result = await call(service, 'discoveryDateAsync', mkContext(), 'airbag');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the response for a found track', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue(found);
    await call(service, 'discoveryDateAsync', mkContext(), 'airbag');
    expect(PlaycountBuilders.buildDiscoveryDateResponse).toHaveBeenCalled();
  });

  it('passes null dates through when the track has never been played', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue(found);
    await call(service, 'discoveryDateAsync', mkContext(), 'airbag');
    const args = (PlaycountBuilders.buildDiscoveryDateResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[5]).toBeNull();
    expect(args[6]).toBeNull();
  });
});

describe('PlaycountCommands.lastListenedAsync', () => {
  it('reports no track to check', async () => {
    const { service } = build();
    const result = await call(service, 'lastListenedAsync', mkContext(), 'airbag');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the response for a found track', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({
      trackName: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer',
    });
    await call(service, 'lastListenedAsync', mkContext(), 'airbag');
    expect(PlaycountBuilders.buildLastListenedDateResponse).toHaveBeenCalled();
  });
});

describe('PlaycountCommands.artistPaceAsync', () => {
  it('reports when the artist cannot be resolved', async () => {
    const { service } = build();
    const result = await call(service, 'artistPaceAsync', mkContext(), 'nobody');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds the response when the artist resolves', async () => {
    const { service, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 10 });
    await call(service, 'artistPaceAsync', mkContext(), 'radiohead');
    expect(PlaycountBuilders.buildArtistPaceResponse).toHaveBeenCalled();
  });
});

describe('PlaycountCommands target errors short-circuit every command', () => {
  it.each([
    ['paceAsync', 'paceAsync'],
    ['milestoneAsync', 'milestoneAsync'],
    ['discoveryDateAsync', 'discoveryDateAsync'],
    ['lastListenedAsync', 'lastListenedAsync'],
    ['artistPaceAsync', 'artistPaceAsync'],
  ])('%s stops when the caller has not registered', async (_label, method) => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, method, mkContext(), 'x');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('PlaycountCommands.yearAsync', () => {
  it('renders a not-found for a genuinely empty year', async () => {
    const { service } = build({
      playHistoryService: { getYearOverview: vi.fn(async () => ({ totalPlays: 0 })) },
    });

    // The direction that must NOT change. "No plays in 2023" is true when it is
    // true, and a fix for the outage case must not start inventing errors.
    const result = await call(service, 'yearAsync', mkContext(), '2023');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  /**
   * Mirrors the slash route's test. Both routes call the same service method and
   * both previously turned a database outage into "No plays found in <year>",
   * so a fix applied to only one of them would leave the text command lying.
   */
  it('reports a load failure rather than "no plays found" when the database is down', async () => {
    const { service } = build({
      playHistoryService: {
        getYearOverview: vi.fn(async () => {
          throw new SourceUnavailableError('db', new Error('connect ECONNREFUSED'), 'Database unavailable');
        }),
      },
    });

    const result = await call(service, 'yearAsync', mkContext(), '2023');

    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('never builds a chart from a failed read', async () => {
    const { service } = build({
      playHistoryService: {
        getYearOverview: vi.fn(async () => {
          throw new SourceUnavailableError('db', new Error('connect ECONNREFUSED'), 'Database unavailable');
        }),
      },
    });

    await call(service, 'yearAsync', mkContext(), '2023');

    expect(PlaycountBuilders.buildYearOverviewResponse).not.toHaveBeenCalled();
  });

  it('re-throws an unrelated error instead of calling it a database outage', async () => {
    const { service } = build({
      playHistoryService: { getYearOverview: vi.fn(async () => { throw new TypeError('x is not a function'); }) },
    });

    await expect(call(service, 'yearAsync', mkContext(), '2023')).rejects.toThrow(TypeError);
  });
});

describe('SettingService.getGoalAmount is total, not an exact figure', () => {
  it('never returns zero, which would divide by zero downstream', () => {
    expect(SettingService.getGoalAmount('', 0)).toBeGreaterThan(0);
  });
});
