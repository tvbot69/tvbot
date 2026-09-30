import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountSlashCommands } from './playcountSlashCommands';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { ReceiptBuilders } from '@bot/builders/receiptBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

const mkUser = (over: Partial<User> = {}): User =>
  ({ userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK', ...over }) as User;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild', iconURL: () => 'https://img/guild.png' },
    prefix: '/',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const build = (over: Record<string, unknown> = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) =>
      id === '111' ? mkUser() : ((over.mentioned ?? null) as User | null)),
    ...(over.userService as object),
  };
  const settingService = {
    getTimePeriod: vi.fn(() => ({ timePeriod: TimePeriod.AllTime, description: 'Alltime', searchValue: '' })),
    ...(over.settingService as object),
  };
  const playHistoryService = {
    getRecentArtistPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getArtistTotalPlays: vi.fn(async () => 0),
    getRecentAlbumPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getAlbumTotalPlays: vi.fn(async () => 0),
    getRecentTrackPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getTrackTotalPlays: vi.fn(async () => 0),
    getScrobbleCountFromDate: vi.fn(async () => 42),
    getMilestoneScrobble: vi.fn(async () => null),
    getDiscoveryDates: vi.fn(async () => ({
      artistFirstPlay: null,
      albumFirstPlayDate: null,
      trackFirstPlayDate: null,
    })),
    getLastListenedDates: vi.fn(async () => ({
      artistLastPlay: null,
      albumLastPlayDate: null,
      trackLastPlayDate: null,
    })),
    getArtistPlaycountForDays: vi.fn(async () => 0),
    getYearOverview: vi.fn(async () => ({ totalPlays: 0 })),
    getGuildPlayLeaderboard: vi.fn(async () => []),
    getGuildTimeLeaderboard: vi.fn(async () => []),
    ...(over.playHistoryService as object),
  };
  const artistsService = { searchArtist: vi.fn(async () => null), ...(over.artistsService as object) };
  const albumService = { searchAlbum: vi.fn(async () => null), ...(over.albumService as object) };
  const trackService = { searchTrack: vi.fn(async () => null), ...(over.trackService as object) };
  const artworkService = {
    getAlbumCoverUrl: vi.fn(async () => null),
    getTrackCoverUrl: vi.fn(async () => null),
    getArtistImageUrl: vi.fn(async () => null),
    ...(over.artworkService as object),
  };
  const lastfmRepository = {
    getUserInfo: vi.fn(async () => ({ playCount: 1000, registeredAt: new Date('2020-01-01') })),
    getTopTracks: vi.fn(async () => []),
    ...(over.lastfmRepository as object),
  };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0xff0000) };
  const receiptGenerator = { generateReceipt: vi.fn(async () => Buffer.from('img')) };
  const deps = { userService, settingService, playHistoryService, artistsService, albumService, trackService, artworkService, lastfmRepository, colorService, receiptGenerator };
  const service = new PlaycountSlashCommands(
    userService as never, settingService as never, playHistoryService as never,
    artistsService as never, albumService as never, trackService as never,
    artworkService as never, lastfmRepository as never, colorService as never,
    receiptGenerator as never,
  );
  return { service, ...deps };
};

const call = (service: PlaycountSlashCommands, name: string, ...args: unknown[]) => {
  const handlers = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  return handlers[name]!.bind(service)(...args);
};

const execute = (service: PlaycountSlashCommands, cmdIndex: number, context: ContextModel) =>
  service.commands[cmdIndex]!.executeAsync(context);

const subCmd = (sub: string, opts: Record<string, unknown> = {}) => ({
  getSubcommand: () => sub,
  getString: (n: string) => (typeof opts[n] === 'string' ? (opts[n] as string) : null),
  getInteger: (n: string) => (typeof opts[n] === 'number' ? (opts[n] as number) : null),
  getUser: (n: string) => (opts[n] ? { id: opts[n] } : null),
});

/**
 * The REAL params object, read off the builder rather than re-declared, so a
 * field added to the receipt card cannot silently go unread here.
 */
type ReceiptParams = Parameters<typeof ReceiptBuilders.buildReceiptResponse>[0];

/** What the card was actually told to draw — including the link on the title. */
const receiptParams = (): ReceiptParams =>
  vi.mocked(ReceiptBuilders.buildReceiptResponse).mock.calls[0]![0];

/** The four arguments the count was asked for: name, from, session key, to. */
const countWindow = (playHistoryService: { getScrobbleCountFromDate: unknown }) => {
  const call = (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mock.calls[0]!;
  return { from: call[1] as number | null, sessionKey: call[2], to: call[3] as number | null };
};

/**
 * The zero-padding the window url is built with, written out here on purpose: a
 * test that imported the production helper would follow it silently, and the
 * whole point of these expectations is to be an independent reading of the shape.
 */
const pad2 = (value: number): string => String(value).padStart(2, '0');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlaycountBuilders, 'buildPlaysResponse').mockReturnValue({ content: 'plays' } as never);
  vi.spyOn(PlaycountBuilders, 'buildArtistPlaysResponse').mockReturnValue({ content: 'artist' } as never);
  vi.spyOn(PlaycountBuilders, 'buildAlbumPlaysResponse').mockReturnValue({ content: 'album' } as never);
  vi.spyOn(PlaycountBuilders, 'buildTrackPlaysResponse').mockReturnValue({ content: 'track' } as never);
  vi.spyOn(PlaycountBuilders, 'buildPaceResponse').mockReturnValue({ content: 'pace' } as never);
  vi.spyOn(PlaycountBuilders, 'buildMilestoneResponse').mockReturnValue({ content: 'milestone' } as never);
  vi.spyOn(PlaycountBuilders, 'buildDiscoveryDateResponse').mockReturnValue({ content: 'discovery' } as never);
  vi.spyOn(PlaycountBuilders, 'buildLastListenedDateResponse').mockReturnValue({ content: 'lastlistened' } as never);
  vi.spyOn(PlaycountBuilders, 'buildArtistPaceResponse').mockReturnValue({ content: 'artistpace' } as never);
  vi.spyOn(PlaycountBuilders, 'buildYearOverviewResponse').mockReturnValue({ content: 'year' } as never);
  vi.spyOn(PlaycountBuilders, 'buildLeaderboardResponse').mockReturnValue({ content: 'leaderboard' } as never);
  vi.spyOn(ReceiptBuilders, 'buildReceiptResponse').mockReturnValue({ content: 'receipt' } as never);
});

describe('PlaycountSlashCommands command routing', () => {
  it('routes the total subcommand to playsSlashAsync', async () => {
    const { service } = build();
    const ctx = mkContext({ interaction: { options: subCmd('total') } });
    await execute(service, 0, ctx);
    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalled();
  });

  it('routes the artist subcommand to artistPlaysSlashAsync', async () => {
    const { service, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 10 });
    const ctx = mkContext({ interaction: { options: subCmd('artist', { artist: 'radiohead' }) } });
    await execute(service, 0, ctx);
    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalled();
  });

  it('routes the album subcommand to albumPlaysSlashAsync', async () => {
    const { service, albumService } = build();
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', userPlaycount: 5 });
    const ctx = mkContext({ interaction: { options: subCmd('album', { album: 'ok computer' }) } });
    await execute(service, 0, ctx);
    expect(PlaycountBuilders.buildAlbumPlaysResponse).toHaveBeenCalled();
  });

  it('routes the track subcommand to trackPlaysSlashAsync', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', trackName: 'Airbag', userPlaycount: 3 });
    const ctx = mkContext({ interaction: { options: subCmd('track', { track: 'airbag' }) } });
    await execute(service, 0, ctx);
    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalled();
  });

  it('defaults to total when no subcommand is given', async () => {
    const { service } = build();
    const ctx = mkContext({ interaction: { options: { getSubcommand: () => undefined, getString: () => null, getUser: () => null } } });
    await execute(service, 0, ctx);
    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalled();
  });

  it('routes pace with artist to artistPaceSlashAsync', async () => {
    const { service, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 100 });
    const ctx = mkContext({ interaction: { options: { getString: (n: string) => (n === 'artist' ? 'radiohead' : null), getUser: () => null } } });
    await execute(service, 1, ctx);
    expect(PlaycountBuilders.buildArtistPaceResponse).toHaveBeenCalled();
  });

  it('routes pace without artist to paceSlashAsync', async () => {
    const { service } = build();
    const ctx = mkContext({ interaction: { options: { getString: () => null, getUser: () => null } } });
    await execute(service, 1, ctx);
    expect(PlaycountBuilders.buildPaceResponse).toHaveBeenCalled();
  });

  it('routes milestone subcommand', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead', albumName: 'OK Computer', name: 'Airbag', timePlayed: new Date(),
    });
    const ctx = mkContext({ interaction: { options: { getString: () => '1000', getUser: () => null } } });
    await execute(service, 2, ctx);
    expect(PlaycountBuilders.buildMilestoneResponse).toHaveBeenCalled();
  });

  it('routes discoverydate subcommand', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', trackName: 'Airbag' });
    const ctx = mkContext({ interaction: { options: { getString: () => 'radiohead', getUser: () => null } } });
    await execute(service, 3, ctx);
    expect(PlaycountBuilders.buildDiscoveryDateResponse).toHaveBeenCalled();
  });

  it('routes lastlistened subcommand', async () => {
    const { service, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', trackName: 'Airbag' });
    const ctx = mkContext({ interaction: { options: { getString: () => 'radiohead', getUser: () => null } } });
    await execute(service, 4, ctx);
    expect(PlaycountBuilders.buildLastListenedDateResponse).toHaveBeenCalled();
  });

  it('routes receipt subcommand', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { artistName: 'Radiohead', name: 'Airbag', playcount: 5 },
    ]);
    const ctx = mkContext({ interaction: { options: { getString: () => null, getUser: () => null } } });
    await execute(service, 5, ctx);
    expect(ReceiptBuilders.buildReceiptResponse).toHaveBeenCalled();
  });

  it('routes year subcommand', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getYearOverview as ReturnType<typeof vi.fn>).mockResolvedValue({ totalPlays: 100 });
    const ctx = mkContext({ interaction: { options: { getInteger: () => 2024, getUser: () => null } } });
    await execute(service, 6, ctx);
    expect(PlaycountBuilders.buildYearOverviewResponse).toHaveBeenCalled();
  });

  it('routes leaderboard plays subcommand', async () => {
    const { service } = build();
    const ctx = mkContext({ interaction: { options: subCmd('plays') } });
    await execute(service, 7, ctx);
    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Scrobbles Leaderboard' }),
    );
  });

  it('routes leaderboard time subcommand', async () => {
    const { service } = build();
    const ctx = mkContext({ interaction: { options: subCmd('time') } });
    await execute(service, 7, ctx);
    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Listening Time Leaderboard' }),
    );
  });
});

describe('PlaycountSlashCommands.playsSlashAsync', () => {
  it('uses Last.fm playcount for alltime period', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ playCount: 5000 });
    const result = await call(service, 'playsSlashAsync', mkContext(), 'alltime', undefined);
    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalledWith('Caller', 5000, true, 'Alltime');
    expect((result as { content?: string }).content).toBe('plays');
  });

  it('uses playHistoryService for non-alltime periods', async () => {
    const { service, settingService, playHistoryService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
      startDateTime: new Date('2024-01-01'), endDateTime: new Date('2024-01-08'),
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(123);
    await call(service, 'playsSlashAsync', mkContext(), 'weekly', undefined);
    expect(playHistoryService.getScrobbleCountFromDate).toHaveBeenCalledWith(
      'DreadRock', expect.any(Number), 'SK', expect.any(Number),
    );
    expect(PlaycountBuilders.buildPlaysResponse).toHaveBeenCalledWith('Caller', 123, false, 'Weekly');
  });

  it('returns not-found when count is null', async () => {
    const { service, settingService, playHistoryService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
      startDateTime: new Date('2024-01-01'), endDateTime: new Date('2024-01-08'),
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'playsSlashAsync', mkContext(), 'weekly', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns not-found when Last.fm user not found for alltime', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'playsSlashAsync', mkContext(), 'alltime', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns not-found when caller is not registered', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'playsSlashAsync', mkContext(), 'alltime', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns not-found when mentioned user is not registered', async () => {
    const { service, userService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === '111' ? mkUser() : null);
    const result = await call(service, 'playsSlashAsync', mkContext(), 'alltime', '999');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('PlaycountSlashCommands.paceSlashAsync', () => {
  it('returns not-found when Last.fm user not found', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'paceSlashAsync', mkContext(), '10000', 'alltime', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns not-found when no plays in period', async () => {
    const { service, settingService, playHistoryService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Weekly, description: 'Weekly', searchValue: '',
      startDateTime: new Date('2024-01-01'), endDateTime: new Date('2024-01-08'),
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const result = await call(service, 'paceSlashAsync', mkContext(), '10000', 'weekly', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds pace response for alltime', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ playCount: 5000, registeredAt: new Date('2020-01-01') });
    await call(service, 'paceSlashAsync', mkContext(), '10000', 'alltime', undefined);
    expect(PlaycountBuilders.buildPaceResponse).toHaveBeenCalled();
  });

  it('builds pace response for a specific period', async () => {
    const { service, settingService, playHistoryService } = build();
    (settingService.getTimePeriod as ReturnType<typeof vi.fn>).mockReturnValue({
      timePeriod: TimePeriod.Monthly, description: 'Monthly', searchValue: '',
      startDateTime: new Date('2024-01-01'), endDateTime: new Date('2024-02-01'),
    });
    (playHistoryService.getScrobbleCountFromDate as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    await call(service, 'paceSlashAsync', mkContext(), '10000', 'monthly', undefined);
    expect(PlaycountBuilders.buildPaceResponse).toHaveBeenCalled();
  });
});

describe('PlaycountSlashCommands.milestoneSlashAsync', () => {
  it('returns not-found when Last.fm user not found', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'milestoneSlashAsync', mkContext(), '1000', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns not-found when milestone scrobble not found', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await call(service, 'milestoneSlashAsync', mkContext(), '1000', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds milestone response with album cover', async () => {
    const { service, playHistoryService, artworkService, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ playCount: 10000, registeredAt: new Date('2020-01-01') });
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead', albumName: 'OK Computer', name: 'Airbag', timePlayed: new Date('2024-01-01'),
    });
    (artworkService.getAlbumCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://img/album.png');
    await call(service, 'milestoneSlashAsync', mkContext(), '1000', undefined);
    expect(PlaycountBuilders.buildMilestoneResponse).toHaveBeenCalledWith(
      'Caller', 'DreadRock', 1000, 'Radiohead', 'OK Computer', 'Airbag', expect.any(Date),
      'https://img/album.png', expect.any(Number), false, 1, 1,
    );
  });

  it('falls back to track cover when album cover is null', async () => {
    const { service, playHistoryService, artworkService, lastfmRepository } = build();
    (lastfmRepository.getUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ playCount: 10000, registeredAt: new Date('2020-01-01') });
    (playHistoryService.getMilestoneScrobble as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead', albumName: null, name: 'Airbag', timePlayed: new Date('2024-01-01'),
    });
    (artworkService.getTrackCoverUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://img/track.png');
    await call(service, 'milestoneSlashAsync', mkContext(), '1000', undefined);
    expect(artworkService.getTrackCoverUrl).toHaveBeenCalled();
    expect(PlaycountBuilders.buildMilestoneResponse).toHaveBeenCalledWith(
      'Caller', 'DreadRock', 1000, 'Radiohead', null, 'Airbag', expect.any(Date),
      'https://img/track.png', expect.any(Number), false, 1, 1,
    );
  });
});

describe('PlaycountSlashCommands.discoveryDateSlashAsync', () => {
  it('returns not-found when track not found', async () => {
    const { service } = build();
    const result = await call(service, 'discoveryDateSlashAsync', mkContext(), 'unknown', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds discovery date response', async () => {
    const { service, trackService, playHistoryService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', trackName: 'Airbag' });
    (playHistoryService.getDiscoveryDates as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistFirstPlay: { timePlayed: new Date('2020-01-01') },
      albumFirstPlayDate: new Date('2020-01-02'),
      trackFirstPlayDate: new Date('2020-01-03'),
    });
    await call(service, 'discoveryDateSlashAsync', mkContext(), 'radiohead', undefined);
    expect(PlaycountBuilders.buildDiscoveryDateResponse).toHaveBeenCalled();
  });
});

describe('PlaycountSlashCommands.lastListenedSlashAsync', () => {
  it('returns not-found when track not found', async () => {
    const { service } = build();
    const result = await call(service, 'lastListenedSlashAsync', mkContext(), 'unknown', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds last listened response', async () => {
    const { service, trackService, playHistoryService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', trackName: 'Airbag' });
    (playHistoryService.getLastListenedDates as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistLastPlay: { timePlayed: new Date('2024-01-01') },
      albumLastPlayDate: new Date('2024-01-02'),
      trackLastPlayDate: new Date('2024-01-03'),
    });
    await call(service, 'lastListenedSlashAsync', mkContext(), 'radiohead', undefined);
    expect(PlaycountBuilders.buildLastListenedDateResponse).toHaveBeenCalled();
  });
});

describe('PlaycountSlashCommands.artistPaceSlashAsync', () => {
  it('returns not-found when artist not found', async () => {
    const { service } = build();
    const result = await call(service, 'artistPaceSlashAsync', mkContext(), 'unknown', '10000', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds artist pace response', async () => {
    const { service, artistsService, playHistoryService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 500 });
    (playHistoryService.getArtistPlaycountForDays as ReturnType<typeof vi.fn>).mockResolvedValue(50);
    await call(service, 'artistPaceSlashAsync', mkContext(), 'radiohead', '10000', undefined);
    expect(PlaycountBuilders.buildArtistPaceResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artistName: 'Radiohead', allTimePlays: 500, periodPlays: 50 }),
    );
  });
});

describe('PlaycountSlashCommands.receiptSlashAsync', () => {
  it('returns not-found when no top tracks', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await call(service, 'receiptSlashAsync', mkContext(), null, undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('returns error when receipt generator is not available', async () => {
    const { lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { artistName: 'Radiohead', name: 'Airbag', playcount: 5 },
    ]);
    const { userService, settingService, playHistoryService, artistsService, albumService, trackService, artworkService, colorService } = build();
    const svc = new PlaycountSlashCommands(
      userService as never, settingService as never, playHistoryService as never,
      artistsService as never, albumService as never, trackService as never,
      artworkService as never, lastfmRepository as never, colorService as never,
      undefined,
    );
    const result = await call(svc, 'receiptSlashAsync', mkContext(), null, undefined);
    expect(result.commandResponse).toBe(CommandResponse.Error);
  });

  it('builds receipt response with tracks', async () => {
    const { service, lastfmRepository } = build();
    (lastfmRepository.getTopTracks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { artistName: 'Radiohead', name: 'Airbag', playcount: 5 },
      { artistName: 'Radiohead', name: 'Paranoid Android', playcount: 3 },
    ]);
    await call(service, 'receiptSlashAsync', mkContext(), 'monthly', undefined);
    expect(ReceiptBuilders.buildReceiptResponse).toHaveBeenCalled();
  });
});

/**
 * The count drawn ON the image and the window its own link describes are ONE
 * claim, and they used to disagree: `totalPlays` was counted from the period
 * start with no end, so a `/receipt 2023` printed "plays since 2023" beside a
 * link to 2023. Every test below compares the two, in both directions — the
 * count must not be wider than the link, and where the link is open-ended the
 * count must not be narrower.
 */
describe('PlaycountSlashCommands.receiptSlashAsync — the count and the link are one window', () => {
  const topTracks = [
    { artistName: 'Radiohead', name: 'Airbag', playcount: 30 },
    { artistName: 'Radiohead', name: 'Karma Police', playcount: 12 },
  ];

  const withTracks = (over: Record<string, unknown> = {}) =>
    build({ lastfmRepository: { getTopTracks: vi.fn(async () => topTracks) }, ...over });

  it('bounds the default-month count to the same window the link names, and never past it', async () => {
    const { service, playHistoryService } = withTracks();

    await call(service, 'receiptSlashAsync', mkContext(), null, undefined);

    const { from, to } = countWindow(playHistoryService);
    const now = new Date();
    const urlEndDayEnd = Math.floor(
      new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime() / 1000,
    );
    // A real window, not an open-ended run to now — that is the bug: `to` used
    // to arrive as `undefined`, so the count ran to today while the link stopped
    // at the end of the month.
    expect(to).not.toBeUndefined();
    expect(to).toBeGreaterThan(from!);
    // Never wider than the day the image's own link names.
    expect(to).toBeLessThanOrEqual(urlEndDayEnd);
    // And never in the future: a `to` past now asks for scrobbles that cannot
    // exist yet, which is the one vendor behaviour here that cannot be probed
    // from this machine, so the request stays inside what is answerable.
    expect(to).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('zero-pads the default-month window on both ends, so the link is a date', async () => {
    // `2026-03-01`, not `2026-3-1`. The original unpadded interpolation is
    // UNMEASURED against the live API — whether Last.fm's library parser accepts
    // `2026-3-1` was never probed and could not be from here — so this asserts
    // the format, not that the server accepts it. Padded is right either way.
    const { service } = withTracks();

    await call(service, 'receiptSlashAsync', mkContext(), null, undefined);

    const now = new Date();
    const month = now.getMonth() + 1;
    const lastDay = new Date(now.getFullYear(), month, 0).getDate();
    expect(receiptParams().tracksUrl).toMatch(
      new RegExp(
        `^https://last\\.fm/user/DreadRock/library/tracks\\?from=\\d{4}-${pad2(month)}-01&to=\\d{4}-${pad2(month)}-${pad2(lastDay)}$`,
      ),
    );
  });

  it('counts an explicit period to the end of the day its link names', async () => {
    // `endDateTime` is a DATE and the url prints it as a date, so the count has
    // to cover that whole day. Stopping at its midnight would silently drop
    // every play after it while the link still showed the day.
    const { service, playHistoryService } = withTracks({
      settingService: {
        getTimePeriod: vi.fn(() => ({
          timePeriod: TimePeriod.Weekly,
          description: 'Weekly',
          searchValue: 'weekly',
          startDateTime: new Date(2024, 2, 1),
          endDateTime: new Date(2024, 2, 8),
        })),
      },
    });

    await call(service, 'receiptSlashAsync', mkContext(), 'weekly', undefined);

    expect(receiptParams().tracksUrl).toBe(
      'https://last.fm/user/DreadRock/library/tracks?from=2024-03-01&to=2024-03-08',
    );
    const { from, to } = countWindow(playHistoryService);
    expect(from).toBe(Math.floor(new Date(2024, 2, 1).getTime() / 1000));
    expect(to).toBe(Math.floor(new Date(2024, 2, 8, 23, 59, 59).getTime() / 1000));
  });

  it('leaves the count unbounded when the link is, rather than inventing an end', async () => {
    // The other direction of the same fix. An all-time receipt links to an
    // unbounded page, so bounding the COUNT would be the same disagreement in
    // reverse: a number for a shorter window than the image's own link.
    const { service, playHistoryService } = withTracks({
      settingService: {
        getTimePeriod: vi.fn(() => ({
          timePeriod: TimePeriod.AllTime,
          description: 'Alltime',
          searchValue: 'alltime',
        })),
      },
    });

    await call(service, 'receiptSlashAsync', mkContext(), 'alltime', undefined);

    expect(receiptParams().tracksUrl).toBe('https://last.fm/user/DreadRock/library/tracks');
    const { from, sessionKey, to } = countWindow(playHistoryService);
    expect(from).toBeNull();
    expect(sessionKey).toBe('SK');
    expect(to).toBeNull();
  });

  it('draws the counted window total on the image, not the fallback sum of the track rows', async () => {
    // The number on the image must be the COUNT for the window, which is what
    // the link names. The two sources are deliberately given different values
    // here, so an image that quietly fell back to summing the twelve top rows
    // would be caught rather than coincidentally matching.
    const { service, receiptGenerator } = withTracks({
      playHistoryService: { getScrobbleCountFromDate: vi.fn(async () => 7) },
    });
    const payload = () =>
      (receiptGenerator.generateReceipt as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        totalPlays: number;
      };

    await call(service, 'receiptSlashAsync', mkContext(), null, undefined);

    // 7 is the count for the window; 30 + 12 = 42 is the row sum it must not be.
    expect(payload().totalPlays).toBe(7);
  });
});

describe('PlaycountSlashCommands.yearSlashAsync', () => {
  it('returns not-found when no plays in year', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getYearOverview as ReturnType<typeof vi.fn>).mockResolvedValue({ totalPlays: 0 });
    const result = await call(service, 'yearSlashAsync', mkContext(), 2024, undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('builds year overview response', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getYearOverview as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalPlays: 500,
      topArtists: [{ name: 'Radiohead' }],
    });
    await call(service, 'yearSlashAsync', mkContext(), 2024, undefined);
    expect(PlaycountBuilders.buildYearOverviewResponse).toHaveBeenCalled();
  });

  /**
   * The service used to answer with zeros on a database outage, so this branch
   * rendered "No plays found in 2024" for a year the user demonstrably played
   * music in. `getYearOverview` now raises; these pin that the raise becomes a
   * *visible* load failure rather than either the old lie or an unhandled
   * throw.
   */
  describe('a dead database does not render as an empty year', () => {
    const deadDatabase = () =>
      build({
        playHistoryService: {
          getYearOverview: vi.fn(async () => {
            throw new SourceUnavailableError('db', new Error('connect ECONNREFUSED'), 'Database unavailable');
          }),
        },
      });

    it('reports a load failure instead of "no plays found"', async () => {
      const { service } = deadDatabase();

      const result = await call(service, 'yearSlashAsync', mkContext(), 2024, undefined);

      // NotFound is the lie. Error is the truth.
      expect(result.commandResponse).toBe(CommandResponse.Error);
    });

    it('never reaches the year-overview builder', async () => {
      const { service } = deadDatabase();

      await call(service, 'yearSlashAsync', mkContext(), 2024, undefined);

      // A chart built from nothing would be a chart of zeros - the exact
      // artefact this change exists to prevent.
      expect(PlaycountBuilders.buildYearOverviewResponse).not.toHaveBeenCalled();
    });

    it('does not swallow an unrelated bug as a database outage', async () => {
      const { service, playHistoryService } = build();
      (playHistoryService.getYearOverview as ReturnType<typeof vi.fn>).mockRejectedValue(
        new TypeError('cannot read properties of undefined'),
      );

      // Re-throwing keeps real defects visible in the log instead of dressing
      // them up as a transient connectivity problem the user is told to retry.
      await expect(call(service, 'yearSlashAsync', mkContext(), 2024, undefined)).rejects.toThrow(TypeError);
    });
  });
});

describe('PlaycountSlashCommands leaderboard', () => {
  it('refuses leaderboard plays outside a guild', async () => {
    const { service } = build();
    const result = await call(service, 'leaderboardPlaysSlashAsync', mkContext({ guild: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('refuses leaderboard time outside a guild', async () => {
    const { service } = build();
    const result = await call(service, 'leaderboardTimeSlashAsync', mkContext({ guild: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
  });

  it('builds leaderboard plays response', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getGuildPlayLeaderboard as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: '111', displayName: 'Caller', playCount: 100 },
    ]);
    await call(service, 'leaderboardPlaysSlashAsync', mkContext());
    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Scrobbles Leaderboard', unit: 'plays' }),
    );
  });

  it('builds leaderboard time response', async () => {
    const { service, playHistoryService } = build();
    (playHistoryService.getGuildTimeLeaderboard as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: '111', displayName: 'Caller', totalMinutes: 60 },
    ]);
    await call(service, 'leaderboardTimeSlashAsync', mkContext());
    expect(PlaycountBuilders.buildLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Listening Time Leaderboard', unit: 'minutes' }),
    );
  });
});

describe('PlaycountSlashCommands command table', () => {
  it('gives every command a unique name', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registers all expected commands', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(names).toContain('plays');
    expect(names).toContain('pace');
    expect(names).toContain('milestone');
    expect(names).toContain('discoverydate');
    expect(names).toContain('lastlistened');
    expect(names).toContain('receipt');
    expect(names).toContain('year');
    expect(names).toContain('leaderboard');
  });

  // `recap` was a byte-identical delegate to `year` on both families. The
  // product owner removed it, so this pins the deletion: a rename or a copy
  // back in is a regression, not a harmless duplicate.
  it('no longer registers the recap duplicate of year', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(names).not.toContain('recap');
  });
});
