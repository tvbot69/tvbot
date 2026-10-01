import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { FmFooterResolver } from '@bot/services/system/fmFooterResolver';
import type { FmFooterData } from '@bot/services/system/fmFooterResolver';
import { FmFooterOption } from '@domain/enums/fmFooterOption';
import { Logger } from '@domain/logging/logger';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { RecentTrack } from '@domain/models/recentTrack';
import { ArtistsService } from '@bot/services/library/artistsService';
import { AlbumService } from '@bot/services/library/albumService';
import { TrackService } from '@bot/services/library/trackService';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';

/**
 * `FmFooterResolver` assembles the "now playing" footer from a bitmask of
 * `FmFooterOption` flags.
 *
 * The load-bearing behaviour is the bitmask. A footer is a *superset* of
 * flags: most of the 28 options (artist country, BPM, first listen, discogs
 * collection, ranks...) are read by the builder, not here. This class owns
 * exactly nine of them. `NON_SCROBBLE_MASK` short-circuits, and each task
 * re-checks its own flag - so a foreign flag is inert twice over, and adding
 * one to the mask is not observable. What *is* observable, and what breaks
 * silently, is a branch wired to the wrong option: the two footer fields swap
 * while every count stays plausible. That is what the per-flag tests here pin.
 *
 * The second contract is the one A1 is about, and it is a decision rather than
 * a mechanism. A failed query must not become a plausible wrong number, and it
 * must not be silent either - so every task catch logs at ERROR naming the
 * exact fields it cost. It does NOT raise, because both callers
 * (`playCommands.fmAsync`, `userSlashCommands.fmAsync`) build the card on the
 * next statement with no local try/catch: a throw would replace the user's own
 * Now Playing card with "Sorry, something went wrong". The tests below
 * therefore come in pairs - a failure is *reported*, and a query that ran and
 * found nothing still leaves its field absent. Asserting only the second half is
 * what let the silent version pass for so long.
 */

// `vi.spyOn(Logger, 'error')` is used throughout the failure tests, and a spy
// left in place is the exact bug class this repo has been bitten by before:
// restoring on a shared module singleton can leave an own property set to
// `undefined`, and every later test then fails silently against it. Restore
// after every test rather than per-test, so a new failure test cannot forget.
afterEach(() => {
  vi.restoreAllMocks();
});

const dummyUser: User = {
  userId: 123,
  discordUserId: '687636049576722472',
  userNameLastFm: 'Moha504',
  sessionKey: 'test-session',
  lastUsed: new Date(),
} as User;

const dummyTrack: RecentTrack = {
  name: 'fukumean',
  artistName: 'Gunna',
  albumName: 'A Gift & a Curse',
  nowPlaying: true,
};

const GUILD = '953703151930847253';

// The nine options this resolver owns. Stated here as a spec, not derived, so
// the test fails when production and this list disagree.
const HANDLED: FmFooterOption[] = [
  FmFooterOption.Loved,
  FmFooterOption.ArtistPlays,
  FmFooterOption.AlbumPlays,
  FmFooterOption.TrackPlays,
  FmFooterOption.ArtistPlaysThisWeek,
  FmFooterOption.ServerArtistListeners,
  FmFooterOption.ServerAlbumListeners,
  FmFooterOption.ServerTrackListeners,
  FmFooterOption.CrownHolder,
];

const ALL_OPTIONS = Object.values(FmFooterOption).filter((v): v is FmFooterOption => typeof v === 'number');

const mask = (...flags: FmFooterOption[]): bigint =>
  flags.reduce<bigint>((acc, f) => acc | BigInt(f), BigInt(0));

/**
 * Registers a full set of collaborators, all returning "there is data", so a
 * test can vary only the mask. Individual tests then retarget one double.
 */
const registerAll = (over: Record<string, unknown> = {}) => {
  const deps: Record<string, unknown> = {
    artistsService: { getArtistInfo: vi.fn(async () => ({ userPlayCount: 263 })) },
    albumService: { getAlbumInfo: vi.fn(async () => ({ userPlayCount: 45 })) },
    trackService: { getTrackInfo: vi.fn(async () => ({ userPlayCount: 3, userLoved: true })) },
    whoKnowsRepo: {
      getIndexedUsersForArtist: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
      getIndexedUsersForAlbum: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
      getIndexedUsersForTrack: vi.fn(async () => [{ userId: 1, playcount: 5 }]),
    },
    crownRepo: { getCurrentCrown: vi.fn(async () => ({ userNameLastFm: 'DreadRock' })) },
    prisma: {
      userArtist: { aggregate: vi.fn(async () => ({ _sum: { playcount: 11 } })) },
      userAlbum: { aggregate: vi.fn(async () => ({ _sum: { playcount: 12 } })) },
      userTrack: { aggregate: vi.fn(async () => ({ _sum: { playcount: 13 } })) },
      userPlay: { count: vi.fn(async () => 7) },
      album: { findFirst: vi.fn(async () => ({ albumId: 99 })) },
      track: { findFirst: vi.fn(async () => ({ trackId: 88 })) },
    },
    ...over,
  };

  container.registerInstance(ArtistsService, deps.artistsService as never);
  container.registerInstance(AlbumService, deps.albumService as never);
  container.registerInstance(TrackService, deps.trackService as never);
  container.registerInstance(WhoKnowsRepository, deps.whoKnowsRepo as never);
  container.registerInstance(CrownRepository, deps.crownRepo as never);
  container.registerInstance(PrismaClient, deps.prisma as never);
  return deps;
};

// One `as any` at the boundary so a test can retarget a single double without
// rebuilding the world. Warn-only rule.
const mockOf = (fn: unknown) => fn as any;

// A promise a test resolves by hand, used to prove the resolver waits for slow
// tasks instead of reading whatever has already settled.
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

/**
 * Asserts a failure was *reported* rather than swallowed: one ERROR whose
 * message and structured context both name the field, carrying the underlying
 * reason.
 *
 * Takes the raw `mock.calls` so it works with the spy of whichever level was
 * used, and matches on the field name rather than on call index - two tasks can
 * fail in one resolve, and which one logged first is not a contract.
 */
const expectReported = (
  calls: ReadonlyArray<readonly unknown[]>,
  field: keyof FmFooterData,
  reason: string,
): void => {
  const seen = calls.map(c => String(c[1] ?? ''));
  const match = calls.find((c) => String(c[1] ?? '').includes(field));
  expect(
    match,
    `no ERROR named "${field}" - logged messages were: ${JSON.stringify(seen)}`,
  ).toBeDefined();
  const [context, message] = match as [Record<string, unknown>, string];
  expect(message).toContain('Now-playing footer: could not read');
  expect(String(context.footerFields)).toContain(field);
  expect(String(context.err)).toContain(reason);
};

describe('FmFooterResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty data immediately if only TotalScrobbles is enabled', async () => {
    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      BigInt(FmFooterOption.TotalScrobbles),
      '953703151930847253',
    );
    expect(data).toEqual({});
  });

  it('returns empty data if track or artist is missing', async () => {
    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      null,
      BigInt(FmFooterOption.ArtistPlays),
      '953703151930847253',
    );
    expect(data).toEqual({});
  });

  it('resolves artist plays, track plays, loved status, and server listeners when flags are active', async () => {
    const mockArtistsService = {
      getArtistInfo: vi.fn().mockResolvedValue({ userPlayCount: 263 }),
    };
    const mockTrackService = {
      getTrackInfo: vi.fn().mockResolvedValue({ userPlayCount: 3, userLoved: true }),
    };
    const mockAlbumService = {
      getAlbumInfo: vi.fn().mockResolvedValue({ userPlayCount: 45 }),
    };
    const mockWhoKnowsRepo = {
      getIndexedUsersForArtist: vi.fn().mockResolvedValue([
        { userId: 123, playcount: 263 },
        { userId: 456, playcount: 10 },
      ]),
    };

    container.registerInstance(ArtistsService, mockArtistsService as any);
    container.registerInstance(TrackService, mockTrackService as any);
    container.registerInstance(AlbumService, mockAlbumService as any);
    container.registerInstance(WhoKnowsRepository, mockWhoKnowsRepo as any);

    const flags =
      BigInt(FmFooterOption.ArtistPlays) |
      BigInt(FmFooterOption.AlbumPlays) |
      BigInt(FmFooterOption.TrackPlays) |
      BigInt(FmFooterOption.Loved) |
      BigInt(FmFooterOption.ServerArtistListeners);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      flags,
      '953703151930847253',
    );

    expect(data.artistPlays).toBe(263);
    expect(data.albumPlays).toBe(45);
    expect(data.trackPlays).toBe(3);
    expect(data.isLoved).toBe(true);
    expect(data.serverArtistListeners).toBe(2);
  });
});

describe('FmFooterResolver - the NON_SCROBBLE_MASK boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('produces nothing for an empty bitmask', async () => {
    registerAll();
    await expect(FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, BigInt(0), GUILD))
      .resolves.toEqual({});
  });

  it('produces nothing for a flag this class does not own, even with a guild', async () => {
    // Nineteen of the twenty-eight options (artist country, BPM, first listen,
    // discogs collection, ranks...) are the builder's job. They must be inert
    // here.
    //
    // Note there are two independent defences: the `NON_SCROBBLE_MASK` early
    // return, and the per-task `has()` guards. Adding a foreign bit to the mask
    // therefore changes nothing observable - the guards still skip every task.
    // So this test pins the *output* contract, and the next one below is what
    // catches a branch being wired to the wrong flag.
    const foreign = ALL_OPTIONS.filter(f => !HANDLED.includes(f));
    expect(foreign.length).toBe(19);

    for (const flag of foreign) {
      registerAll();
      await expect(FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, BigInt(flag), GUILD))
        .resolves.toEqual({});
    }
  });

  it('wires each branch to the option it claims, not a neighbouring one', async () => {
    // This is the assertion the mask test cannot make. Retargeting a single
    // `has()` guard to the wrong option leaves the output contract above
    // intact while silently swapping two footer fields.
    const pairs: Array<[FmFooterOption, keyof FmFooterData]> = [
      [FmFooterOption.CrownHolder, 'crownHolder'],
      [FmFooterOption.ServerArtistListeners, 'serverArtistListeners'],
      [FmFooterOption.ServerTrackListeners, 'serverTrackListeners'],
      [FmFooterOption.ServerAlbumListeners, 'serverAlbumListeners'],
      [FmFooterOption.ArtistPlaysThisWeek, 'artistPlaysThisWeek'],
      [FmFooterOption.ArtistPlays, 'artistPlays'],
      [FmFooterOption.AlbumPlays, 'albumPlays'],
    ];

    for (const [flag, key] of pairs) {
      registerAll();
      const alone = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, BigInt(flag), GUILD);

      // The flag populates its own field...
      expect(Object.keys(alone), `flag ${FmFooterOption[flag]} produced ${Object.keys(alone).join(',')}`)
        .toContain(key);
    }
  });

  it('still resolves when a foreign flag is mixed in with a handled one', async () => {
    registerAll();
    const flags = mask(FmFooterOption.ArtistCountry, FmFooterOption.TrackBpm, FmFooterOption.ArtistPlays);

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, flags, GUILD);

    expect(data).toEqual({ artistPlays: 263 });
  });

  it('still produces nothing when only foreign flags are combined', async () => {
    registerAll();
    const flags = mask(
      FmFooterOption.TotalScrobbles,
      FmFooterOption.ArtistCountry,
      FmFooterOption.GlobalArtistRank,
      FmFooterOption.LastTrackListen,
    );

    await expect(FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, flags, GUILD))
      .resolves.toEqual({});
  });

  it('resolves every handled flag on its own, so no option is masked out by omission', async () => {
    for (const flag of HANDLED) {
      registerAll();
      const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, BigInt(flag), GUILD);
      const keys = Object.keys(data);
      expect(keys.length, `flag ${FmFooterOption[flag]} produced nothing`).toBeGreaterThan(0);
    }
  });

  it('depends only on the handled bits: extra foreign bits never change the result', async () => {
    // The point of the mask is that the other nineteen options are inert here.
    // So: pin a random subset of the nine, vary the foreign bits around it, and
    // require the output to be byte-identical. (The noise must be drawn from
    // the foreign set only - a random "extra" that happened to be a handled
    // flag would change the mask itself and prove nothing.)
    const FOREIGN = ALL_OPTIONS.filter(f => !HANDLED.includes(f));
    const makeRng = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const rng = makeRng(24680);
    const pickFrom = (pool: FmFooterOption[], n: number) =>
      Array.from({ length: n }, () => pool[Math.floor(rng() * pool.length)]!);

    for (let round = 0; round < 25; round++) {
      const handledSubset = pickFrom(HANDLED, 1 + Math.floor(rng() * HANDLED.length));
      const sparse = pickFrom(FOREIGN, 1 + Math.floor(rng() * 3));
      const dense = pickFrom(FOREIGN, 6);

      registerAll();
      const a = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...handledSubset, ...sparse), GUILD);
      registerAll();
      const b = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...handledSubset, ...dense), GUILD);

      expect(b).toEqual(a);
    }
  });
});

describe('FmFooterResolver - track guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('returns nothing when the track is undefined', async () => {
    registerAll();
    await expect(FmFooterResolver.resolveFooterData(dummyUser, undefined, mask(FmFooterOption.ArtistPlays), GUILD))
      .resolves.toEqual({});
  });

  it('returns nothing when the artist name is blank', async () => {
    // Last.fm sends a now-playing row with no artist often enough that the
    // footer must degrade rather than query for "".
    registerAll();
    const track = { ...dummyTrack, artistName: '' };

    await expect(FmFooterResolver.resolveFooterData(dummyUser, track, mask(FmFooterOption.ArtistPlays), GUILD))
      .resolves.toEqual({});
  });

  it('does not require a track name for artist-scoped options', async () => {
    registerAll();
    const track = { name: '', artistName: 'Gunna' } as RecentTrack;

    const data = await FmFooterResolver.resolveFooterData(dummyUser, track, mask(FmFooterOption.ArtistPlays), GUILD);

    expect(data.artistPlays).toBe(263);
  });
});

describe('FmFooterResolver - artist plays', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('asks the artists service for the count', async () => {
    const deps = registerAll();

    await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expect(mockOf(deps.artistsService).getArtistInfo).toHaveBeenCalledWith('Gunna', 'Moha504');
  });

  it('falls back to the database aggregate when the service knows no count', async () => {
    const deps = registerAll();
    mockOf(deps.artistsService).getArtistInfo.mockResolvedValue({ name: 'Gunna' });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expect(data.artistPlays).toBe(11);
    expect(mockOf(deps.prisma).userArtist.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'Gunna', mode: 'insensitive' } },
    });
  });

  it('omits the count entirely when the aggregate is zero', async () => {
    // A zero is not a count. Writing artistPlays: 0 would render "0 plays"
    // where the truth is "we have no record of you listening".
    const deps = registerAll();
    mockOf(deps.artistsService).getArtistInfo.mockResolvedValue(null);
    mockOf(deps.prisma).userArtist.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expect('artistPlays' in data).toBe(false);
  });

  it('omits the count when the aggregate sum is null', async () => {
    const deps = registerAll();
    mockOf(deps.artistsService).getArtistInfo.mockResolvedValue(null);
    mockOf(deps.prisma).userArtist.aggregate.mockResolvedValue({ _sum: { playcount: null } });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expect('artistPlays' in data).toBe(false);
  });

  it('keeps a zero the service did report', async () => {
    // Asymmetric on purpose: an explicit 0 from the service is a real answer,
    // an absent aggregate row is an unknown.
    const deps = registerAll();
    mockOf(deps.artistsService).getArtistInfo.mockResolvedValue({ userPlayCount: 0 });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expect(data.artistPlays).toBe(0);
  });

  it('reports a failing service instead of dropping the clause in silence', async () => {
    // REPLACED an assertion of the bug. This test used to be titled "swallows a
    // failing service" and asserted only `expect(data).toEqual({})`, which is
    // exactly what the user saw: a footer with no artist-plays clause, no error,
    // no log line - indistinguishable from never having played the artist. The
    // card still survives (that part is the deliberate decision, pinned by the
    // test below), but the failure is now REPORTED.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.artistsService).getArtistInfo.mockRejectedValue(new Error('lastfm down'));

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expectReported(logged.mock.calls, 'artistPlays', 'lastfm down');
    expect(data).toEqual({});
  });

  it('reports a failing aggregate, and says which query it was', async () => {
    // The pair to the one above: the database fallback is the other thing that
    // can throw in this task, and it is the one A1 is actually about. The
    // genuine-empty half is "omits the count entirely when the aggregate is
    // zero" above - a query that RAN and found nothing must stay silent and
    // stay empty, or the fix has replaced a lie with a different lie.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.artistsService).getArtistInfo.mockResolvedValue(null);
    mockOf(deps.prisma).userArtist.aggregate.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays), GUILD);

    expectReported(logged.mock.calls, 'artistPlays', 'db down');
    expect('artistPlays' in data).toBe(false);
  });

  it('keeps the other clauses when one task fails, because the card must not die', async () => {
    // The other half of the decision. Raising here would skip `buildFmResponse`
    // at both call sites and hand the user an apology instead of their card.
    const deps = registerAll();
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.crownRepo).getCurrentCrown.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      mask(FmFooterOption.ArtistPlays, FmFooterOption.CrownHolder),
      GUILD,
    );

    expect(data).toEqual({ artistPlays: 263 });
  });
});

describe('FmFooterResolver - album plays', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('skips the album entirely when the track has no album', async () => {
    const deps = registerAll();
    // A blank album name is what Last.fm actually sends for a single.
    const track = { ...dummyTrack, albumName: '' };

    const data = await FmFooterResolver.resolveFooterData(dummyUser, track, mask(FmFooterOption.AlbumPlays), GUILD);

    expect(data).toEqual({});
    expect(mockOf(deps.albumService).getAlbumInfo).not.toHaveBeenCalled();
    expect(mockOf(deps.prisma).userAlbum.aggregate).not.toHaveBeenCalled();
  });

  it('passes the artist as well, so an album name cannot cross-match', async () => {
    const deps = registerAll();

    await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.AlbumPlays), GUILD);

    expect(mockOf(deps.albumService).getAlbumInfo).toHaveBeenCalledWith('Gunna', 'A Gift & a Curse', 'Moha504');
  });

  it('falls back to the database aggregate', async () => {
    const deps = registerAll();
    mockOf(deps.albumService).getAlbumInfo.mockResolvedValue({ name: 'A Gift & a Curse' });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.AlbumPlays), GUILD);

    expect(data.albumPlays).toBe(12);
    expect(mockOf(deps.prisma).userAlbum.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'A Gift & a Curse', mode: 'insensitive' } },
    });
  });

  it('omits the count when the aggregate is zero', async () => {
    // The genuine-empty half of the pair below, and the reason the test was
    // renamed: as written it made the *service* reject, so the aggregate was
    // never reached and the assertion it actually made was "a throw is
    // swallowed" - not what its title claimed. The service now declines
    // normally, so the zero genuinely comes from the query.
    const deps = registerAll();
    mockOf(deps.albumService).getAlbumInfo.mockResolvedValue({ name: 'A Gift & a Curse' });
    mockOf(deps.prisma).userAlbum.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.AlbumPlays), GUILD);

    expect('albumPlays' in data).toBe(false);
  });

  it('reports a failing album read instead of dropping the clause in silence', async () => {
    // REPLACED an assertion of the bug. As written, this test made the service
    // reject and asserted only that the field came back absent - the footer
    // simply lost its album-plays clause, with nothing said anywhere.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.albumService).getAlbumInfo.mockResolvedValue({ name: 'A Gift & a Curse' });
    mockOf(deps.prisma).userAlbum.aggregate.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.AlbumPlays), GUILD);

    expectReported(logged.mock.calls, 'albumPlays', 'db down');
    expect('albumPlays' in data).toBe(false);
  });
});

describe('FmFooterResolver - track plays and loved share one lookup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('reports loved without paying for the playcount fallback query', async () => {
    // Loved alone still unlocks the shared lookup, and the service's own
    // playcount comes along with it. What the flag withholds is the *database*
    // fallback - that one is explicitly guarded, so a user with no track row
    // does not trigger a query they never asked for.
    const deps = registerAll();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.Loved), GUILD);

    expect(data).toEqual({ trackPlays: 3, isLoved: true });
    expect(mockOf(deps.prisma).userTrack.aggregate).not.toHaveBeenCalled();
  });

  it('reports a playcount without a playcount fallback query', async () => {
    const deps = registerAll();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect(data.trackPlays).toBe(3);
    expect(mockOf(deps.prisma).userTrack.aggregate).not.toHaveBeenCalled();
  });

  it('leaks the loved status into a playcount-only footer when Last.fm reports it', async () => {
    // Documented asymmetry, not an accident of the test: Loved and TrackPlays
    // share one lookup, and the playcount half is guarded by its own flag while
    // the loved half is not. So enabling TrackPlays on its own also surfaces
    // `isLoved` whenever the service volunteered it. Harmless - the builder
    // only renders what it was asked for - but it means the resolver's output
    // is not a clean subset of the mask.
    registerAll();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect(data).toEqual({ trackPlays: 3, isLoved: true });
  });

  it('omits the leaked loved status when the service does not report one', async () => {
    const deps = registerAll();
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue({ userPlayCount: 3 });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect(data).toEqual({ trackPlays: 3 });
  });

  it('reports both from a single service call when both are enabled', async () => {
    const deps = registerAll();

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.Loved, FmFooterOption.TrackPlays), GUILD,
    );

    expect(data).toEqual({ trackPlays: 3, isLoved: true });
    expect(mockOf(deps.trackService).getTrackInfo).toHaveBeenCalledTimes(1);
  });

  it('carries an explicit false through, since un-loved is a real answer', async () => {
    const deps = registerAll();
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue({ userPlayCount: 4, userLoved: false });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.Loved), GUILD);

    expect(data.isLoved).toBe(false);
  });

  it('falls back to the aggregate when the service returns nothing at all', async () => {
    const deps = registerAll();
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue(null);

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect(data.trackPlays).toBe(13);
    expect(mockOf(deps.prisma).userTrack.aggregate).toHaveBeenCalledWith({
      _sum: { playcount: true },
      where: { userId: 123, name: { equals: 'fukumean', mode: 'insensitive' } },
    });
  });

  it('keeps a zero playcount the service reported', async () => {
    const deps = registerAll();
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue({ userPlayCount: 0, userLoved: true });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect(data.trackPlays).toBe(0);
    expect(mockOf(deps.prisma).userTrack.aggregate).not.toHaveBeenCalled();
  });

  it('omits the playcount when neither the service nor the aggregate knows one', async () => {
    const deps = registerAll();
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue(null);
    mockOf(deps.prisma).userTrack.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays), GUILD);

    expect('trackPlays' in data).toBe(false);
  });

  it('reports a fallback failure by name, and only for the half that was lost', async () => {
    // REPLACED an assertion of the bug. This test used to be titled "omits the
    // playcount when the service knows none and the aggregate fails" and
    // asserted only `toEqual({ isLoved: true })` - the partial success with no
    // report at all, which is the more insidious half of the class: the loved
    // heart rendered, so the footer looked trustworthy right up to the playcount
    // that silently was not there.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.trackService).getTrackInfo.mockResolvedValue({ userLoved: true });
    mockOf(deps.prisma).userTrack.aggregate.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays, FmFooterOption.Loved), GUILD,
    );

    // The loved half of the shared task still lands; only the playcount is lost.
    expect(data).toEqual({ isLoved: true });
    expectReported(logged.mock.calls, 'trackPlays', 'db down');
    // ...and the log must not claim `isLoved` was lost too. It was not.
    expect(logged.mock.calls.flat().join(' ')).not.toContain('isLoved');
  });

  it('reports both halves of the shared task when the service itself fails', async () => {
    // The other failure point of task 3. The Loved/TrackPlays coupling is
    // deliberate and preserved: one service call answers both flags, so losing
    // it loses both - and the log has to say so.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.trackService).getTrackInfo.mockRejectedValue(new Error('lastfm down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.TrackPlays, FmFooterOption.Loved), GUILD,
    );

    expect(data).toEqual({});
    expectReported(logged.mock.calls, 'trackPlays', 'lastfm down');
    expectReported(logged.mock.calls, 'isLoved', 'lastfm down');
    // Still one shared lookup, still one log line: a two-field loss is one event.
    expect(logged.mock.calls).toHaveLength(1);
  });
});

describe('FmFooterResolver - artist plays this week', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('counts plays in a seven-day window, case-insensitively', async () => {
    const deps = registerAll();

    await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlaysThisWeek), GUILD);

    const call = mockOf(deps.prisma).userPlay.count.mock.calls[0]![0];
    expect(call.where.userId).toBe(123);
    expect(call.where.artistName).toEqual({ equals: 'Gunna', mode: 'insensitive' });
    const daysOut = (Date.now() - call.where.timePlayed.gte.getTime()) / 86400000;
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('reports a genuine zero rather than omitting the field', async () => {
    // Unlike the playcounts, "you played them zero times this week" is a real,
    // displayable answer, so 0 is written through.
    const deps = registerAll();
    mockOf(deps.prisma).userPlay.count.mockResolvedValue(0);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlaysThisWeek), GUILD,
    );

    expect(data.artistPlaysThisWeek).toBe(0);
  });

  it('reports a failing count instead of dropping the clause in silence', async () => {
    // REPLACED an assertion of the bug: the old title was "swallows a failing
    // count" and the only assertion was `toEqual({})`. The pair is the genuine
    // zero directly above - that one runs, answers, and stays silent.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.prisma).userPlay.count.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlaysThisWeek), GUILD,
    );

    expectReported(logged.mock.calls, 'artistPlaysThisWeek', 'db down');
    expect(data).toEqual({});
  });
});

describe('FmFooterResolver - server listener counts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('counts only the listeners with a positive playcount', async () => {
    // A row at zero is someone the index knows but who never actually played
    // them; counting them inflates the who-else-listen count.
    const deps = registerAll();
    mockOf(deps.whoKnowsRepo).getIndexedUsersForArtist.mockResolvedValue([
      { userId: 1, playcount: 20 },
      { userId: 2, playcount: 0 },
      { userId: 3, playcount: 4 },
    ]);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerArtistListeners), GUILD,
    );

    expect(data.serverArtistListeners).toBe(2);
  });

  it('reports zero listeners when the server has none', async () => {
    const deps = registerAll();
    mockOf(deps.whoKnowsRepo).getIndexedUsersForArtist.mockResolvedValue([]);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerArtistListeners), GUILD,
    );

    expect(data.serverArtistListeners).toBe(0);
  });

  it('skips every server option when there is no guild', async () => {
    // DMs and the "no guild configured" path both land here. A server-scoped
    // count has no meaning without a guild, and the query would be wrong.
    const deps = registerAll();

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      mask(
        FmFooterOption.ServerArtistListeners,
        FmFooterOption.ServerAlbumListeners,
        FmFooterOption.ServerTrackListeners,
        FmFooterOption.CrownHolder,
      ),
      null,
    );

    expect(data).toEqual({});
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForArtist).not.toHaveBeenCalled();
    expect(mockOf(deps.prisma).album.findFirst).not.toHaveBeenCalled();
    expect(mockOf(deps.prisma).track.findFirst).not.toHaveBeenCalled();
    expect(mockOf(deps.crownRepo).getCurrentCrown).not.toHaveBeenCalled();
  });

  it('resolves the album row by name and artist before counting its listeners', async () => {
    const deps = registerAll();
    mockOf(deps.whoKnowsRepo).getIndexedUsersForAlbum.mockResolvedValue([
      { userId: 1, playcount: 3 },
      { userId: 2, playcount: 0 },
    ]);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerAlbumListeners), GUILD,
    );

    expect(mockOf(deps.prisma).album.findFirst).toHaveBeenCalledWith({
      where: {
        name: { equals: 'A Gift & a Curse', mode: 'insensitive' },
        artist: { name: { equals: 'Gunna', mode: 'insensitive' } },
      },
    });
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForAlbum).toHaveBeenCalledWith(GUILD, 99);
    expect(data.serverAlbumListeners).toBe(1);
  });

  it('omits the album listener count when the album is not in the catalogue', async () => {
    const deps = registerAll();
    mockOf(deps.prisma).album.findFirst.mockResolvedValue(null);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerAlbumListeners), GUILD,
    );

    expect('serverAlbumListeners' in data).toBe(false);
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForAlbum).not.toHaveBeenCalled();
  });

  it('skips the album listener count when the track has no album', async () => {
    const deps = registerAll();
    const track = { ...dummyTrack, albumName: '' };

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, track, mask(FmFooterOption.ServerAlbumListeners), GUILD,
    );

    expect(data).toEqual({});
    expect(mockOf(deps.prisma).album.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the track row by name and artist before counting its listeners', async () => {
    const deps = registerAll();
    mockOf(deps.whoKnowsRepo).getIndexedUsersForTrack.mockResolvedValue([
      { userId: 1, playcount: 9 },
    ]);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerTrackListeners), GUILD,
    );

    expect(mockOf(deps.prisma).track.findFirst).toHaveBeenCalledWith({
      where: {
        name: { equals: 'fukumean', mode: 'insensitive' },
        artist: { name: { equals: 'Gunna', mode: 'insensitive' } },
      },
    });
    expect(mockOf(deps.whoKnowsRepo).getIndexedUsersForTrack).toHaveBeenCalledWith(GUILD, 88);
    expect(data.serverTrackListeners).toBe(1);
  });

  it('omits the track listener count when the track is not in the catalogue', async () => {
    const deps = registerAll();
    mockOf(deps.prisma).track.findFirst.mockResolvedValue(null);

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerTrackListeners), GUILD,
    );

    expect('serverTrackListeners' in data).toBe(false);
  });

  it('reports a failing who-knows query instead of dropping the clause in silence', async () => {
    // REPLACED an assertion of the bug: the old title was "swallows a failing
    // who-knows query", asserting only `toEqual({})`. The genuine-empty half is
    // "reports zero listeners when the server has none" above.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.whoKnowsRepo).getIndexedUsersForArtist.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerArtistListeners), GUILD,
    );

    expectReported(logged.mock.calls, 'serverArtistListeners', 'db down');
    expect(data).toEqual({});
  });

  it('reports a failing catalogue lookup by name, not as a missing track', async () => {
    // REPLACED an assertion of the bug, and the worst version of it: the old
    // test ("swallows a failing catalogue lookup") asserted `toEqual({})` for a
    // `findFirst` that had *thrown*. An absent track row and an unreadable one
    // rendered identically - the user could not tell "this track is not in our
    // catalogue" from "the catalogue is down". The genuine-empty half is "omits
    // the track listener count when the track is not in the catalogue" above.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.prisma).track.findFirst.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ServerTrackListeners), GUILD,
    );

    expectReported(logged.mock.calls, 'serverTrackListeners', 'db down');
    expect('serverTrackListeners' in data).toBe(false);
  });
});

describe('FmFooterResolver - crown holder', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('reads the crown for the guild and the artist', async () => {
    const deps = registerAll();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.CrownHolder), GUILD);

    expect(mockOf(deps.crownRepo).getCurrentCrown).toHaveBeenCalledWith(GUILD, 'Gunna');
    expect(data.crownHolder).toBe('DreadRock');
  });

  it('omits the holder when the crown has no last.fm username yet', async () => {
    // A freshly seeded crown has no winner. The footer must show nothing
    // rather than an empty crown link.
    const deps = registerAll();
    mockOf(deps.crownRepo).getCurrentCrown.mockResolvedValue({ userNameLastFm: '' });

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.CrownHolder), GUILD);

    expect('crownHolder' in data).toBe(false);
  });

  it('omits the holder when nobody holds the crown', async () => {
    const deps = registerAll();
    mockOf(deps.crownRepo).getCurrentCrown.mockResolvedValue(null);

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.CrownHolder), GUILD);

    expect(data).toEqual({});
  });

  it('reports a failing crown lookup instead of implying nobody holds it', async () => {
    // REPLACED an assertion of the bug: the old title was "swallows a failing
    // crown lookup", asserting only `toEqual({})` - byte-identical to the
    // genuine "nobody holds the crown" below, which is the pair's other half.
    const deps = registerAll();
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    mockOf(deps.crownRepo).getCurrentCrown.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(FmFooterOption.CrownHolder), GUILD);

    expectReported(logged.mock.calls, 'crownHolder', 'db down');
    expect(data).toEqual({});
  });
});

describe('FmFooterResolver - assembling the full mask', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  it('populates every field when all nine options are enabled', async () => {
    registerAll();

    const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...HANDLED), GUILD);

    expect(data).toEqual({
      artistPlays: 263,
      albumPlays: 45,
      trackPlays: 3,
      artistPlaysThisWeek: 7,
      serverArtistListeners: 1,
      serverAlbumListeners: 1,
      serverTrackListeners: 1,
      isLoved: true,
      crownHolder: 'DreadRock',
    });
  });

  it('waits for every task, including the slowest one', async () => {
    // The tasks run concurrently and are joined. A resolver that sampled the
    // result before the slow query settled would silently drop a field.
    const slow = deferred<number>();
    const deps = registerAll();
    mockOf(deps.prisma).userPlay.count.mockReturnValue(slow.promise);

    const pending = FmFooterResolver.resolveFooterData(
      dummyUser, dummyTrack, mask(FmFooterOption.ArtistPlays, FmFooterOption.ArtistPlaysThisWeek), GUILD,
    );
    slow.resolve(42);

    await expect(pending).resolves.toEqual({ artistPlays: 263, artistPlaysThisWeek: 42 });
  });

  it('keeps the fast fields when the slow one fails', async () => {
    const deps = registerAll();
    mockOf(deps.prisma).userPlay.count.mockRejectedValue(new Error('db down'));

    const data = await FmFooterResolver.resolveFooterData(
      dummyUser,
      dummyTrack,
      mask(FmFooterOption.ArtistPlays, FmFooterOption.ArtistPlaysThisWeek, FmFooterOption.CrownHolder),
      GUILD,
    );

    expect(data).toEqual({ artistPlays: 263, crownHolder: 'DreadRock' });
  });

  it('never throws, whatever every collaborator does', async () => {
    // Half of the contract, and the half that is easy to get wrong by fixing the
    // other one: the card survives total failure. The other half is asserted in
    // the `A1` describe below - surviving is not the same as being silent.
    const boom = () => {
      throw new Error('boom');
    };
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const deps = registerAll({
      artistsService: { getArtistInfo: boom },
      albumService: { getAlbumInfo: boom },
      trackService: { getTrackInfo: boom },
      whoKnowsRepo: {
        getIndexedUsersForArtist: boom,
        getIndexedUsersForAlbum: boom,
        getIndexedUsersForTrack: boom,
      },
      crownRepo: { getCurrentCrown: boom },
      prisma: {
        userArtist: { aggregate: boom },
        userAlbum: { aggregate: boom },
        userTrack: { aggregate: boom },
        userPlay: { count: boom },
        album: { findFirst: boom },
        track: { findFirst: boom },
      },
    });

    await expect(FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(...HANDLED), GUILD))
      .resolves.toEqual({});
    expect(deps).toBeDefined();

    // Every task reports, and nothing outside the eight tasks does. Nine
    // options map to EIGHT tasks - Loved and TrackPlays share one lookup - and
    // that shared task reports both halves as a single line. Asserted by name
    // rather than by count alone, so a task that logged the wrong field fails
    // here instead of passing on arithmetic.
    const reported = logged.mock.calls
      .map(c => String((c[0] as { footerFields?: unknown }).footerFields))
      .sort();
    expect(reported).toEqual([
      'albumPlays',
      'artistPlays',
      'artistPlaysThisWeek',
      'crownHolder',
      'serverAlbumListeners',
      'serverArtistListeners',
      'serverTrackListeners',
      'trackPlays + isLoved',
    ]);
  });
});

/**
 * A1 for this file: no query may fail without saying so.
 *
 * Table-driven on purpose. The bug was eight identical `catch { // graceful
 * fallback }` blocks, and a per-field test can be satisfied by fixing seven of
 * them - this one entry per field fails if any single site is left silent, and
 * the `field in data === false` half keeps the fix from being "log it and then
 * fabricate a value", which is the non-fix the plan calls out by name.
 */
describe('FmFooterResolver - A1: a query that cannot be read says so', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    container.clearInstances();
  });

  type Deps = ReturnType<typeof registerAll>;

  interface FailureCase {
    /** The footer field whose query is broken. */
    field: keyof FmFooterData;
    /** The single option that switches that task on, in isolation. */
    flag: FmFooterOption;
    /** Breaks exactly one collaborator on the way to `field`. */
    breakIt: (deps: Deps) => void;
    /**
     * Makes the same query RUN and answer "nothing here", and states whether
     * that leaves the field set. The two answers are not interchangeable and
     * the distinction is the point of the row:
     *
     *  - a 0 playcount is not a count, so it is left unset (the playcounts);
     *  - "you played them zero times this week" and "zero listeners here" ARE
     *    real answers and are written through as 0;
     *  - a catalogue row that does not exist leaves the field unset.
     */
    answered: (deps: Deps) => void;
    answeredPresent: boolean;
  }

  const CASES: FailureCase[] = [
    {
      field: 'artistPlays',
      flag: FmFooterOption.ArtistPlays,
      breakIt: d => mockOf(d.artistsService).getArtistInfo.mockRejectedValue(new Error('db down')),
      answered: d => {
        mockOf(d.artistsService).getArtistInfo.mockResolvedValue({ name: 'Gunna' });
        mockOf(d.prisma).userArtist.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });
      },
      answeredPresent: false,
    },
    {
      field: 'albumPlays',
      flag: FmFooterOption.AlbumPlays,
      // The service must decline first, or it answers with a playcount and the
      // aggregate is never reached - which would make this row test nothing.
      breakIt: d => {
        mockOf(d.albumService).getAlbumInfo.mockResolvedValue({ name: 'A Gift & a Curse' });
        mockOf(d.prisma).userAlbum.aggregate.mockRejectedValue(new Error('db down'));
      },
      answered: d => {
        mockOf(d.albumService).getAlbumInfo.mockResolvedValue({ name: 'A Gift & a Curse' });
        mockOf(d.prisma).userAlbum.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });
      },
      answeredPresent: false,
    },
    {
      field: 'trackPlays',
      flag: FmFooterOption.TrackPlays,
      breakIt: d => mockOf(d.trackService).getTrackInfo.mockRejectedValue(new Error('db down')),
      answered: d => {
        mockOf(d.trackService).getTrackInfo.mockResolvedValue(null);
        mockOf(d.prisma).userTrack.aggregate.mockResolvedValue({ _sum: { playcount: 0 } });
      },
      answeredPresent: false,
    },
    {
      field: 'artistPlaysThisWeek',
      flag: FmFooterOption.ArtistPlaysThisWeek,
      breakIt: d => mockOf(d.prisma).userPlay.count.mockRejectedValue(new Error('db down')),
      answered: d => { mockOf(d.prisma).userPlay.count.mockResolvedValue(0); },
      answeredPresent: true,
    },
    {
      field: 'serverArtistListeners',
      flag: FmFooterOption.ServerArtistListeners,
      breakIt: d => mockOf(d.whoKnowsRepo).getIndexedUsersForArtist.mockRejectedValue(new Error('db down')),
      answered: d => { mockOf(d.whoKnowsRepo).getIndexedUsersForArtist.mockResolvedValue([]); },
      answeredPresent: true,
    },
    {
      field: 'serverAlbumListeners',
      flag: FmFooterOption.ServerAlbumListeners,
      breakIt: d => mockOf(d.whoKnowsRepo).getIndexedUsersForAlbum.mockRejectedValue(new Error('db down')),
      answered: d => { mockOf(d.prisma).album.findFirst.mockResolvedValue(null); },
      answeredPresent: false,
    },
    {
      field: 'serverTrackListeners',
      flag: FmFooterOption.ServerTrackListeners,
      breakIt: d => mockOf(d.whoKnowsRepo).getIndexedUsersForTrack.mockRejectedValue(new Error('db down')),
      answered: d => { mockOf(d.prisma).track.findFirst.mockResolvedValue(null); },
      answeredPresent: false,
    },
    {
      field: 'crownHolder',
      flag: FmFooterOption.CrownHolder,
      breakIt: d => mockOf(d.crownRepo).getCurrentCrown.mockRejectedValue(new Error('db down')),
      answered: d => { mockOf(d.crownRepo).getCurrentCrown.mockResolvedValue(null); },
      answeredPresent: false,
    },
  ];

  // The list is stated here rather than derived from the resolver, so a ninth
  // task added to production without a row here fails the test.
  it('covers exactly the eight queried fields', () => {
    expect(CASES.map(c => c.field).sort()).toEqual([
      'albumPlays',
      'artistPlays',
      'artistPlaysThisWeek',
      'crownHolder',
      'serverAlbumListeners',
      'serverArtistListeners',
      'serverTrackListeners',
      'trackPlays',
    ]);
  });

  for (const { field, flag, breakIt, answered, answeredPresent } of CASES) {
    it(`reports a throw on the ${field} query instead of omitting it silently`, async () => {
      const deps = registerAll();
      const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
      breakIt(deps);

      const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(flag), GUILD);

      expectReported(logged.mock.calls, field, 'db down');
      // Absent, not zero and not a guess: the field the builder gates on
      // `!== undefined` is genuinely unset, so no confident number is rendered.
      expect(field in data).toBe(false);
    });

    it(`stays silent for the ${field} query that ran and found nothing`, async () => {
      // The other half of the pair, and the one a careless fix breaks: a
      // successful query with nothing to report is a real answer, so it must
      // not be logged as a failure and must not become a fabricated value.
      const deps = registerAll();
      const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
      answered(deps);

      const data = await FmFooterResolver.resolveFooterData(dummyUser, dummyTrack, mask(flag), GUILD);

      expect(field in data).toBe(answeredPresent);
      expect(logged.mock.calls).toEqual([]);
    });
  }
});
