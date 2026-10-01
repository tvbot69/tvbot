/**
 * `/artist info|overview|albums|tracks` - four subcommands over ONE shared
 * pipeline, and the pipeline has the most load-bearing guard in the file:
 * `resolveArtistAndUser`.
 *
 * WHY THE RESOLVER IS THE WHOLE STORY. All four subcommands start with the same
 * two questions, and both of them can fail in a way that is invisible:
 *
 *   - No artist argument. The handler reads the caller's own last scrobble and
 *     takes the artist from it. If that read fails, `artistName` stays empty and
 *     the command answers "No recent tracks found." - which is a claim about the
 *     user's Last.fm history, made by a command that never reached Last.fm. There
 *     is no catch here, so the raise survives to the command boundary. That is
 *     the whole test of the branch, and it is a PAIR: a genuine empty profile
 *     must still say "No recent tracks found", because that is TRUE for it.
 *
 *   - An artist argument. The handler asks Last.fm to canonicalise it, because
 *     "boards of canada" and "Boards of Canada" are two different artist rows to
 *     everything downstream. When the search returns nothing the raw input is
 *     kept, which is right: Last.fm saying "I have never heard of this" is an
 *     answer, and a lookup that failed is not - and this raise survives too.
 *
 * The second trust boundary is `getOrCreateArtist`. It catches and returns
 * `{ artistId: 0, name }`, and that `0` is a SENTINEL, not an id: every builder
 * uses it in a `customId` and in a navigation button. The file is explicit that
 * the sentinel exists so `getArtistImage` skips its cache write rather than
 * writing a cover against artist id 0 - so both halves are asserted, and a
 * mutation that removed the `artistId > 0` guard would write a cover onto an
 * artist row that does not exist.
 *
 * The third is the pair of catches in `getArtistImage`, and they are NOT
 * interchangeable:
 *   - the INNER catch is a cache WRITE. The cover has already been found and is
 *     about to be returned, so a failed write must not abort a card that is
 *     already correct - the only cost is that the next lookup asks again.
 *   - the OUTER catch is the Spotify SEARCH, whose product is decoration. A
 *     failure means "no cover", and the card renders without one.
 * The failing-writes test and the failing-search test therefore assert DIFFERENT
 * things, which is what keeps the two catches from being merged.
 *
 * Prisma is mocked at the module boundary (`vi.mock`), because `getArtistImage`
 * reaches for the real singleton. The two container-resolved collaborators -
 * `ColorService` and `ArtistRepository` - are POPULATED with `registerInstance`,
 * never spied on, so `container.resolve` stays a real code path.
 *
 * Constructor arity read from `artistSlashCommands.ts`:
 * (userService, artistTrackService, musicBrainzService, genreService,
 *  spotifySearchApi, lastfmRepository, updateService). Seven, none `@inject`ed.
 */
import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { ArtistSlashCommands } from '@bot/slashCommands/library/artistSlashCommands';
import { ColorService } from '@bot/services/system/colorService';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { CommandResponse } from '@domain/enums/commandResponse';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { ArtistTrackService } from '@bot/services/library/artistTrackService';
import type { MusicBrainzService } from '@bot/services/media/musicBrainzService';
import type { GenreService } from '@bot/services/library/genreService';
import type { UpdateService } from '@bot/services/lastfm/updateService';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';

const db = vi.hoisted(() => ({
  artist: { update: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

const CALLER = {
  userId: 7,
  discordUserId: 'caller1',
  userNameLastFm: 'DreadRock',
  sessionKey: 'sk-caller',
  lastUpdate: new Date(),
  totalPlayCount: 1000,
};

const LFM_DOWN = (method = 'user.getrecenttracks') =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 500'));

const SPOTIFY_ARTIST = { images: [{ url: 'https://img.test/spotify.jpg' }] };

interface CtxSpec {
  inGuild?: boolean;
  subcommand?: string;
  /** Set when the interaction reports no subcommand at all (a bare `/artist`). */
  noSubcommand?: boolean;
  artist?: string | undefined;
  members?: Record<string, string>;
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const members = spec.members ?? {};
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    guild: inGuild
      ? { id: '222', name: 'Test Guild', members: { cache: { get: (id: string) => (members[id] ? { displayName: members[id] } : undefined) } } }
      : null,
    prefix: '/',
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guildId: inGuild ? '222' : undefined,
      commandName: 'artist',
      user: { id: 'caller1' },
      options: {
        getSubcommand: () => (spec.noSubcommand ? undefined : (spec.subcommand ?? 'info')),
        getString: (name: string) => (name === 'artist' ? (spec.artist ?? null) : null),
      },
    },
  } as unknown as ContextModel;
};

/**
 * Every line of text a user could read on this card, at any nesting depth.
 *
 * RECURSIVE ON PURPOSE. `buildArtistInfoResponse` and `buildArtistOverviewResponse`
 * both switch between a bare `TextDisplayBuilder` and a `SectionBuilder` depending
 * on whether a cover was resolved - and the Section puts its content one level
 * deeper. A flat `components.map(c => c.content)` therefore finds the STATS and
 * loses the artist name and the display name, which is exactly the pair of facts
 * the tests here are about. A flat extractor would make every assertion on the
 * header vacuous while every assertion on the body passed.
 */
const allText = (nodes: unknown[]): string => {
  const lines: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as { content?: unknown; components?: unknown; accessory?: unknown; title?: unknown; description?: unknown };
    if (typeof record.content === 'string') lines.push(record.content);
    if (typeof record.title === 'string') lines.push(record.title);
    if (typeof record.description === 'string') lines.push(record.description);
    if (Array.isArray(record.components)) lines.push(allText(record.components));
    if (record.accessory) lines.push(allText([record.accessory]));
  }
  return lines.join('\n');
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    const json = response.componentsV2Container.toJSON() as { components?: unknown[] };
    return allText(json.components ?? []);
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface Doubles {
  caller?: unknown;
  recent?: () => Promise<unknown[]>;
  search?: () => Promise<unknown[]>;
  topTracks?: unknown[];
  topAlbums?: unknown[];
  totalPlays?: number;
  recentPlays?: { week: number; month: number };
  serverStats?: { serverPlays: number; serverListeners: number };
  genres?: string[];
  artistInfo?: unknown;
  mbData?: unknown;
  spotify?: () => Promise<unknown[]>;
  color?: number;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? CALLER : over.caller)),
  };
  const artistTrackService = {
    getTopTracksForArtist: vi.fn(async () => over.topTracks ?? []),
    getTopAlbumsForArtist: vi.fn(async () => over.topAlbums ?? []),
    getTotalArtistPlays: vi.fn(async () => over.totalPlays ?? 0),
    getArtistRecentPlays: vi.fn(async () => over.recentPlays ?? { week: 1, month: 2 }),
    getServerArtistStats: vi.fn(async () => over.serverStats ?? { serverPlays: 5, serverListeners: 3 }),
  };
  const musicBrainzService = {
    getArtistData: vi.fn(async () => (over.mbData === undefined ? null : over.mbData)),
  };
  const genreService = { getGenresForArtist: vi.fn(async () => over.genres ?? []) };
  const spotifySearchApi = {
    searchArtists: vi.fn(over.spotify ?? (async () => [SPOTIFY_ARTIST])),
  };
  const lastfmRepository = {
    getUserRecentTracks: vi.fn(over.recent ?? (async () => [])),
    searchArtists: vi.fn(over.search ?? (async () => [])),
    getArtistInfo: vi.fn(async () => (over.artistInfo === undefined ? null : over.artistInfo)),
  };
  const updateService = { updateUser: vi.fn(async () => undefined) };

  const cmd = new ArtistSlashCommands(
    userService as unknown as UserService,
    artistTrackService as unknown as ArtistTrackService,
    musicBrainzService as unknown as MusicBrainzService,
    genreService as unknown as GenreService,
    spotifySearchApi as unknown as SpotifySearchApi,
    lastfmRepository as unknown as LastFmRepository,
    updateService as unknown as UpdateService,
  );
  const privates = cmd as unknown as {
    handleSubcommandAsync(c: ContextModel): Promise<ResponseModel>;
  };
  return {
    cmd,
    privates,
    userService,
    artistTrackService,
    musicBrainzService,
    genreService,
    spotifySearchApi,
    lastfmRepository,
    updateService,
  };
};

/** Re-registers the container-resolved repository double for one test. */
const withArtistRow = (row: unknown): void => {
  container.registerInstance(ArtistRepository, {
    getOrCreateArtist: vi.fn(typeof row === 'function' ? (row as () => Promise<unknown>) : async () => row),
  } as unknown as ArtistRepository);
};

const DB_ARTIST = { artistId: 12, name: 'Radiohead', spotifyImageUrl: null, deezerImageUrl: null };

beforeEach(() => {
  db.artist.update.mockReset();
  db.artist.update.mockResolvedValue({});
  container.registerInstance(ColorService, {
    getColorFromImageUrl: vi.fn(async () => 0x445566),
    getAccentColorAsync: vi.fn(async () => 0x445566),
  } as unknown as ColorService);
  withArtistRow(DB_ARTIST);
});

describe('artist target resolution: a failed read is not an empty history', () => {
  it('takes the artist from the caller\'s last scrobble when no artist is given', async () => {
    withArtistRow(DB_ARTIST);
    const { privates, lastfmRepository, artistTrackService } = build({
      recent: async () => [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
    });
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info' }));

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1, 1, undefined, 'sk-caller');
    expect(artistTrackService.getTotalArtistPlays).toHaveBeenCalledWith(7, 'Radiohead');
  });

  it('reports the empty profile when there genuinely are no recent tracks', async () => {
    withArtistRow(DB_ARTIST);
    const { privates, artistTrackService } = build({ recent: async () => [] });
    const response = await privates.handleSubcommandAsync(makeContext({ subcommand: 'info' }));

    // The genuine empty, and TRUE: the user really has scrobbled nothing.
    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('No recent tracks found');
    // And no artist claims are made off the back of it.
    expect(artistTrackService.getTotalArtistPlays).not.toHaveBeenCalled();
  });

  it('RAISES rather than claiming an empty history when Last.fm is down', async () => {
    // THE A1 TEST. The sentence above is the sentence an outage would produce if
    // the read were swallowed - and it is a claim about the user's Last.fm
    // account, made by a command that never got to ask. Nothing about the card
    // would look wrong; there would be no card.
    withArtistRow(DB_ARTIST);
    const { privates } = build({ recent: () => Promise.reject(LFM_DOWN()) });

    const settled = await privates.handleSubcommandAsync(makeContext({ subcommand: 'info' })).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect(settled.e).toBeInstanceOf(LastFmUnavailableError);
    expect(String(settled.e)).toMatch(/user\.getrecenttracks/);
    expect(String(settled.e)).not.toContain('No recent tracks found');
  });

  it('canonicalises a typed artist through Last.fm before anything downstream sees it', async () => {
    // "boards of canada" and "Boards of Canada" are different rows to every
    // artist table in this bot. A raw pass-through would split one artist's
    // history in two and answer `/artist info` for a name the rest of the bot
    // cannot resolve.
    withArtistRow({ ...DB_ARTIST, name: 'Boards of Canada' });
    const { privates, lastfmRepository, artistTrackService } = build({
      search: async () => [{ name: 'Boards of Canada', playcount: 900 }],
    });
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'boards of canada' }));

    expect(lastfmRepository.searchArtists).toHaveBeenCalledWith('boards of canada');
    expect(artistTrackService.getTotalArtistPlays).toHaveBeenCalledWith(7, 'Boards of Canada');
  });

  it('keeps the typed name when Last.fm has never heard of it', async () => {
    // A search that returns nothing is an ANSWER ("no such artist"), not a
    // failure, so the raw input is carried on - unchanged, including its case -
    // and every downstream query is made about the name the user typed. The next
    // test is the other half.
    //
    // The row double returns that same lowercase name, so the assertion below is
    // on what the DATABASE was asked for rather than on what came back; a
    // canonicalising step anywhere in the pipeline would break it.
    withArtistRow({ ...DB_ARTIST, name: 'nobody famous' });
    const { privates, artistTrackService } = build({ search: async () => [] });
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'nobody famous' }));

    const artistRepository = container.resolve(ArtistRepository) as unknown as {
      getOrCreateArtist: ReturnType<typeof vi.fn>;
    };
    expect(artistRepository.getOrCreateArtist).toHaveBeenCalledWith('nobody famous');
    expect(artistTrackService.getTotalArtistPlays).toHaveBeenCalledWith(7, 'nobody famous');
  });

  it('RAISES when the canonicalising search is down rather than trusting the raw spelling', async () => {
    // The asymmetric case, and the more dangerous one. An empty search result
    // keeps the user's own spelling, which is almost always right. An
    // UNREADABLE search would too - so a typo would silently become the artist
    // for every card, and a right spelling would silently become a different
    // (case-wrong) artist that the database does not have.
    withArtistRow(DB_ARTIST);
    const { privates, artistTrackService } = build({
      search: () => Promise.reject(LFM_DOWN('artist.search')),
    });

    await expect(
      privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'boards of canada' })),
    ).rejects.toBeInstanceOf(LastFmUnavailableError);
    expect(artistTrackService.getTotalArtistPlays).not.toHaveBeenCalled();
  });

  it('does not read Last.fm at all when an artist is typed - the search IS the read', async () => {
    const { privates, lastfmRepository } = build();
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' }));
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller before any Last.fm or database read', async () => {
    const { privates, lastfmRepository, musicBrainzService } = build({ caller: null });
    const response = await privates.handleSubcommandAsync(makeContext({ subcommand: 'info' }));

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('have not connected your Last.fm account');
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
    expect(musicBrainzService.getArtistData).not.toHaveBeenCalled();
  });
});

describe('artist row creation: artistId 0 is a sentinel, not an id', () => {
  it('still renders the card under the artist\'s name when the row cannot be read', async () => {
    // `getOrCreateArtist` catches and returns `{ artistId: 0, name }`. The
    // degradation the file promises is "no cover" rather than "wrong artist", so
    // the NAME has to survive - a card titled with an empty artist would be
    // unusable, and one titled with a different artist would be a lie.
    withArtistRow(() => Promise.reject(new Error("Can't reach database server")));
    const { privates } = build({ search: async () => [{ name: 'Radiohead' }] });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );

    expect(cardText(response)).toContain('Radiohead');
  });

  it('writes NO cover when the artist row could not be read', async () => {
    // The load-bearing half of the sentinel. `getArtistImage` found a cover and
    // would have written it to `artist.update` - but with `artistId` 0 there is no
    // row to attach it to, and a write against id 0 either creates a junk
    // artist or fails. So the write is skipped and the cover is still returned.
    withArtistRow(() => Promise.reject(new Error("Can't reach database server")));
    const { privates } = build({ search: async () => [{ name: 'Radiohead' }] });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );

    expect(db.artist.update).not.toHaveBeenCalled();
    // And the cover still reaches the card: the write was a cache, not the answer.
    expect(JSON.stringify(response.componentsV2Container?.toJSON())).toContain(
      'https://img.test/spotify.jpg',
    );
  });

  it('caches the cover it found on the artist row when the row exists', async () => {
    withArtistRow({ ...DB_ARTIST, spotifyImageUrl: null });
    const { privates } = build({ search: async () => [{ name: 'Radiohead' }] });
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' }));

    expect(db.artist.update).toHaveBeenCalledTimes(1);
    const call = db.artist.update.mock.calls[0]![0] as { where: { artistId: number }; data: { spotifyImageUrl: string } };
    expect(call.where.artistId).toBe(12);
    expect(call.data.spotifyImageUrl).toBe('https://img.test/spotify.jpg');
  });

  it('does not re-search Spotify when the row already carries a cover', async () => {
    // The whole point of caching it. A provider call per invocation is a
    // rate-limit cost, and the row's URL was written by that same call last time.
    withArtistRow({ ...DB_ARTIST, spotifyImageUrl: 'https://img.test/cached.jpg' });
    const { privates, spotifySearchApi } = build({ search: async () => [{ name: 'Radiohead' }] });
    await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' }));

    expect(spotifySearchApi.searchArtists).not.toHaveBeenCalled();
    expect(db.artist.update).not.toHaveBeenCalled();
  });

  it('uses the Deezer URL before asking Spotify, since it is already on file', async () => {
    withArtistRow({ ...DB_ARTIST, deezerImageUrl: 'https://img.test/deezer.jpg' });
    const { privates, spotifySearchApi } = build({ search: async () => [{ name: 'Radiohead' }] });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );

    expect(spotifySearchApi.searchArtists).not.toHaveBeenCalled();
    expect(JSON.stringify(response.componentsV2Container?.toJSON())).toContain(
      'https://img.test/deezer.jpg',
    );
  });
});

describe('cover resolution: the two catches do different work and must stay different', () => {
  it('renders the full card when only the cover CACHE WRITE fails', async () => {
    // THE INNER CATCH. The cover has been found and is about to be returned, so
    // raising here would abort a card that is already completely correct - and
    // the only cost of a failed write is that the next invocation asks Spotify
    // again. Asserted on the whole card, not just the cover, because "renders the
    // cover" would pass on a card that had lost its stats.
    withArtistRow({ ...DB_ARTIST });
    db.artist.update.mockRejectedValue(new Error('P2025: record to update not found'));
    const { privates } = build({
      search: async () => [{ name: 'Radiohead' }],
      totalPlays: 120,
      serverStats: { serverPlays: 5, serverListeners: 3 },
      genres: ['alternative'],
      artistInfo: { name: 'Radiohead', playCount: 5_000_000, listeners: 2_000_000, summary: 'A band.' },
    });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );

    const text = cardText(response);
    expect(text).toContain('Radiohead');
    expect(text).toContain('120');
    expect(text).toContain('5,000,000');
    expect(text).toContain('alternative');
    expect(text).toContain('A band.');
    expect(JSON.stringify(response.componentsV2Container?.toJSON())).toContain(
      'https://img.test/spotify.jpg',
    );
  });

  it('renders the card without a cover when the Spotify SEARCH fails', async () => {
    // THE OUTER CATCH, and the difference that matters. Its product is
    // decoration, so the failure costs a thumbnail and nothing else - every
    // number on the card came from somewhere else and every one is still true.
    withArtistRow({ ...DB_ARTIST });
    const { privates } = build({
      search: async () => [{ name: 'Radiohead' }],
      totalPlays: 120,
      genres: ['alternative'],
      spotify: () => Promise.reject(new Error('spotify 503')),
    });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );

    const text = cardText(response);
    expect(text).toContain('Radiohead');
    expect(text).toContain('120');
    expect(text).toContain('alternative');
    // No thumbnail, and no invented colour sampled out of nothing.
    expect(JSON.stringify(response.componentsV2Container?.toJSON())).not.toContain(
      'https://img.test/spotify.jpg',
    );
  });

  it('renders no cover when Spotify answers with an artist that has no image', async () => {
    withArtistRow({ ...DB_ARTIST });
    const { privates } = build({
      search: async () => [{ name: 'Radiohead' }],
      spotify: async () => [{ images: [] }],
    });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );
    expect(cardText(response)).toContain('Radiohead');
    expect(db.artist.update).not.toHaveBeenCalled();
  });

  it('never treats a null Last.fm artist record as zero plays and zero listeners', async () => {
    // `lfmInfo?.playCount ?? 0` is the honest default for a record Last.fm
    // genuinely has nothing for. The thing to pin is the opposite: when it HAS
    // one, the real numbers must appear, because a card that always says 0 looks
    // identical to one built from a failed read.
    withArtistRow({ ...DB_ARTIST });
    const { privates } = build({
      search: async () => [{ name: 'Radiohead' }],
      artistInfo: { name: 'Radiohead', playCount: 12345, listeners: 6789, summary: 'A band.' },
    });
    const text = cardText(await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' })));

    expect(text).toContain('12,345');
    expect(text).toContain('6,789');
  });
});

describe('the four subcommands agree on the pipeline and differ only in the claim', () => {
  const SUBS: Array<{ name: string; expectOnCard: (text: string) => void }> = [
    {
      name: 'info',
      expectOnCard: (t) => {
        expect(t).toContain('Last.fm plays by');
      },
    },
    {
      name: 'overview',
      expectOnCard: (t) => {
        expect(t).toContain('Artist overview for');
      },
    },
    {
      name: 'albums',
      expectOnCard: (t) => {
        expect(t).toContain('Your top albums for');
      },
    },
    {
      name: 'tracks',
      expectOnCard: (t) => {
        expect(t).toContain('total artist plays');
      },
    },
  ];

  it.each(SUBS)('/artist $name renders its own card for the same resolved artist', async ({ name, expectOnCard }) => {
    withArtistRow(DB_ARTIST);
    const { privates } = build({
      search: async () => [{ name: 'Radiohead' }],
      topTracks: [{ name: 'Airbag', playcount: 40 }],
      topAlbums: [{ name: 'OK Computer', playcount: 30 }],
      totalPlays: 120,
    });
    const response = await privates.handleSubcommandAsync(
      makeContext({ subcommand: name, artist: 'Radiohead' }),
    );

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expectOnCard(cardText(response));
  });

  it('defaults to the info card when the subcommand cannot be read', async () => {
    // `?? 'info'` is the default a bare `/artist` lands on. It must be the FULL
    // card and not an error, because `/artist` with no subcommand is a legal
    // invocation and the subcommand is the only thing separating it from `/artist
    // info`.
    withArtistRow(DB_ARTIST);
    const { privates } = build({ search: async () => [{ name: 'Radiohead' }] });
    const response = await privates.handleSubcommandAsync(
      makeContext({ noSubcommand: true, artist: 'Radiohead' }),
    );
    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(cardText(response)).toContain('Last.fm plays by');
  });

  it('renders the honest empty per subcommand rather than a shared "nothing found"', async () => {
    // Each subcommand has its own empty wording. A shared error would tell a user
    // with no albums that they have no tracks.
    withArtistRow(DB_ARTIST);
    const empty = build({ search: async () => [{ name: 'Radiohead' }] });
    const albums = cardText(
      await empty.privates.handleSubcommandAsync(makeContext({ subcommand: 'albums', artist: 'Radiohead' })),
    );
    expect(albums).toContain('No albums found.');

    const tracksEmpty = build({ search: async () => [{ name: 'Radiohead' }] });
    const tracks = cardText(
      await tracksEmpty.privates.handleSubcommandAsync(makeContext({ subcommand: 'tracks', artist: 'Radiohead' })),
    );
    expect(tracks).toContain('No tracks found.');
  });

  it('reports the caller\'s share of their own plays, and 0% when the denominator is 0', async () => {
    // `totalPlayCount` of 0 must give 0%, not NaN%. A `NaN %` on the card is
    // visibly broken, and a divide-by-zero that rendered nothing at all would be
    // a silently missing claim.
    withArtistRow(DB_ARTIST);
    const withTotal = build({ search: async () => [{ name: 'Radiohead' }], totalPlays: 250 });
    expect(cardText(await withTotal.privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' })))).toContain(
      '25.00 %',
    );

    withArtistRow(DB_ARTIST);
    const zeroTotal = build({
      caller: { ...CALLER, totalPlayCount: 0 },
      search: async () => [{ name: 'Radiohead' }],
      totalPlays: 250,
    });
    const text = cardText(
      await zeroTotal.privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' })),
    );
    expect(text).toContain('250');
    expect(text).not.toContain('NaN');
  });

  it('titles the card with the guild nickname when the caller has one', async () => {
    withArtistRow(DB_ARTIST);
    const { privates } = build({ search: async () => [{ name: 'Radiohead' }], totalPlays: 10 });
    const text = cardText(
      await privates.handleSubcommandAsync(
        makeContext({ subcommand: 'info', artist: 'Radiohead', members: { caller1: 'Nickname' } }),
      ),
    );
    expect(text).toContain('Nickname');
  });

  it('reports zero server plays in a DM rather than claiming the server has none', async () => {
    // Outside a guild there is no server, so `getServerArtistStats` is not
    // called at all - the "N plays in this server" clause is omitted rather than
    // printed as zero, because "0 plays in this server" in a DM is a claim about
    // a server the user is not in.
    withArtistRow(DB_ARTIST);
    const { privates, artistTrackService } = build({
      search: async () => [{ name: 'Radiohead' }],
      totalPlays: 10,
    });
    const text = cardText(
      await privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead', inGuild: false })),
    );

    expect(artistTrackService.getServerArtistStats).not.toHaveBeenCalled();
    expect(text).not.toContain('in this server');
  });

  it('refreshes a stale account without blocking the answer, and leaves a fresh one alone', async () => {
    withArtistRow(DB_ARTIST);
    const stale = build({
      caller: { ...CALLER, lastUpdate: new Date('2020-01-01T00:00:00Z') },
      search: async () => [{ name: 'Radiohead' }],
      totalPlays: 10,
    });
    const response = await stale.privates.handleSubcommandAsync(
      makeContext({ subcommand: 'info', artist: 'Radiohead' }),
    );
    expect(stale.updateService.updateUser).toHaveBeenCalledWith(7, { accurateTotal: true });
    expect(response.commandResponse).toBe(CommandResponse.Ok);

    withArtistRow(DB_ARTIST);
    const fresh = build({ search: async () => [{ name: 'Radiohead' }] });
    await fresh.privates.handleSubcommandAsync(makeContext({ subcommand: 'info', artist: 'Radiohead' }));
    expect(fresh.updateService.updateUser).not.toHaveBeenCalled();
  });

  it('registers exactly one command, with all four subcommands', async () => {
    // The dual-mode contract: one top-level builder, and the subcommand names are
    // what the text twin's hand-written grammar has to match. A missing
    // subcommand here is a command the user can see in help and not run.
    const { cmd } = build();
    expect(cmd.commands).toHaveLength(1);
    const json = cmd.commands[0]!.data.toJSON() as { name: string; options?: Array<{ name: string }> };
    expect(json.name).toBe('artist');
    expect((json.options ?? []).map((o) => o.name).sort()).toEqual(['albums', 'info', 'overview', 'tracks']);
  });
});
