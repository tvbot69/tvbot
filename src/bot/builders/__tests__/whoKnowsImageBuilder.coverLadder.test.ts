import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { buildWhoKnowsImageResponse } from '@bot/builders/whoKnowsImageBuilder';
/*
 * The collaborator types every `WhoKnowsImageDeps` field is declared as. Named
 * explicitly rather than reached through a blind cast, because a double that does
 * not typecheck against the real collaborator is a double that has drifted from
 * its signature. `as unknown as X` is the honest bridge: each double implements
 * one method of a class that has many, and `as never` would hide exactly the
 * mismatch a reviewer wants to see.
 */
import type { WhoKnowsImageDeps } from '@bot/builders/whoKnowsImageDeps';
import type { ContextModel } from '@bot/models/contextModel';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import type { ArtistsService } from '@bot/services/library/artistsService';
import type { AlbumService } from '@bot/services/library/albumService';
import type { ArtworkService } from '@bot/services/media/artworkService';
import type { UserService } from '@bot/services/user/userService';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import type { DeezerApi } from '@deezer/api/deezerApi';
import type { DeezerAlbum } from '@deezer/models/deezerModels';
import type { DeezerCoverIndexer } from '@bot/services/media/deezerCoverIndexer';

/**
 * The two ladders inside `whoKnowsImageBuilder` that nobody was pinning: how a
 * URL becomes an artist and an album name, and how a set of covers is admitted.
 *
 * WHAT IS ALREADY COVERED, AND WHY THIS IS NOT A DUPLICATE
 * ------------------------------------------------------
 * `whoKnowsImageBuilder.test.ts` is a characterisation test written before the
 * DI refactor: it pins that a card renders, that a throwing generator degrades to
 * null, and that crownText and genres are forwarded. `collageFailure.test.ts`
 * pins the `// CORRECT AS IS` swallow sites by making every read RAISE and then
 * asserting the real figures survived.
 *
 * Neither one exercises the ladders with a source that SUCCEEDS. Every existing
 * fixture either has no collaborators at all (`NO_DEPS`) or has every
 * collaborator throw. So the order of the rungs, the cap at ten, the
 * artist-name verification on the Deezer rung, and the album track-name ladder
 * had no coverage at all - which is where a wrong-artist cover or a stale name
 * would live.
 *
 * THE TWO CLAIMS THAT MATTER
 * --------------------------
 *  1. A NAME is parsed out of a Last.fm URL, not guessed. The `_` segment means
 *     "track", so `/music/Artist/_/Track` must not produce an album called `_`.
 *     Getting that wrong puts a track name in an album cover query.
 *  2. A COVER is only admitted if it can be ATTRIBUTED. A namesake's cover is a
 *     claim about a person and a mosaic has no legend saying which tile is which.
 *
 * The existing `collageFailure.test.ts` proves a failed source cannot change a
 * figure. This file proves a SUCCEEDING source cannot introduce a wrong one.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fea7b1c1e4000000049454e44ae426082',
  'hex',
);

const USERS: WhoKnowsUser[] = [
  { userId: 1, playcount: 150, lastFmUsername: 'alice', discordName: 'Alice' },
  { userId: 2, playcount: 120, lastFmUsername: 'bob', discordName: 'Bob' },
];

const PLACEHOLDER = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
const COVER = (n: number) => `https://img.test/cover${n}.jpg`;

/** A context double. `guild` is a plain field, not a getter, so this is fine. */
const ctx = (guildName?: string) =>
  ({
    guildId: 'g-1',
    discordUserId: 'd-1',
    guild: guildName === undefined ? undefined : { name: guildName },
  }) as unknown as ContextModel;

interface Args {
  url?: string;
  title?: string;
  type?: 'Artist' | 'Track' | 'Album';
  requestedUserId?: number;
  thumbnailUrl?: string | null;
  metadata?: Record<string, unknown>;
}

const call = (deps: WhoKnowsImageDeps, over: Args = {}) =>
  buildWhoKnowsImageResponse(
    {
      context: ctx('Test Guild'),
      title: 'Radiohead',
      url: 'https://www.last.fm/music/Radiohead',
      thumbnailUrl: null,
      users: USERS,
      resolvedAccent: 0x00ff00,
      type: 'Artist',
      requestedUserId: 1,
      metadata: { globalPlays: 500, globalListeners: 7 },
      ...over,
    },
    deps,
  );

/** Every collaborator absent. The starting point for each test. */
const NO_DEPS: WhoKnowsImageDeps = {
  generator: null,
  artistsService: null,
  albumService: null,
  artworkService: null,
  userService: null,
  spotifyApi: null,
  deezerApi: null,
  coverIndexer: null,
};

/**
 * A stub generator, handed back so its arguments can be read. No global state is
 * touched, which is the whole point of the deps refactor.
 */
const withGenerator = (over: Partial<WhoKnowsImageDeps> = {}): {
  deps: WhoKnowsImageDeps;
  generate: ReturnType<typeof vi.fn>;
} => {
  const generate = vi.fn(async (..._args: unknown[]) => PNG);
  return {
    deps: { ...NO_DEPS, generator: { generateWhoKnowsImage: generate } as unknown as WhoKnowsGenerator, ...over },
    generate,
  };
};

/** The single argument the generator was called with. */
const generatorArg = (generate: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  generate.mock.calls[0]![0] as Record<string, unknown>;

/** An artistsService double with every method answering, so the rungs are optional. */
const artistsService = (over: Record<string, unknown> = {}) =>
  ({
    getTopAlbumsForArtist: vi.fn(async () => [] as Array<{ name: string; artistName: string }>),
    getTopTracksForArtist: vi.fn(async () => [] as Array<{ name: string }>),
    getTopTracksForArtistGlobal: vi.fn(async () => [] as Array<{ name: string }>),
    getTopAlbumsForArtistGlobal: vi.fn(async () => [] as Array<{ name: string; artistName: string }>),
    getIndexedAlbumCoversForArtist: vi.fn(async () => [] as string[]),
    ...over,
  }) as unknown as ArtistsService;

const albumService = (over: Record<string, unknown> = {}) =>
  ({
    getTopTracksForAlbum: vi.fn(async () => [] as string[]),
    ...over,
  }) as unknown as AlbumService;

describe('whoKnowsImageBuilder: the names it works from come off the URL', () => {
  it('reads the artist off a Last.fm artist URL', async () => {
    const spotifyApi = { getArtistDiscographyCovers: vi.fn(async () => []) };
    const { deps } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService, spotifyApi: spotifyApi as unknown as SpotifySearchApi });

    await call(deps, { url: 'https://www.last.fm/music/Slowdive' });

    expect(spotifyApi.getArtistDiscographyCovers).toHaveBeenCalledWith('Slowdive', undefined, 15);
  });

  it('decodes a plus in the artist segment, because Last.fm paths use them for spaces', async () => {
    // `music/Slow+dive` is the same artist as `music/Slowdive` is not; the plus
    // form is what Last.fm hands out and a raw split leaves the plus in the name.
    const spotifyApi = { getArtistDiscographyCovers: vi.fn(async () => []) };
    const { deps } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService, spotifyApi: spotifyApi as unknown as SpotifySearchApi });

    await call(deps, { url: 'https://www.last.fm/music/Fleet+Woods' });

    expect(spotifyApi.getArtistDiscographyCovers).toHaveBeenCalledWith('Fleet Woods', undefined, 15);
  });

  it('reads the album off a two-segment URL', async () => {
    const getTopTracksForAlbum = vi.fn(async () => ['Weird Fishes']);
    const { deps } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum }),
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    expect(getTopTracksForAlbum).toHaveBeenCalledWith('Radiohead', 'OK Computer', 3, 1);
  });

  it('treats the `_` segment as a track and never queries an album named "_"', async () => {
    // `/music/Artist/_/Track` is Last.fm's track form. Reading `_` as the album
    // would put a literal underscore into every album cover and track query.
    const getTopTracksForAlbum = vi.fn(async () => []);
    const { deps } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum }),
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/_/Creep', type: 'Album' });

    expect(getTopTracksForAlbum).not.toHaveBeenCalledWith('Radiohead', '_', 3, 1);
    for (const args of getTopTracksForAlbum.mock.calls) {
      expect((args as unknown[])[1]).not.toBe('_');
    }
  });

  it('falls back to the title for the album name when the URL has none', async () => {
    // The `_` guard stops the URL supplying an album, and the title fallback then
    // supplies one instead. REPORTED, NOT PINNED as a defect: for an Album card
    // whose URL is a TRACK url, that fallback produces a nonsense album name
    // (here the artist name) and the album ladder runs against it.
    //
    // It is not reachable from the production caller: `whoKnowsBuilders` infers
    // `type` from the same URL, so `/_/` yields 'Track' and the Album branch is
    // never entered. It is reachable only if a caller passes `mediaType: 'Album'`
    // with a track URL. Asserted here as it behaves, so the interaction is
    // visible rather than hidden.
    const getTopTracksForAlbum = vi.fn(async () => []);
    const { deps } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum }),
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/_/Creep', type: 'Album', title: 'Radiohead' });

    expect(getTopTracksForAlbum).toHaveBeenCalledWith('Radiohead', 'Radiohead', 3, 1);
  });

  it('drops a query string before reading the segments', async () => {
    const spotifyApi = { getArtistDiscographyCovers: vi.fn(async () => []) };
    const { deps } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService, spotifyApi: spotifyApi as unknown as SpotifySearchApi });

    await call(deps, { url: 'https://www.last.fm/music/Slowdive?x=1' });

    expect(spotifyApi.getArtistDiscographyCovers).toHaveBeenCalledWith('Slowdive', undefined, 15);
  });

  it('falls back to the title when the URL is not a Last.fm path', async () => {
    const spotifyApi = { getArtistDiscographyCovers: vi.fn(async () => []) };
    const { deps } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService, spotifyApi: spotifyApi as unknown as SpotifySearchApi });

    await call(deps, { url: 'https://example.com/anything', title: 'Slowdive in Souvlaki' });

    expect(spotifyApi.getArtistDiscographyCovers).toHaveBeenCalledWith('Slowdive', undefined, 15);
  });

  it('falls back to the whole title when it carries no artist hint at all', async () => {
    const spotifyApi = { getArtistDiscographyCovers: vi.fn(async () => []) };
    const { deps } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService, spotifyApi: spotifyApi as unknown as SpotifySearchApi });

    await call(deps, { url: 'https://example.com/x', title: 'Mystery Record' });

    expect(spotifyApi.getArtistDiscographyCovers).toHaveBeenCalledWith('Mystery Record', undefined, 15);
  });
});

describe('whoKnowsImageBuilder: the album track-name ladder', () => {
  it('uses the caller\'s own top tracks first, anchored to the caller id', async () => {
    const getTopTracksForAlbum = vi.fn(async (..._a: unknown[]) => ['Weird Fishes']);
    const { deps, generate } = withGenerator({ albumService: albumService({ getTopTracksForAlbum }) });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    // The `(artist, album, 3, callerId)` shape is the personalisation: without
    // the id the same query returns the global top three, which would then be
    // labelled as the caller's own.
    expect(getTopTracksForAlbum).toHaveBeenCalledWith('Radiohead', 'OK Computer', 3, 1);
    expect(generatorArg(generate).topTracks).toEqual(['Weird Fishes']);
  });

  it('does not ask for the caller rung when it has no caller id', async () => {
    // `requestedUserId` is 0 when the caller is not indexed. Asking with 0 would
    // return the global top three wearing a "your plays" label.
    const getTopTracksForAlbum = vi.fn(async () => []);
    const { deps } = withGenerator({ albumService: albumService({ getTopTracksForAlbum }) });

    await call(deps, {
      url: 'https://www.last.fm/music/Radiohead/OK+Computer',
      type: 'Album',
      requestedUserId: 0,
    });

    expect(getTopTracksForAlbum).not.toHaveBeenCalledWith('Radiohead', 'OK Computer', 3, 0);
  });

  it('keeps the caller rung out of the way when it already produced three names', async () => {
    const getTopTracksForAlbum = vi.fn(async (..._a: unknown[]) => ['A', 'B', 'C']);
    const { deps, generate } = withGenerator({ albumService: albumService({ getTopTracksForAlbum }) });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    // Once per query, not once per name.
    expect(getTopTracksForAlbum).toHaveBeenCalledTimes(1);
    expect(generatorArg(generate).topTracks).toEqual(['A', 'B', 'C']);
    expect(generatorArg(generate).topItemValue).toBe('A');
  });

  it('tops a short caller list up from the global database query', async () => {
    const getTopTracksForAlbum = vi.fn(async (..._a: unknown[]) => ['A']);
    const { deps, generate } = withGenerator({ albumService: albumService({ getTopTracksForAlbum }) });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    // Called twice: once for the caller (with an id) and once for the world.
    expect(getTopTracksForAlbum).toHaveBeenCalledTimes(2);
    expect(getTopTracksForAlbum).toHaveBeenCalledWith('Radiohead', 'OK Computer', 5);
    expect(generatorArg(generate).topTracks).toEqual(['A']);
  });

  it('fills the remaining slots from the caller-supplied tracklist', async () => {
    const { deps, generate } = withGenerator({ albumService: albumService({}) });
    await call(deps, {
      url: 'https://www.last.fm/music/Radiohead/OK+Computer',
      type: 'Album',
      metadata: { topTracks: ['From Metadata 1', 'From Metadata 2'] },
    });
    expect(generatorArg(generate).topTracks).toEqual(['From Metadata 1', 'From Metadata 2']);
  });

  it('asks Spotify only for the slots that are still empty, and stops at three', async () => {
    const getAlbumTrackNames = vi.fn(async () => ['Spotify A', 'Spotify B']);
    const { deps, generate } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum: vi.fn(async () => ['From DB']) }),
      spotifyApi: { getAlbumTrackNames } as unknown as SpotifySearchApi,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    // Spotify is rung 4: it is asked only because rungs 1-3 left room, and the
    // list is capped at three so the row never overflows its box.
    expect(getAlbumTrackNames).toHaveBeenCalledWith('OK Computer', 'Radiohead', 5);
    expect(generatorArg(generate).topTracks).toEqual(['From DB', 'Spotify A', 'Spotify B']);
  });

  it('does not ask Spotify at all once three names are in hand', async () => {
    const getAlbumTrackNames = vi.fn(async () => ['Should Not Be Asked']);
    const { deps } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum: vi.fn(async () => ['A', 'B', 'C']) }),
      spotifyApi: { getAlbumTrackNames } as unknown as SpotifySearchApi,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    expect(getAlbumTrackNames).not.toHaveBeenCalled();
  });

  it('labels the row it filled in, so the card says what the row is', async () => {
    const { deps, generate } = withGenerator({
      albumService: albumService({
        getTopTracksForAlbum: vi.fn(async (..._a: unknown[]) => ['A', 'B', 'C']),
      }),
    });
    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });
    expect(generatorArg(generate).topItemLabel).toBe('Top Track');
  });

  it('leaves the row label alone when nothing was found, rather than labelling an empty row', async () => {
    const { deps, generate } = withGenerator({ albumService: albumService({}) });
    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });
    expect(generatorArg(generate).topItemLabel).toBeUndefined();
  });

  it('never repeats a name the caller rung already produced', async () => {
    const getAlbumTrackNames = vi.fn(async () => ['From DB', 'Spotify A']);
    const { deps, generate } = withGenerator({
      albumService: albumService({ getTopTracksForAlbum: vi.fn(async () => ['From DB']) }),
      spotifyApi: { getAlbumTrackNames } as unknown as SpotifySearchApi,
    });

    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });

    expect(generatorArg(generate).topTracks).toEqual(['From DB', 'Spotify A']);
  });

  it('leaves the whole row absent when no rung produced anything', async () => {
    // An absent row is the honest outcome. Substituting a plausible track name
    // would be a claim the bot cannot support.
    const { deps, generate } = withGenerator({ albumService: albumService({}) });
    await call(deps, { url: 'https://www.last.fm/music/Radiohead/OK+Computer', type: 'Album' });
    expect(generatorArg(generate).topTracks).toBeUndefined();
    expect(generatorArg(generate).topItemValue).toBeUndefined();
  });
});

describe('whoKnowsImageBuilder: the artist track-name row', () => {
  it('prefers the caller\'s own top tracks', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getTopTracksForArtist: vi.fn(async () => [{ name: 'Weird Fishes' }]),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { type: 'Artist' });

    expect(generatorArg(generate).topTracks).toEqual(['Weird Fishes']);
    expect(generatorArg(generate).topItemValue).toBe('Weird Fishes');
  });

  it('tops a short list up from the global query, only in artist mode', async () => {
    const getTopTracksForArtistGlobal = vi.fn(async () => [{ name: 'Reckoner' }]);
    const { deps, generate } = withGenerator({
      artistsService: artistsService({ getTopTracksForArtistGlobal }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { type: 'Artist' });

    expect(getTopTracksForArtistGlobal).toHaveBeenCalledWith('Radiohead', 5);
    expect(generatorArg(generate).topTracks).toEqual(['Reckoner']);
  });

  it('does not run the global top-tracks rung for a track card', async () => {
    // A track's "top tracks" row would be a list of other tracks, which is a
    // different claim about a different entity.
    const getTopTracksForArtistGlobal = vi.fn(async () => [{ name: 'Reckoner' }]);
    const { deps, generate } = withGenerator({
      artistsService: artistsService({ getTopTracksForArtistGlobal }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { type: 'Track' });

    expect(getTopTracksForArtistGlobal).not.toHaveBeenCalled();
    expect(generatorArg(generate).topTracks).toBeUndefined();
  });

  it('does not overwrite a top item the caller already resolved', async () => {
    // The caller may have a real album title; replacing it with a track name
    // would change what the row above the list says the thing is.
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getTopTracksForArtist: vi.fn(async () => [{ name: 'A DB Track' }]),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { metadata: { topItemValue: 'A Caller Supplied Item' } });

    expect(generatorArg(generate).topItemValue).toBe('A Caller Supplied Item');
  });

  it('falls back to a caller top-album name when no track name was found at all', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getTopAlbumsForArtist: vi.fn(async () => [{ name: 'OK Computer', artistName: 'Radiohead' }]),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps, { type: 'Artist' });

    expect(generatorArg(generate).topItemValue).toBe('OK Computer');
  });

  it('resolves the caller id from Discord when the caller is not indexed yet', async () => {
    const getUserByDiscordId = vi.fn(async () => ({ userId: 55 }));
    const { deps } = withGenerator({
      userService: { getUserByDiscordId } as unknown as UserService,
      albumService: albumService({ getTopTracksForAlbum: vi.fn(async () => []) }),
    });

    await call(deps, {
      url: 'https://www.last.fm/music/Radiohead/OK+Computer',
      type: 'Album',
      requestedUserId: 0,
    });

    expect(getUserByDiscordId).toHaveBeenCalledWith('d-1');
  });
});

describe('whoKnowsImageBuilder: the cover ladder admits only attributable covers', () => {
  it('omits the mosaic when nothing answered, rather than sending an empty list', async () => {
    const { deps, generate } = withGenerator({ artistsService: artistsService(), artworkService: {} as unknown as ArtworkService });
    await call(deps, { thumbnailUrl: null });
    expect(generatorArg(generate).backgroundCovers).toBeUndefined();
  });

  it('takes the verified discography covers first', async () => {
    const getArtistDiscographyCovers = vi.fn(async () => [COVER(1), COVER(2)]);
    const { deps, generate } = withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
    });

    await call(deps);

    expect(getArtistDiscographyCovers).toHaveBeenCalled();
    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(1), COVER(2)]);
  });

  it('anchors the discography query with a caller track name, so a namesake does not win', async () => {
    const getArtistDiscographyCovers = vi.fn(async () => []);
    const { deps } = withGenerator({
      artistsService: artistsService({
        getTopTracksForArtist: vi.fn(async () => [{ name: 'Reckoner' }]),
      }),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
    });

    await call(deps);

    expect(getArtistDiscographyCovers).toHaveBeenCalledWith('Radiohead', 'Reckoner', 15);
  });

  it('adds the indexed database covers after the discography ones', async () => {
    const getArtistDiscographyCovers = vi.fn(async () => [COVER(1)]);
    const getIndexedAlbumCoversForArtist = vi.fn(async () => [COVER(2)]);
    const { deps, generate } = withGenerator({
      artistsService: artistsService({ getIndexedAlbumCoversForArtist }),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
    });

    await call(deps);

    expect(getIndexedAlbumCoversForArtist).toHaveBeenCalled();
    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(1), COVER(2)]);
  });

  it('keeps one copy of a cover two rungs both returned', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getIndexedAlbumCoversForArtist: vi.fn(async () => [COVER(1), COVER(2)]),
      }),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => [COVER(1)]) } as unknown as SpotifySearchApi,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(1), COVER(2)]);
  });

  it('stops the database rung at ten, because ten is what the generator lays out', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getIndexedAlbumCoversForArtist: vi.fn(async () => Array.from({ length: 14 }, (_, i) => COVER(i))),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toHaveLength(10);
  });

  it('rejects a Deezer cover credited to a different artist', async () => {
    // The namesakes case. A mosaic of ten tiles has no legend, so a wrong cover
    // is invisible - and it is a claim about a person.
    const { deps, generate } = withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
      deezerApi: {
        searchAlbums: vi.fn(async () => [
          { artist: { name: 'Radiohead Tribute Band' }, cover_xl: COVER(9) },
          { artist: { name: 'radiohead' }, cover_xl: COVER(8) },
        ]),
      } as never,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(8)]);
  });

  it('skips the Deezer rung once the earlier rungs are nearly full', async () => {
    // The threshold is 8, not 10: below that the mosaic looks empty enough to be
    // worth a fuzzy search, above it a duplicate tile costs more than a gap.
    const searchAlbums = vi.fn(async () => []);
    const { deps } = withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: {
        getArtistDiscographyCovers: vi.fn(async () => Array.from({ length: 9 }, (_, i) => COVER(i))),
      } as never,
      deezerApi: { searchAlbums } as unknown as DeezerApi,
    });

    await call(deps);

    expect(searchAlbums).not.toHaveBeenCalled();
  });

  it('asks Deezer when the earlier rungs came back nearly empty', async () => {
    const searchAlbums = vi.fn(async () => []);
    const { deps } = withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => [COVER(1)]) } as unknown as SpotifySearchApi,
      deezerApi: { searchAlbums } as unknown as DeezerApi,
    });

    await call(deps);

    expect(searchAlbums).toHaveBeenCalled();
  });

  it('takes the largest Deezer cover it is offered', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
      deezerApi: {
        searchAlbums: vi.fn(async () => [{ artist: { name: 'Radiohead' }, cover_medium: COVER(3) }]),
      } as never,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(3)]);
  });

  it('tops the mosaic up from an album row that already carried its own cover', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getTopAlbumsForArtist: vi.fn(async () => [
          { name: 'OK Computer', artistName: 'Radiohead', directImage: COVER(7) },
        ]),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(7)]);
  });

  it('never tops up from a Last.fm placeholder, which is not artwork', async () => {
    const { deps, generate } = withGenerator({
      artistsService: artistsService({
        getTopAlbumsForArtist: vi.fn(async () => [
          { name: 'OK Computer', artistName: 'Radiohead', directImage: PLACEHOLDER },
        ]),
      }),
      artworkService: {} as unknown as ArtworkService,
    });

    await call(deps);

    expect(generatorArg(generate).backgroundCovers).toBeUndefined();
  });

  it('does not run the ladder at all without an artwork service, even with everything else present', async () => {
    // The guard is `artistsService && artworkService`, so a container missing
    // the artwork service skips the whole block. Pinned because it is a two-word
    // guard that decides whether ten covers or zero are drawn.
    const getArtistDiscographyCovers = vi.fn(async () => [COVER(1)]);
    const { deps, generate } = withGenerator({
      artistsService: artistsService(),
      artworkService: null,
      spotifyApi: { getArtistDiscographyCovers } as unknown as SpotifySearchApi,
    });

    await call(deps);

    expect(getArtistDiscographyCovers).not.toHaveBeenCalled();
    expect(generatorArg(generate).backgroundCovers).toBeUndefined();
  });

  it('does not run the ladder without an artists service either', async () => {
    const { deps, generate } = withGenerator({ artistsService: null, artworkService: {} as unknown as ArtworkService });
    await call(deps);
    expect(generatorArg(generate).backgroundCovers).toBeUndefined();
  });
});

describe('whoKnowsImageBuilder: the background cover write', () => {
  /** `indexCovers` is fired on `setImmediate`, so let the queue drain. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const verifiedDeezer = () => ({
    searchAlbums: vi.fn(async () => [
      { artist: { name: 'Radiohead' }, cover_xl: COVER(1) },
      { artist: { name: 'Radiohead Tribute Band' }, cover_xl: COVER(9) },
    ]),
  });

  const depsWithDeezer = (coverIndexer: unknown) =>
    withGenerator({
      artistsService: artistsService(),
      artworkService: {} as unknown as ArtworkService,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(async () => []) } as unknown as SpotifySearchApi,
      deezerApi: verifiedDeezer() as unknown as DeezerApi,
      coverIndexer: coverIndexer as unknown as DeezerCoverIndexer,
    });

  /**
   * The real `indexCovers(artistName, verifiedAlbums)` signature, so
   * `mock.calls[0]` is a two-argument tuple the assertions can read without a
   * cast. The declared parameters are the production ones; a double typed
   * `async () => undefined` would make `calls[0]` an empty tuple and force the
   * arguments to be re-asserted by hand.
   */
  const indexerDouble = (impl?: (artistName: string, albums: DeezerAlbum[]) => Promise<number>) =>
    vi.fn(impl ?? (async () => 0));

  it('indexes the covers it admitted, keyed to the artist it asked about', async () => {
    const indexCovers = indexerDouble();
    const { deps } = depsWithDeezer({ indexCovers });

    await call(deps);
    await settle();

    expect(indexCovers).toHaveBeenCalledTimes(1);
    expect(indexCovers.mock.calls[0]![0]).toBe('Radiohead');
  });

  it('never indexes an album it rejected, or the write would store a namesake cover', async () => {
    // This is the load-bearing half of the attribution check. Admitting is
    // visible; PERSISTING is not - a rejected cover written to the database is
    // read back out by every future cascade for that artist.
    const indexCovers = indexerDouble();
    const { deps } = depsWithDeezer({ indexCovers });

    await call(deps);
    await settle();

    const indexed = indexCovers.mock.calls[0]![1];
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.artist?.name).toBe('Radiohead');
  });

  it('writes nothing when no indexer is registered', async () => {
    const { deps } = depsWithDeezer(null);

    await expect(call(deps)).resolves.not.toBeNull();
    await settle();
    // No throw and no write is the whole contract of the null branch.
  });

  it('survives an indexer that rejects, because a background write must not escape', async () => {
    const indexCovers = vi.fn(async () => {
      throw new Error('unique constraint violated');
    });
    const { deps } = depsWithDeezer({ indexCovers });

    await expect(call(deps)).resolves.not.toBeNull();
    await settle();
    // The failure is recorded at DEBUG, not thrown: `indexDiscoveredCovers`
    // catches it so a background write cannot reach the process.
  });

  it('still renders the card when the write fails', async () => {
    const indexCovers = vi.fn(async () => {
      throw new Error('write failed');
    });
    const { deps, generate } = depsWithDeezer({ indexCovers });

    const response = await call(deps);
    await settle();

    expect(response).not.toBeNull();
    expect(response?.fileName).toBe('whoknows.png');
    expect(generatorArg(generate).backgroundCovers).toEqual([COVER(1)]);
  });
});
