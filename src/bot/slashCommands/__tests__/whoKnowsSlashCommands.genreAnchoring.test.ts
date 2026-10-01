import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoKnowsSlashCommands';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * The "anchored genres" read in `whoKnowsSlashCommands`, pinned as a deliberate
 * degradation. Same reasoning, same trade and the same shape as its text-command
 * twin, which is covered in full by
 * `whoKnowsCommands.genreAnchoring.test.ts`; this file exists because the two
 * are separate copies of the same branch and a change to one is not a change to
 * the other.
 *
 * The short version: on failure `anchoredGenres` is `undefined`, the
 * `!== undefined` guard skips the assignment, and the card keeps the genres
 * `getFilteredUsersForArtist` already established - so a failure cannot ADD a
 * claim to a card that is otherwise entirely real. A genuine empty `[]` does
 * overwrite, which is the test that would fail if someone removed the guard.
 * `whoKnowsBuilders` has no "could not load genres" affordance, so raising
 * would delete a real card over a footer line.
 */

const USER = { userId: 1, userNameLastFm: 'DreadRock', sessionKey: 'SK' };

const opts = (o: Record<string, string | number | boolean | null> = {}) => ({
  getString: (n: string) => (typeof o[n] === 'string' ? (o[n] as string) : null),
  getInteger: (n: string) => (typeof o[n] === 'number' ? (o[n] as number) : null),
  getBoolean: (n: string) => (typeof o[n] === 'boolean' ? (o[n] as boolean) : null),
});

const ctx = (): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { name: 'Test Guild' },
    prefix: '/',
    interaction: { options: opts({ artist: 'mond' }) },
  }) as unknown as ContextModel;

const filterStats = { total: 0, eligible: 0, filtered: 0 };

/** The caller has no scrobbles, so the top listener's scrobble becomes the anchor. */
const NO_CALLER_TRACK_TOP_LISTENER = {
  filteredUsersWithArtist: [{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }],
  filterStats,
  guildUsers: [],
  genres: ['indie rock'] as string[] | undefined,
  crownModel: null,
};

const builderArgs = () =>
  (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;

const sourceDown = () =>
  new SourceUnavailableError('genreService.getGenresForArtist', new Error('502 from last.fm'), 'Last.fm unavailable', 'LastFmUnavailableError');

const build = (artistResult: Record<string, unknown>) => {
  const service = new WhoKnowsSlashCommands(
    { getUserByDiscordId: vi.fn(async () => USER) } as never,
    { getArtistImageUrl: vi.fn(async () => 'https://img/a.png') } as never,
    { getArtistInfo: vi.fn(async () => null), getArtistAccentColorAsync: vi.fn(async () => undefined) } as never,
    { getAlbumInfo: vi.fn(async () => null) } as never,
    { getTrackInfo: vi.fn(async () => null) } as never,
    { getCloseFriendUserIds: vi.fn(async () => []), getFriendsByUserId: vi.fn(async () => []) } as never,
    { getFilteredUsersForArtist: vi.fn(async () => artistResult), getFriendUsersForArtists: vi.fn(async () => []) } as never,
    { getFilteredUsersForTrack: vi.fn(async () => ({})), getFriendUsersForTrack: vi.fn(async () => []) } as never,
    { getFilteredUsersForAlbum: vi.fn(async () => ({})), getFriendUsersForAlbum: vi.fn(async () => []) } as never,
    { getGuildAlsoPlayingArtist: vi.fn(async () => undefined) } as never,
    { getUserRecentTracks: vi.fn(async () => []) } as never,
    { updateUser: vi.fn(async () => undefined) } as never,
  );
  const privates = service as unknown as {
    whoKnowsArtistAsync: (c: ContextModel) => Promise<unknown>;
  };
  return { call: () => privates.whoKnowsArtistAsync(ctx()) };
};

let genreImpl: () => Promise<string[]>;

beforeEach(() => {
  genreImpl = async () => ['synthwave', 'electronic'];
  vi.restoreAllMocks();
  vi.spyOn(WhoKnowsBuilders, 'buildWhoKnowsResponse').mockResolvedValue({ embed: {} } as never);
  // Called twice: the caller's (undefined) then the top listener's, which is
  // what puts the code on the anchored branch at all.
  let call = 0;
  container.registerInstance(ArtistTrackService, {
    getSampleTrackForArtist: vi.fn(async () => (call++ === 0 ? undefined : 'Sample Track')),
  } as never);
  container.registerInstance(GenreService, {
    getGenresForArtist: vi.fn(() => genreImpl()),
  } as never);
});

describe('WhoKnowsSlashCommands anchored genre read', () => {
  it('still renders the leaderboard when the anchored genre read raises', async () => {
    genreImpl = async () => { throw sourceDown(); };
    const { call } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await call();

    // Argument 4 is `filteredUsersWithArtist` (5 is `filterStats`).
    expect(builderArgs()[4]).toEqual([{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }]);
  });

  it('keeps the genres the service already established, rather than blanking them', async () => {
    genreImpl = async () => { throw sourceDown(); };
    const { call } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await call();

    expect(builderArgs()[7]).toEqual(['indie rock']);
  });

  it('overwrites with the anchored genres when the read succeeds', async () => {
    const { call } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await call();

    expect(builderArgs()[7]).toEqual(['synthwave', 'electronic']);
  });

  it('overwrites with an EMPTY list when the query ran and the artist has no genres', async () => {
    genreImpl = async () => [];
    const { call } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await call();

    expect(builderArgs()[7]).toEqual([]);
  });
});
