/**
 * `.artist` / `.artistoverview` / `.artistalbums` — the three artist cards.
 *
 * All three run the same four-step pipeline, and the interesting failures are
 * all about WHICH ARTIST the card ends up naming, because every number on it
 * hangs off that name.
 *
 * **1. The name resolution has two branches and only one is trustworthy.**
 * With an argument, the typed string is run through `searchArtists` and the
 * FIRST result wins. With no argument, the caller's most recent scrobble
 * supplies the name. Both can fail, and both failures have to be told apart
 * from a genuine zero:
 *   - `searchArtists` returns `[]` -> keep the typed string. A user who typed a
 *     band Last.fm's search does not index must still get a card about THAT
 *     band, not "No recent tracks found."
 *   - `searchArtists` RAISES -> nothing was learned, so nothing may be claimed.
 *     A caught throw here answered `No recent tracks found.`, which is a
 *     statement about the caller's listening history produced by a network
 *     failure.
 *   - `getUserRecentTracks` returns `[]` -> genuinely nothing to describe.
 *
 * **2. `getOrCreateArtist` failing degrades to `artistId: 0`, and that zero is
 * load-bearing.** It gates the Spotify cover CACHE WRITE (`artistId > 0`), so a
 * failed artist lookup must not write a cover onto artist row 0 — which every
 * later read of row 0 would then serve as the cover for whichever artist failed
 * first. It is also the id stamped into the navigation customIds, so the card
 * still navigates, to id 0, which is a real (if unhelpful) state rather than a
 * wrong artist's page.
 *
 * The inner `.catch(() => undefined)` on the Prisma write is asserted as a FLOOR
 * and not as a bug: the URL has already been fetched and is about to be
 * returned, so a failed cache write costs the next lookup and nothing else. The
 * Spotify SEARCH is the same shape — decoration, and the card is complete
 * without it.
 *
 * Constructor arity, read from `artistCommands.ts` — EIGHT, all required, in
 * this order: (userService, artistTrackService, musicBrainzService,
 * genreService, spotifySearchApi, lastfmRepository, updateService,
 * artistsService). A swapped stub compiles clean and then fails inside the
 * service, looking exactly like "this user has no plays".
 *
 * `container.resolve(ArtistRepository)` is real production wiring, so
 * `ArtistRepository` is REGISTERED as an instance and cleared afterwards — no
 * `vi.spyOn(container, ...)`. `prisma` is mocked as a module, because
 * `artistCommands` imports the singleton directly.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';

import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';

/**
 * `vi.mock` is hoisted above every other statement, so a factory that closes
 * over a top-level `const` throws `Cannot access ... before initialization` when
 * the import graph reaches it. `vi.hoisted` builds the double in the hoisted
 * phase instead.
 */
const prismaMock = vi.hoisted(() => ({
  artist: {
    update: vi.fn(async (..._args: unknown[]) => ({})),
    findFirst: vi.fn(async (..._args: unknown[]) => null),
  },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: prismaMock }));

import { ArtistCommands } from '@bot/textCommands/lastfm/artistCommands';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { UserService } from '@bot/services/user/userService';
import type { ArtistTrackService } from '@bot/services/library/artistTrackService';
import type { MusicBrainzArtistData, MusicBrainzService } from '@bot/services/media/musicBrainzService';
import type { GenreService } from '@bot/services/library/genreService';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import type { SpotifySearchArtist } from '@spotify/models/spotifyModels';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { UpdateService } from '@bot/services/lastfm/updateService';
import type { ArtistsService } from '@bot/services/library/artistsService';

/**
 * Everything the user reads.
 *
 * Recursive, because these cards put their HEADLINE inside a
 * `SectionBuilder` accessory structure: the artist name, the "from Abingdon"
 * line and the cover thumbnail all live one level below the container's own
 * components. A flat `map(c => c.content)` reads the bio and the stats and
 * silently misses the title — which is how a test can pass while asserting
 * nothing about which artist the card names.
 */
const flatten = (components: Array<Record<string, unknown>>): string[] => {
  const out: string[] = [];
  for (const component of components) {
    if (typeof component.content === 'string') out.push(component.content);
    if (Array.isArray(component.components)) {
      out.push(...flatten(component.components as Array<Record<string, unknown>>));
    }
    if (Array.isArray(component.accessory) && typeof component.content === 'string') {
      out.push(component.content);
    }
  }
  return out;
};

const textOf = (response: ResponseModel): string => {
  const containerJson = response.componentsV2Container?.toJSON() as
    | { components: Array<Record<string, unknown>> }
    | undefined;
  const fromContainer = containerJson ? flatten(containerJson.components) : [];
  return [...fromContainer, response.embed.data.description ?? '', response.content ?? ''].join('\n');
};

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 7,
    discordUserId: 'caller1',
    userNameLastFm: 'DreadRock',
    sessionKey: 'sk',
    registeredOn: new Date('2026-01-01T00:00:00Z'),
    // Fresh enough that `needsUpdate` is false and the background resync does
    // not fire, so the update assertions are about the update path itself.
    lastUpdate: new Date(),
    totalPlayCount: 1000,
    ...over,
  }) as User;

const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: 'caller1',
    guildId: '900000000000000001',
    guild: {
      id: '900000000000000001',
      name: 'Test Guild',
      members: { cache: new Map<string, { displayName: string }>() },
    },
    prefix: '.',
    accentColor: 0xba0009,
    ...over,
  }) as unknown as ContextModel;

const dmCtx = (): ContextModel => ctx({ guildId: undefined, guild: null });

const MB_DATA: MusicBrainzArtistData = {
  mbid: 'a74b1b7f',
  location: 'Abingdon',
  countryCode: 'GB',
  type: 'Group',
  birthDate: 1991,
  links: { spotify: 'https://open.spotify.test/artist/x' },
};

type Over = {
  caller?: User | null;
  searchArtists?: Array<{ name: string }>;
  searchArtistsThrow?: unknown;
  recents?: Array<{ artistName: string }> | null;
  recentsThrow?: unknown;
  artistRow?: { artistId: number; name: string; spotifyImageUrl?: string | null; deezerImageUrl?: string | null };
  artistRepoThrows?: boolean;
  /**
   * What `searchArtists` answers. Typed as the real `SpotifySearchArtist`, not
   * as `{ images }`: `artistCommands.ts:236-238` reads `images[0].url` off
   * `spotifyArtists?.[0]`, and a row without `id`/`name`/`uri` is a shape the API
   * never returns.
   */
  spotifyArtists?: SpotifySearchArtist[];
  spotifyThrows?: unknown;
  /** What Last.fm's `artist.getinfo` answers. `null` is a real Last.fm answer. */
  lfmInfo?: ArtistInfo | null;
  serverStats?: { serverPlays: number; serverListeners: number };
  totalPlays?: number;
  recentPlays?: { week: number; month: number };
  genres?: string[];
  topTracks?: Array<{ name: string; playcount: number }>;
  topAlbums?: Array<{ name: string; playcount: number }>;
  accentColor?: number;
  updateUserThrows?: boolean;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async () => (over.caller === undefined ? caller() : over.caller)),
  } as unknown as UserService;

  const getServerArtistStats = vi.fn(async () => over.serverStats ?? { serverPlays: 12, serverListeners: 3 });
  const getTotalArtistPlays = vi.fn(async () => over.totalPlays ?? 240);
  const getArtistRecentPlays = vi.fn(async () => over.recentPlays ?? { week: 12, month: 40 });
  const getTopTracksForArtist = vi.fn(async () => over.topTracks ?? [{ name: 'Paranoid Android', playcount: 90 }]);
  const getTopAlbumsForArtist = vi.fn(async () => over.topAlbums ?? [{ name: 'OK Computer', playcount: 80 }]);
  const artistTrackService = {
    getServerArtistStats,
    getTotalArtistPlays,
    getArtistRecentPlays,
    getTopTracksForArtist,
    getTopAlbumsForArtist,
  } as unknown as ArtistTrackService;

  const getArtistData = vi.fn(async (): Promise<MusicBrainzArtistData | null> => MB_DATA);
  const musicBrainzService = { getArtistData } as unknown as MusicBrainzService;

  const getGenresForArtist = vi.fn(async () => over.genres ?? ['alternative rock', 'art rock']);
  const genreService = { getGenresForArtist } as unknown as GenreService;

  const searchArtists = vi.fn(async (): Promise<Array<{ name: string }>> => {
    if (over.searchArtistsThrow) throw over.searchArtistsThrow;
    return over.searchArtists ?? [{ name: 'Radiohead' }];
  });
  const spotifySearchApi = { searchArtists } as unknown as SpotifySearchApi;

  const getUserRecentTracks = vi.fn(async (..._args: unknown[]) => {
    if (over.recentsThrow) throw over.recentsThrow;
    return over.recents === undefined ? [{ artistName: 'Radiohead' }] : over.recents;
  });
  const getArtistInfo = vi.fn(
    async (): Promise<ArtistInfo | null> =>
      over.lfmInfo === undefined
        ? { name: 'Radiohead', playCount: 900000, listeners: 40000, summary: 'English band from Abingdon.' }
        : over.lfmInfo,
  );
  const searchArtistsOnLfm = vi.fn(async () =>
    over.searchArtistsThrow
      ? Promise.reject(over.searchArtistsThrow)
      : (over.searchArtists ?? [{ name: 'Radiohead' }]),
  );
  const lastfmRepository = {
    getUserRecentTracks,
    getArtistInfo,
    searchArtists: searchArtistsOnLfm,
  } as unknown as LastFmRepository;

  const updateUser = vi.fn(async () => {
    if (over.updateUserThrows) throw new Error('background update failed');
    return { userId: 7 };
  });
  const updateService = { updateUser } as unknown as UpdateService;

  const getArtistAccentColorAsync = vi.fn(async () => over.accentColor ?? 0x445566);
  const artistsService = { getArtistAccentColorAsync } as unknown as ArtistsService;

  const getOrCreateArtist = vi.fn(async (name: string) => {
    if (over.artistRepoThrows) throw new Error('P1001: Cannot reach database server');
    return over.artistRow ?? { artistId: 42, name };
  });
  // The registered instance is a real `ArtistRepository` prototype with one
  // method replaced, so `container.resolve(ArtistRepository)` returns something
  // the token accepts without a cast. The alternative — `as never` — is how a
  // test ends up asserting against a shape the production type does not have.
  container.registerInstance(
    ArtistRepository,
    Object.assign(Object.create(ArtistRepository.prototype) as ArtistRepository, { getOrCreateArtist }),
  );

  const spotifyLookup = vi.fn(async (): Promise<SpotifySearchArtist[]> => {
    if (over.spotifyThrows) throw over.spotifyThrows;
    return over.spotifyArtists ?? [
      {
        id: '4Z8W4fKeB5YxbusRsdQVPb',
        name: 'Radiohead',
        uri: 'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb',
        images: [{ url: 'https://cdn.example.test/radiohead.jpg', height: 640, width: 640 }],
      },
    ];
  });
  // The Spotify API double the CARD uses is separate from the one the artwork
  // lookup uses; both go through the same injected `spotifySearchApi`, so it is
  // one mock with a per-test behaviour switch.
  spotifySearchApi.searchArtists = spotifyLookup;

  const cmd = new ArtistCommands(
    userService,
    artistTrackService,
    musicBrainzService,
    genreService,
    spotifySearchApi,
    lastfmRepository,
    updateService,
    artistsService,
  );

  return {
    cmd,
    getServerArtistStats,
    getTotalArtistPlays,
    getArtistRecentPlays,
    getTopTracksForArtist,
    getTopAlbumsForArtist,
    getArtistData,
    getGenresForArtist,
    spotifyLookup,
    getUserRecentTracks,
    getArtistInfo,
    updateUser,
    getArtistAccentColorAsync,
    getOrCreateArtist,
  };
};

const run = (cmd: ArtistCommands, name: string, args: string[], context = ctx()) =>
  cmd.commands.find((c) => c.name === name)!.executeAsync(context, args);

/** The real transport failure, built the way `lastfmApi` builds it. */
const LFM_DOWN = (method: string) =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 503'));

beforeEach(() => {
  prismaMock.artist.update.mockClear();
  prismaMock.artist.update.mockImplementation(async () => ({}));
});

afterEach(() => {
  container.clearInstances();
});

describe('ArtistCommands — a caller with no account is told so, not given an empty card', () => {
  it.each(['artist', 'artistoverview', 'artistalbums'])('.%s refuses an unconnected caller', async (name) => {
    const built = build({ caller: null });
    const response = await run(built.cmd, name, ['Radiohead']);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('not connected your Last.fm account');
    // No reads at all: an unregistered caller has no library to rank, and asking
    // anyway would produce a card with invented zeroes.
    expect(built.getTotalArtistPlays).not.toHaveBeenCalled();
    expect(built.getOrCreateArtist).not.toHaveBeenCalled();
  });

  it('starts a background resync when the caller\'s stats are stale', async () => {
    const built = build({ caller: caller({ lastUpdate: new Date(Date.now() - 60 * 60 * 1000) }) });
    await run(built.cmd, 'artist', ['Radiohead']);

    // Fire-and-forget: `void this.updateService.updateUser(...)`. The card must
    // not wait on it, but the resync must still happen.
    expect(built.updateUser).toHaveBeenCalledWith(7, { accurateTotal: true });
  });

  it('does not start a resync for a caller whose stats are fresh', async () => {
    const built = build();
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.updateUser).not.toHaveBeenCalled();
  });

  it.each(['artistoverview', 'artistalbums'])(
    '.%s starts the same resync as `.artist` — the three cards are not decoupled',
    async (name) => {
      // The same four lines are copied into all three handlers. If a copy were
      // dropped, that card would keep serving a stale total with no resync
      // behind it and nothing on it would say so.
      const built = build({ caller: caller({ lastUpdate: new Date(Date.now() - 60 * 60 * 1000) }) });
      await run(built.cmd, name, ['Radiohead']);

      expect(built.updateUser).toHaveBeenCalledWith(7, { accurateTotal: true });
    },
  );

  it('treats a caller with NO recorded update as stale, rather than as fresh', async () => {
    // `needsUpdate` returns true for a missing `lastUpdate`. Reading it as
    // "never synced, so nothing to do" would leave a brand-new account rendering
    // zeroes indefinitely.
    const built = build({ caller: caller({ lastUpdate: undefined }) });
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.updateUser).toHaveBeenCalled();
  });

  it('treats an UNREADABLE lastUpdate as stale, because a string date is what a cache returns', async () => {
    // `CacheService` serialises dates, so `lastUpdate` really can arrive as a
    // string in production. `needsUpdate` handles it, and the consequence of
    // getting it wrong is a total that never refreshes.
    const built = build({ caller: caller({ lastUpdate: 'not a date' as unknown as Date }) });
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.updateUser).toHaveBeenCalled();
  });

  it('renders the card even when the background resync fails', async () => {
    // `void promise` with no catch is an unhandled rejection waiting to happen,
    // and it must not take the card with it.
    const built = build({
      caller: caller({ lastUpdate: new Date(Date.now() - 60 * 60 * 1000) }),
      updateUserThrows: true,
    });

    const response = await run(built.cmd, 'artist', ['Radiohead']);
    expect(textOf(response)).toContain('Radiohead');
  });
});

describe('ArtistCommands — which artist the card names', () => {
  it('uses the FIRST search hit for a typed name', async () => {
    const built = build({ searchArtists: [{ name: 'Radiohead' }, { name: 'Radiohead Tribute Band' }] });
    const response = await run(built.cmd, 'artist', ['radiohed']);

    expect(textOf(response)).toContain('Radiohead');
    expect(textOf(response)).not.toContain('Tribute');
  });

  it('keeps the typed string when Last.fm search finds nothing', async () => {
    // The genuine empty. `searchArtists` returning `[]` is a real answer and must
    // not become "No recent tracks found." — the caller never asked about their
    // tracks, they named an artist.
    const built = build({ searchArtists: [] });
    const response = await run(built.cmd, 'artist', ['An Unindexed Band']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('An Unindexed Band');
  });

  it('propagates a search failure instead of claiming the caller has no recent tracks', async () => {
    // THE CLAIM. "No recent tracks found." is a statement about the caller's
    // listening history, and a network failure is not evidence of it.
    const built = build({ searchArtistsThrow: LFM_DOWN('artist.search') });

    await expect(run(built.cmd, 'artist', ['Radiohead'])).rejects.toBeDefined();
  });

  it('falls back to the caller\'s most recent scrobble when no artist is named', async () => {
    const built = build({ recents: [{ artistName: 'Boards of Canada' }] });
    const response = await run(built.cmd, 'artist', ['   ']);

    // No search: the name came from a scrobble, not from a query.
    expect(built.getUserRecentTracks).toHaveBeenCalledWith(
      'DreadRock',
      1,
      1,
      undefined,
      'sk',
    );
    expect(textOf(response)).toContain('Boards of Canada');
  });

  it('says so plainly when there is no scrobble and no artist named', async () => {
    const built = build({ recents: [] });
    const response = await run(built.cmd, 'artist', []);

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(textOf(response)).toContain('No recent tracks found');
  });

  it('propagates a failed scrobble read rather than answering "No recent tracks found"', async () => {
    // The other half of the fallback branch, and the same lie one layer down:
    // an outage rendered as an empty listening history.
    const built = build({ recentsThrow: LFM_DOWN('user.getrecenttracks') });

    await expect(run(built.cmd, 'artist', [])).rejects.toBeDefined();
  });

  it('runs the artist lookup on the RESOLVED name, not the typed one', async () => {
    // If the lookup ran on the raw argument while the card named the search hit,
    // the playcounts on the card would belong to a different artist and nothing
    // on it would say so.
    const built = build({ searchArtists: [{ name: 'Radiohead' }] });
    await run(built.cmd, 'artist', ['  radiohead  ']);

    expect(built.getOrCreateArtist).toHaveBeenCalledWith('Radiohead');
    expect(built.getTotalArtistPlays).toHaveBeenCalledWith(7, 'Radiohead');
  });
});

describe('ArtistCommands — artistId 0 is a degradation, and it gates the cover cache', () => {
  it('renders the typed artist name when the artist row cannot be read', async () => {
    const built = build({ artistRepoThrows: true });
    const response = await run(built.cmd, 'artist', ['Radiohead']);

    // The name came from the search, so it survives: a card about the right
    // artist with no id is incomplete, while a card about the WRONG artist is a
    // lie.
    expect(textOf(response)).toContain('Radiohead');
  });

  it('never writes a cover onto the sentinel row 0', async () => {
    // THE ONE. `artistId > 0` is the whole guard. Without it a failed artist
    // lookup caches a Spotify URL on row 0, and the next artist whose lookup
    // also fails inherits that cover — a wrong picture with no error.
    const built = build({ artistRepoThrows: true });
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(prismaMock.artist.update).not.toHaveBeenCalled();
  });

  it('does write the cover onto a real artist row', async () => {
    const built = build();
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(prismaMock.artist.update).toHaveBeenCalledTimes(1);
    const args = prismaMock.artist.update.mock.calls[0]![0] as { where: { artistId: number } };
    expect(args.where.artistId).toBe(42);
  });

  it('still shows the cover when the cache write fails', async () => {
    // The `.catch(() => undefined)` on the write is correct: the URL was already
    // fetched and is about to be returned, so a failed write costs the next
    // lookup and nothing on this card.
    const built = build();
    prismaMock.artist.update.mockRejectedValue(new Error('P1001: Cannot reach database server'));

    const response = await run(built.cmd, 'artist', ['Radiohead']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('English band from Abingdon');
  });

  it('uses the cached Spotify URL without a provider call', async () => {
    const built = build({
      artistRow: { artistId: 42, name: 'Radiohead', spotifyImageUrl: 'https://cdn.example.test/cached.jpg' },
    });
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.spotifyLookup).not.toHaveBeenCalled();
    expect(prismaMock.artist.update).not.toHaveBeenCalled();
  });

  it('falls back to the Deezer URL when Spotify has never been searched', async () => {
    const built = build({
      artistRow: { artistId: 42, name: 'Radiohead', deezerImageUrl: 'https://cdn.example.test/deezer.jpg' },
    });
    await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.spotifyLookup).not.toHaveBeenCalled();
  });

  it('renders a complete card when the Spotify search fails', async () => {
    // The outer `catch` is the SEARCH, whose product is decoration. Every
    // playcount, genre and stat on the card comes from somewhere else.
    const built = build({ spotifyThrows: new Error('Spotify returned 429') });
    const response = await run(built.cmd, 'artist', ['Radiohead']);

    expect(response.commandResponse).toBe(CommandResponse.Ok);
    expect(textOf(response)).toContain('240');
    expect(textOf(response)).toContain('alternative rock');
    // No cover means no thumbnail, and the card still names the artist.
    expect(textOf(response)).toContain('Radiohead');
  });
});

describe('ArtistCommands.artist — the numbers on the card', () => {
  it('renders server plays only when the guild actually has any', async () => {
    const inGuild = await run(build().cmd, 'artist', ['Radiohead']);
    expect(textOf(inGuild)).toContain('plays in this server by **3** listeners');

    const quiet = await run(build({ serverStats: { serverPlays: 0, serverListeners: 0 } }).cmd, 'artist', [
      'Radiohead',
    ]);
    // Zero server plays must not render "0 plays in this server by 0 listeners" —
    // that is a claim about every member of the guild.
    expect(textOf(quiet)).not.toContain('plays in this server');
  });

  it('never asks for server stats in a DM', async () => {
    const built = build();
    const response = await run(built.cmd, 'artist', ['Radiohead'], dmCtx());

    expect(built.getServerArtistStats).not.toHaveBeenCalled();
    expect(textOf(response)).toContain('900,000');
  });

  it('falls back to zeroes for Last.fm stats the API did not return', async () => {
    const built = build({ lfmInfo: null });
    const response = await run(built.cmd, 'artist', ['Radiohead']);

    // `lfmInfo?.playCount ?? 0` — a Last.fm that answered with nothing must not
    // produce NaN, and must not be presented as a nonzero count either.
    expect(textOf(response)).toContain('**0** Last.fm plays');
    expect(textOf(response)).not.toContain('NaN');
  });

  it('renders the caller\'s share of their own plays, and omits it at zero', async () => {
    const withShare = await run(build({ totalPlays: 250 }).cmd, 'artist', ['Radiohead']);
    expect(textOf(withShare)).toContain('**25.00 %** of all your plays');

    // Zero plays for the artist: the whole user-stats section is omitted rather
    // than rendering "0 plays by DreadRock — 0.00 % of all your plays", which
    // would be a division by a numerator the card has just said is zero.
    const withoutShare = await run(build({ totalPlays: 0 }).cmd, 'artist', ['Radiohead']);
    expect(textOf(withoutShare)).not.toContain('plays by **DreadRock**');
    expect(textOf(withoutShare)).not.toContain('NaN');
    // The Last.fm and server lines are untouched, so the card is not blank.
    expect(textOf(withoutShare)).toContain('Last.fm plays');
  });

  it('omits the share clause for a caller with no lifetime play count', async () => {
    const built = build({ caller: caller({ totalPlayCount: undefined }), totalPlays: 240 });
    const response = await run(built.cmd, 'artist', ['Radiohead']);

    expect(textOf(response)).not.toContain('NaN');
    expect(textOf(response)).not.toContain('% of all your plays');
  });

  it('names the caller by their guild display name when they have one', async () => {
    const context = ctx();
    (context.guild!.members.cache as unknown as Map<string, { displayName: string }>).set('caller1', {
      displayName: 'DreadRock (server)',
    });

    const response = await run(build().cmd, 'artist', ['Radiohead'], context);

    expect(textOf(response)).toContain('DreadRock (server)');
  });

  it('falls back to the registered Last.fm name outside a guild', async () => {
    const response = await run(build().cmd, 'artist', ['Radiohead'], dmCtx());
    expect(textOf(response)).toContain('plays by **DreadRock**');
  });

  it('reports the accent colour the artist service decided, not a constant', async () => {
    const built = build({ accentColor: 0x123456 });
    const response = await run(built.cmd, 'artist', ['Radiohead']);

    expect(built.getArtistAccentColorAsync).toHaveBeenCalled();
    // The accent goes on the container, not the prose, so assert it structurally.
    expect((response.componentsV2Container?.toJSON() as { accent_color?: number }).accent_color).toBe(
      0x123456,
    );
  });
});

describe('ArtistCommands.artistoverview — the same pipeline, different card', () => {
  it('renders top tracks and albums for the resolved artist', async () => {
    const built = build();
    const response = await run(built.cmd, 'artistoverview', ['Radiohead']);

    expect(textOf(response)).toContain('Paranoid Android');
    expect(textOf(response)).toContain('OK Computer');
    expect(built.getTopTracksForArtist).toHaveBeenCalledWith(7, 'Radiohead');
    expect(built.getTopAlbumsForArtist).toHaveBeenCalledWith(7, 'Radiohead');
  });

  it('omits the track and album sections entirely for a genuine zero', async () => {
    // The genuine empty, and the shape the card takes for it: no section at all,
    // a lifetime total of zero, and the two navigation buttons DISABLED. A failed
    // read that produced this card would be indistinguishable from a listener
    // who has never pressed play.
    const built = build({ topTracks: [], topAlbums: [], totalPlays: 0 });
    const response = await run(built.cmd, 'artistoverview', ['Radiohead']);
    const text = textOf(response);

    expect(text).toContain('**0** plays');
    expect(text).not.toContain('Your top tracks');
    expect(text).not.toContain('Your top albums');
    expect(text).not.toContain('NaN');
  });

  it('disables the tracks and albums buttons when there is nothing behind them', async () => {
    // A working button that leads to "no results" is a claim the card has
    // already contradicted.
    const built = build({ topTracks: [], topAlbums: [] });
    const response = await run(built.cmd, 'artistoverview', ['Radiohead']);
    const container = response.componentsV2Container?.toJSON() as {
      components: Array<{ type?: number; components?: Array<{ custom_id?: string; disabled?: boolean }> }>;
    };
    // Scanned across EVERY row rather than `find(c => c.components)`: a
    // `SectionBuilder` also carries `components`, so `find` can land on the
    // header section and report no buttons at all.
    const buttons = container.components.flatMap((row) =>
      (row.components ?? []).map((b) => [b.custom_id?.split(':')[0], b.disabled] as const),
    );

    expect(buttons).toContainEqual(['artist-tracks', true]);
    expect(buttons).toContainEqual(['artist-albums', true]);
  });

  it.each([
    ['artistoverview', 'Paranoid Android'],
    ['artistalbums', 'OK Computer'],
  ] as const)('.%s names the caller by their guild display name', async (name, expected) => {
    // The same `context.guild?.members.cache.get(...)?.displayName ??
    // userNameLastFm` expression as `.artist`, copied into the other two. The
    // header says "Artist overview for X" / "Your top albums" and the footer
    // attributes the plays to X, so a card crediting the wrong name is a wrong
    // claim about whose library this is.
    const context = ctx();
    (context.guild!.members.cache as unknown as Map<string, { displayName: string }>).set('caller1', {
      displayName: 'DreadRock (server)',
    });
    const built = build();

    const text = textOf(await run(built.cmd, name, ['Radiohead'], context));

    expect(text).toContain(expected);
    expect(text).toContain('DreadRock (server)');
  });

  it.each([
    ['artistoverview', 'Paranoid Android'],
    ['artistalbums', 'OK Computer'],
  ] as const)('.%s falls back to the registered name outside a guild', async (name, expected) => {
    const built = build();
    const text = textOf(await run(built.cmd, name, ['Radiohead'], dmCtx()));

    expect(text).toContain(expected);
    expect(text).toContain('DreadRock');
  });

  it('does not read server stats at all — the card has no server section', async () => {
    const built = build();
    await run(built.cmd, 'artistoverview', ['Radiohead']);

    expect(built.getServerArtistStats).not.toHaveBeenCalled();
    expect(built.getArtistInfo).not.toHaveBeenCalled();
  });
});

describe('ArtistCommands.artistalbums — the album list and its page arithmetic', () => {
  it('renders one row per album with its playcount', async () => {
    const built = build({
      topAlbums: [
        { name: 'OK Computer', playcount: 80 },
        { name: 'Kid A', playcount: 1 },
      ],
    });
    const response = await run(built.cmd, 'artistalbums', ['Radiohead']);

    expect(textOf(response)).toContain('OK Computer');
    expect(textOf(response)).toContain('Kid A');
    // `*80 plays*` — the singular/plural is the builder's, and a row reading
    // "1 plays" would be a visible typo in a number.
    expect(textOf(response)).toContain('*80 plays*');
    expect(textOf(response)).toContain('*1 play*');
  });

  it.each(['artistoverview', 'artistalbums'])(
    '.%s says so plainly when there is no artist and no scrobble',
    async (name) => {
      // The same two lines as `.artist`, in two more handlers. A copy that lost
      // the guard would carry a `""` artist name into the card title, the
      // navigation customIds, and the artwork lookup.
      const built = build({ recents: [] });
      const response = await run(built.cmd, name, []);

      expect(response.commandResponse).toBe(CommandResponse.NotFound);
      expect(textOf(response)).toContain('No recent tracks found');
      expect(built.getOrCreateArtist).not.toHaveBeenCalled();
    },
  );

  it.each(['artistoverview', 'artistalbums'])(
    '.%s propagates a failed scrobble read on its fallback branch',
    async (name) => {
      const built = build({ recentsThrow: LFM_DOWN('user.getrecenttracks') });
      await expect(run(built.cmd, name, [])).rejects.toBeDefined();
    },
  );

  it('renders a coherent page footer rather than inventing page two', async () => {
    const built = build();
    const response = await run(built.cmd, 'artistalbums', ['Radiohead']);

    // One album, one page. "Page 1/2" with two albums and no next content would
    // be a page that does not exist. And the count is one, so the noun is
    // singular — "1 different albums" was pinned here as if it were correct, and
    // it is the same fabricated-agreement defect the plural sweep fixed across
    // fifteen builders.
    expect(textOf(response)).toContain('Page 1/1');
    expect(textOf(response)).toContain('1 different album');
    expect(textOf(response)).not.toContain('1 different albums');
  });

  it('says so plainly when the caller has no albums for this artist', async () => {
    const built = build({ topAlbums: [] });
    const response = await run(built.cmd, 'artistalbums', ['Radiohead']);

    expect(textOf(response)).toContain('No albums found');
    expect(textOf(response)).toContain('Page 1/1');
  });

  it('starts the card on page one always — the buttons own the paging', async () => {
    const built = build({
      topAlbums: Array.from({ length: 25 }, (_v, i) => ({ name: `Album ${i}`, playcount: i })),
    });
    const response = await run(built.cmd, 'artistalbums', ['Radiohead']);

    // 25 albums at 10 per page is 3 pages, and page one is rows 1..10. If the
    // slice started anywhere else the ranks on the card would be wrong.
    expect(textOf(response)).toContain('Page 1/3');
    expect(textOf(response)).toContain('1. **');
    expect(textOf(response)).not.toContain('11. **');
    expect(textOf(response)).toContain('25 different albums');
  });

  it('uses the singular for exactly one lifetime play', async () => {
    const built = build({ totalPlays: 1 });
    const response = await run(built.cmd, 'artistalbums', ['Radiohead']);

    expect(textOf(response)).toContain('total artist play');
    expect(textOf(response)).not.toContain('total artist plays');
  });
});

describe('ArtistCommands — the registry surface', () => {
  it('exposes the three artist commands with their established aliases', () => {
    const built = build();
    expect(built.cmd.commands.map((c) => c.name)).toEqual([
      'artist',
      'artistoverview',
      'artistalbums',
    ]);
    // `a` on artist and `ao` on the overview: swapping these would change the
    // card a user gets for a one-letter command they did not change.
    expect(built.cmd.commands[0]!.aliases).toEqual(['a']);
    expect(built.cmd.commands[1]!.aliases).toEqual(['ao', 'artistov', 'aov']);
  });

  it('joins a multi-token argument into one query string', async () => {
    const built = build({ searchArtists: [] });
    await run(built.cmd, 'artist', ['Godspeed', 'You!', 'Black Emperor']);

    expect(built.getOrCreateArtist).toHaveBeenCalledWith('Godspeed You! Black Emperor');
  });
});