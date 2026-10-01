import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlaycountCommands } from '@bot/textCommands/lastfm/playcountCommands';
import { PlaycountBuilders } from '@bot/builders/library/playcountBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/ports/iuserRepository';

/**
 * `.artistplays` / `.albumplays` / `.trackplays` — the playcount reconciliation
 * in the TEXT family.
 *
 * `playcountSlashCommands.target.test.ts` already pins the same arithmetic for
 * the slash family. It is duplicated here on purpose rather than skipped: the
 * two families are separate copies of this logic (AGENTS.md 3.4), so a fix or a
 * regression applied to one leaves the other lying. The number that reaches the
 * card is the MAXIMUM of three independent sources — Last.fm, the local
 * database, and the recent-window count — and each source can be unreadable in
 * a different way, which is where the interesting cases are:
 *
 *  - the `lfm:someone` sentinel fabricates `userId: 0`. Querying play history
 *    for id 0 would read a different row, so the local reads must be skipped
 *    entirely rather than returning the caller's own counts under someone
 *    else's name;
 *  - a genuine 0 from the local count must still render 0. A fix for the
 *    unreadable case that also swallowed the honest zero would make
 *    "you have never played this artist" unanswerable;
 *  - when the local read RAISES, no card may be built at all. There is no
 *    per-row loop and no Promise.all on this path, so aborting before the
 *    builder is the whole fix.
 */

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

const dbDown = () =>
  new SourceUnavailableError(
    'playRepository.getEntityTotalPlaycount:userPlay.count',
    new Error('connect ECONNREFUSED'),
    'Database unavailable',
  );

type Over = {
  caller?: User | null;
  mentioned?: User | null;
  byLfmName?: User | null;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...args: unknown[]) => {
      const id = args[0] as string;
      if (id === '111') return over.caller === undefined ? caller() : over.caller;
      return (over.mentioned ?? null) as User | null;
    }),
    getUserByLastFmName: vi.fn(async () => (over.byLfmName ?? null) as User | null),
  };
  const settingService = { getTimePeriod: vi.fn(() => ({ timePeriod: 'AllTime', description: 'Alltime', searchValue: '' })) };
  const playHistoryService = {
    getRecentArtistPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getArtistTotalPlays: vi.fn(async () => 0),
    getRecentAlbumPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getAlbumTotalPlays: vi.fn(async () => 0),
    getRecentTrackPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })),
    getTrackTotalPlays: vi.fn(async () => 0),
  };
  const artistsService = { searchArtist: vi.fn(async () => null) };
  const albumService = { searchAlbum: vi.fn(async () => null) };
  const trackService = { searchTrack: vi.fn(async () => null) };
  const artworkService = { getArtistImageUrl: vi.fn(async () => 'https://img/artist.png') };
  const lastfmRepository = { getUserInfo: vi.fn(async () => null) };
  const colorService = { getColorFromImageUrl: vi.fn(async () => 0x445566) };

  const commands = new PlaycountCommands(
    userService as never,
    settingService as never,
    playHistoryService as never,
    artistsService as never,
    albumService as never,
    trackService as never,
    artworkService as never,
    lastfmRepository as never,
    colorService as never,
    undefined,
  );
  return { commands, userService, playHistoryService, artistsService, albumService, trackService };
};

const priv = (c: PlaycountCommands) =>
  c as unknown as Record<
    string,
    (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>
  >;

const artistPlays = (c: PlaycountCommands, raw = 'radiohead') => priv(c)['artistPlaysAsync']!.bind(c)(ctx(), raw);
const albumPlays = (c: PlaycountCommands, raw = 'ok computer') => priv(c)['albumPlaysAsync']!.bind(c)(ctx(), raw);
const trackPlays = (c: PlaycountCommands, raw = 'airbag') => priv(c)['trackPlaysAsync']!.bind(c)(ctx(), raw);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(PlaycountBuilders, 'buildArtistPlaysResponse').mockReturnValue({ marker: 'artist' } as never);
  vi.spyOn(PlaycountBuilders, 'buildAlbumPlaysResponse').mockReturnValue({ marker: 'album' } as never);
  vi.spyOn(PlaycountBuilders, 'buildTrackPlaysResponse').mockReturnValue({ marker: 'track' } as never);
});

describe('.artistplays — reconciling three sources into one number', () => {
  it('reports the artist as unresolvable rather than rendering a zero', async () => {
    const { commands } = build();

    const result = await artistPlays(commands, 'zzzznotanartist');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(PlaycountBuilders.buildArtistPlaysResponse).not.toHaveBeenCalled();
  });

  it('uses the Last.fm playcount when it is the highest of the three', async () => {
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 100 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 2 });

    const result = await artistPlays(commands);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 100, 1, 2);
    expect(result).toEqual({ marker: 'artist' });
  });

  it('raises the total to the local count when Last.fm reports zero', async () => {
    // Last.fm answering 0 for an artist the local index has 55 plays of is the
    // classic split-brain; the higher figure is the one the user can verify.
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(55);
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 0, month: 0 });

    await artistPlays(commands);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 55, 0, 0);
  });

  it('never lets a lower local count shrink a number the user can already see', async () => {
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 100 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(5);

    await artistPlays(commands);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 100, 0, 0);
  });

  it('raises the total to the monthly window when that is higher again', async () => {
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 3 });
    (playHistoryService.getRecentArtistPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 40 });

    await artistPlays(commands);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 40, 1, 40);
  });

  it('renders a genuine zero instead of pretending the count is unknown', async () => {
    // The direction a fix must not break. Last.fm says 0 and the local count
    // says 0 because the user genuinely never played the artist, and that is a
    // real answer. `getEntityTotalPlaycount` raises on a failed query instead of
    // returning 0 precisely so that this case stays reachable.
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const result = await artistPlays(commands);

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 0, 0, 0);
    expect(result.commandResponse).not.toBe(CommandResponse.Error);
  });

  it('asks the database about the LAST.FM-NAMED target only, never the caller', async () => {
    // The `lfm:` sentinel keeps the caller's `userId`, so the two reads are
    // keyed on it. The assertion is that the sentinel short-circuits them.
    const { commands, playHistoryService, artistsService } = build({ byLfmName: null });
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });

    await artistPlays(commands, 'lfm:ghost');

    expect(playHistoryService.getRecentArtistPlaycounts).not.toHaveBeenCalled();
    expect(playHistoryService.getArtistTotalPlays).not.toHaveBeenCalled();
    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('ghost', 'Radiohead', 0, 0, 0);
  });

  it('reads the local counts of a mentioned user, not the caller’s', async () => {
    const { commands, playHistoryService, artistsService } = build({
      mentioned: caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }),
    });
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(12);

    await artistPlays(commands, '<@999> radiohead');

    expect(playHistoryService.getArtistTotalPlays).toHaveBeenCalledWith(7, 'Radiohead');
    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledWith('<@999>', 'Radiohead', 12, 0, 0);
  });

  it('builds no card at all when the local count raises, so no zero escapes', async () => {
    const { commands, playHistoryService, artistsService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'Radiohead', userPlaycount: 0 });
    (playHistoryService.getArtistTotalPlays as ReturnType<typeof vi.fn>).mockRejectedValue(dbDown());

    await expect(artistPlays(commands)).rejects.toThrow(/Database unavailable/);

    // The builder is the last step, so aborting before it is the whole fix: the
    // user gets the command boundary's visible error instead of "0 plays".
    expect(PlaycountBuilders.buildArtistPlaysResponse).not.toHaveBeenCalled();
  });

  it('stops at the account check without touching Last.fm for an unregistered caller', async () => {
    const { commands, userService, artistsService } = build({ caller: null });

    const result = await artistPlays(commands);

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(artistsService.searchArtist).not.toHaveBeenCalled();
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('111');
  });
});

describe('.albumplays — the same arithmetic, a different entity', () => {
  it('reports the album as unresolvable', async () => {
    const { commands } = build();

    const result = await albumPlays(commands, 'zzzznotanalbum');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(PlaycountBuilders.buildAlbumPlaysResponse).not.toHaveBeenCalled();
  });

  it('reconciles the album total across the three sources', async () => {
    const { commands, playHistoryService, albumService } = build();
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead',
      albumName: 'OK Computer',
      userPlaycount: 7,
    });
    (playHistoryService.getRecentAlbumPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 2, month: 9 });
    (playHistoryService.getAlbumTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await albumPlays(commands);

    expect(PlaycountBuilders.buildAlbumPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'OK Computer', 9, 2, 9);
  });

  it('skips both local reads for the userId 0 sentinel', async () => {
    const { commands, playHistoryService, albumService } = build({ byLfmName: null });
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'A', albumName: 'B', userPlaycount: 4,
    });

    await albumPlays(commands, 'lfm:ghost');

    expect(playHistoryService.getRecentAlbumPlaycounts).not.toHaveBeenCalled();
    expect(playHistoryService.getAlbumTotalPlays).not.toHaveBeenCalled();
  });

  it('builds no card when the album count raises', async () => {
    const { commands, playHistoryService, albumService } = build();
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'A', albumName: 'B', userPlaycount: 0,
    });
    (playHistoryService.getAlbumTotalPlays as ReturnType<typeof vi.fn>).mockRejectedValue(dbDown());

    await expect(albumPlays(commands)).rejects.toThrow(/Database unavailable/);
    expect(PlaycountBuilders.buildAlbumPlaysResponse).not.toHaveBeenCalled();
  });
});

describe('.trackplays — the same arithmetic, a third entity', () => {
  it('reports the track as unresolvable', async () => {
    const { commands } = build();

    const result = await trackPlays(commands, 'zzzznotatrack');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(PlaycountBuilders.buildTrackPlaysResponse).not.toHaveBeenCalled();
  });

  it('reconciles the track total across the three sources', async () => {
    const { commands, playHistoryService, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead', trackName: 'Airbag', userPlaycount: 4,
    });
    (playHistoryService.getRecentTrackPlaycounts as ReturnType<typeof vi.fn>).mockResolvedValue({ week: 1, month: 3 });
    (playHistoryService.getTrackTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    await trackPlays(commands);

    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'Airbag', 4, 1, 3);
  });

  it('raises the total to the local count when Last.fm reports zero', async () => {
    const { commands, playHistoryService, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'Radiohead', trackName: 'Airbag', userPlaycount: 0,
    });
    (playHistoryService.getTrackTotalPlays as ReturnType<typeof vi.fn>).mockResolvedValue(88);

    await trackPlays(commands);

    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalledWith('Caller', 'Radiohead', 'Airbag', 88, 0, 0);
  });

  it('skips both local reads for the userId 0 sentinel', async () => {
    const { commands, playHistoryService, trackService } = build({ byLfmName: null });
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'A', trackName: 'B', userPlaycount: 9,
    });

    await trackPlays(commands, 'lfm:ghost');

    expect(playHistoryService.getRecentTrackPlaycounts).not.toHaveBeenCalled();
    expect(playHistoryService.getTrackTotalPlays).not.toHaveBeenCalled();
  });

  it('builds no card when the track count raises', async () => {
    const { commands, playHistoryService, trackService } = build();
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: 'A', trackName: 'B', userPlaycount: 0,
    });
    (playHistoryService.getTrackTotalPlays as ReturnType<typeof vi.fn>).mockRejectedValue(dbDown());

    await expect(trackPlays(commands)).rejects.toThrow(/Database unavailable/);
    expect(PlaycountBuilders.buildTrackPlaysResponse).not.toHaveBeenCalled();
  });
});

describe('the playcount triggers reach those bodies through the registry', () => {
  it('routes the alias of each entity command to the same body', async () => {
    const { commands, artistsService, albumService, trackService } = build();
    (artistsService.searchArtist as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'R', userPlaycount: 1 });
    (albumService.searchAlbum as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'R', albumName: 'A', userPlaycount: 1 });
    (trackService.searchTrack as ReturnType<typeof vi.fn>).mockResolvedValue({ artistName: 'R', trackName: 'T', userPlaycount: 1 });

    for (const [name, alias] of [
      ['artistplays', 'ap'],
      ['albumplays', 'abp'],
      ['trackplays', 'tp'],
    ] as const) {
      const byName = commands.commands.find((c) => c.name === name)!;
      const byAlias = commands.commands.find((c) => (c.aliases ?? []).includes(alias))!;
      expect(byAlias).toBeDefined();

      const named = await byName.executeAsync(ctx(), ['radiohead']);
      const aliased = await byAlias.executeAsync(ctx(), ['radiohead']);

      expect(named).toBeDefined();
      expect(aliased).toBeDefined();
    }

    expect(PlaycountBuilders.buildArtistPlaysResponse).toHaveBeenCalledTimes(2);
    expect(PlaycountBuilders.buildAlbumPlaysResponse).toHaveBeenCalledTimes(2);
    expect(PlaycountBuilders.buildTrackPlaysResponse).toHaveBeenCalledTimes(2);

    // Same body, same builder, SAME ARGUMENTS for the long name and the short
    // alias. The registry lets a duplicate trigger win silently, so a divergence
    // here is a real difference in what two users of the same command see.
    const artistCalls = vi.mocked(PlaycountBuilders.buildArtistPlaysResponse).mock.calls;
    const albumCalls = vi.mocked(PlaycountBuilders.buildAlbumPlaysResponse).mock.calls;
    const trackCalls = vi.mocked(PlaycountBuilders.buildTrackPlaysResponse).mock.calls;
    expect(artistCalls[0]).toEqual(artistCalls[1]);
    expect(albumCalls[0]).toEqual(albumCalls[1]);
    expect(trackCalls[0]).toEqual(trackCalls[1]);
  });

  it('reports the unresolvable entity through the trigger, not a crash', async () => {
    const { commands } = build();
    const byName = commands.commands.find((c) => c.name === 'trackplays')!;

    const result = await byName.executeAsync(ctx(), []);

    // An empty argument vector must be tolerated by the hand-written join, and
    // the honest "no such track" must survive to the user.
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});
