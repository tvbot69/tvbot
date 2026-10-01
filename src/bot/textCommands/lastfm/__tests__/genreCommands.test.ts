import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GenreCommands } from '@bot/textCommands/lastfm/genreCommands';
import { GenreBuilders } from '@bot/builders/genreBuilders';
import { storeGenreQuery } from '@bot/interactions/genreInteractions';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TimeSettingsModel } from '@domain/models/timeSettings';

/**
 * `.topgenres` / `.genre` / `.whoknowsgenre` / `.artistgenres`.
 *
 * The interesting surface here is the ARGUMENT GRAMMAR, which is hand-written
 * and therefore the part most likely to drift: a leading `<@id>` mention and a
 * leading `lfm:name` both select a DIFFERENT user, and both must then be removed
 * from the query that decides the time period. A mention that leaks into the
 * query is not a crash — it is `.topgenres @someone weekly` silently rendering
 * as an all-time chart of a search string nobody typed, which is exactly the
 * confident-wrong-answer failure the repo treats as the worst outcome.
 *
 * The second axis is the guild-only guard on `.whoknowsgenre`, and the third is
 * the empty-argument path, which silently substitutes the caller's most recent
 * track. That substitution is the kind of thing that should be pinned by a test,
 * because it is a guess the user never made.
 */

vi.mock('@bot/interactions/genreInteractions', () => ({
  storeGenreQuery: vi.fn(),
}));

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

const timeSettings = (over: Partial<TimeSettingsModel> = {}): TimeSettingsModel =>
  ({
    timePeriod: undefined,
    description: 'Weekly',
    searchValue: '',
    ...over,
  }) as TimeSettingsModel;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: {
      id: '222',
      name: 'Test Guild',
      members: { cache: new Map<string, { displayName: string }>() },
    },
    prefix: '.',
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => ctx({ guildId: undefined, guild: null });

type Overrides = {
  caller?: User | null;
  byDiscordId?: Record<string, User | null>;
  byLastFmName?: Record<string, User | null>;
  recentTracks?: unknown[] | null;
  allTimeGenres?: unknown[];
  topArtists?: unknown[] | null;
  artistGenres?: string[];
  artistsForGenre?: unknown[];
  guildUsers?: unknown[];
  timeSettings?: TimeSettingsModel;
  accentColor?: number | null;
};

const build = (over: Overrides = {}) => {
  const me = over.caller === undefined ? caller() : over.caller;

  const userService = {
    getUserByDiscordId: vi.fn(async (...args: unknown[]) => {
      const id = args[0] as string;
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id]!;
      return id === '111' ? me : null;
    }),
    getUserByLastFmName: vi.fn(async (...args: unknown[]) => {
      const name = args[0] as string;
      return (over.byLastFmName?.[name] as User | undefined) ?? null;
    }),
  };
  const settingService = {
    getTimePeriod: vi.fn((..._a: unknown[]) => over.timeSettings ?? timeSettings()),
  };
  const lastfmRepository = {
    getTopArtists: vi.fn(async (..._a: unknown[]) =>
      over.topArtists === undefined ? ([{ name: 'Radiohead', playcount: 900 }] as unknown[]) : over.topArtists,
    ),
    getUserRecentTracks: vi.fn(async (..._a: unknown[]) =>
      over.recentTracks === undefined
        ? ([{ name: 'Weird Fishes', artistName: 'Radiohead' }] as unknown[])
        : over.recentTracks,
    ),
  };
  const genreService = {
    getTopGenresForUserAllTime: vi.fn(async (..._a: unknown[]) =>
      over.allTimeGenres === undefined
        ? [{ genreName: 'Art Rock', userPlaycount: 12, topArtists: ['Radiohead'] }]
        : over.allTimeGenres,
    ),
    getTopGenresForTopArtists: vi.fn(async (..._a: unknown[]) =>
      over.allTimeGenres === undefined
        ? [{ genreName: 'Art Rock', userPlaycount: 12, topArtists: ['Radiohead'] }]
        : over.allTimeGenres,
    ),
    getGenresForArtist: vi.fn(async (..._a: unknown[]) => over.artistGenres ?? ['Art Rock', 'Alternative']),
    getUserArtistsForGenre: vi.fn(async (..._a: unknown[]) =>
      over.artistsForGenre === undefined
        ? [{ artistName: 'Radiohead', userPlaycount: 40 }]
        : over.artistsForGenre,
    ),
    getGuildUsersForGenre: vi.fn(async (..._a: unknown[]) =>
      over.guildUsers === undefined ? [{ userName: 'Alpha', playcount: 40 }] : over.guildUsers,
    ),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async (..._a: unknown[]) =>
      over.accentColor === undefined ? 0x445566 : over.accentColor,
    ),
  };

  const commands = new GenreCommands(
    userService as never,
    settingService as never,
    lastfmRepository as never,
    genreService as never,
    colorService as never,
  );

  return { commands, userService, settingService, lastfmRepository, genreService, colorService };
};

/** Reach the private handlers the way the registry does. */
const privates = (c: GenreCommands) =>
  c as unknown as {
    topGenresAsync: (ctx: ContextModel, raw: string) => Promise<{ commandResponse: CommandResponse }>;
    genreInfoAsync: (ctx: ContextModel, raw: string) => Promise<{ commandResponse: CommandResponse }>;
    whoKnowsGenreAsync: (ctx: ContextModel, raw: string) => Promise<{ commandResponse: CommandResponse }>;
    artistGenresAsync: (ctx: ContextModel, raw: string) => Promise<{ commandResponse: CommandResponse }>;
  };

const desc = (r: { embed: { data: { description?: string } } }): string =>
  (r.embed.data.description ?? '') as string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(GenreBuilders, 'buildTopGenresResponse').mockReturnValue({ marker: 'top' } as never);
  vi.spyOn(GenreBuilders, 'buildArtistGenresResponse').mockReturnValue({ marker: 'artist' } as never);
  vi.spyOn(GenreBuilders, 'buildGenreArtistsResponse').mockReturnValue({ marker: 'info' } as never);
  vi.spyOn(GenreBuilders, 'buildWhoKnowsGenreResponse').mockReturnValue({ marker: 'whoknows' } as never);
  vi.mocked(storeGenreQuery).mockClear();
});

describe('GenreCommands — registration', () => {
  it('registers all four genre triggers with their aliases', () => {
    const { commands } = build();
    expect(commands.commands.map(c => c.name)).toEqual([
      'topgenres',
      'genre',
      'whoknowsgenre',
      'artistgenres',
    ]);
    expect(commands.commands[0]!.aliases).toContain('gl');
    expect(commands.commands[2]!.aliases).toEqual(['wg', 'wkg', 'wkgenre']);
  });
});

describe('GenreCommands.topGenresAsync — the user grammar', () => {
  it('reads the caller themselves when no user is given', async () => {
    const { commands, genreService } = build();

    const result = await privates(commands).topGenresAsync(ctx(), 'weekly');

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ marker: 'top' });
    expect(genreService.getTopGenresForUserAllTime).toHaveBeenCalledWith(1, 100);
  });

  it('routes a leading mention to that user and strips it from the time query', async () => {
    const { commands, userService, settingService, genreService } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) },
    });

    await privates(commands).topGenresAsync(ctx(), '<@999> weekly');

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('999');
    // The mention must not survive into the period parser, or `weekly` is
    // searched alongside a mention nobody meant as a period.
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('weekly');
    expect(genreService.getTopGenresForUserAllTime).toHaveBeenCalledWith(7, 100);
  });

  it('accepts the <@!id> mention form too', async () => {
    const { commands, userService, settingService } = build({
      byDiscordId: { '999': caller({ userId: 7, discordUserId: '999' }) },
    });

    await privates(commands).topGenresAsync(ctx(), '<@!999>');

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('999');
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('');
  });

  it('resolves an lfm: target to a Last.fm name with no Discord user attached', async () => {
    const { commands, userService, settingService } = build();

    await privates(commands).topGenresAsync(ctx(), 'lfm:External monthly');

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('External');
    expect(settingService.getTimePeriod).toHaveBeenCalledWith('monthly');
    // An unregistered external user has no userId, so the all-time rollup is
    // unreachable and the Last.fm fallback must be the path taken.
    const call = vi.mocked(GenreBuilders.buildTopGenresResponse).mock.calls[0]![0] as {
      displayName: string;
    };
    expect(call.displayName).toBe('External');
  });

  it('reports an unregistered mention as NotFound naming the id', async () => {
    const { commands, lastfmRepository } = build({ byDiscordId: { '999': null } });

    const result = await privates(commands).topGenresAsync(ctx(), '<@999>');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('999');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('refuses when the caller has no linked account at all', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await privates(commands).topGenresAsync(ctx(), 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('.register');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });
});

describe('GenreCommands.topGenresAsync — all-time vs a bounded period', () => {
  it('falls back to Last.fm top artists when the all-time rollup is empty', async () => {
    const { commands, lastfmRepository, genreService } = build({ allTimeGenres: [] });

    await privates(commands).topGenresAsync(ctx(), 'weekly');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', undefined, 150);
    expect(genreService.getTopGenresForTopArtists).toHaveBeenCalledWith(
      [{ name: 'Radiohead', playcount: 900 }],
      100,
    );
  });

  it('still builds a card when Last.fm returns nothing at all', async () => {
    // An empty genre list is a real answer here (nobody has scrobbled), so the
    // card renders empty. The bug to avoid is throwing, not the emptiness.
    const { commands } = build({ allTimeGenres: [], topArtists: [] });

    const result = await privates(commands).topGenresAsync(ctx(), 'weekly');

    expect(GenreBuilders.buildTopGenresResponse).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ marker: 'top' });
  });

  it('treats an explicit "alltime" as the all-time rollup even when a period was parsed', async () => {
    // `getTimePeriod('alltime')` DOES return TimePeriod.AllTime, so the
    // `cleanQuery.includes('alltime')` arm is a belt-and-braces second route to
    // the same read. Here the rollup comes back empty, so the assertion is that
    // the FALLBACK runs with an undefined period rather than with whatever
    // token the user typed.
    const { commands, lastfmRepository } = build({ allTimeGenres: [] });

    await privates(commands).topGenresAsync(ctx(), 'alltime');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', undefined, 150);
  });

  it('caches the payload under a fresh key for the paginator', async () => {
    const { commands } = build();

    await privates(commands).topGenresAsync(ctx(), 'weekly');

    const [key, payload] = vi.mocked(storeGenreQuery).mock.calls[0]!;
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(payload).toMatchObject({ type: 'top', displayName: 'Alpha' });
  });
});

describe('GenreCommands.genreInfoAsync — artist vs genre disambiguation', () => {
  it('shows an artist card when the query names an artist with tags', async () => {
    const { commands, genreService } = build({ artistGenres: ['Art Rock', 'Alternative'] });

    const result = await privates(commands).genreInfoAsync(ctx(), 'Radiohead');

    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Radiohead');
    expect(GenreBuilders.buildArtistGenresResponse).toHaveBeenCalledWith(
      'Radiohead',
      ['Art Rock', 'Alternative'],
      0x445566,
    );
    expect(result).toEqual({ marker: 'artist' });
    // The artist branch returns early: it must not also store a genre query.
    expect(storeGenreQuery).not.toHaveBeenCalled();
  });

  it('treats a query with no artist tags as a genre name and lists the callers artists', async () => {
    const { commands, genreService } = build({ artistGenres: [] });

    const result = await privates(commands).genreInfoAsync(ctx(), 'shoegaze');

    expect(genreService.getUserArtistsForGenre).toHaveBeenCalledWith(1, 'shoegaze', 50);
    expect(result).toEqual({ marker: 'info' });
    const [, payload] = vi.mocked(storeGenreQuery).mock.calls[0]!;
    expect(payload).toMatchObject({ type: 'info', genreName: 'shoegaze', isServerView: false });
  });

  it('substitutes the caller\'s most recent artist when no genre is given', async () => {
    const { commands, genreService, lastfmRepository } = build();

    await privates(commands).genreInfoAsync(ctx(), '');

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('Alpha', 1);
    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Radiohead');
  });

  it('reports a caller with no recent track rather than guessing an artist', async () => {
    const { commands, genreService } = build({ recentTracks: [] });

    const result = await privates(commands).genreInfoAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('No recent tracks');
    expect(genreService.getGenresForArtist).not.toHaveBeenCalled();
  });

  it('refuses the recent-track fallback for an unregistered caller', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await privates(commands).genreInfoAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });
});

describe('GenreCommands.whoKnowsGenreAsync — guild only', () => {
  it('refuses outside a server', async () => {
    const { commands, genreService } = build();

    const result = await privates(commands).whoKnowsGenreAsync(dmCtx(), 'indie');

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(genreService.getGuildUsersForGenre).not.toHaveBeenCalled();
  });

  it('asks the guild for the named genre and stores the ranking', async () => {
    const { commands, genreService } = build();

    const result = await privates(commands).whoKnowsGenreAsync(ctx(), 'indie rock');

    expect(genreService.getGuildUsersForGenre).toHaveBeenCalledWith('222', 'indie rock');
    expect(result).toEqual({ marker: 'whoknows' });
    const [, payload] = vi.mocked(storeGenreQuery).mock.calls[0]!;
    expect(payload).toMatchObject({ type: 'whoknows', genreName: 'indie rock', guildId: '222' });
  });

  it('infers a genre from the caller\'s recent artist when none is named', async () => {
    const { commands, genreService } = build({ artistGenres: ['Art Rock', 'Noise Pop'] });

    await privates(commands).whoKnowsGenreAsync(ctx(), '');

    expect(genreService.getGuildUsersForGenre).toHaveBeenCalledWith('222', 'Art Rock');
  });

  it('asks for a genre when the inference cannot produce one', async () => {
    const { commands, genreService } = build({ recentTracks: [], artistGenres: [] });

    const result = await privates(commands).whoKnowsGenreAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('.whoknowsgenre');
    expect(genreService.getGuildUsersForGenre).not.toHaveBeenCalled();
  });
});

describe('GenreCommands.artistGenresAsync', () => {
  it('builds the card for the named artist', async () => {
    const { commands, genreService } = build();

    const result = await privates(commands).artistGenresAsync(ctx(), 'Boards of Canada');

    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Boards of Canada');
    expect(result).toEqual({ marker: 'artist' });
  });

  it('falls back to the recent artist and says so when there are no tags', async () => {
    const { commands, genreService } = build({ artistGenres: [] });

    await privates(commands).artistGenresAsync(ctx(), '');

    // An empty tag list is a genuine answer: the artist exists and has no
    // genres on file. What must not happen is a crash or a stale card.
    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Radiohead');
    expect(GenreBuilders.buildArtistGenresResponse).toHaveBeenCalledWith('Radiohead', [], 0x445566);
  });

  it('reports no recent track instead of inventing an artist', async () => {
    const { commands, genreService } = build({ recentTracks: [] });

    const result = await privates(commands).artistGenresAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(genreService.getGenresForArtist).not.toHaveBeenCalled();
  });

  it('refuses for an unregistered caller on the empty path', async () => {
    const { commands } = build({ caller: null });

    const result = await privates(commands).artistGenresAsync(ctx(), '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('.register');
  });
});
