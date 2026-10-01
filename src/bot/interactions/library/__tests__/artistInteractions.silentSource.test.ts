/**
 * `ArtistInteractions.handle` wraps every read it performs - `getTopTracks*`,
 * `getTopAlbums*`, `getTotalArtistPlays`, `getArtistRecentPlays`,
 * `genreService.getGenresForArtist`, `lastfmRepository.getArtistInfo` - in one
 * `try`, and that single catch used to end in a bare
 * `{ Logger.error(...); deferUpdate(); }`.
 *
 * So every deliberate raise those reads make was laundered into the same thing
 * the user sees: press a nav button or a page arrow during a Last.fm outage and
 * the card silently does not change, with no error rendered and no indication
 * that a read had failed. `getGenresForArtist` and `getArtistInfo` both
 * re-throw `LastFmUnavailableError` rather than cache "no genres" / "no
 * artist"; overruling that here is the bug. The catch is now narrowed with
 * `isSourceUnavailable`, so the deliberate signal reaches
 * `interactionHandler.onInteractionCreated` - a real boundary that answers the
 * presser - while a genuine query failure still degrades to the unchanged card.
 *
 * BOTH DIRECTIONS. Pinning only the raise would pass just as happily against a
 * blanket `throw err`, which would break every ordinary query failure; pinning
 * only the degrade would pass against the bug. So each raising read is pinned,
 * a plain failure still degrades, and a read that RAN and returned nothing
 * still renders.
 *
 * Plain object doubles, built fresh per test and handed to the constructor in
 * the real positional order (artistTrackService, musicBrainzService,
 * genreService, userService, colorService, spotifySearchApi, lastfmRepository).
 * The only spies are the `ArtistBuilders` / `ArtistTrackBuilders` statics, which
 * hold no state.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { ArtistInteractions } from '@bot/interactions/library/artistInteractions';
import { ArtistBuilders } from '@bot/builders/library/artistBuilders';
import { ArtistTrackBuilders } from '@bot/builders/library/artistTrackBuilders';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/errors/sourceUnavailableError';
import type { ButtonInteraction } from 'discord.js';

const LFM_DOWN = (method: string): LastFmUnavailableError =>
  new LastFmUnavailableError(method, new Error('Last.fm returned HTTP 500'));

const DB_DOWN = (method: string): SourceUnavailableError =>
  new SourceUnavailableError(method, new Error('connect ECONNREFUSED'), 'Database unavailable');

const V2_CONTAINER = { sentinel: 'components-v2' } as never;

const BUILT_RESPONSE = {
  componentsV2Container: V2_CONTAINER,
  buildEmbed: () => ({ embeds: [] }),
  buildComponents: () => [],
};

const mkButton = (customId: string) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1', username: 'Tester' },
    guild: { id: 'g1', name: 'Test Guild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const artistTrackService = {
    getTopTracksForArtist: vi.fn(async () => [{ name: 'Track 1', playcount: 10 }]),
    getTopAlbumsForArtist: vi.fn(async () => [{ name: 'Album 1', playcount: 8 }]),
    getTotalArtistPlays: vi.fn(async () => 18),
    getArtistRecentPlays: vi.fn(async () => ({ month: 3, total: 18 })),
    getServerArtistStats: vi.fn(async () => ({ serverPlays: 4, serverListeners: 2 })),
    getDistinctTrackCount: vi.fn(async () => 1),
    ...(over.artistTrackService as object),
  };
  const musicBrainzService = {
    getArtistData: vi.fn(async () => null),
    ...(over.musicBrainzService as object),
  };
  const genreService = {
    getGenresForArtist: vi.fn(async () => ['art rock']),
    ...(over.genreService as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'Tester', discordUserId: 'u1', totalPlayCount: 100 })),
    ...(over.userService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const spotifySearchApi = {
    searchArtists: vi.fn(async () => []),
    ...(over.spotifySearchApi as object),
  };
  const lastfmRepository = {
    getArtistInfo: vi.fn(async () => ({ playCount: 5000, listeners: 900, summary: 'A band.' })),
    ...(over.lastfmRepository as object),
  };
  const service = new ArtistInteractions(
    artistTrackService as never,
    musicBrainzService as never,
    genreService as never,
    userService as never,
    colorService as never,
    spotifySearchApi as never,
    lastfmRepository as never,
  );
  return { service, artistTrackService, genreService, lastfmRepository };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ArtistBuilders, 'buildArtistOverviewResponse').mockReturnValue(BUILT_RESPONSE as never);
  vi.spyOn(ArtistBuilders, 'buildArtistInfoResponse').mockReturnValue(BUILT_RESPONSE as never);
  vi.spyOn(ArtistBuilders, 'buildArtistTopAlbumsResponse').mockReturnValue(BUILT_RESPONSE as never);
  vi.spyOn(ArtistTrackBuilders, 'buildArtistTopTracksResponse').mockReturnValue(BUILT_RESPONSE as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ArtistInteractions.handle — a source outage is not a silently dead card', () => {
  it('artist-overview re-throws a Last.fm outage from the genre read', async () => {
    const { service } = build({
      genreService: {
        getGenresForArtist: vi.fn(async () => { throw LFM_DOWN('artist.getinfo'); }),
      },
    });
    const press = mkButton('artist-overview:Radiohead');

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('artist-info re-throws a Last.fm outage from getArtistInfo', async () => {
    const { service } = build({
      lastfmRepository: {
        getArtistInfo: vi.fn(async () => { throw LFM_DOWN('artist.getinfo'); }),
      },
    });
    const press = mkButton('artist-info:Radiohead');

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    expect(press.update).not.toHaveBeenCalled();
    expect(ArtistBuilders.buildArtistInfoResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['artist-tracks:Radiohead', 'getTopTracksForArtist'],
    ['artist-albums:Radiohead', 'getTopAlbumsForArtist'],
    ['aab:next:0:Radiohead', 'getTopAlbumsForArtist'],
  ])('%s re-throws a database outage from %s', async (customId, read) => {
    const { service } = build({
      artistTrackService: {
        [read]: vi.fn(async () => { throw DB_DOWN(`artistTrackService.${read}`); }),
      },
    });
    const press = mkButton(customId);

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('still degrades a genuine query failure to the unchanged card', async () => {
    // The other half of the pair. Narrowing the catch to `isSourceUnavailable`
    // must not have turned an ordinary driver failure into a raised one: the
    // card cannot be rebuilt, so leaving it where it was is the right answer,
    // and this is what proves the re-throw is narrow rather than blanket.
    const { service } = build({
      genreService: {
        getGenresForArtist: vi.fn(async () => { throw new Error("Can't reach database server"); }),
      },
    });
    const press = mkButton('artist-overview:Radiohead');

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('artist-overview still renders when every read ran and returned nothing', async () => {
    // The honest empty. `getGenresForArtist` returning `[]` and the track/album
    // reads returning `[]` are legitimate answers, and they must still reach the
    // builder - otherwise the fix above would make "no indexed plays" and "the
    // source is down" render the same way.
    const { service } = build({
      artistTrackService: {
        getTopTracksForArtist: vi.fn(async () => []),
        getTopAlbumsForArtist: vi.fn(async () => []),
        getTotalArtistPlays: vi.fn(async () => 0),
        getArtistRecentPlays: vi.fn(async () => ({ month: 0, total: 0 })),
      },
      genreService: { getGenresForArtist: vi.fn(async () => []) },
      // A genuine "no such artist" from Last.fm, which the repository returns as
      // `null` rather than raising.
      lastfmRepository: { getArtistInfo: vi.fn(async () => null) },
    });
    const press = mkButton('artist-overview:Radiohead');

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(ArtistBuilders.buildArtistOverviewResponse).toHaveBeenCalledTimes(1);
    expect(ArtistBuilders.buildArtistOverviewResponse).toHaveBeenCalledWith(
      'Radiohead', 0, 'Tester', 'u1', 'u1', 0, 0,
      [], [], [], null, 0xff0000,
    );
    expect(press.update).toHaveBeenCalledWith({
      components: [V2_CONTAINER],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('artist-tracks still renders an empty track list', async () => {
    const { service } = build({
      artistTrackService: {
        getTopTracksForArtist: vi.fn(async () => []),
        getTotalArtistPlays: vi.fn(async () => 0),
      },
    });
    const press = mkButton('artist-tracks:Radiohead');

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(ArtistTrackBuilders.buildArtistTopTracksResponse).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('aab pagination still renders an empty album list', async () => {
    const { service } = build({
      artistTrackService: {
        getTopAlbumsForArtist: vi.fn(async () => []),
        getTotalArtistPlays: vi.fn(async () => 0),
      },
    });
    const press = mkButton('aab:next:0:Radiohead');

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(ArtistBuilders.buildArtistTopAlbumsResponse).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});
