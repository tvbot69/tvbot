import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { SettingService } from '@bot/services/system/settingService';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { GenreService } from '@bot/services/library/genreService';
import { WhoKnowsBuilders } from '@bot/builders/whoKnowsBuilders';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The "anchored genres" read in `whoKnowsCommands`, pinned as a deliberate
 * degradation. Its twin in `whoKnowsSlashCommands.ts` is the same code in the
 * same shape; both are covered by the reasoning here and the identical test in
 * `whoKnowsSlashCommands.genreAnchoring.test.ts`.
 *
 * WHY THIS IS NOT THE `.affinity` PARTIAL-SUCCESS CASE, WHICH IT RESEMBLES
 * ------------------------------------------------------------------------
 * The resemblance is real and it is the shape the previous round had to fix
 * twice, so it is worth being precise about the difference. In `.affinity` the
 * unmeasured columns sat INSIDE a table of real people: `artistPercentage` was
 * true, the middle two columns were never measured, and the table looked
 * trustworthy right up to the columns that were not. A reader had no way to
 * tell which parts were real.
 *
 * Here the genre read is the LAST refinement applied to an already-complete
 * card, and its failure cannot ADD a claim to it:
 *
 *   - `anchoredGenres` is `undefined` on failure (the `.catch` replaces the
 *     rejection), and the `anchoredGenres !== undefined` guard therefore SKIPS
 *     the assignment. `result.genres` keeps whatever the service already had.
 *   - a genuine empty `[]` DOES overwrite. So "this artist has no genres" and
 *     "we could not ask" are distinct values in the type, and a fix that raised
 *     on the empty case would break the first.
 *
 * What the user actually sees on failure is the card they would have seen
 * without the refinement: the same real leaderboard, the same real playcounts,
 * one fewer decoration. `whoKnowsBuilders` has no "could not load genres"
 * affordance to render into, so raising would delete a real card over a footer
 * line. Same trade as `fmFooterResolver` and `whoKnowsArtistService`.
 *
 * These assertions are what would catch a regression in either direction: a
 * change that started raising breaks the "still renders" test, and a change
 * that let a failure overwrite good genres breaks the "keeps the caller's own"
 * test.
 */

const user = (): User =>
  ({ userId: 1, discordUserId: '111', userNameLastFm: 'DreadRock', sessionKey: 'SK' } as User);

const ctx = (): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { name: 'Test Guild', members: { cache: { get: () => undefined } } },
    prefix: '.',
    args: [],
  }) as unknown as ContextModel;

const filterStats = { startCount: 0, endCount: 0 };

/** The builder is spied on because it is a static on a class, not an instance
 *  under test - the repo's existing pattern in `whoKnowsCommands.test.ts`. */
const builderArgs = () =>
  (WhoKnowsBuilders.buildWhoKnowsResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;

const sourceDown = () =>
  new SourceUnavailableError('genreService.getGenresForArtist', new Error('502 from last.fm'), 'Last.fm unavailable', 'LastFmUnavailableError');

const build = (artistResult: Record<string, unknown>) => {
  const deps: Record<string, unknown> = {
    userService: { getUserByDiscordId: vi.fn(async () => user()) },
    settingService: new SettingService(),
    artworkService: { getArtistImageUrl: vi.fn(async () => undefined) },
    artistsService: {
      getArtistInfo: vi.fn(async () => null),
      getArtistAccentColorAsync: vi.fn(async () => undefined),
    },
    albumService: { getAlbumInfo: vi.fn(async () => null), getAlbumAccentColor: vi.fn(async () => undefined) },
    trackService: { getTrackInfo: vi.fn(async () => null) },
    friendsService: {
      getFriendsByUserId: vi.fn(async () => []),
      getCloseFriendUserIds: vi.fn(async () => new Set<number>()),
    },
    whoKnowsArtistService: {
      getFilteredUsersForArtist: vi.fn(async () => artistResult),
      getFriendUsersForArtists: vi.fn(async () => []),
    },
    whoKnowsTrackService: { getFilteredUsersForTrack: vi.fn(async () => ({})), getFriendUsersForTrack: vi.fn(async () => []) },
    whoKnowsAlbumService: { getFilteredUsersForAlbum: vi.fn(async () => ({})), getFriendUsersForAlbum: vi.fn(async () => []) },
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
  const commands = new WhoKnowsCommands(
    ...(args as unknown as ConstructorParameters<typeof WhoKnowsCommands>),
  );
  return { commands };
};

/** The caller has no scrobbles, so the top listener's scrobble is the anchor. */
const NO_CALLER_TRACK_TOP_LISTENER = {
  filteredUsersWithArtist: [{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }],
  filterStats,
  guildUsers: [],
  genres: ['indie rock'] as string[] | undefined,
  crownModel: null,
};

let sampleTrack: string | undefined;
let genreImpl: () => Promise<string[]>;

beforeEach(() => {
  sampleTrack = undefined;
  genreImpl = async () => ['synthwave', 'electronic'];
  vi.restoreAllMocks();
  vi.spyOn(WhoKnowsBuilders, 'buildWhoKnowsResponse').mockResolvedValue({} as never);
  // `getSampleTrackForArtist` is called twice: the caller's (undefined) then the
  // top listener's ('Sample Track'). That is what puts the code on the anchored
  // branch at all.
  let call = 0;
  container.registerInstance(ArtistTrackService, {
    getSampleTrackForArtist: vi.fn(async () => (call++ === 0 ? sampleTrack : 'Sample Track')),
  } as never);
  container.registerInstance(GenreService, {
    getGenresForArtist: vi.fn(() => genreImpl()),
  } as never);
});

describe('WhoKnowsCommands anchored genre read', () => {
  it('still renders the leaderboard when the anchored genre read raises', async () => {
    genreImpl = async () => { throw sourceDown(); };
    const { commands } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await commands.whoKnowsArtistAsync(ctx(), 'mond');

    // Argument 4 is `filteredUsersWithArtist` (5 is `filterStats`); it must be
    // the real list.
    expect(builderArgs()[4]).toEqual([{ userId: 42, playcount: 99, lastFmUsername: 'topfan' }]);
  });

  it('keeps the genres the service already established, rather than blanking them', async () => {
    // The load-bearing distinction. On failure `anchoredGenres` is undefined and
    // the guard skips the assignment, so the card keeps what it had. A future
    // change that let the failure overwrite would silently drop real genres.
    genreImpl = async () => { throw sourceDown(); };
    const { commands } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await commands.whoKnowsArtistAsync(ctx(), 'mond');

    expect(builderArgs()[7]).toEqual(['indie rock']);
  });

  it('overwrites with the anchored genres when the read succeeds', async () => {
    // The happy half, proving the branch above is actually reached and the
    // failures above were caused by the raise rather than by dead code.
    const { commands } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await commands.whoKnowsArtistAsync(ctx(), 'mond');

    expect(builderArgs()[7]).toEqual(['synthwave', 'electronic']);
  });

  it('overwrites with an EMPTY list when the query ran and the artist has no genres', async () => {
    // A genuine empty is a real answer and MUST overwrite, or a stale genre
    // from the unanchored read would survive and be rendered as fact. This is
    // the test that would fail if someone "fixed" the failure case by deleting
    // the `!== undefined` guard.
    genreImpl = async () => [];
    const { commands } = build(NO_CALLER_TRACK_TOP_LISTENER);

    await commands.whoKnowsArtistAsync(ctx(), 'mond');

    expect(builderArgs()[7]).toEqual([]);
  });
});
