/**
 * `/genre top | info | whoknows | artist` - the four subcommands, and the two
 * questions this file exists to answer.
 *
 * 1. WHICH BRANCH TURNS AN UNREADABLE SOURCE INTO A CONFIDENT WRONG ANSWER.
 *
 *    `handleTopSubcommand` is the interesting one. When the database aggregate
 *    `getTopGenresForUserAllTime` comes back EMPTY it does not give up - it
 *    falls back to asking Last.fm for the caller's top artists and deriving
 *    genres from those (`genreSlashCommands.ts:173-187`). That fallback is the
 *    feature: an un-indexed listener still gets a card.
 *
 *    It is also the exact shape of the lie this repo refuses to tell. If the
 *    database read is fine but the Last.fm read blows up, the handler reaches
 *    `GenreBuilders.buildTopGenresResponse({ genres: [] })`, which renders
 *    "Sorry, no genre data could be found for your top artists in the selected
 *    time period" with `commandResponse: NotFound` - byte-identical to the card
 *    for a user who genuinely has no genre data. `getTopArtists` raises
 *    `LastFmUnavailableError` on an outage precisely so that cannot happen, and
 *    there is no catch here, so the raise escapes. These tests pin that, and
 *    pin the genuine-empty in the same file so a blanket `catch` cannot pass.
 *
 * 2. WRONG INPUT MUST NOT RENDER AS A SUCCESS.
 *
 *    An unregistered mention must not fall through to being treated as a
 *    Last.fm username, and an unknown subcommand must not be answered with the
 *    default one.
 *
 * Everything here is a plain object double handed to the constructor, built
 * fresh per test. Nothing is spied on - no builder, no service, no container -
 * so there is no `mockRestore` own-property hazard and the assertions are on
 * the ResponseModel the user would actually read.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { GenreSlashCommands } from '@bot/slashCommands/library/genreSlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { GenreService } from '@bot/services/library/genreService';
import type { ColorService } from '@bot/services/system/colorService';

const CALLER = {
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: 'caller1',
  sessionKey: 'sk',
};

/** The transport failure `lastfmApi` raises for anything but a real not-found. */
const LFM_DOWN = (method = 'user.gettopartists') =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 500'));

interface CtxSpec {
  sub?: string | null;
  strings?: Record<string, string | undefined>;
  inGuild?: boolean;
  discordUserId?: string;
}

/**
 * `getString` returns null for an absent option, matching discord.js. `guild`
 * carries the `members.cache.get` the display-name lookups reach for, and is
 * omitted entirely for the DM cases so `context.guild` is genuinely null.
 */
const makeCtx = (spec: CtxSpec = {}): ContextModel => {
  const discordUserId = spec.discordUserId ?? 'caller1';
  const guild =
    spec.inGuild === false
      ? undefined
      : { id: '222', name: 'Test Guild', members: { cache: { get: () => undefined } } };
  return {
    discordUserId,
    guildId: guild ? '222' : undefined,
    guild,
    member: { displayName: 'Caller' },
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guild,
      user: { id: discordUserId, tag: 'caller#1' },
      options: {
        getSubcommand: () => (spec.sub === undefined ? 'top' : spec.sub),
        getString: (name: string) => spec.strings?.[name] ?? null,
        getUser: () => null,
      },
    },
    userIsGuildAdmin: false,
  } as unknown as ContextModel;
};

/** Every word the user would actually read on the card. */
const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return (
      response.componentsV2Container.toJSON() as { components: Array<{ content?: string }> }
    )
      .components.map((c) => c.content ?? '')
      .join('\n');
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface Doubles {
  user?: unknown;
  timePeriod?: { timePeriod?: TimePeriod; description: string };
  topArtists?: () => Promise<unknown[]>;
  recent?: unknown[];
  topGenresForUser?: unknown[];
  topGenresForArtists?: unknown[];
  genresForArtist?: string[];
  artistsForGenre?: unknown[];
  guildGenres?: unknown[];
}

/**
 * Constructor arity, read from `genreSlashCommands.ts`:
 * (userService, settingService, lastfmRepository, genreService, colorService?).
 * The colour service is a double that always answers, so the guild accent
 * branch is exercised rather than skipped.
 */
const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.user === undefined ? CALLER : over.user)),
    getUserByLastFmName: vi.fn(async () => null),
  } as unknown as UserService;
  const settingService = {
    getTimePeriod: vi.fn(() => over.timePeriod ?? { timePeriod: TimePeriod.AllTime, description: 'Alltime' }),
  } as unknown as SettingService;
  const lastfmRepository = {
    getTopArtists: vi.fn(over.topArtists ?? (async () => [])),
    getUserRecentTracks: vi.fn(async () => (over.recent ?? [])),
  } as unknown as LastFmRepository;
  const genreService = {
    getTopGenresForUserAllTime: vi.fn(async () => (over.topGenresForUser ?? [])),
    getTopGenresForTopArtists: vi.fn(async () => (over.topGenresForArtists ?? [])),
    getGenresForArtist: vi.fn(async () => (over.genresForArtist ?? [])),
    getUserArtistsForGenre: vi.fn(async () => (over.artistsForGenre ?? [])),
    getGuildUsersForGenre: vi.fn(async () => (over.guildGenres ?? [])),
  } as unknown as GenreService;
  const colorService = { getAccentColorAsync: vi.fn(async () => 0x00ff00) } as unknown as ColorService;
  const cmd = new GenreSlashCommands(
    userService,
    settingService,
    lastfmRepository,
    genreService,
    colorService,
  );
  return { cmd, userService, lastfmRepository, genreService, colorService };
};

type Handlers = {
  handleGenreSlash(c: ContextModel): Promise<ResponseModel>;
};
const run = (cmd: GenreSlashCommands, ctx: ContextModel) =>
  (cmd as unknown as Handlers).handleGenreSlash(ctx);

describe('GenreSlashCommands.handleGenreSlash: an unknown subcommand is rejected, not defaulted', () => {
  it('answers WrongInput and reaches neither data source', async () => {
    const { cmd, genreService, lastfmRepository } = build();
    const response = await run(cmd, makeCtx({ sub: 'genreplotz' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Unknown subcommand');
    expect(genreService.getTopGenresForUserAllTime).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('treats a missing subcommand as the documented default (top)', async () => {
    // The opposite direction: the `?? 'top'` is a supported input, not a
    // swallow. Discord always sends one, but the fallback must not read as a
    // failure path or the default would be untested dead behaviour.
    const { cmd, genreService } = build({ topGenresForUser: [{ genreName: 'ambient', userPlaycount: 4 }] });
    const response = await run(cmd, makeCtx({ sub: null }));
    expect(genreService.getTopGenresForUserAllTime).toHaveBeenCalledWith(7, 100);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });
});

describe('GenreSlashCommands target resolution: an unregistered user is never a Last.fm username', () => {
  it('refuses an unregistered mention and never retries it as a name', async () => {
    const { cmd, userService } = build({ user: null });
    const response = await run(cmd, makeCtx({ strings: { user: '<@424242>' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('is not registered');
    // The dangerous shape: `getUserByLastFmName('<@424242>')` returning null and
    // the handler carrying on with that string as a Last.fm name.
    expect(userService.getUserByLastFmName).not.toHaveBeenCalled();
  });

  it('resolves a registered mention through the mention id, not the display string', async () => {
    const { cmd, userService } = build({
      topGenresForUser: [{ genreName: 'shoegaze', userPlaycount: 9 }],
    });
    const response = await run(cmd, makeCtx({ strings: { user: '<@424242>' } }));

    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('424242');
    expect(cardText(response)).toContain('Shoegaze');
  });

  it('strips the `lfm:` prefix before looking the name up', async () => {
    const { cmd, userService, lastfmRepository } = build({
      topGenresForUser: [{ genreName: 'dub', userPlaycount: 2 }],
    });
    await run(cmd, makeCtx({ strings: { user: 'lfm:SomeUser' } }));

    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('SomeUser');
    // The resolved name is what reaches Last.fm, prefix included or not.
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('SomeUser', TimePeriod.AllTime, 150);
  });

  it('answers NotFound for a caller who has never registered', async () => {
    const { cmd, genreService } = build({ user: null });
    const response = await run(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/login');
    expect(genreService.getTopGenresForUserAllTime).not.toHaveBeenCalled();
  });
});

describe('GenreSlashCommands /genre top: the Last.fm fallback must not launder an outage into "no genres"', () => {
  it('renders the database aggregate without touching Last.fm when the index has data', async () => {
    const { cmd, genreService, lastfmRepository } = build({
      topGenresForUser: [{ genreName: 'ambient', userPlaycount: 120 }],
    });
    const response = await run(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Ambient');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(genreService.getTopGenresForTopArtists).not.toHaveBeenCalled();
  });

  it('falls back to the caller\'s Last.fm top artists when the index is genuinely empty', async () => {
    // The feature half. An un-indexed listener must still get an answer, and
    // the fallback must be the one the code documents: top ARTISTS, turned into
    // genres by the genre service.
    const topArtists = [
      { name: 'Radiohead', playcount: 900 },
      { name: 'Boards of Canada', playcount: null },
    ];
    const { cmd, lastfmRepository, genreService } = build({
      topGenresForUser: [],
      topArtists: async () => topArtists,
      topGenresForArtists: [{ genreName: 'idm', userPlaycount: 55 }],
    });
    const response = await run(cmd, makeCtx());

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('DreadRock', TimePeriod.AllTime, 150);
    // A null playcount must not become NaN in the mapper input.
    expect(genreService.getTopGenresForTopArtists).toHaveBeenCalledWith([
      { name: 'Radiohead', playcount: 900 },
      { name: 'Boards of Canada', playcount: 0 },
    ], 100);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Idm');
  });

  it('refuses to render the empty card when Last.fm is down', async () => {
    // THE A1 TEST. `buildTopGenresResponse([])` renders "Sorry, no genre data
    // could be found" with NotFound - the same card a user with no genres gets.
    // If the raise were caught anywhere on this path, this test fails.
    const { cmd } = build({ topGenresForUser: [], topArtists: async () => Promise.reject(LFM_DOWN()) });
    await expect(run(cmd, makeCtx())).rejects.toBeInstanceOf(LastFmUnavailableError);
  });

  it('renders the honest empty when Last.fm genuinely answers with no artists', async () => {
    // The other half of the pair. A real "this user has no top artists" must
    // still render the empty card, or the re-throw above would be a blanket
    // refusal that breaks every legitimate un-indexed user.
    const { cmd } = build({ topGenresForUser: [], topArtists: async () => [] });
    const response = await run(cmd, makeCtx());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('no genre data could be found');
  });

  it('skips the database entirely for a bounded period and says which period it rendered', async () => {
    // `weekly` is not an all-time period, so the rollup is skipped and the
    // header must name the period the user asked for - otherwise the card reads
    // as an all-time claim.
    const { cmd, genreService, lastfmRepository } = build({
      timePeriod: { timePeriod: TimePeriod.Weekly, description: 'Weekly' },
      topGenresForUser: [{ genreName: 'shoegaze', userPlaycount: 3 }],
    });
    const response = await run(cmd, makeCtx({ strings: { period: 'weekly' } }));

    expect(genreService.getTopGenresForUserAllTime).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('DreadRock', TimePeriod.Weekly, 150);
    expect(cardText(response)).toContain('Top Weekly genres');
  });
});

describe('GenreSlashCommands /genre info: detection from the now-playing track', () => {
  it('refuses, rather than guessing, when there is no query and no recent track', async () => {
    const { cmd, lastfmRepository, genreService } = build({ recent: [] });
    const response = await run(cmd, makeCtx({ sub: 'info' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recent tracks found');
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
    expect(genreService.getGenresForArtist).not.toHaveBeenCalled();
  });

  it('detects the artist from the caller\'s most recent track when no query is given', async () => {
    const { cmd, lastfmRepository, genreService } = build({
      recent: [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
      genresForArtist: ['art rock', 'alternative'],
    });
    const response = await run(cmd, makeCtx({ sub: 'info' }));

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
    expect(genreService.getGenresForArtist).toHaveBeenCalledWith('Radiohead');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Art Rock');
  });

  it('shows the tag card and does not fall through to the genre chart when tags exist', async () => {
    const { cmd, genreService } = build({
      genresForArtist: ['ambient'],
      artistsForGenre: [{ artistName: 'Boards of Canada', userPlaycount: 12 }],
    });
    await run(cmd, makeCtx({ sub: 'info', strings: { search: 'Boards of Canada' } }));

    expect(genreService.getUserArtistsForGenre).not.toHaveBeenCalled();
  });

  it('falls through to the genre chart when the name has no tags at all', async () => {
    // Characterisation of a real conflation: `info` takes one free-text option
    // for BOTH an artist and a genre, and an artist with no tags is re-rendered
    // as a genre with no artists under it. Nothing is asserted as correct here
    // beyond the behaviour; it is reported separately.
    const { cmd, genreService } = build({
      genresForArtist: [],
      artistsForGenre: [{ artistName: 'Boards of Canada', userPlaycount: 12 }],
    });
    const response = await run(cmd, makeCtx({ sub: 'info', strings: { search: 'Boards of Canada' } }));

    expect(genreService.getUserArtistsForGenre).toHaveBeenCalledWith(7, 'Boards of Canada', 50);
    expect(response.commandResponse).toBe(CommandResponse.Ok);
  });

  it('renders NotFound for a genre nobody in the library plays', async () => {
    const { cmd } = build({ genresForArtist: [], artistsForGenre: [] });
    const response = await run(cmd, makeCtx({ sub: 'info', strings: { search: 'polka' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('no registered artists found');
  });
});

describe('GenreSlashCommands /genre whoknows: a DM cannot answer a server question', () => {
  it('refuses outside a guild instead of returning an empty listener list', async () => {
    const { cmd, genreService } = build({ guildGenres: [] });
    const response = await run(cmd, makeCtx({ sub: 'whoknows', inGuild: false, strings: { genre: 'dub' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(cardText(response)).toContain('within a server');
    expect(genreService.getGuildUsersForGenre).not.toHaveBeenCalled();
  });

  it('asks for a genre rather than guessing one when detection finds nothing', async () => {
    const { cmd, lastfmRepository } = build({ recent: [], genresForArtist: [] });
    const response = await run(cmd, makeCtx({ sub: 'whoknows', strings: {} }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Please specify a genre');
    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
  });

  it('derives the genre from the caller\'s now-playing artist when none is given', async () => {
    const { cmd, genreService } = build({
      recent: [{ name: 'Teardrop', artistName: 'Massive Attack', albumName: 'Mezzanine' }],
      genresForArtist: ['trip hop', 'downtempo'],
      guildGenres: [
        { userId: 7, discordUserId: 'caller1', userNameLastFm: 'DreadRock', playcount: 40 },
      ],
    });
    const response = await run(cmd, makeCtx({ sub: 'whoknows' }));

    expect(genreService.getGuildUsersForGenre).toHaveBeenCalledWith('222', 'trip hop');
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('DreadRock');
  });

  it('renders NotFound - not an error - when nobody in the server plays the genre', async () => {
    const { cmd } = build({ guildGenres: [] });
    const response = await run(cmd, makeCtx({ sub: 'whoknows', strings: { genre: 'dub' } }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Nobody in **Test Guild**');
  });
});

describe('GenreSlashCommands /genre artist', () => {
  it('refuses a blank artist without reading the genre table', async () => {
    const { cmd, genreService } = build();
    const response = await run(cmd, makeCtx({ sub: 'artist', strings: { artist: '   ' } }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Please specify an artist name');
    expect(genreService.getGenresForArtist).not.toHaveBeenCalled();
  });

  it('renders the real no-tags card rather than an error for a known-but-untagged artist', async () => {
    const { cmd } = build({ genresForArtist: [] });
    const response = await run(cmd, makeCtx({ sub: 'artist', strings: { artist: 'Radiohead' } }));

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('No registered genres or tags found');
  });
});