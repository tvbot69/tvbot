import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WhoKnowsArtistService } from './whoKnowsArtistService';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository } from '@domain/interfaces/iguildUserRepository';
import type { GuildService } from '../guild/guildService';
import type { GenreService } from '../genreService';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The `getGenresForArtist` swallow in `whoKnowsArtistService`, pinned as a
 * DELIBERATE degradation.
 *
 * This is a "left alone, on purpose" site, and this file exists so that the
 * decision is checkable rather than merely claimed in a comment. The reasoning,
 * briefly: `genres` is a decoration on an otherwise complete card. The
 * who-knows leaderboard - real people, real playcounts, the "N listeners - M
 * plays - Z avg" footer - comes from `whoKnowsRepository` and the repository
 * above it, and none of it passes through this catch. `whoKnowsBuilders` renders
 * the tag line only when the list is non-empty and has no "genres could not
 * load" affordance, so the only reachable outcome is a card with one fewer
 * footer line. Raising would delete the whole leaderboard over that line, which
 * is a worse lie in the other direction. Same trade as `fmFooterResolver`.
 *
 * The assertions below are therefore about the SHAPE of the degradation, and
 * they are what would catch a regression in either direction: a future change
 * that started raising would break the "still returns the leaderboard" test,
 * and one that turned the catch into a real fabricated claim would break the
 * "no genre claim is rendered" test.
 */

const user = { userId: 1, discordUserId: '1', userNameLastFm: 'Moha' } as unknown as User;

const INDEXED_ROWS = [
  { userId: 7, playcount: 120 },
  { userId: 8, playcount: 40 },
];

/**
 * A Discord guild double. It is not optional: `getFilteredUsersForArtist` only
 * queries `whoKnowsRepository` when `discordGuild` is non-null, so passing
 * `null` would silently yield an empty leaderboard and the "still returns the
 * real leaderboard" assertion would pass for the wrong reason. `members.cache`
 * is a real Map because the service reads `.get()` off it twice.
 */
const GUILD = { id: 'g-1', members: { cache: new Map<string, unknown>() } } as never;

/**
 * A real raise, built the way `genreService` builds one. `isSourceUnavailable`
 * matches on `name`, not `instanceof`, precisely because the class is loaded
 * through several module specifiers.
 */
const sourceDown = () =>
  new SourceUnavailableError('genreService.getGenresForArtist', new Error('502 from last.fm'), 'Last.fm unavailable', 'LastFmUnavailableError');

const build = (getGenresForArtist: () => Promise<string[]>) => {
  // Positional arity read off the constructor: (whoKnowsRepository,
  // guildUserRepository, guildService, genreService?, crownService?).
  const whoKnowsRepository = {
    getIndexedUsersForArtist: vi.fn(async () => INDEXED_ROWS),
  } as unknown as IWhoKnowsRepository;
  const guildUserRepository = {
    getGuildUsers: vi.fn(async () => []),
  } as unknown as IGuildUserRepository;
  const guildService = { getGuild: vi.fn(async () => null) } as unknown as GuildService;
  const genreService = { getGenresForArtist: vi.fn(getGenresForArtist) } as unknown as GenreService;

  return new WhoKnowsArtistService(whoKnowsRepository, guildUserRepository, guildService, genreService);
};

const call = (getGenresForArtist: () => Promise<string[]>) =>
  build(getGenresForArtist).getFilteredUsersForArtist(GUILD, user, 'Radiohead', null, false, undefined);

describe('WhoKnowsArtistService genre read', () => {
  it('still returns the real leaderboard when the genre source is unavailable', async () => {
    // The load-bearing assertion: the catch costs a decoration, not the card.
    const result = await call(async () => { throw sourceDown(); });

    expect(result.filteredUsersWithArtist.map((u) => u.userId)).toEqual([7, 8]);
    expect(result.filteredUsersWithArtist.map((u) => u.playcount)).toEqual([120, 40]);
  });

  it('leaves genres undefined on failure, so the builder omits the tag line rather than claiming any', async () => {
    const result = await call(async () => { throw sourceDown(); });

    // `undefined` and `[]` render identically in `whoKnowsBuilders`, but only
    // `undefined` is honest about "we did not ask".
    expect(result.genres).toBeUndefined();
  });

  it('returns real genres when the read succeeds, proving the catch is not masking a success', async () => {
    const result = await call(async () => ['art rock', 'alternative rock']);

    expect(result.genres).toEqual(['art rock', 'alternative rock']);
  });

  it('returns an EMPTY list - not undefined - when the query ran and this artist has no genres', async () => {
    // The honest-empty half. If this collapsed to `undefined` the two cases
    // would be indistinguishable to every caller, which is the shape of the bug
    // this whole round exists to close.
    const result = await call(async () => []);

    expect(result.genres).toEqual([]);
    expect(result.filteredUsersWithArtist).toHaveLength(2);
  });

  it('passes the sample track through to the genre read so the caller anchor is not lost', async () => {
    const genreService = { getGenresForArtist: vi.fn(async () => ['shoegaze']) } as unknown as GenreService;
    const whoKnowsRepository = {
      getIndexedUsersForArtist: vi.fn(async () => INDEXED_ROWS),
    } as unknown as IWhoKnowsRepository;
    const guildUserRepository = { getGuildUsers: vi.fn(async () => []) } as unknown as IGuildUserRepository;
    const guildService = { getGuild: vi.fn(async () => null) } as unknown as GuildService;

    const service = new WhoKnowsArtistService(whoKnowsRepository, guildUserRepository, guildService, genreService);
    await service.getFilteredUsersForArtist(GUILD, user, 'Radiohead', null, false, 'Weird Fishes');

    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Radiohead', 'Weird Fishes');
  });
});
