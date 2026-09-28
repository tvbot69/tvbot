import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountSlashCommands } from './playcountSlashCommands';
import { PlaycountBuilders } from '@bot/builders/playcountBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * playcountSlashCommands was 25.64% with 580 uncovered lines, the largest
 * single gap in the repo.
 *
 * The interesting part is the target resolution and the playcount
 * reconciliation, not the builders. Three rules are easy to get wrong and all
 * three are user-visible:
 *
 *  1. A slash command takes a TYPED user option, so unlike the text commands
 *     there is no mention or `lfm:` parsing to do. The only decision is
 *     whether the option names somebody else.
 *  2. `userId > 0` is a sentinel. A user resolved by Last.fm name rather than
 *     registered has no local row, and querying play history for id 0 would
 *     read SOMEONE ELSE's counts.
 *  3. The total is reconciled across three sources - Last.fm, the local
 *     database, and the recent-window count - taking whichever is highest. A
 *     lower local count must not shrink a number the user can see.
 */

const mkUser = (over: Partial<User> = {}): User =>
  ({ userId: 1, userNameLastFm: 'DreadRock', ...over }) as User;

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
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
  const settingService = { getTimePeriod: vi.fn(() => ({ timePeriod: 'AllTime', description: 'Alltime', searchValue: '' })), ...(over.settingService as object) };
  const playHistoryService = {
    getRecentArtistPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getArtistTotalPlays: vi.fn(async () => 0),
    getRecentAlbumPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getAlbumTotalPlays: vi.fn(async () => 0),
    getRecentTrackPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getTrackTotalPlays: vi.fn(async () => 0),
    ...(over.playHistoryService as object),
  };
  const artistsService = { searchArtist: vi.fn(async () => null), ...(over.artistsService as object) };
  const albumService = { searchAlbum: vi.fn(async () => null), ...(over.albumService as object) };
  const trackService = { searchTrack: vi.fn(async () => null), ...(over.trackService as object) };
  const artworkService = { getAccentColorAsync: vi.fn(async () => undefined), ...(over.artworkService as object) };
  const lastfmRepository = {
    getUserRecentTracksWithMetadata: vi.fn(async () => ({ tracks: [], totalPages: 0, totalScrobbles: 0 })),
    ...(over.lastfmRepository as object),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const deps = { userService, settingService, playHistoryService, artistsService, albumService, trackService, artworkService, lastfmRepository, colorService };
  const service = new PlaycountSlashCommands(
    userService as never, settingService as never, playHistoryService as never,
    artistsService as never, albumService as never, trackService as never,
    artworkService as never, lastfmRepository as never, colorService as never, undefined,
  );
  return { service, ...deps };
};

/** The private resolver, reached the way the command handlers reach it. */
const resolve = (service: PlaycountSlashCommands, context: ContextModel, target?: string) =>
  (service as unknown as { resolveTarget(c: ContextModel, t?: string): Promise<Record<string, unknown>> })
    .resolveTarget(context, target);

const call = (service: PlaycountSlashCommands, name: string, ...args: unknown[]) => {
  const handlers = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  // `.bind` matters: these are private METHODS, so an unbound call would pass
  // the instance as the first real argument and shift everything by one.
  return handlers[name]!.bind(service)(...args);
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlaycountBuilders, 'buildArtistPlaysResponse').mockReturnValue({ embed: {} } as never);
  vi.spyOn(PlaycountBuilders, 'buildAlbumPlaysResponse').mockReturnValue({ embed: {} } as never);
  vi.spyOn(PlaycountBuilders, 'buildTrackPlaysResponse').mockReturnValue({ embed: {} } as never);
});

describe('PlaycountSlashCommands.resolveTarget', () => {
  it('refuses when the caller has not registered', async () => {
    const { service } = build();
    (service as unknown as { userService: { getUserByDiscordId: ReturnType<typeof vi.fn> } })
      .userService.getUserByDiscordId.mockResolvedValue(null);
    const result = await resolve(service, mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('defaults to the caller', async () => {
    const { service } = build();
    const result = await resolve(service, mkContext());
    expect(result.isDifferentUser).toBe(false);
    expect(result.displayName).toBe('Caller');
  });

  it('falls back to the Last.fm name when the context has no member', async () => {
    const { service } = build();
    const result = await resolve(service, mkContext({ member: null }));
    expect(result.displayName).toBe('DreadRock');
  });

  it('redirects to a mentioned user', async () => {
    const { service } = build({ mentioned: mkUser({ userId: 2, userNameLastFm: 'Tycho' }) });
    const result = await resolve(service, mkContext(), '333');
    expect(result.isDifferentUser).toBe(true);
    expect(result.displayName).toBe('<@333>');
  });

  it('refuses a mention whose target has not registered', async () => {
    const { service } = build({ mentioned: null });
    const result = await resolve(service, mkContext(), '333');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('treats a self-mention as the caller', async () => {
    const { service } = build({ mentioned: mkUser({ userId: 2 }) });
    const result = await resolve(service, mkContext(), '111');
    expect(result.isDifferentUser).toBe(false);
  });
});

describe('PlaycountSlashCommands.artistPlaysSlashAsync', () => {
  const found = { artistName: 'Radiohead', userPlaycount: 100 };

  it('returns not-found when the artist cannot be resolved', async () => {
    const { service } = build();
    const result = await call(service, 'artistPlaysSlashAsync', mkContext(), 'nobody', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('uses the Last.fm playcount when it is the highest', async () => {
    const { service, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue(found);
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 2 });

    await call(service, 'artistPlaysSlashAsync', mkContext(), 'radiohead', undefined);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 100, 1, 2);
  });

  it('raises the total to the local count when Last.fm reports zero', async () => {
    const { service, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(55);
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 0, month: 0 });

    await call(service, 'artistPlaysSlashAsync', mkContext(), 'radiohead', undefined);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 55, 0, 0);
  });

  it('never lets a lower local count shrink the number', async () => {
    // A stale local total must not reduce a figure the user can already see.
    const { service, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue(found);
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 0, month: 0 });

    await call(service, 'artistPlaysSlashAsync', mkContext(), 'radiohead', undefined);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 100, 0, 0);
  });

  it('raises the total to the monthly count when that is higher', async () => {
    const { service, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 3 });
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 40 });

    await call(service, 'artistPlaysSlashAsync', mkContext(), 'radiohead', undefined);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 40, 1, 40);
  });

  it('skips the database for a user with the userId 0 sentinel', async () => {
    // userId 0 means "resolved by Last.fm name, not registered". Querying
    // play history for it would read a different user's counts.
    const { service, userService, playHistoryService, artistsService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(mkUser({ userId: 0 }));
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue(found);

    await call(service, 'artistPlaysSlashAsync', mkContext(), 'radiohead', undefined);

    expect(playHistoryService.getRecentArtistPlaycounts).not.toHaveBeenCalled();
    expect(playHistoryService.getArtistTotalPlays).not.toHaveBeenCalled();
  });
});

describe('PlaycountSlashCommands.albumPlaysSlashAsync', () => {
  it('returns not-found when the album cannot be resolved', async () => {
    const { service } = build();
    const result = await call(service, 'albumPlaysSlashAsync', mkContext(), 'nothing', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reconciles the album total across the three sources', async () => {
    const { service, playHistoryService, albumService } = build();
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', albumName: 'OK Computer', userPlaycount: 7 });
    (playHistoryService.getRecentAlbumPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 2, month: 9 });
    (playHistoryService.getAlbumTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await call(service, 'albumPlaysSlashAsync', mkContext(), 'ok computer', undefined);

    expect(PlaycountBuilders.buildAlbumPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'OK Computer', 9, 2, 9);
  });

  it('skips the database for the userId 0 sentinel', async () => {
    const { service, userService, playHistoryService, albumService } = build();
    (userService.getUserByDiscordId as ReturnType<typeof vi.fn>).mockResolvedValue(mkUser({ userId: 0 }));
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({ albumName: 'A', userPlaycount: 1 });

    await call(service, 'albumPlaysSlashAsync', mkContext(), 'a', undefined);

    expect(playHistoryService.getAlbumTotalPlays).not.toHaveBeenCalled();
  });
});

describe('PlaycountSlashCommands.trackPlaysSlashAsync', () => {
  it('returns not-found when the track cannot be resolved', async () => {
    const { service } = build();
    const result = await call(service, 'trackPlaysSlashAsync', mkContext(), 'nothing', undefined);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reconciles the track total across the three sources', async () => {
    const { service, playHistoryService, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', trackName: 'Airbag', userPlaycount: 4 });
    (playHistoryService.getRecentTrackPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 3 });
    (playHistoryService.getTrackTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    await call(service, 'trackPlaysSlashAsync', mkContext(), 'airbag', undefined);

    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'Airbag', 4, 1, 3);
  });

  it('raises the total to the local count when Last.fm reports zero', async () => {
    const { service, playHistoryService, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', trackName: 'Airbag', userPlaycount: 0 });
    (playHistoryService.getTrackTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(88);
    (playHistoryService.getRecentTrackPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 0, month: 0 });

    await call(service, 'trackPlaysSlashAsync', mkContext(), 'airbag', undefined);

    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'Airbag', 88, 0, 0);
  });
});

describe('PlaycountSlashCommands command table', () => {
  it('gives every command a unique name', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with a documented reserved name', () => {
    const { service } = build();
    expect(service.commands.map((c) => c.data.name)).not.toContain('remove');
  });
});
